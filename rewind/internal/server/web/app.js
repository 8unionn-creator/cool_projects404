// Rewind Map viewer. No dependencies: the binary serves this file offline.
"use strict";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtN = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const dirOf = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "." : p.slice(0, i); };
const baseOf = (p) => p.slice(p.lastIndexOf("/") + 1);
const LANGS = { go: "Go", py: "Python", ts: "TypeScript", js: "JavaScript" };

const S = {
  meta: null,
  at: "worktree",       // what /api/graph is asked for
  tree: null,           // resolved tree id of the current graph
  data: null,           // /api/graph response
  depth: 0,             // 0 = choose automatically
  focus: "",            // directory being drilled into
  showTests: false,
  showTypes: true,
  heat: false,
  selected: null,       // {kind: "group"|"file", id}
  manualImpact: null,   // file path whose dependents are highlighted
  session: null,        // {name, steps}
  stepIdx: -1,
  diff: null,           // structural diff for the selected step
  view: { x: 0, y: 0, k: 1 },
  model: null,          // derived graph for rendering
  layout: null,
};
const graphCache = new Map();
const diffCache = new Map();

async function api(path) {
  const r = await fetch(path);
  const body = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body.error || body || r.statusText);
  return body;
}

// ---------------------------------------------------------------- loading

async function init() {
  S.meta = await api("/api/meta");
  $("repo").textContent = S.meta.root;
  document.title = `${S.meta.root} · Rewind Map`;
  const sel = $("snapshot");
  const opts = [`<option value="worktree">Working tree (now)</option>`];
  if (S.meta.hasHead) opts.push(`<option value="HEAD">Last commit (HEAD)</option>`);
  for (const s of S.meta.sessions) {
    opts.push(`<option value="session:${esc(s.name)}">Session ${esc(s.name)} · ${plural(s.steps, "step")}</option>`);
  }
  sel.innerHTML = opts.join("");
  sel.addEventListener("change", () => chooseSnapshot(sel.value));
  const current = S.meta.sessions.find((s) => s.current);
  if (current) { sel.value = `session:${current.name}`; await chooseSnapshot(sel.value); }
  else await chooseSnapshot("worktree");
  setInterval(pollLive, 4000);
}

async function chooseSnapshot(v) {
  if (v.startsWith("session:")) {
    const name = v.slice(8);
    S.session = await api(`/api/session?name=${encodeURIComponent(name)}`);
    $("timeline").hidden = false;
    renderTimeline();
    await selectStep(S.session.steps.length - 1);
    return;
  }
  S.session = null; S.stepIdx = -1; S.diff = null;
  $("timeline").hidden = true;
  stopPlay();
  await loadGraph(v, true);
}

async function loadGraph(at, refit) {
  S.at = at;
  let data = at !== "worktree" ? graphCache.get(at) : null;
  if (!data) {
    $("loading").hidden = false;
    try { data = await api(`/api/graph?at=${encodeURIComponent(at)}`); }
    catch (e) { $("loading").textContent = "Could not map this snapshot: " + e.message; return; }
    if (at !== "worktree") graphCache.set(at, data);
  }
  $("loading").hidden = true;
  const firstLoad = !S.data;
  S.data = data;
  S.tree = data.graph.tree;
  prepare();
  if (S.depth === 0 || firstLoad) S.depth = autoDepth();
  rebuild(refit || firstLoad);
}

// Live mode: while an agent works, new steps appear on their own.
async function pollLive() {
  if (!S.session || document.hidden) return;
  try {
    const meta = await api("/api/meta");
    const s = meta.sessions.find((x) => x.name === S.session.name);
    if (!s || s.steps === S.session.steps.length) return;
    const atEnd = S.stepIdx === S.session.steps.length - 1;
    S.session = await api(`/api/session?name=${encodeURIComponent(S.session.name)}`);
    renderTimeline();
    if (atEnd) await selectStep(S.session.steps.length - 1);
  } catch (e) { /* the server may have stopped; keep the current view */ }
}

// ---------------------------------------------------------------- model

function prepare() {
  const g = S.data.graph;
  const n = g.files.length;
  g.out = Array.from({ length: n }, () => []);
  g.in = Array.from({ length: n }, () => []);
  g.byPath = new Map(g.files.map((f, i) => [f.p, i]));
  for (const [a, b, w, t] of g.edges) {
    g.out[a].push({ to: b, w, t });
    g.in[b].push({ from: a, w, t });
  }
  const churn = S.data.churn || {};
  let max = 0;
  g.files.forEach((f) => { f.score = (churn[f.p] || 0) * (f.c + 1); f.commits = churn[f.p] || 0; max = Math.max(max, f.score); });
  g.maxScore = max;
}

const visibleFile = (f) => S.showTests || !f.t;

// groupKey decides which box a file belongs to at the current zoom level.
function groupKey(path) {
  const dir = dirOf(path);
  if (!S.focus) {
    if (dir === ".") return ".";
    return dir.split("/").slice(0, S.depth).join("/");
  }
  if (dir === S.focus) return "f:" + path;
  if (dir.startsWith(S.focus + "/")) return S.focus + "/" + dir.slice(S.focus.length + 1).split("/")[0];
  const levels = S.focus.split("/").length;
  return "o:" + (dir === "." ? "." : dir.split("/").slice(0, levels).join("/"));
}

function labelOf(key) {
  if (key === ".") return "(root files)";
  if (key.startsWith("f:")) return baseOf(key.slice(2));
  if (key.startsWith("o:")) return key === "o:." ? "(root files)" : key.slice(2) + "/";
  const base = S.focus ? key.slice(S.focus.length + 1) : key;
  return base + "/";
}

function autoDepth() {
  const files = S.data.graph.files.filter(visibleFile);
  const save = S.focus; S.focus = "";
  let best = 1;
  let prev = -1;
  for (let d = 1; d <= 8; d++) {
    S.depth = d;
    const count = new Set(files.map((f) => groupKey(f.p))).size;
    if (count > 60) break;
    best = d;
    if (count >= 10 || count === prev) break;
    prev = count;
  }
  S.focus = save;
  return best;
}

function buildModel() {
  const g = S.data.graph;
  const nodes = new Map();
  const fileGroup = new Array(g.files.length).fill(null);
  g.files.forEach((f, i) => {
    if (!visibleFile(f)) return;
    const key = groupKey(f.p);
    fileGroup[i] = key;
    let n = nodes.get(key);
    if (!n) {
      n = { key, label: labelOf(key), files: [], lines: 0, langs: {}, entry: false, score: 0,
        kind: key.startsWith("f:") ? "file" : key.startsWith("o:") ? "outside" : "dir" };
      nodes.set(key, n);
    }
    n.files.push(i);
    n.lines += f.n;
    n.langs[f.g] = (n.langs[f.g] || 0) + f.n;
    n.entry = n.entry || !!f.e;
    n.score = Math.max(n.score, f.score);
  });
  const edges = new Map();
  for (const [a, b, w, t] of g.edges) {
    const ka = fileGroup[a], kb = fileGroup[b];
    if (!ka || !kb || ka === kb) continue;
    if (t && !S.showTypes) continue;
    if (ka.startsWith("o:") && kb.startsWith("o:")) continue;
    const k = ka + "\u0000" + kb;
    const e = edges.get(k);
    if (e) { e.w += w; e.t = e.t && !!t; }
    else edges.set(k, { from: ka, to: kb, w, t: !!t });
  }
  // Outside groups are context: keep only those wired to the focus.
  if (S.focus) {
    const linked = new Set();
    for (const e of edges.values()) { linked.add(e.from); linked.add(e.to); }
    for (const k of [...nodes.keys()]) if (k.startsWith("o:") && !linked.has(k)) nodes.delete(k);
  }
  for (const n of nodes.values()) {
    n.lang = Object.entries(n.langs).sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  const model = { nodes, edges: [...edges.values()], fileGroup };
  markCycles(model);
  return model;
}

// Tarjan's algorithm over the group graph; type-only edges never form cycles.
function sccs(keys, edges, skip) {
  const adj = new Map(keys.map((k) => [k, []]));
  for (const e of edges) if (!skip(e) && adj.has(e.from) && adj.has(e.to)) adj.get(e.from).push(e.to);
  let index = 0;
  const idx = new Map(), low = new Map(), on = new Set(), stack = [], out = [];
  const visit = (root) => {
    const call = [[root, 0]];
    idx.set(root, index); low.set(root, index); index++; stack.push(root); on.add(root);
    while (call.length) {
      const top = call[call.length - 1];
      const [v] = top;
      const next = adj.get(v);
      if (top[1] < next.length) {
        const w = next[top[1]++];
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++; stack.push(w); on.add(w); call.push([w, 0]);
        } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
        continue;
      }
      if (low.get(v) === idx.get(v)) {
        const comp = [];
        let w;
        do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
        out.push(comp);
      }
      call.pop();
      if (call.length) { const p = call[call.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(v))); }
    }
  };
  for (const k of keys) if (!idx.has(k)) visit(k);
  return out;
}

function markCycles(model) {
  const comps = sccs([...model.nodes.keys()], model.edges, (e) => e.t);
  model.comp = new Map();
  comps.forEach((c, i) => c.forEach((k) => model.comp.set(k, i)));
  model.compSize = comps.map((c) => c.length);
  for (const e of model.edges) {
    e.cycle = !e.t && model.comp.get(e.from) === model.comp.get(e.to) && model.compSize[model.comp.get(e.from)] > 1;
  }
  for (const n of model.nodes.values()) n.cycle = model.compSize[model.comp.get(n.key)] > 1;
}

// ---------------------------------------------------------------- layout

// Layered layout: importers above the code they depend on, so the map
// reads top-down from entry points to foundations. Cycles are collapsed so
// their members share a layer.
function layout(model) {
  const keys = [...model.nodes.keys()];
  const nComp = model.compSize.length;
  const preds = Array.from({ length: nComp }, () => new Set());
  const succs = Array.from({ length: nComp }, () => new Set());
  const degree = new Map(keys.map((k) => [k, 0]));
  for (const e of model.edges) {
    degree.set(e.from, degree.get(e.from) + 1); degree.set(e.to, degree.get(e.to) + 1);
    // Type-only edges were left out of the cycle detection, so they must
    // not shape the layers either, or they would reintroduce loops.
    if (e.t) continue;
    const a = model.comp.get(e.from), b = model.comp.get(e.to);
    if (a !== b) { succs[a].add(b); preds[b].add(a); }
  }
  const rank = new Array(nComp).fill(0);
  const indeg = preds.map((p) => p.size);
  const queue = [];
  indeg.forEach((d, i) => { if (d === 0) queue.push(i); });
  while (queue.length) {
    const c = queue.shift();
    for (const s of succs[c]) {
      rank[s] = Math.max(rank[s], rank[c] + 1);
      if (--indeg[s] === 0) queue.push(s);
    }
  }
  const connected = keys.filter((k) => degree.get(k) > 0);
  const isolated = keys.filter((k) => degree.get(k) === 0).sort();
  const layers = [];
  for (const k of connected) {
    const r = rank[model.comp.get(k)];
    (layers[r] ||= []).push(k);
  }
  for (let r = 0; r < layers.length; r++) layers[r] ||= [];
  layers.forEach((l) => l.sort());

  // Barycenter ordering to reduce crossings.
  const pos = new Map();
  const setPos = () => layers.forEach((l) => l.forEach((k, i) => pos.set(k, (i + 0.5) / l.length)));
  setPos();
  const nb = { up: new Map(), down: new Map() };
  for (const k of keys) { nb.up.set(k, []); nb.down.set(k, []); }
  for (const e of model.edges) { nb.down.get(e.from).push(e.to); nb.up.get(e.to).push(e.from); }
  const avg = (list, fallback) => {
    const xs = list.filter((k) => pos.has(k)).map((k) => pos.get(k));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : fallback;
  };
  for (let it = 0; it < 8; it++) {
    const dir = it % 2 === 0 ? "up" : "down";
    const order = dir === "up" ? layers : [...layers].reverse();
    for (const l of order) {
      const key = new Map(l.map((k) => [k, avg(nb[dir].get(k), pos.get(k))]));
      l.sort((a, b) => key.get(a) - key.get(b));
      l.forEach((k, i) => pos.set(k, (i + 0.5) / l.length));
    }
  }

  // Wrap very wide layers into rows, then place everything.
  const W = (n) => Math.min(250, Math.max(140, n.label.length * 7.2 + 44));
  const H = 50, GAP_X = 26, ROW_GAP = 34, LAYER_GAP = 74, PER_ROW = 9;
  const boxes = new Map();
  let y = 0;
  const rows = [];
  layers.forEach((l, r) => {
    for (let i = 0; i < l.length; i += PER_ROW) rows.push({ keys: l.slice(i, i + PER_ROW), layer: r, first: i === 0 });
  });
  if (isolated.length) {
    for (let i = 0; i < isolated.length; i += PER_ROW) rows.push({ keys: isolated.slice(i, i + PER_ROW), layer: -1, first: i === 0 });
  }
  let maxW = 0;
  rows.forEach((row, ri) => {
    if (ri > 0) y += row.first ? LAYER_GAP : ROW_GAP;
    const widths = row.keys.map((k) => W(model.nodes.get(k)));
    const total = widths.reduce((a, b) => a + b, 0) + GAP_X * (row.keys.length - 1);
    maxW = Math.max(maxW, total);
    let x = -total / 2;
    row.keys.forEach((k, i) => {
      boxes.set(k, { x, y, w: widths[i], h: H, layer: row.layer });
      x += widths[i] + GAP_X;
    });
    row.y = y;
    y += H;
  });
  return { boxes, rows, width: maxW, height: y };
}

// ---------------------------------------------------------------- render

function rebuild(refit) {
  S.model = buildModel();
  S.layout = layout(S.model);
  render();
  renderCrumbs();
  renderLegend();
  renderPanel();
  $("depth-label").textContent = S.focus ? "drilled in" : `depth ${S.depth}`;
  if (refit) fit();
}

function highlightSets() {
  const g = S.data.graph;
  const changed = new Set();
  if (S.session && S.stepIdx > 0) {
    for (const c of S.session.steps[S.stepIdx].changes) if (g.byPath.has(c.path)) changed.add(c.path);
  }
  const sources = S.manualImpact ? [S.manualImpact] : [...changed];
  const impacted = impactOf(sources);
  return { changed, impacted };
}

function impactOf(paths) {
  const g = S.data.graph;
  const dist = new Map();
  const queue = [];
  for (const p of paths) { const i = g.byPath.get(p); if (i !== undefined) { dist.set(i, 0); queue.push(i); } }
  while (queue.length) {
    const v = queue.shift();
    for (const { from } of g.in[v]) if (!dist.has(from)) { dist.set(from, dist.get(v) + 1); queue.push(from); }
  }
  const out = new Map();
  for (const [i, d] of dist) if (d > 0) out.set(g.files[i].p, d);
  return out;
}

function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

function render() {
  const vp = $("viewport");
  vp.textContent = "";
  const { boxes } = S.layout;
  const g = S.data.graph;
  const { changed, impacted } = highlightSets();
  const nodeChanged = new Map(), nodeImpacted = new Set();
  for (const p of changed) { const k = S.model.fileGroup[g.byPath.get(p)]; if (k) nodeChanged.set(k, (nodeChanged.get(k) || 0) + 1); }
  for (const p of impacted.keys()) { const k = S.model.fileGroup[g.byPath.get(p)]; if (k) nodeImpacted.add(k); }
  const newPairs = newEdgePairs();
  const sel = selectedGroup();
  const neighbors = new Set(sel ? [sel] : []);
  if (sel) for (const e of S.model.edges) { if (e.from === sel) neighbors.add(e.to); if (e.to === sel) neighbors.add(e.from); }

  const edgeLayer = el("g", {}, vp);
  for (const e of S.model.edges) {
    const a = boxes.get(e.from), b = boxes.get(e.to);
    if (!a || !b) continue;
    const isNew = newPairs.has(e.from + "\u0000" + e.to);
    const hot = nodeChanged.has(e.to) && (nodeImpacted.has(e.from) || nodeChanged.has(e.from));
    let cls = "edge";
    if (e.t) cls += " type";
    if (e.cycle) cls += " cycle";
    if (hot) cls += " hot";
    if (isNew) cls += " new";
    if (sel) cls += e.from === sel || e.to === sel ? " focus" : " dim";
    const marker = e.cycle ? "arrow-cycle" : hot || isNew ? "arrow-hot" : "arrow";
    const path = el("path", { d: edgePath(a, b), class: cls, "marker-end": `url(#${marker})` }, edgeLayer);
    el("title", {}, path).textContent = `${labelOf(e.from)} → ${labelOf(e.to)} · ${plural(e.w, "reference")}${e.t ? " (types only)" : ""}${e.cycle ? " · part of a cycle" : ""}`;
  }

  const nodeLayer = el("g", {}, vp);
  for (const [key, n] of S.model.nodes) {
    const b = boxes.get(key);
    let cls = "node";
    if (n.kind === "outside") cls += " outside";
    if (n.cycle) cls += " cycle";
    if (nodeChanged.has(key)) cls += " changed";
    else if (nodeImpacted.has(key)) cls += " impacted";
    if (key === sel) cls += " selected";
    if (sel && !neighbors.has(key)) cls += " dim";
    const gEl = el("g", { class: cls, transform: `translate(${b.x},${b.y})`, tabindex: 0, role: "button", "data-key": key }, nodeLayer);
    el("rect", { class: "box", width: b.w, height: b.h, rx: 8 }, gEl);
    if (S.heat && n.score > 0 && g.maxScore > 0) {
      el("rect", { width: b.w, height: b.h, rx: 8, fill: "var(--cycle)", opacity: (0.08 + 0.5 * n.score / g.maxScore).toFixed(2), "pointer-events": "none" }, gEl);
    }
    el("rect", { class: "lang", x: 0, y: 8, width: 4, height: b.h - 16, rx: 2, fill: `var(--lang-${n.lang || "go"})` }, gEl);
    const title = el("text", { x: 14, y: 21 }, gEl);
    title.textContent = truncate(n.label, Math.floor((b.w - 34) / 7));
    const sub = el("text", { x: 14, y: 38, class: "sub" }, gEl);
    sub.textContent = n.kind === "file" ? `${fmtN(n.lines)} lines` : `${plural(n.files.length, "file")} · ${fmtN(n.lines)} lines`;
    if (n.entry) el("circle", { class: "entry", cx: b.w - 12, cy: 14, r: 4 }, gEl).appendChild(document.createElementNS(NS, "title")).textContent = "Contains an entry point";
    const c = nodeChanged.get(key);
    if (c) {
      const bw = 14 + String(c).length * 6; // bubble sits on the top-right corner, left of the entry dot
      el("rect", { class: "badge", x: b.w - bw - 18, y: -8, width: bw, height: 16, rx: 8 }, gEl);
      const t = el("text", { class: "badge-text", x: b.w - bw / 2 - 18, y: 4, "text-anchor": "middle" }, gEl);
      t.textContent = c;
    }
    el("title", {}, gEl).textContent = (n.kind === "outside" ? "Outside this folder: " : "") + key.replace(/^[fo]:/, "");
  }
  applyView();
}

function edgePath(a, b) {
  const sx = a.x + a.w / 2, tx = b.x + b.w / 2;
  if (b.y > a.y + a.h / 2) { // downward: bottom of source to top of target
    const sy = a.y + a.h, ty = b.y - 3, dy = Math.max(28, (ty - sy) / 2);
    return `M${sx},${sy} C${sx},${sy + dy} ${tx},${ty - dy} ${tx},${ty}`;
  }
  if (Math.abs(b.y - a.y) < 1) { // same row: arc over the top
    const sy = a.y, ty = b.y - 3, lift = 30 + Math.abs(tx - sx) * 0.12;
    return `M${sx},${sy} C${sx},${sy - lift} ${tx},${ty - lift} ${tx},${ty}`;
  }
  // upward (only inside cycles or wrapped rows): leave from the side
  const sy = a.y + a.h / 2, ty = b.y + b.h + 3;
  const side = tx >= sx ? 1 : -1;
  return `M${a.x + (side > 0 ? a.w : 0)},${sy} C${sx + side * 120},${sy} ${tx},${ty + 60} ${tx},${ty}`;
}

const truncate = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);

function selectedGroup() {
  if (!S.selected) return null;
  if (S.selected.kind === "group") return S.selected.id;
  const i = S.data.graph.byPath.get(S.selected.id);
  return i === undefined ? null : S.model.fileGroup[i];
}

// Map the step's new directory dependencies onto the boxes on screen.
function newEdgePairs() {
  const pairs = new Set();
  if (!S.diff) return pairs;
  const keyOfDir = (d) => groupKey(d === "." ? "x" : d + "/x");
  for (const [a, b] of S.diff.addedDeps) {
    const ka = keyOfDir(a), kb = keyOfDir(b);
    if (ka !== kb) pairs.add(ka + "\u0000" + kb);
  }
  return pairs;
}

// ---------------------------------------------------------------- pan & zoom

function applyView() {
  const { x, y, k } = S.view;
  $("viewport").setAttribute("transform", `translate(${x},${y}) scale(${k})`);
}

function fit() {
  const svg = $("map");
  const r = svg.getBoundingClientRect();
  const L = S.layout;
  if (!L || !r.width) return;
  const pad = 60;
  const minX = -L.width / 2, w = L.width, h = L.height;
  const k = Math.min(1.4, Math.max(0.15, Math.min((r.width - pad * 2) / Math.max(w, 1), (r.height - pad * 2 - 30) / Math.max(h, 1))));
  S.view = { k, x: r.width / 2 - (minX + w / 2) * k, y: pad + 20 + Math.max(0, (r.height - pad * 2 - 30 - h * k) / 2) };
  applyView();
}

function setupPanZoom() {
  const svg = $("map");
  let drag = null;
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k2 = Math.min(3, Math.max(0.1, S.view.k * Math.exp(-e.deltaY * 0.0015)));
    S.view.x = mx - (mx - S.view.x) * (k2 / S.view.k);
    S.view.y = my - (my - S.view.y) * (k2 / S.view.k);
    S.view.k = k2;
    applyView();
  }, { passive: false });
  svg.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".node")) return;
    drag = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y, moved: false };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("panning");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    S.view.x = drag.vx + dx; S.view.y = drag.vy + dy;
    applyView();
  });
  svg.addEventListener("pointerup", (e) => {
    if (drag && !drag.moved && !e.target.closest(".node")) { S.selected = null; S.manualImpact = null; render(); renderPanel(); }
    drag = null;
    svg.classList.remove("panning");
  });
  // Selecting redraws the map, so the browser's own dblclick never reaches
  // the new node; detect the second click by key and time instead.
  let last = { key: null, at: 0 };
  svg.addEventListener("click", (e) => {
    const node = e.target.closest(".node");
    if (!node) return;
    const key = node.dataset.key;
    if (last.key === key && e.timeStamp - last.at < 400) { last = { key: null, at: 0 }; open(key); return; }
    last = { key, at: e.timeStamp };
    selectGroup(key);
  });
  svg.addEventListener("keydown", (e) => {
    const node = e.target.closest(".node");
    if (node && e.key === "Enter") open(node.dataset.key);
    if (node && e.key === " ") { e.preventDefault(); selectGroup(node.dataset.key); }
  });
  window.addEventListener("resize", () => fit());
}

function selectGroup(key) {
  if (key.startsWith("f:")) S.selected = { kind: "file", id: key.slice(2) };
  else S.selected = { kind: "group", id: key };
  S.manualImpact = null;
  render();
  renderPanel();
}

function open(key) {
  if (key.startsWith("f:")) { selectFile(key.slice(2)); return; }
  drill(key.startsWith("o:") ? key.slice(2) : key);
}

function drill(dir) {
  S.focus = dir === "." ? "" : dir;
  S.selected = null;
  S.manualImpact = null;
  rebuild(true);
}

function selectFile(path, line) {
  S.selected = { kind: "file", id: path, line };
  S.manualImpact = null;
  render();
  renderPanel();
}

// ---------------------------------------------------------------- chrome

function renderCrumbs() {
  const c = $("crumbs");
  const parts = S.focus ? S.focus.split("/") : [];
  let html = `<button data-dir=".">${esc(S.meta.root)}</button>`;
  parts.forEach((p, i) => {
    html += `<span>/</span><button data-dir="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</button>`;
  });
  c.innerHTML = html;
  c.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => drill(b.dataset.dir)));
}

function renderLegend() {
  const langs = new Set([...S.model.nodes.values()].map((n) => n.lang).filter(Boolean));
  let html = [...langs].map((l) => `<span><i style="background:var(--lang-${l})"></i>${LANGS[l]}</span>`).join("");
  html += `<span><i style="background:var(--entry);border-radius:50%"></i>entry point</span>`;
  if (S.model.edges.some((e) => e.cycle)) html += `<span><i style="background:var(--cycle)"></i>cycle</span>`;
  if (S.session && S.stepIdx > 0) html += `<span><i style="background:var(--agent)"></i>changed in step</span><span><i style="background:var(--impact)"></i>depends on the change</span>`;
  html += `<span>arrows point to what is imported</span>`;
  $("legend").innerHTML = html;
}

// ---------------------------------------------------------------- panel

function renderPanel() {
  const p = $("panel");
  let html = "";
  if (S.session && S.stepIdx >= 0) html += stepSection();
  if (!S.selected) html += overview();
  else if (S.selected.kind === "group") html += groupPanel(S.selected.id);
  else html += filePanel(S.selected.id);
  p.innerHTML = html;
  p.querySelectorAll("[data-file]").forEach((x) => x.addEventListener("click", () => selectFile(x.dataset.file, +x.dataset.line || undefined)));
  p.querySelectorAll("[data-group]").forEach((x) => x.addEventListener("click", () => selectGroup(x.dataset.group)));
  p.querySelectorAll("[data-drill]").forEach((x) => x.addEventListener("click", () => drill(x.dataset.drill)));
  p.querySelectorAll("[data-impact]").forEach((x) => x.addEventListener("click", () => {
    S.manualImpact = S.manualImpact === x.dataset.impact ? null : x.dataset.impact;
    render(); renderPanel();
  }));
  if (S.selected?.kind === "file" && S.data.graph.byPath.has(S.selected.id)) loadCode(S.selected.id, S.selected.line);
}

function fileRow(path, meta, line) {
  return `<li data-file="${esc(path)}"${line ? ` data-line="${line}"` : ""}><span class="name" title="${esc(path)}">${esc(path)}</span>${meta ? `<span class="meta">${meta}</span>` : ""}</li>`;
}

function overview() {
  const g = S.data.graph;
  const files = g.files.filter(visibleFile);
  const lines = files.reduce((a, f) => a + f.n, 0);
  const byLang = {};
  files.forEach((f) => (byLang[f.g] = (byLang[f.g] || 0) + f.n));
  const langs = Object.entries(byLang).sort((a, b) => b[1] - a[1]);
  const label = S.session ? `step ${S.session.steps[S.stepIdx].step} of ${S.session.name}` : S.at === "HEAD" ? "last commit" : "working tree";

  let html = `<h2>${esc(S.meta.root)}</h2><div class="sub">${esc(label)} · mapped in ${S.data.elapsed} ms</div>`;
  html += `<div class="tiles"><div class="tile"><b>${fmtN(files.length)}</b><span>files</span></div>
    <div class="tile"><b>${fmtN(lines)}</b><span>lines</span></div>
    <div class="tile"><b>${fmtN(g.edges.length)}</b><span>dependencies</span></div></div>`;
  html += `<div class="langbar">${langs.map(([l, n]) => `<span style="width:${(100 * n / Math.max(lines, 1)).toFixed(2)}%;background:var(--lang-${l})" title="${LANGS[l]}"></span>`).join("")}</div>`;
  html += `<div class="langkeys">${langs.map(([l, n]) => `<span><i style="background:var(--lang-${l})"></i>${LANGS[l]} ${Math.round(100 * n / Math.max(lines, 1))}%</span>`).join("")}</div>`;

  const entries = files.filter((f) => f.e).slice(0, 8);
  html += `<h3>Start here <small>entry points</small></h3>`;
  html += entries.length ? `<ul class="list">${entries.map((f) => fileRow(f.p, `${fmtN(f.n)} lines`)).join("")}</ul>` : `<p class="empty">No entry points found (no main, __main__, or package.json bin).</p>`;

  const cycles = S.data.cycles;
  html += `<h3>Cycles <small>${cycles.length ? plural(cycles.length, "cycle") : "none"}</small></h3>`;
  if (cycles.length) {
    html += `<ul class="list">${cycles.slice(0, 10).map((c) => {
      const first = c.members[0];
      const attr = c.level === "file" ? `data-file="${esc(first)}"` : `data-drill="${esc(first)}"`;
      return `<li ${attr}><span class="pill warn">${c.level === "file" ? "import" : "folder"}</span><span class="name" title="${esc(c.members.join(" ↔ "))}">${esc(c.members.map(baseOf).join(" ↔ "))}</span></li>`;
    }).join("")}</ul>`;
  } else html += `<p class="empty">No import cycles between files or folders.</p>`;

  const hot = files.filter((f) => f.score > 0 && !f.t).sort((a, b) => b.score - a.score).slice(0, 8);
  html += `<h3>Hotspots <small>commits × complexity, last year</small></h3>`;
  html += hot.length ? `<ul class="list">${hot.map((f) => fileRow(f.p, `${f.commits}× · cx ${f.c}`)).join("")}</ul>` : `<p class="empty">No commit history to rank by yet.</p>`;

  const fanIn = files.map((f) => [f, g.in[g.byPath.get(f.p)].length]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  html += `<h3>Most depended on</h3>`;
  html += fanIn.length ? `<ul class="list">${fanIn.map(([f, n]) => fileRow(f.p, `used by ${n}`)).join("")}</ul>` : `<p class="empty">No internal dependencies found.</p>`;

  const ext = {};
  g.files.forEach((f) => (f.x || []).forEach((x) => (ext[x] = (ext[x] || 0) + 1)));
  const top = Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 12);
  html += `<h3>External packages <small>${Object.keys(ext).length} total</small></h3>`;
  html += top.length ? `<ul class="list">${top.map(([x, n]) => `<li class="static"><span class="name">${esc(x)}</span><span class="meta">${plural(n, "file")}</span></li>`).join("")}</ul>` : `<p class="empty">No third-party imports.</p>`;
  html += `<p class="empty" style="margin-top:18px">Click a box for details, double-click to open it. Arrows point from the importer to what it imports.</p>`;
  return html;
}

function groupPanel(key) {
  const n = S.model.nodes.get(key);
  if (!n) return overview();
  const g = S.data.graph;
  const dir = key.replace(/^o:/, "");
  const outs = S.model.edges.filter((e) => e.from === key).sort((a, b) => b.w - a.w);
  const ins = S.model.edges.filter((e) => e.to === key).sort((a, b) => b.w - a.w);
  const files = [...n.files].sort((a, b) => g.in[b].length - g.in[a].length || g.files[a].p.localeCompare(g.files[b].p));
  let html = `<h2>${esc(n.label)}</h2><div class="sub">${esc(dir === "." ? "files at the repository root" : dir)}</div>`;
  if (n.cycle) html += `<p><span class="pill warn">cycle</span> This folder is part of a dependency cycle.</p>`;
  html += `<div class="tiles"><div class="tile"><b>${n.files.length}</b><span>files</span></div>
    <div class="tile"><b>${fmtN(n.lines)}</b><span>lines</span></div>
    <div class="tile"><b>${ins.length}/${outs.length}</b><span>used by / uses</span></div></div>`;
  if (dir !== "." && n.kind !== "file") html += `<div class="actions"><button data-drill="${esc(dir)}">Open folder</button></div>`;
  html += `<h3>Files</h3><ul class="list">${files.slice(0, 80).map((i) => fileRow(g.files[i].p, `${fmtN(g.files[i].n)} · used by ${g.in[i].length}`)).join("")}</ul>`;
  if (files.length > 80) html += `<p class="empty">…and ${files.length - 80} more.</p>`;
  const groupRow = (k, w) => `<li data-group="${esc(k)}"><span class="name">${esc(labelOf(k))}</span><span class="meta">${plural(w, "ref")}</span></li>`;
  html += `<h3>Uses</h3>` + (outs.length ? `<ul class="list">${outs.map((e) => groupRow(e.to, e.w)).join("")}</ul>` : `<p class="empty">Nothing else in the repository.</p>`);
  html += `<h3>Used by</h3>` + (ins.length ? `<ul class="list">${ins.map((e) => groupRow(e.from, e.w)).join("")}</ul>` : `<p class="empty">Nothing in the repository imports this.</p>`);
  return html;
}

function filePanel(path) {
  const g = S.data.graph;
  const i = g.byPath.get(path);
  if (i === undefined) return `<h2>${esc(baseOf(path))}</h2><p class="empty">This file is not in the selected snapshot.</p>`;
  const f = g.files[i];
  const imp = impactOf([path]);
  let html = `<h2>${esc(baseOf(path))}</h2><div class="sub">${esc(path)}</div><p>`;
  html += `<span class="pill">${LANGS[f.g]}</span> `;
  if (f.e) html += `<span class="pill entry">entry point</span> `;
  if (f.t) html += `<span class="pill">test</span> `;
  if (f.commits) html += `<span class="pill">${plural(f.commits, "commit")} this year</span>`;
  html += `</p><div class="tiles"><div class="tile"><b>${fmtN(f.n)}</b><span>lines</span></div>
    <div class="tile"><b>${f.c}</b><span>complexity</span></div>
    <div class="tile"><b>${imp.size}</b><span>depend on it</span></div></div>`;
  html += `<div class="actions"><button data-impact="${esc(path)}">${S.manualImpact === path ? "Hide impact" : "Show impact on map"}</button>`;
  html += `<button data-drill="${esc(dirOf(path))}">Open its folder</button></div>`;
  const syms = f.s || [];
  html += `<h3>Defines <small>${plural(syms.length, "symbol")}</small></h3>`;
  html += syms.length ? `<ul class="list">${syms.slice(0, 120).map((s) => `<li data-file="${esc(path)}" data-line="${s.l}"><span class="pill">${esc(s.k)}</span><span class="name">${esc(s.n)}</span><span class="meta">:${s.l}</span></li>`).join("")}</ul>` : `<p class="empty">No top-level definitions.</p>`;
  const outs = g.out[i].map((e) => g.files[e.to].p).sort();
  const ins = g.in[i].map((e) => g.files[e.from].p).sort();
  html += `<h3>Imports <small>${outs.length}</small></h3>` + (outs.length ? `<ul class="list">${outs.map((p) => fileRow(p)).join("")}</ul>` : `<p class="empty">No files in this repository.</p>`);
  html += `<h3>Imported by <small>${ins.length}</small></h3>` + (ins.length ? `<ul class="list">${ins.map((p) => fileRow(p)).join("")}</ul>` : `<p class="empty">Nothing imports this file${f.e ? " (it is an entry point)" : ""}.</p>`);
  if ((f.x || []).length) html += `<h3>External</h3><ul class="list">${f.x.map((x) => `<li class="static"><span class="name">${esc(x)}</span></li>`).join("")}</ul>`;
  if (imp.size) {
    const rows = [...imp.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, 30);
    html += `<h3>Impact <small>who breaks if this changes</small></h3><ul class="list">${rows.map(([p, d]) => fileRow(p, d === 1 ? "direct" : `${d} hops`)).join("")}</ul>`;
  }
  html += `<h3>Source</h3><pre class="code" id="code"><span class="l">Loading…</span></pre>`;
  return html;
}

let codeToken = 0;
async function loadCode(path, line) {
  const token = ++codeToken;
  let text;
  try { text = await api(`/api/file?at=${encodeURIComponent(S.tree)}&path=${encodeURIComponent(path)}`); }
  catch (e) { text = "Could not load the file: " + e.message; }
  const pre = $("code");
  if (!pre || token !== codeToken) return;
  const lines = String(text).split("\n");
  if (lines.length > 4000) lines.length = 4000;
  pre.innerHTML = lines.map((l, i) => `<span class="l${i + 1 === line ? " hl" : ""}">${esc(l) || " "}</span>`).join("");
  if (line) {
    const target = pre.children[line - 1];
    if (target) pre.scrollTop = target.offsetTop - pre.clientHeight / 3;
  }
}

function stepSection() {
  const st = S.session.steps[S.stepIdx];
  let html = `<h2>Step ${st.step} <span class="pill agent">${esc(st.kind)}</span></h2><div class="sub">${esc(st.summary)} · ${new Date(st.time * 1000).toLocaleTimeString()}</div>`;
  if (st.prompt) html += `<h3>Prompt</h3><div class="prompt">${esc(st.prompt)}</div>`;
  if (S.stepIdx > 0) {
    html += `<h3>Changed <small>${plural(st.changes.length, "file")}</small></h3>`;
    html += st.changes.length ? `<ul class="list">${st.changes.map((c) => `<li data-file="${esc(c.path)}"><span class="name" title="${esc(c.path)}">${esc(c.path)}</span><span class="meta change">${c.added < 0 ? "binary" : `<span class="plus">+${c.added}</span> <span class="minus">-${c.deleted}</span>`}</span></li>`).join("")}</ul>` : `<p class="empty">No file changes.</p>`;
    const d = S.diff;
    if (d) {
      const items = [];
      d.newCycles.forEach((c) => items.push(`<li class="static"><span class="pill warn">new cycle</span><span class="name" title="${esc(c.members.join(" ↔ "))}">${esc(c.members.map(baseOf).join(" ↔ "))}</span></li>`));
      d.addedDeps.forEach(([a, b]) => items.push(`<li class="static"><span class="pill agent">+ dep</span><span class="name">${esc(a)} → ${esc(b)}</span></li>`));
      d.removedDeps.forEach(([a, b]) => items.push(`<li class="static"><span class="pill">− dep</span><span class="name">${esc(a)} → ${esc(b)}</span></li>`));
      d.addedExternal.forEach((x) => items.push(`<li class="static"><span class="pill agent">+ package</span><span class="name">${esc(x)}</span></li>`));
      d.addedFiles.forEach((p) => items.push(`<li data-file="${esc(p)}"><span class="pill">new file</span><span class="name">${esc(p)}</span></li>`));
      d.removedFiles.forEach((p) => items.push(`<li class="static"><span class="pill">deleted</span><span class="name">${esc(p)}</span></li>`));
      html += `<h3>Structure</h3>` + (items.length ? `<ul class="list">${items.join("")}</ul>` : `<p class="empty">No change to how the code fits together.</p>`);
    }
    const { impacted } = highlightSets();
    if (!S.manualImpact) {
      html += `<h3>Impact <small>${plural(impacted.size, "file")} depend on this step</small></h3>`;
      if (impacted.size) {
        const rows = [...impacted.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, 12);
        html += `<ul class="list">${rows.map(([p, dd]) => fileRow(p, dd === 1 ? "direct" : `${dd} hops`)).join("")}</ul>`;
      }
    }
  }
  return html + `<hr style="border:0;border-top:1px solid var(--line);margin:18px 0 8px">`;
}

// ---------------------------------------------------------------- timeline

function renderTimeline() {
  const track = $("tl-track");
  const steps = S.session.steps;
  let lastPrompt = null;
  track.innerHTML = steps.map((st, i) => {
    const lines = st.changes.reduce((a, c) => a + Math.max(0, c.added) + Math.max(0, c.deleted), 0);
    const h = Math.round(10 + Math.min(26, Math.log2(1 + lines) * 3.2));
    const newPrompt = st.prompt && st.prompt !== lastPrompt;
    if (st.prompt) lastPrompt = st.prompt;
    const d = diffCache.get(st.tree);
    const warn = d && d.newCycles.length ? " warn" : "";
    return `<div class="tick ${esc(st.kind)}${newPrompt && i > 0 ? " prompt-start" : ""}${warn}" style="height:${h}px" role="option" data-i="${i}" aria-selected="${i === S.stepIdx}" title="Step ${st.step}: ${esc(st.summary)}"></div>`;
  }).join("");
  track.querySelectorAll(".tick").forEach((t) => t.addEventListener("click", () => { stopPlay(); selectStep(+t.dataset.i); }));
}

async function selectStep(i) {
  const steps = S.session.steps;
  i = Math.max(0, Math.min(steps.length - 1, i));
  S.stepIdx = i;
  const st = steps[i];
  S.manualImpact = null;
  S.diff = null;
  $("tl-title").innerHTML = `<b>${esc(S.session.name)}</b> · step ${st.step}/${steps[steps.length - 1].step} · ${esc(st.summary)}`;
  $("tl-track").querySelectorAll(".tick").forEach((t) => t.setAttribute("aria-selected", String(+t.dataset.i === i)));
  $("tl-track").querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (i > 0) {
    const key = st.tree;
    if (!diffCache.has(key)) {
      try { diffCache.set(key, await api(`/api/diff?from=${steps[i - 1].tree}&to=${st.tree}`)); } catch (e) { /* show the step without it */ }
    }
    S.diff = diffCache.get(key) || null;
    if (S.diff?.newCycles.length) $("tl-track").querySelector(`[data-i="${i}"]`)?.classList.add("warn");
  }
  await loadGraph(st.tree, false);
}

let playTimer = null;
function stopPlay() { clearInterval(playTimer); playTimer = null; $("tl-play").textContent = "▶"; }
function togglePlay() {
  if (playTimer) { stopPlay(); return; }
  if (S.stepIdx >= S.session.steps.length - 1) selectStep(0);
  $("tl-play").textContent = "❚❚";
  playTimer = setInterval(async () => {
    if (S.stepIdx >= S.session.steps.length - 1) { stopPlay(); return; }
    await selectStep(S.stepIdx + 1);
  }, 1100);
}

// ---------------------------------------------------------------- search

function setupSearch() {
  const input = $("search"), list = $("results");
  let items = [], active = 0;
  const run = () => {
    const q = input.value.trim().toLowerCase();
    if (!q || !S.data) { list.hidden = true; return; }
    const g = S.data.graph;
    const scored = [];
    g.files.forEach((f) => {
      const b = baseOf(f.p).toLowerCase(), p = f.p.toLowerCase();
      const s = b.startsWith(q) ? 0 : b.includes(q) ? 1 : p.includes(q) ? 2 : -1;
      if (s >= 0) scored.push({ s, kind: "file", label: baseOf(f.p), path: f.p });
      for (const sym of f.s || []) {
        const n = sym.n.toLowerCase();
        const t = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 3 : -1;
        if (t >= 0) scored.push({ s: t + 0.5, kind: sym.k, label: sym.n, path: f.p, line: sym.l });
      }
    });
    scored.sort((a, b) => a.s - b.s || a.label.length - b.label.length);
    items = scored.slice(0, 30);
    active = 0;
    list.innerHTML = items.length
      ? items.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === 0}"><span class="k">${esc(it.kind)}</span><span>${esc(it.label)}</span><span class="p">${esc(it.path)}</span></li>`).join("")
      : `<li class="static"><span class="p">No matches</span></li>`;
    list.hidden = false;
    list.querySelectorAll("[data-i]").forEach((li) => li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(+li.dataset.i); }));
  };
  const pick = (i) => {
    const it = items[i];
    if (!it) return;
    list.hidden = true;
    input.value = "";
    input.blur();
    const dir = dirOf(it.path);
    if (S.focus && dir !== S.focus && !dir.startsWith(S.focus + "/")) { S.focus = ""; rebuild(false); }
    selectFile(it.path, it.line);
  };
  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, Math.min(items.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
      list.querySelectorAll("[data-i]").forEach((li) => li.setAttribute("aria-selected", String(+li.dataset.i === active)));
    } else if (e.key === "Enter") pick(active);
    else if (e.key === "Escape") { input.value = ""; list.hidden = true; input.blur(); }
  });
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 100));
}

// ---------------------------------------------------------------- wiring

function setupControls() {
  const toggle = (id, key) => $(id).addEventListener("click", () => {
    S[key] = !S[key];
    $(id).setAttribute("aria-pressed", String(S[key]));
    rebuild(key === "showTests");
  });
  toggle("t-heat", "heat");
  toggle("t-tests", "showTests");
  toggle("t-types", "showTypes");
  $("depth-minus").addEventListener("click", () => { if (!S.focus && S.depth > 1) { S.depth--; rebuild(true); } });
  $("depth-plus").addEventListener("click", () => { if (!S.focus && S.depth < 10) { S.depth++; rebuild(true); } });
  $("fit").addEventListener("click", fit);
  $("tl-play").addEventListener("click", togglePlay);
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === "/") { e.preventDefault(); $("search").focus(); }
    else if (e.key === "f" || e.key === "F") fit();
    else if (e.key === "Escape" || e.key === "Backspace") {
      if (S.selected || S.manualImpact) { S.selected = null; S.manualImpact = null; render(); renderPanel(); }
      else if (S.focus) drill(S.focus.includes("/") ? S.focus.slice(0, S.focus.lastIndexOf("/")) : ".");
    } else if (S.session && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault(); stopPlay(); selectStep(S.stepIdx + (e.key === "ArrowRight" ? 1 : -1));
    }
  });
}

setupPanZoom();
setupSearch();
setupControls();
init().catch((e) => { $("loading").hidden = false; $("loading").textContent = "Could not start: " + e.message; });
