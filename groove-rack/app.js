/* Groove Rack — interface, transport and storage. */
(function () {
'use strict';
const GR = window.GR, TPB = GR.TPB, I = GR.INST;
const $ = (s, r) => (r || document).querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
};
const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  spk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg>',
  spkOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>'
};
const RES_LABEL = { 12: '1/8 triplet', 16: '1/16', 24: '1/16 triplet', 32: '1/32' };

/* ---------- state ---------- */
let P = null;
const ui = { group: 'drums', sel: null, bar: 0, follow: true, view: 'steps', rollOpen: true, folded: false, chord: 0, scaleOnly: false, metro: false, muted: false };
const hist = { undo: [], redo: [] };
const snap = () => JSON.stringify(P);
function commit() { hist.undo.push(snap()); if (hist.undo.length > 200) hist.undo.shift(); hist.redo.length = 0; }
function settle() { if (hist.undo.length && hist.undo[hist.undo.length - 1] === snap()) hist.undo.pop(); }
function edit(fn) { commit(); fn(); changed(); settle(); }
const track = id => P.tracks.find(t => t.id === id);
const selTrack = () => track(ui.sel);
const groupTracks = g => P.tracks.filter(t => t.group === g);
const other = g => (g === 'drums' ? 'audio' : 'drums');
const GROUP_NAME = { drums: 'Drums', audio: 'Audio' };

/* ---------- audio ---------- */
let ctx = null, mix = null;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    mix = GR.buildMix(ctx, true);
    GR.updateMix(mix, P, ui.muted);
  }
  return ctx;
}
function resume() {
  audio();
  if (ctx.state !== 'running') ctx.resume();
}
function audition(tr, note) {
  if (S.playing) return;
  resume();
  const s = mix.strips[tr.id] || (GR.updateMix(mix, P, ui.muted), mix.strips[tr.id]);
  const inst = I[tr.inst];
  const v = ctx.createGain(); v.connect(s.in);
  const p = note && note.p != null ? note.p : defaultPitch(tr);
  GR.voice(ctx, v, ctx.currentTime + 0.01, tr, { vel: note ? note.vel : 0.85, p, dur: inst.pitched ? 0.32 : 0.1, from: null });
}

/* ---------- transport ---------- */
const S = { playing: false, nextTick: 0, nextTime: 0, aTick: 0, aTime: 0, timer: 0, st: null, map: null };
function tickMap() { if (!S.map) S.map = GR.buildTickMap(P); return S.map; }
function play() {
  resume();
  S.st = GR.newState(); S.playing = true;
  S.nextTick = 0; S.nextTime = ctx.currentTime + 0.08; S.aTick = 0; S.aTime = S.nextTime;
  clearInterval(S.timer); S.timer = setInterval(sched, 25); sched();
  renderTransport();
}
function stop() {
  S.playing = false; clearInterval(S.timer);
  if (ctx && S.st) {
    const now = ctx.currentTime;
    S.st.voices.forEach(x => { if (x.end > now) { try { x.v.gain.cancelScheduledValues(now); x.v.gain.setTargetAtTime(0, now, 0.02); } catch (e) {} } });
  }
  renderTransport(); renderProgress();
}
function toggle() { S.playing ? stop() : play(); }
function seek(bar) {
  ui.bar = clamp(bar, 0, P.bars - 1);
  if (S.playing) {
    S.nextTick = ui.bar * TPB; S.nextTime = ctx.currentTime + 0.03; S.aTick = S.nextTick; S.aTime = S.nextTime;
  }
  renderRack(); renderRoll(); renderBarChip(); renderProgress(); renderPlaylistHead();
}
function sched() {
  if (!S.playing) return;
  const td = GR.tickDur(P), loopT = P.bars * TPB, map = tickMap(), now = ctx.currentTime, horizon = now + 0.12;
  if (S.nextTime < now - 0.25) {  // the tab slept: jump ahead instead of playing a burst
    const skip = Math.ceil((now - S.nextTime) / td); S.nextTick += skip; S.nextTime += skip * td; S.aTick = S.nextTick; S.aTime = S.nextTime;
  }
  while (S.nextTime < horizon) {
    const tick = S.nextTick % loopT, ev = map.get(tick);
    if (ev) {
      const t = S.nextTime + GR.swing(P, tick, td);
      ev.forEach(([tr, n]) => { const s = mix.strips[tr.id]; if (s) GR.playEvent(ctx, s.in, S.st, tr, n, t, td); });
    }
    if (ui.metro && tick % 24 === 0) metroClick(S.nextTime, tick % TPB === 0);
    S.nextTick++; S.nextTime += td;
  }
  if (S.st.voices.length > 400) S.st.voices = S.st.voices.filter(x => x.end > now);
}
function metroClick(t, down) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = down ? 1900 : 1300; o.type = 'square';
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.001); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  o.connect(g).connect(mix.master); o.start(t); o.stop(t + 0.05);
}
function pos() {
  if (!S.playing || !ctx) return null;
  const td = GR.tickDur(P), loopT = P.bars * TPB;
  const p = S.aTick + (ctx.currentTime - (ctx.outputLatency || 0) - S.aTime) / td;
  return ((p % loopT) + loopT) % loopT;
}
function setBpm(v) {
  v = clamp(Math.round(v * 10) / 10, 40, 240);
  if (S.playing) { S.aTick = S.nextTick; S.aTime = S.nextTime; }
  P.bpm = v;
}

/* ---------- change pipeline ---------- */
let saveT = 0;
function changed() {
  S.map = null;
  if (mix) GR.updateMix(mix, P, ui.muted);
  if (ui.bar >= P.bars) ui.bar = P.bars - 1;
  clearTimeout(saveT); saveT = setTimeout(autosave, 400);
  wavesSoon();
  renderAll();
}
function light(tr) {  // cheap update during a drag
  S.map = null;
  const lane = $(`#rackGrid .lane[data-id="${tr.id}"]`); if (lane) lane.innerHTML = laneInner(tr);
  if (!$('#roll').hidden) drawRollNotes();
}
function autosave() { store.set('groove-rack.current', snap()); }
function load(project, keepHistory) {
  P = sanitize(project);
  if (!keepHistory) { hist.undo.length = 0; hist.redo.length = 0; }
  if (!track(ui.sel)) { const g = groupTracks(ui.group); ui.sel = (g[0] || P.tracks[0] || {}).id || null; }
  if (!groupTracks(ui.group).length && P.tracks.length) ui.group = P.tracks[0].group;
  ui.bar = clamp(ui.bar, 0, P.bars - 1);
  waves.clear();
  loadSamples();
  changed();
}
function sanitize(p) {
  p = Object.assign(GR.emptyProject(), { tracks: [] }, p);
  p.bpm = clamp(+p.bpm || 120, 40, 240); p.bars = clamp(p.bars | 0 || 4, 1, 8); p.swing = clamp(+p.swing || 0, 0, 100);
  p.master = clamp(p.master == null ? 0.8 : +p.master, 0, 1); p.key = clamp(p.key | 0, 0, 11);
  if (!GR.SCALES[p.scale]) p.scale = 'minor';
  p.tracks = (p.tracks || []).filter(t => t && I[t.inst]).map(t => {
    const n = GR.newTrack(t.inst, t.sound, t);
    if (!I[n.inst].sounds[n.sound]) n.sound = I[n.inst].def;
    if (![12, 16, 24, 32].includes(n.res)) n.res = 16;
    n.notes = (t.notes || []).filter(x => x && isFinite(x.t)).map(x => Object.assign({}, x));
    return n;
  });
  return p;
}
function undo() {
  if (!hist.undo.length) return toast('Nothing to undo');
  hist.redo.push(snap()); P = JSON.parse(hist.undo.pop()); afterHistory(); toast('Undone');
}
function redo() {
  if (!hist.redo.length) return toast('Nothing to redo');
  hist.undo.push(snap()); P = JSON.parse(hist.redo.pop()); afterHistory(); toast('Redone');
}
function afterHistory() {
  if (!track(ui.sel)) ui.sel = (P.tracks[0] || {}).id || null;
  changed();
}

/* ---------- notes ---------- */
function defaultPitch(tr) {
  if (tr.lastP != null) return tr.lastP;
  const I0 = I[tr.inst];
  if (!I0.pitched) return 60;
  return nearestInScale((tr.low != null ? tr.low : I0.base) + 12);
}
function inScale(m) { return GR.SCALES[P.scale].includes(((m - P.key) % 12 + 12) % 12); }
function nearestInScale(m) { for (let d = 0; d < 12; d++) { if (inScale(m - d)) return m - d; } return m; }
function sortNotes(tr) { tr.notes.sort((a, b) => a.t - b.t || (a.p || 0) - (b.p || 0)); }
function addNote(tr, t, extra) {
  const stepT = TPB / tr.res, inst = I[tr.inst];
  const n = inst.pitched ? Object.assign({ t, p: defaultPitch(tr), len: tr.lastLen || stepT * 2, vel: 0.85 }, extra) : Object.assign({ t, vel: 0.9 }, extra);
  tr.notes.push(n); sortNotes(tr); return n;
}
function removeNote(tr, n) { const i = tr.notes.indexOf(n); if (i >= 0) tr.notes.splice(i, 1); }
function stepNotes(tr, bar, step) {
  const stepT = TPB / tr.res, a = bar * TPB + step * stepT;
  if (I[tr.inst].pitched) return tr.notes.filter(n => n.t < a + stepT && n.t + (n.len || stepT) > a);
  return tr.notes.filter(n => n.t >= a && n.t < a + stepT);
}
function chordFrom(p, size) {
  if (!size) return [p];
  const sc = GR.SCALES[P.scale], rel = ((p - P.key) % 12 + 12) % 12, idx = sc.indexOf(rel);
  if (idx < 0 || sc.length < 7) return size === 3 ? [p, p + 4, p + 7] : [p, p + 4, p + 7, p + 10];
  const base = p - rel, out = [p];
  for (let k = 2; k <= (size === 3 ? 4 : 6); k += 2) { const j = idx + k; out.push(base + sc[j % sc.length] + 12 * Math.floor(j / sc.length)); }
  return out;
}

/* ---------- rendering ---------- */
function renderAll() {
  renderTop(); renderProgress(); renderTransport(); renderRackHead(); renderRack(); renderRoll(); renderPlaylist();
}
function renderTop() {
  $('#bpmVal').textContent = P.bpm % 1 ? P.bpm.toFixed(1) : P.bpm;
  const tr = selTrack();
  $('#soundBtn').textContent = tr ? GR.soundLabel(tr) : 'no track';
  $('#trackCount').textContent = P.tracks.length;
  $('#tracksBtn').lastChild.textContent = P.tracks.length === 1 ? ' track' : ' tracks';
}
function renderProgress() {
  const box = $('#progress');
  if (box.children.length !== P.bars) {
    box.innerHTML = Array.from({ length: P.bars }, (_, i) => `<button data-bar="${i}" aria-label="Go to bar ${i + 1}"><i></i></button>`).join('');
  }
  const p = pos();
  Array.from(box.children).forEach((b, i) => {
    let f = 0;
    if (p != null) { const pb = p / TPB; f = i < Math.floor(pb) ? 1 : i === Math.floor(pb) ? pb - i : 0; }
    else f = i === ui.bar ? 1 : 0;
    b.style.setProperty('--f', f.toFixed(3));
    b.classList.toggle('view', i === ui.bar);
  });
}
function renderTransport() {
  const b = $('#playBtn'); b.innerHTML = S.playing ? ICON.stop : ICON.play;
  b.setAttribute('aria-label', S.playing ? 'Stop' : 'Play'); b.title = S.playing ? 'Stop (Space)' : 'Play (Space)';
}
function renderBarChip() { $('#barBtn').textContent = innerWidth <= 460 ? `bar ${ui.bar + 1}/${P.bars}` : `bar ${ui.bar + 1} of ${P.bars}`; }
function renderRackHead() {
  $('#groupBtn').textContent = GROUP_NAME[other(ui.group)] + ' ▸';
  $('#rackTitle').innerHTML = ui.view === 'mix' ? 'Mixer' : '<span class="t-long">Channel rack</span><span class="t-short">Rack</span>';
  $('#muteBtn').innerHTML = ui.muted ? ICON.spkOff : ICON.spk;
  $('#muteBtn').setAttribute('aria-label', ui.muted ? 'Unmute output' : 'Mute output');
  $('#knob').style.setProperty('--a', (-135 + P.master * 270) + 'deg');
  $('#knob').title = `Master volume ${Math.round(P.master * 100)}% (drag)`;
  renderBarChip();
  $('#mixBtn').className = 'ib hide-sm' + (ui.view === 'mix' ? ' on' : '');
  $('#stepBtn').className = 'ib' + (ui.view === 'steps' ? ' on' : '');
  $('#stepBtn').setAttribute('aria-label', ui.view === 'steps' ? 'Mixer view' : 'Step view');
  $('#foldBtn').innerHTML = ui.folded ? ICON.plus : ICON.x;
  $('#foldBtn').setAttribute('aria-label', ui.folded ? 'Show rack' : 'Hide rack');
  $('#rackBody').hidden = ui.folded;
}
function rowStart(tr, lane) {
  const cls = ['row']; if (tr.id === ui.sel) cls.push('sel'); if (tr.mute) cls.push('muted'); if (tr.solo) cls.push('solo');
  return `<div class="${cls.join(' ')}" data-id="${tr.id}">
    <div class="ncell"><button class="tname" data-act="name" title="${esc(GR.soundLabel(tr))}"><i class="dot"></i><span class="nm">${esc(tr.name)}</span></button><button class="led" data-act="mute" aria-label="${tr.mute ? 'Unmute' : 'Mute'} ${esc(tr.name)}" title="${tr.mute ? 'Unmute' : 'Mute'}"></button></div>
    <div class="meter" data-meter="${tr.id}" aria-hidden="true"><i></i><i></i></div>${lane}</div>`;
}
function laneInner(tr) {
  const inst = I[tr.inst], b0 = ui.bar * TPB, b1 = b0 + TPB, stepT = TPB / tr.res, stepPct = 100 / tr.res;
  let h = `<div class="dots" style="--res:${tr.res}"></div>`;
  tr.notes.forEach(n => {
    if (inst.pitched) {
      const len = n.len || stepT; if (n.t >= b1 || n.t + len <= b0) return;
      const a = Math.max(n.t, b0), e = Math.min(n.t + len, b1);
      const l = (a - b0) / TPB * 100, w = (e - a) / TPB * 100;
      const cls = ['pill', 'mel']; if (n.t < b0) cls.push('cont'); if (n.vel < 0.5) cls.push('ghost'); if (n.slide) cls.push('slide');
      h += `<i class="${cls.join(' ')}" style="left:calc(${l}% + 1px);width:calc(${w}% - 2px);--v:${n.vel}">${n.t >= b0 && w > stepPct * 1.6 ? GR.noteName(n.p) : ''}</i>`;
    } else {
      if (n.t < b0 || n.t >= b1) return;
      const l = (n.t - b0) / TPB * 100 + stepPct * 0.18;
      const cls = 'pill' + (n.vel < 0.5 ? ' ghost' : '');
      h += `<i class="${cls}" style="left:${l}%;width:${stepPct * 0.64}%;--v:${n.vel}"${n.roll > 1 ? ` data-roll="${n.roll}"` : ''}></i>`;
    }
  });
  return h;
}
function mixInner(tr) {
  return `<div class="mix" data-id="${tr.id}">
    <button class="ms mute${tr.mute ? ' on' : ''}" data-act="mute" aria-label="Mute">M</button>
    <button class="ms${tr.solo ? ' on' : ''}" data-act="solo" aria-label="Solo">S</button>
    <label><span>vol</span> <input type="range" min="0" max="1" step="0.01" value="${tr.vol}" data-k="vol" aria-label="${esc(tr.name)} volume"></label>
    <label class="pan"><span>pan</span> <input type="range" min="-1" max="1" step="0.02" value="${tr.pan}" data-k="pan" aria-label="${esc(tr.name)} pan"></label>
  </div>`;
}
function renderRack() {
  const grid = $('#rackGrid'), tracks = groupTracks(ui.group);
  if (!tracks.length) {
    grid.innerHTML = `<div class="empty">No ${GROUP_NAME[ui.group].toLowerCase()} tracks yet.<br><button class="b" data-act="add">Add a track</button></div>`;
    return;
  }
  let h = tracks.map(tr => rowStart(tr, ui.view === 'mix' ? mixInner(tr) : `<div class="lane" data-id="${tr.id}">${laneInner(tr)}</div>`)).join('');
  if (ui.view === 'steps') {
    h += `<div class="overlay" style="--end:${tracks.length + 1}">${[25, 50, 75].map(x => `<i class="bl" style="left:${x}%"></i>`).join('')}<i class="phd" id="rackHead" hidden></i></div>`;
    h += `<div class="nums" aria-hidden="true">${[0, 1, 2, 3].map(i => `<span style="left:${i * 25 + 3.2}%">${i + 1}</span>`).join('')}</div>`;
  }
  grid.innerHTML = h;
}
function renderPlaylist() {
  const g = other(ui.group), tracks = groupTracks(g), grid = $('#plGrid');
  if (!tracks.length) {
    grid.innerHTML = `<div class="empty">No ${GROUP_NAME[g].toLowerCase()} tracks. Add one with <b>${P.tracks.length} tracks</b> at the top.</div>`;
    return;
  }
  let h = tracks.map(tr => rowStart(tr, `<div class="lane" data-id="${tr.id}" data-pl="1"><canvas></canvas></div>`)).join('');
  h += `<div class="overlay" style="--end:${tracks.length + 1}">${Array.from({ length: P.bars - 1 }, (_, i) => `<i class="bl" style="left:${(i + 1) / P.bars * 100}%"></i>`).join('')}<i class="phd" id="plHead" hidden></i></div>`;
  h += `<div class="nums">${Array.from({ length: P.bars }, (_, i) => `<span style="left:${i / P.bars * 100}%">${i + 1}</span>`).join('')}</div>`;
  grid.innerHTML = h;
  tracks.forEach(tr => drawWave(tr.id));
  renderPlaylistHead();
}
function renderPlaylistHead() {
  // mark the bar the rack is showing
  document.querySelectorAll('#plGrid .nums span').forEach((s, i) => { s.style.color = i === ui.bar ? 'var(--gold)' : ''; });
}

/* ---------- piano roll ---------- */
const ROWH = 20;
function rollRows(tr) {
  const rows = [];
  for (let m = tr.low + 24; m >= tr.low; m--) if (!ui.scaleOnly || inScale(m)) rows.push(m);
  return rows;
}
function renderRoll() {
  const box = $('#roll'), tr = selTrack();
  const show = !!(tr && I[tr.inst].pitched && ui.rollOpen && !ui.folded);
  box.hidden = !show; if (!show) return;
  const rows = rollRows(tr);
  const keyName = GR.NOTE_NAMES[P.key] + ' ' + P.scale;
  const prevScroll = box.querySelector('.rwrap') ? box.querySelector('.rwrap').scrollTop : null;
  box.innerHTML = `<div class="phead">
      <h2 class="ptitle">Piano roll <span style="color:var(--muted);font-weight:600">· ${esc(tr.name)} · bar ${ui.bar + 1}</span></h2>
      <button class="ib boxed" data-act="closeroll" aria-label="Close piano roll">${ICON.x}</button>
    </div>
    <div class="rtools">
      <button class="chip" data-act="song" title="Key and scale">${esc(keyName)}</button>
      <div class="seg" role="group" aria-label="Chord mode">${['note', 'triad', '7th'].map((l, i) => `<button data-chord="${i ? i + 2 : 0}" class="${ui.chord === (i ? i + 2 : 0) ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button class="chip" data-act="scaleonly" aria-pressed="${ui.scaleOnly}" style="${ui.scaleOnly ? 'color:var(--gold)' : ''}">scale only</button>
      <span class="sp"></span>
      <button class="ib" data-act="octdown" aria-label="Octave down" title="Octave down">▼</button>
      <button class="ib" data-act="octup" aria-label="Octave up" title="Octave up">▲</button>
    </div>
    <div class="rwrap"><div class="rbody">
      <div class="rkeys">${rows.map(m => { const pc = ((m % 12) + 12) % 12; const blk = [1, 3, 6, 8, 10].includes(pc); const root = pc === P.key;
        return `<button data-key="${m}" class="${blk ? 'blk' : ''}${root ? ' root' : ''}" tabindex="-1">${GR.noteName(m)}</button>`; }).join('')}</div>
      <div class="rcanvas" id="rcanvas" style="--res:${tr.res};height:${rows.length * ROWH}px">
        ${rows.map(m => `<div class="rrow ${(((m - P.key) % 12) + 12) % 12 === 0 ? 'root' : inScale(m) ? 'ins' : 'out'}"></div>`).join('')}
        <div id="rnotes"></div>
      </div>
    </div></div>
    <div class="rhint" id="rhint"></div>`;
  drawRollNotes();
  const wrap = box.querySelector('.rwrap');
  if (prevScroll != null && ui._rollFor === tr.id) wrap.scrollTop = prevScroll;
  else {
    const b0 = ui.bar * TPB, ns = tr.notes.filter(n => n.t >= b0 && n.t < b0 + TPB);
    const top = ns.length ? Math.max(...ns.map(n => n.p)) : tr.low + 14;
    const idx = rows.findIndex(m => m <= top);
    wrap.scrollTop = Math.max(0, idx * ROWH - 40);
  }
  ui._rollFor = tr.id;
}
function drawRollNotes() {
  const tr = selTrack(), layer = $('#rnotes'); if (!tr || !layer) return;
  const rows = rollRows(tr), b0 = ui.bar * TPB, b1 = b0 + TPB, stepT = TPB / tr.res;
  let h = '', above = 0, below = 0, hidden = 0;
  tr.notes.forEach(n => {
    const len = n.len || stepT; if (n.t >= b1 || n.t + len <= b0) return;
    const r = rows.indexOf(n.p);
    if (r < 0) { if (n.p > tr.low + 24) above++; else if (n.p < tr.low) below++; else hidden++; return; }
    const a = Math.max(n.t, b0), e = Math.min(n.t + len, b1);
    h += `<div class="rnote${n.t < b0 ? ' cont' : ''}" style="top:${r * ROWH + 1}px;left:calc(${(a - b0) / TPB * 100}% + 1px);width:calc(${(e - a) / TPB * 100}% - 2px);--v:${n.vel}">${n.slide ? '↗' : ''}${GR.noteName(n.p)}</div>`;
  });
  layer.innerHTML = h;
  const hint = $('#rhint');
  if (hint) {
    const bits = [];
    if (above) bits.push(`${above} note${above > 1 ? 's' : ''} above — press ▲`);
    if (below) bits.push(`${below} note${below > 1 ? 's' : ''} below — press ▼`);
    if (hidden) bits.push(`${hidden} outside the scale — turn off “scale only”`);
    hint.textContent = bits.length ? bits.join(' · ') : 'Tap to add a note and drag right to make it longer. Drag a note to move it, tap it to delete, hold it for velocity and slide.';
  }
}

/* ---------- waveforms ---------- */
const waves = new Map();
let waveT = 0, waveBusy = false;
function wavesSoon() { clearTimeout(waveT); waveT = setTimeout(renderWaves, 280); }
async function renderWaves() {
  if (waveBusy) { wavesSoon(); return; }
  waveBusy = true;
  try {
    for (const tr of groupTracks(other(ui.group))) {
      const sig = JSON.stringify([tr.inst, tr.sound, tr.notes, tr.res, tr.pitch, tr.decay, tr.vol, tr.sample, !!GR.samples.get(tr.sample), P.bpm, P.bars, P.swing]);
      const w = waves.get(tr.id); if (w && w.sig === sig) continue;
      let peaks = new Float32Array(1);
      if (tr.notes.length) {
        const buf = await GR.render(Object.assign({}, P, { tracks: [tr] }), { only: tr.id, channels: 1, sr: 22050, tail: 1.5 });
        const d = buf.getChannelData(0), N = 1400; peaks = new Float32Array(N);
        const per = d.length / N; let mx = 0;
        for (let i = 0; i < N; i++) {
          let m = 0; const a = Math.floor(i * per), b = Math.floor((i + 1) * per);
          for (let j = a; j < b; j += 2) { const v = Math.abs(d[j]); if (v > m) m = v; }
          peaks[i] = m; if (m > mx) mx = m;
        }
        const k = 1 / Math.max(mx, 0.3); for (let i = 0; i < N; i++) peaks[i] = Math.min(1, peaks[i] * k);
      }
      waves.set(tr.id, { sig, peaks });
      drawWave(tr.id);
    }
  } catch (e) { console.warn('waveform', e); }
  waveBusy = false;
}
function drawWave(id) {
  const lane = $(`#plGrid .lane[data-id="${id}"]`); if (!lane) return;
  const cv = lane.querySelector('canvas'), dpr = window.devicePixelRatio || 1;
  const W = lane.clientWidth, H = lane.clientHeight; if (!W) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const tr = track(id), mid = H / 2;
  g.fillStyle = '#ffffff1f'; g.fillRect(0, mid - 0.5, W, 1);
  const w = waves.get(id); if (!w || w.peaks.length < 2) return;
  g.fillStyle = tr && tr.mute ? '#6b5e5899' : '#b9aaa2d0';
  const N = w.peaks.length;
  for (let x = 0; x < W; x += 2.5) {
    const a = Math.floor(x / W * N), b = Math.max(a + 1, Math.floor((x + 2.5) / W * N));
    let m = 0; for (let i = a; i < b && i < N; i++) if (w.peaks[i] > m) m = w.peaks[i];
    const h = Math.max(0.8, m * (H * 0.46));
    if (m > 0.012) g.fillRect(x, mid - h, 1.3, h * 2);
  }
}

/* ---------- animation: playhead, meters, follow ---------- */
const tmp = new Float32Array(256);
const lv = {};
function frame() {
  requestAnimationFrame(frame);
  const p = pos();
  const rh = $('#rackHead'), ph = $('#plHead');
  if (p != null) {
    const bar = Math.floor(p / TPB);
    if (ui.follow && bar !== ui.bar && !dragging) {
      ui.bar = bar;
      document.querySelectorAll('#rackGrid .lane').forEach(l => { const tr = track(l.dataset.id); if (tr) l.innerHTML = laneInner(tr); });
      renderBarChip(); renderPlaylistHead();
      if (!$('#roll').hidden) { const t = $('#roll .ptitle span'); const tr = selTrack(); if (t && tr) t.textContent = `· ${tr.name} · bar ${ui.bar + 1}`; drawRollNotes(); }
    }
    if (rh) { rh.hidden = bar !== ui.bar; rh.style.left = ((p % TPB) / TPB * 100) + '%'; }
    if (ph) { ph.hidden = false; ph.style.left = (p / (P.bars * TPB) * 100) + '%'; }
  } else {
    if (rh) rh.hidden = true;
    if (ph) ph.hidden = true;
  }
  if (S.playing) renderProgress();
  if (!mix) return;
  document.querySelectorAll('[data-meter]').forEach(m => {
    const id = m.dataset.meter, s = mix.strips[id]; if (!s || !s.an) return;
    s.an.getFloatTimeDomainData(tmp);
    let pk = 0, sq = 0; for (let i = 0; i < tmp.length; i++) { const v = Math.abs(tmp[i]); if (v > pk) pk = v; sq += v * v; }
    const rms = Math.sqrt(sq / tmp.length);
    const o = lv[id] || (lv[id] = { a: 0, b: 0 });
    o.a = Math.max(Math.min(1, pk * 1.4), o.a * 0.88); o.b = Math.max(Math.min(1, rms * 3), o.b * 0.9);
    m.style.setProperty('--l', o.a.toFixed(3)); m.style.setProperty('--l2', o.b.toFixed(3));
    const led = m.previousElementSibling && m.previousElementSibling.querySelector('.led');
    if (led) led.classList.toggle('on', o.a > 0.12);
  });
}

/* ---------- rack interactions ---------- */
let dragging = false;
function select(id, openRoll) {
  const changedSel = ui.sel !== id; ui.sel = id;
  if (openRoll) ui.rollOpen = true;
  if (changedSel || openRoll) {
    document.querySelectorAll('.row').forEach(r => r.classList.toggle('sel', r.dataset.id === id));
    renderTop(); renderRoll();
  }
}
function onLaneDown(e) {
  const lane = e.target.closest('.lane'); if (!lane || lane.dataset.pl) return;
  const tr = track(lane.dataset.id); if (!tr) return;
  e.preventDefault();
  select(tr.id, I[tr.inst].pitched && ui.sel !== tr.id ? true : false);
  const rect = lane.getBoundingClientRect(), stepT = TPB / tr.res;
  const stepAt = x => clamp(Math.floor((x - rect.left) / rect.width * tr.res), 0, tr.res - 1);
  const tickOf = s => ui.bar * TPB + s * stepT;
  const s0 = stepAt(e.clientX);
  let hit = stepNotes(tr, ui.bar, s0)[0];
  if (e.button === 2) { if (hit) noteSheet(tr, hit); return; }
  commit(); dragging = true;
  let mode = hit ? 'hit' : 'add', moved = false;
  const x0 = e.clientX, y0 = e.clientY, done = new Set([s0]);
  if (!hit) { hit = addNote(tr, tickOf(s0)); audition(tr, hit); light(tr); }
  const vel0 = hit.vel;
  const lp = setTimeout(() => { if (!moved) { mode = 'menu'; finish(); noteSheet(tr, hit); } }, 480);
  try { lane.setPointerCapture(e.pointerId); } catch (err) {}
  const move = ev => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if (!moved && Math.hypot(dx, dy) > 7) {
      moved = true; clearTimeout(lp);
      if (Math.abs(dy) > Math.abs(dx)) mode = 'vel';
      else if (mode === 'hit') { mode = 'erase'; removeNote(tr, hit); light(tr); }
      else mode = 'paint';
    }
    if (mode === 'vel') {
      hit.vel = clamp(Math.round((vel0 - dy / 90) * 100) / 100, 0.05, 1);
      light(tr); hud(`velocity ${Math.round(hit.vel * 100)}%`);
    } else if (mode === 'paint' || mode === 'erase') {
      const s = stepAt(ev.clientX); if (done.has(s)) return; done.add(s);
      const ex = stepNotes(tr, ui.bar, s);
      if (mode === 'paint' && !ex.length) addNote(tr, tickOf(s), I[tr.inst].pitched ? { p: hit.p } : null);
      if (mode === 'erase') ex.forEach(n => removeNote(tr, n));
      light(tr);
    }
  };
  const up = () => {
    clearTimeout(lp);
    if (mode === 'hit' && !moved) removeNote(tr, hit);
    finish();
    changed(); settle();
  };
  function finish() {
    dragging = false;
    lane.removeEventListener('pointermove', move); lane.removeEventListener('pointerup', up); lane.removeEventListener('pointercancel', up);
    hud(null);
  }
  lane.addEventListener('pointermove', move); lane.addEventListener('pointerup', up); lane.addEventListener('pointercancel', up);
}
function onRowClick(e, inPlaylist) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const row = e.target.closest('.row'), tr = row && track(row.dataset.id);
  const act = b.dataset.act;
  if (act === 'add') return addSheet();
  if (!tr) return;
  if (act === 'mute') { edit(() => { tr.mute = !tr.mute; }); toast(tr.mute ? `${tr.name} muted` : `${tr.name} on`); }
  else if (act === 'solo') edit(() => { tr.solo = !tr.solo; });
  else if (act === 'name') {
    if (inPlaylist) { ui.group = tr.group; ui.sel = tr.id; ui.rollOpen = true; waves.clear(); renderAll(); wavesSoon(); return; }
    if (ui.sel === tr.id) { channelSheet(tr); return; }
    select(tr.id, I[tr.inst].pitched);
    audition(tr);
  }
}
function onMixInput(e) {
  const inp = e.target.closest('input[data-k]'); if (!inp) return;
  const tr = track(inp.closest('.mix').dataset.id); if (!tr) return;
  if (!inp._c) { commit(); inp._c = 1; }
  tr[inp.dataset.k] = +inp.value;
  if (mix) GR.updateMix(mix, P, ui.muted);
  clearTimeout(saveT); saveT = setTimeout(autosave, 400);
}
function onMixChange(e) { const inp = e.target.closest('input[data-k]'); if (inp) { inp._c = 0; settle(); wavesSoon(); } }

/* ---------- piano roll interactions ---------- */
function onRollDown(e) {
  const cv = e.target.closest('#rcanvas'); if (!cv) return;
  const tr = selTrack(); if (!tr) return;
  e.preventDefault();
  const rows = rollRows(tr), rect = cv.getBoundingClientRect(), stepT = TPB / tr.res, b0 = ui.bar * TPB;
  const colAt = x => clamp(Math.floor((x - rect.left) / rect.width * tr.res), 0, tr.res - 1);
  const rowAt = y => clamp(Math.floor((y - rect.top) / ROWH), 0, rows.length - 1);
  const c0 = colAt(e.clientX), r0 = rowAt(e.clientY), p0 = rows[r0], tick0 = b0 + c0 * stepT;
  const hit = tr.notes.find(n => n.p === p0 && n.t <= tick0 && tick0 < n.t + (n.len || stepT) && n.t + (n.len || stepT) > b0);
  if (e.button === 2) { if (hit) noteSheet(tr, hit); return; }
  commit(); dragging = true;
  let mode, group, moved = false;
  if (hit) {
    const endX = rect.left + (Math.min(hit.t + hit.len, b0 + TPB) - b0) / TPB * rect.width;
    mode = e.clientX > endX - Math.min(12, rect.width / tr.res * 0.45) ? 'resize' : 'move';
    group = [hit];
  } else {
    mode = 'new';
    group = chordFrom(p0, ui.chord).map(p => addNote(tr, tick0, { p, len: tr.lastLen || stepT * 2, vel: 0.85 }));
    group.forEach((n, i) => setTimeout(() => audition(tr, n), i * 4));
    drawRollNotes();
  }
  const orig = group.map(n => ({ t: n.t, p: n.p, len: n.len }));
  const lp = setTimeout(() => { if (!moved && hit) { mode = 'menu'; finish(); noteSheet(tr, hit); } }, 480);
  try { cv.setPointerCapture(e.pointerId); } catch (err) {}
  let lastP = p0;
  const move = ev => {
    const c = colAt(ev.clientX), r = rowAt(ev.clientY);
    if (!moved && (c !== c0 || r !== r0 || Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 8)) { moved = true; clearTimeout(lp); }
    if (!moved) return;
    if (mode === 'resize' || mode === 'new') {
      group.forEach((n, i) => { n.len = Math.max(stepT, (c - Math.floor((orig[i].t - b0) / stepT) + 1) * stepT); });
    } else if (mode === 'move') {
      const dc = c - c0, dr = r - r0;
      group.forEach((n, i) => {
        n.t = clamp(orig[i].t + dc * stepT, 0, P.bars * TPB - stepT);
        const ri = rows.indexOf(orig[i].p); n.p = ri >= 0 ? rows[clamp(ri + dr, 0, rows.length - 1)] : orig[i].p;
      });
      if (group[0].p !== lastP) { lastP = group[0].p; audition(tr, group[0]); }
    }
    drawRollNotes(); light(tr);
  };
  const up = () => {
    clearTimeout(lp);
    if (mode === 'move' && !moved) removeNote(tr, hit);
    if (mode !== 'menu' && group[0] && tr.notes.includes(group[0])) { tr.lastLen = group[0].len; tr.lastP = group[0].p; }
    sortNotes(tr);
    finish(); changed(); settle();
  };
  function finish() {
    dragging = false;
    cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up);
  }
  cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
}
function onRollClick(e) {
  const b = e.target.closest('[data-act],[data-chord],[data-key]'); if (!b) return;
  const tr = selTrack(); if (!tr) return;
  if (b.dataset.key) { audition(tr, { p: +b.dataset.key, vel: 0.85 }); return; }
  if (b.dataset.chord != null) { ui.chord = +b.dataset.chord; renderRoll(); return; }
  const a = b.dataset.act;
  if (a === 'closeroll') { ui.rollOpen = false; renderRoll(); }
  else if (a === 'octup') { tr.low = Math.min(96, tr.low + 12); ui._rollFor = null; renderRoll(); autosave(); }
  else if (a === 'octdown') { tr.low = Math.max(0, tr.low - 12); ui._rollFor = null; renderRoll(); autosave(); }
  else if (a === 'scaleonly') { ui.scaleOnly = !ui.scaleOnly; ui._rollFor = null; renderRoll(); }
  else if (a === 'song') songSheet();
}

/* ---------- sheets ---------- */
let sheetEl = null;
function openSheet(title, html, mount) {
  closeSheet();
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div>
    <div class="sh-head"><h3>${esc(title)}</h3><button class="ib boxed" data-close aria-label="Close">${ICON.x}</button></div>${html}</div>`;
  scrim.addEventListener('pointerdown', e => { if (e.target === scrim) scrim._down = true; });
  scrim.addEventListener('click', e => { if ((e.target === scrim && scrim._down) || e.target.closest('[data-close]')) closeSheet(); scrim._down = false; });
  document.body.appendChild(scrim); sheetEl = scrim;
  const sh = scrim.firstElementChild;
  if (mount) mount(sh);
  const f = sh.querySelector('[data-close]'); if (f) f.focus({ preventScroll: true });
  return sh;
}
function closeSheet() { if (sheetEl) { sheetEl.remove(); sheetEl = null; } }
// wire a range input: live preview, one undo step per drag
function slider(sh, id, apply, fmt) {
  const inp = sh.querySelector('#' + id), out = sh.querySelector(`output[for="${id}"]`);
  let started = false;
  const show = () => { if (out) out.textContent = fmt(+inp.value); };
  inp.addEventListener('input', () => { if (!started) { commit(); started = true; } apply(+inp.value); show(); changed(); });
  inp.addEventListener('change', () => { started = false; settle(); });
  show();
}
const ctlRow = (id, label, min, max, step, val) => `<label class="ctl"><span>${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output for="${id}"></output></label>`;
const pct = v => Math.round(v * 100) + '%';

function songSheet() {
  const sh = openSheet('Song', `
    <div class="big-bpm"><button class="b" data-d="-1" aria-label="Slower">−</button><span><span id="sBpm">${P.bpm}</span><small>BPM</small></span><button class="b" data-d="1" aria-label="Faster">+</button></div>
    ${ctlRow('s_bpm', 'Tempo', 50, 200, 1, P.bpm)}
    <div class="btns" style="justify-content:center"><button class="b" id="tapBtn">Tap tempo</button><button class="b sm" data-half>½×</button><button class="b sm" data-dbl>2×</button></div>
    ${ctlRow('s_swing', 'Swing', 0, 100, 1, P.swing)}
    ${ctlRow('s_master', 'Master', 0, 1, 0.01, P.master)}
    <div class="sh-sec"><h4>Key</h4>
      <div class="btns"><select class="txt" id="s_key" style="width:auto">${GR.NOTE_NAMES.map((n, i) => `<option value="${i}"${i === P.key ? ' selected' : ''}>${n}</option>`).join('')}</select>
      <select class="txt" id="s_scale" style="width:auto">${Object.keys(GR.SCALES).map(s => `<option${s === P.scale ? ' selected' : ''}>${s}</option>`).join('')}</select>
      <button class="b sm" data-tr="-1">Transpose −1</button><button class="b sm" data-tr="1">Transpose +1</button></div>
      <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">Key and scale light up the piano roll and steer chord mode. Transpose moves every melodic note and the key together.</p>
    </div>
    <div class="sh-sec"><h4>Loop length</h4><div class="seg" role="group" aria-label="Bars">${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<button data-bars="${n}" class="${n === P.bars ? 'on' : ''}">${n}</button>`).join('')}</div>
      <div class="btns" style="margin-top:8px"><button class="b sm" data-double>Double the loop</button></div></div>
    <div class="sh-sec"><h4>Playback</h4><div class="btns">
      <button class="b sm${ui.metro ? ' on' : ''}" data-metro>Metronome ${ui.metro ? 'on' : 'off'}</button>
      <button class="b sm${ui.follow ? ' on' : ''}" data-follow>Follow playhead ${ui.follow ? 'on' : 'off'}</button></div></div>`, sh => {
    const refreshBpm = () => { sh.querySelector('#sBpm').textContent = P.bpm; sh.querySelector('#s_bpm').value = P.bpm; };
    slider(sh, 's_bpm', v => { setBpm(v); sh.querySelector('#sBpm').textContent = P.bpm; }, v => v);
    slider(sh, 's_swing', v => { P.swing = v; }, v => v + '%');
    slider(sh, 's_master', v => { P.master = v; }, pct);
    const taps = [];
    sh.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.d) { edit(() => setBpm(P.bpm + +b.dataset.d)); refreshBpm(); }
      else if (b.id === 'tapBtn') {
        const now = performance.now(); if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
        taps.push(now); if (taps.length > 6) taps.shift();
        if (taps.length >= 3) { const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); edit(() => setBpm(Math.round(60000 / avg))); refreshBpm(); }
        b.textContent = taps.length < 3 ? `Tap ${3 - taps.length} more` : 'Tap tempo';
      }
      else if (b.dataset.half != null) { edit(() => setBpm(P.bpm / 2)); refreshBpm(); }
      else if (b.dataset.dbl != null) { edit(() => setBpm(P.bpm * 2)); refreshBpm(); }
      else if (b.dataset.tr) {
        const d = +b.dataset.tr;
        edit(() => { P.key = (P.key + d + 12) % 12; P.tracks.forEach(t => { if (I[t.inst].pitched) t.notes.forEach(n => { n.p = clamp(n.p + d, 0, 127); }); }); });
        sh.querySelector('#s_key').value = P.key; toast('Key: ' + GR.NOTE_NAMES[P.key] + ' ' + P.scale);
      }
      else if (b.dataset.bars) { edit(() => { P.bars = +b.dataset.bars; }); sh.querySelectorAll('[data-bars]').forEach(x => x.classList.toggle('on', +x.dataset.bars === P.bars)); }
      else if (b.dataset.double != null) {
        if (P.bars > 4) return toast('The loop can be at most 8 bars');
        edit(() => { const L = P.bars * TPB; P.tracks.forEach(t => { t.notes = t.notes.filter(n => n.t < L); t.notes = t.notes.concat(t.notes.map(n => Object.assign({}, n, { t: n.t + L }))); }); P.bars *= 2; });
        sh.querySelectorAll('[data-bars]').forEach(x => x.classList.toggle('on', +x.dataset.bars === P.bars)); toast(`Loop is now ${P.bars} bars`);
      }
      else if (b.dataset.metro != null) { ui.metro = !ui.metro; b.classList.toggle('on', ui.metro); b.textContent = 'Metronome ' + (ui.metro ? 'on' : 'off'); }
      else if (b.dataset.follow != null) { ui.follow = !ui.follow; b.classList.toggle('on', ui.follow); b.textContent = 'Follow playhead ' + (ui.follow ? 'on' : 'off'); }
    });
    sh.querySelector('#s_key').addEventListener('change', e => edit(() => { P.key = +e.target.value; }));
    sh.querySelector('#s_scale').addEventListener('change', e => edit(() => { P.scale = e.target.value; }));
  });
}

function barSheet() {
  const sh = openSheet('Bars', `
    <div class="big-bpm" style="font-size:30px"><button class="b" data-go="-1" aria-label="Previous bar">‹</button><span id="bLabel">bar ${ui.bar + 1} of ${P.bars}</span><button class="b" data-go="1" aria-label="Next bar">›</button></div>
    <div class="sh-sec"><h4>Loop length</h4><div class="seg">${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<button data-bars="${n}" class="${n === P.bars ? 'on' : ''}">${n}</button>`).join('')}</div></div>
    <div class="sh-sec"><h4>This bar, every track</h4><div class="btns">
      <button class="b sm" data-copy="next">Copy to next bar</button>
      <button class="b sm" data-copy="all">Copy to all bars</button>
      <button class="b sm warn" data-clear>Clear this bar</button></div></div>
    <div class="sh-sec"><div class="btns"><button class="b sm${ui.follow ? ' on' : ''}" data-follow>Follow playhead ${ui.follow ? 'on' : 'off'}</button></div></div>`, sh => {
    const lab = () => { sh.querySelector('#bLabel').textContent = `bar ${ui.bar + 1} of ${P.bars}`; sh.querySelectorAll('[data-bars]').forEach(x => x.classList.toggle('on', +x.dataset.bars === P.bars)); };
    sh.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.go) { seek((ui.bar + +b.dataset.go + P.bars) % P.bars); lab(); }
      else if (b.dataset.bars) { edit(() => { P.bars = +b.dataset.bars; }); lab(); }
      else if (b.dataset.copy) {
        const targets = b.dataset.copy === 'next' ? [(ui.bar + 1) % P.bars] : Array.from({ length: P.bars }, (_, i) => i).filter(i => i !== ui.bar);
        edit(() => P.tracks.forEach(t => copyBar(t, ui.bar, targets)));
        toast(b.dataset.copy === 'next' ? `Copied to bar ${targets[0] + 1}` : 'Copied to every bar');
      }
      else if (b.dataset.clear != null) { edit(() => P.tracks.forEach(t => clearBar(t, ui.bar))); toast(`Cleared bar ${ui.bar + 1}`); }
      else if (b.dataset.follow != null) { ui.follow = !ui.follow; b.classList.toggle('on', ui.follow); b.textContent = 'Follow playhead ' + (ui.follow ? 'on' : 'off'); }
    });
  });
}
function clearBar(t, bar) { const a = bar * TPB; t.notes = t.notes.filter(n => n.t < a || n.t >= a + TPB); }
function copyBar(t, from, targets) {
  const a = from * TPB, src = t.notes.filter(n => n.t >= a && n.t < a + TPB);
  targets.forEach(b => { clearBar(t, b); src.forEach(n => t.notes.push(Object.assign({}, n, { t: n.t - a + b * TPB }))); });
  sortNotes(t);
}

function channelSheet(tr) {
  const inst = I[tr.inst];
  const instOpts = Object.values(I).map(x => `<option value="${x.id}"${x.id === tr.inst ? ' selected' : ''}>${x.label}</option>`).join('');
  const sounds = Object.entries(inst.sounds).map(([k, v]) => `<button class="b sm${!tr.sample && k === tr.sound ? ' on' : ''}" data-snd="${k}">${v[0]}</button>`).join('');
  const sh = openSheet(tr.name, `
    <div class="sh-sec"><h4>Name</h4><input class="txt" id="c_name" value="${esc(tr.name)}" maxlength="24" autocomplete="off"></div>
    <div class="sh-sec"><h4>Sound</h4>
      <div class="btns" style="margin-bottom:8px"><select class="txt" id="c_inst" style="width:auto" aria-label="Instrument">${instOpts}</select>
        <button class="b sm" data-act="file">${tr.sample ? 'Replace sound file' : 'Use a sound file…'}</button>
        ${tr.sample ? `<button class="b sm" data-act="unsample">Back to synth (${esc(tr.sampleName || 'file')})</button>` : ''}</div>
      <div class="btns">${sounds}</div></div>
    <div class="sh-sec"><h4>Steps per bar</h4><div class="seg">${[12, 16, 24, 32].map(r => `<button data-res="${r}" class="${r === tr.res ? 'on' : ''}" title="${RES_LABEL[r]}">${r}</button>`).join('')}</div>
      <span style="color:var(--muted);font-size:12.5px;margin-left:8px">${RES_LABEL[tr.res]} — 12 and 24 give triplet grids</span></div>
    <div class="sh-sec"><h4>Channel</h4>
      ${ctlRow('c_vol', 'Volume', 0, 1, 0.01, tr.vol)}${ctlRow('c_pan', 'Pan', -1, 1, 0.02, tr.pan)}
      ${ctlRow('c_pitch', 'Pitch', -24, 24, 1, tr.pitch)}${ctlRow('c_decay', inst.pitched ? 'Release' : 'Length', 0.3, 2, 0.05, tr.decay)}
      ${ctlRow('c_tone', 'Tone', 0, 1, 0.01, tr.tone)}${ctlRow('c_rev', 'Reverb', 0, 1, 0.01, tr.rev)}${ctlRow('c_echo', 'Echo', 0, 1, 0.01, tr.echo)}
      <div class="btns"><button class="b sm${tr.mute ? ' on' : ''}" data-act="mute">${tr.mute ? 'Muted' : 'Mute'}</button><button class="b sm${tr.solo ? ' on' : ''}" data-act="solo">${tr.solo ? 'Soloed' : 'Solo'}</button>
        <button class="b sm" data-act="move">Move to ${GROUP_NAME[other(tr.group)]} rack</button></div></div>
    <div class="sh-sec"><h4>Pattern · bar ${ui.bar + 1}</h4><div class="btns">
      <button class="b sm" data-fill="1">Every step</button><button class="b sm" data-fill="2">Every 2</button><button class="b sm" data-fill="4">Every 4</button><button class="b sm" data-fill="8">Every 8</button>
      <button class="b sm" data-shift="-1" aria-label="Shift left">◀ Shift</button><button class="b sm" data-shift="1" aria-label="Shift right">Shift ▶</button>
      <button class="b sm" data-act="random">Randomize</button><button class="b sm" data-act="copyall">Copy to all bars</button>
      <button class="b sm warn" data-act="clearbar">Clear bar</button><button class="b sm warn" data-act="clearall">Clear all bars</button></div></div>
    <div class="sh-sec"><h4>Track</h4><div class="btns"><button class="b sm" data-act="dup">Duplicate</button><button class="b sm warn" data-act="del">Delete track</button></div></div>`, sh => {
    const name = sh.querySelector('#c_name');
    name.addEventListener('change', () => edit(() => { tr.name = name.value.trim() || inst.label; }));
    sh.querySelector('#c_inst').addEventListener('change', e => {
      edit(() => {
        const ni = I[e.target.value], was = I[tr.inst];
        tr.inst = ni.id; tr.sound = ni.def;
        if (ni.pitched && !was.pitched) { tr.low = ni.base; tr.notes.forEach(n => { n.p = nearestInScale(ni.base + 12); n.len = TPB / tr.res; }); }
        if (!ni.pitched) tr.notes.forEach(n => { delete n.slide; });
        if (tr.name === was.label) tr.name = ni.label;
      });
      channelSheet(tr); audition(tr);
    });
    const f = v => (v > 0 ? '+' : '') + v;
    slider(sh, 'c_vol', v => { tr.vol = v; }, pct);
    slider(sh, 'c_pan', v => { tr.pan = v; }, v => (Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)));
    slider(sh, 'c_pitch', v => { tr.pitch = v; }, v => f(v) + ' st');
    slider(sh, 'c_decay', v => { tr.decay = v; }, v => v.toFixed(2) + '×');
    slider(sh, 'c_tone', v => { tr.tone = v; }, v => (v >= 0.99 ? 'open' : pct(v)));
    slider(sh, 'c_rev', v => { tr.rev = v; }, pct);
    slider(sh, 'c_echo', v => { tr.echo = v; }, pct);
    ['c_pitch', 'c_decay'].forEach(id => sh.querySelector('#' + id).addEventListener('change', () => audition(tr)));
    sh.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const stepT = TPB / tr.res, a0 = ui.bar * TPB;
      if (b.dataset.snd) {
        edit(() => { tr.sound = b.dataset.snd; tr.sample = null; tr.sampleName = null; });
        sh.querySelectorAll('[data-snd]').forEach(x => x.classList.toggle('on', x === b)); audition(tr);
      } else if (b.dataset.res) {
        edit(() => { tr.res = +b.dataset.res; }); channelSheet(tr);
      } else if (b.dataset.fill) {
        const k = +b.dataset.fill;
        edit(() => { clearBar(tr, ui.bar); for (let s = 0; s < tr.res; s += k) addNote(tr, a0 + s * stepT); });
      } else if (b.dataset.shift) {
        const d = +b.dataset.shift;
        edit(() => tr.notes.forEach(n => { if (n.t >= a0 && n.t < a0 + TPB) n.t = a0 + (((n.t - a0) / stepT + d + tr.res) % tr.res) * stepT; }));
      } else {
        const a = b.dataset.act;
        if (a === 'file') pickSample(tr);
        else if (a === 'unsample') { edit(() => { tr.sample = null; tr.sampleName = null; }); channelSheet(tr); }
        else if (a === 'mute') { edit(() => { tr.mute = !tr.mute; }); b.classList.toggle('on', tr.mute); b.textContent = tr.mute ? 'Muted' : 'Mute'; }
        else if (a === 'solo') { edit(() => { tr.solo = !tr.solo; }); b.classList.toggle('on', tr.solo); b.textContent = tr.solo ? 'Soloed' : 'Solo'; }
        else if (a === 'move') { edit(() => { tr.group = other(tr.group); }); ui.group = tr.group; waves.clear(); changed(); closeSheet(); toast(`${tr.name} is in the ${GROUP_NAME[tr.group]} rack`); }
        else if (a === 'random') edit(() => randomize(tr, ui.bar));
        else if (a === 'copyall') { edit(() => copyBar(tr, ui.bar, Array.from({ length: P.bars }, (_, i) => i).filter(i => i !== ui.bar))); toast('Copied to every bar'); }
        else if (a === 'clearbar') edit(() => clearBar(tr, ui.bar));
        else if (a === 'clearall') edit(() => { tr.notes = []; });
        else if (a === 'dup') {
          const c = JSON.parse(JSON.stringify(tr)); c.id = GR.newId(); c.name = tr.name + ' 2'; c.solo = false;
          edit(() => P.tracks.splice(P.tracks.indexOf(tr) + 1, 0, c)); ui.sel = c.id; closeSheet(); renderAll(); toast('Duplicated');
        } else if (a === 'del') {
          edit(() => { P.tracks.splice(P.tracks.indexOf(tr), 1); }); ui.sel = (groupTracks(ui.group)[0] || P.tracks[0] || {}).id || null;
          closeSheet(); changed(); toast(`Deleted ${tr.name}. Undo brings it back.`);
        }
      }
    });
  });
}
function randomize(tr, bar) {
  clearBar(tr, bar);
  const inst = I[tr.inst], stepT = TPB / tr.res, per = tr.res / 4, a0 = bar * TPB;
  const sc = GR.SCALES[P.scale], base = (tr.low != null ? tr.low : 48) + 12;
  const dens = { kick: 0.3, snare: 0.15, clap: 0.15, snap: 0.15, hat: 0.7, openhat: 0.15, shaker: 0.7, conga: 0.35, bell: 0.3, block: 0.35, rim: 0.3, tom: 0.15, fx: 0.08, cymbal: 0.05 }[tr.inst] || 0.35;
  for (let s = 0; s < tr.res; s++) {
    const onBeat = s % per === 0, onEighth = s % (per / 2) === 0;
    const pr = dens * (onBeat ? 1.5 : onEighth ? 1 : 0.6);
    if (Math.random() > pr) continue;
    if (inst.pitched) {
      const deg = Math.floor(Math.random() * sc.length * 1.4);
      const p = nearestInScale(base - (base % 12) + P.key + sc[deg % sc.length] + 12 * Math.floor(deg / sc.length));
      const len = stepT * (1 + Math.floor(Math.random() * 3));
      addNote(tr, a0 + s * stepT, { p, len, vel: 0.7 + Math.random() * 0.3 });
      s += Math.round(len / stepT) - 1;
    } else addNote(tr, a0 + s * stepT, { vel: Math.random() < 0.25 ? 0.42 : 0.75 + Math.random() * 0.25 });
  }
}

function noteSheet(tr, n) {
  const inst = I[tr.inst];
  const sh = openSheet(`${tr.name} · ${inst.pitched ? GR.noteName(n.p) : 'step ' + (Math.floor((n.t % TPB) / (TPB / tr.res)) + 1)}`, `
    ${ctlRow('n_vel', 'Velocity', 0.05, 1, 0.01, n.vel)}
    ${!inst.pitched ? `<div class="sh-sec"><h4>Roll (hits inside the step)</h4><div class="seg">${[1, 2, 3, 4].map(r => `<button data-roll="${r}" class="${(n.roll || 1) === r ? 'on' : ''}">${r === 1 ? 'off' : r + '×'}</button>`).join('')}</div></div>` : `
    <div class="sh-sec"><h4>Pitch</h4><div class="btns"><button class="b sm" data-p="-12">−oct</button><button class="b sm" data-p="-1">−1</button><b id="nP" style="min-width:52px;text-align:center;align-self:center">${GR.noteName(n.p)}</b><button class="b sm" data-p="1">+1</button><button class="b sm" data-p="12">+oct</button></div></div>
    <div class="sh-sec"><h4>Length</h4><div class="btns"><button class="b sm" data-l="-1">shorter</button><b id="nL" style="min-width:64px;text-align:center;align-self:center"></b><button class="b sm" data-l="1">longer</button></div></div>
    ${inst.mono ? `<div class="sh-sec"><div class="btns"><button class="b sm${n.slide ? ' on' : ''}" data-slide>Slide into this note ${n.slide ? 'on' : 'off'}</button></div></div>` : ''}`}
    <div class="sh-sec"><div class="btns"><button class="b sm" data-ghost>${n.vel < 0.5 ? 'Make it full' : 'Make it a ghost note'}</button><button class="b sm warn" data-del>Delete note</button></div></div>`, sh => {
    const stepT = TPB / tr.res;
    const lab = () => { const l = sh.querySelector('#nL'); if (l) l.textContent = `${+(n.len / stepT).toFixed(2)} step${n.len === stepT ? '' : 's'}`; const p = sh.querySelector('#nP'); if (p) p.textContent = GR.noteName(n.p); };
    lab();
    slider(sh, 'n_vel', v => { n.vel = v; }, pct);
    sh.querySelector('#n_vel').addEventListener('change', () => audition(tr, n));
    sh.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.roll) { edit(() => { const r = +b.dataset.roll; if (r > 1) n.roll = r; else delete n.roll; }); sh.querySelectorAll('[data-roll]').forEach(x => x.classList.toggle('on', x === b)); }
      else if (b.dataset.p) { edit(() => { n.p = clamp(n.p + +b.dataset.p, 0, 127); tr.lastP = n.p; }); lab(); audition(tr, n); }
      else if (b.dataset.l) { edit(() => { n.len = Math.max(stepT, n.len + +b.dataset.l * stepT); tr.lastLen = n.len; }); lab(); }
      else if (b.dataset.slide != null) { edit(() => { n.slide = !n.slide; if (!n.slide) delete n.slide; }); b.classList.toggle('on', !!n.slide); b.textContent = 'Slide into this note ' + (n.slide ? 'on' : 'off'); }
      else if (b.dataset.ghost != null) { edit(() => { n.vel = n.vel < 0.5 ? 0.9 : 0.42; }); closeSheet(); }
      else if (b.dataset.del != null) { edit(() => removeNote(tr, n)); closeSheet(); }
    });
  });
}

function addSheet() {
  const cats = {};
  Object.values(I).forEach(x => { (cats[x.cat] = cats[x.cat] || []).push(x); });
  const html = Object.entries(cats).map(([cat, list]) => `<div class="sh-sec"><h4>${cat}</h4>${list.map(x => `<div class="inst"><b>${x.label}</b><div class="btns">${Object.entries(x.sounds).map(([k, v]) => `<button class="b sm" data-inst="${x.id}" data-s="${k}">${v[0]}</button>`).join('')}</div></div>`).join('')}</div>`).join('')
    + `<div class="sh-sec"><h4>Your own sound</h4><div class="btns"><button class="b sm" data-file="fx">One-shot from a file</button><button class="b sm" data-file="keys">Playable instrument from a file</button></div>
       <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">A playable file is treated as middle C and pitched across the piano roll. Files stay in this browser.</p></div>`;
  openSheet(`${P.tracks.length} tracks · add one`, html, sh => {
    sh.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.inst) {
        const t = GR.newTrack(b.dataset.inst, b.dataset.s);
        if (I[t.inst].pitched) t.low = I[t.inst].base;
        edit(() => P.tracks.push(t)); ui.group = t.group; ui.sel = t.id; ui.rollOpen = true; waves.clear();
        closeSheet(); changed(); audition(t); toast(`Added ${t.name}`);
      } else if (b.dataset.file) {
        const t = GR.newTrack(b.dataset.file, null, { name: 'Sample' });
        pickSample(t, true);
      }
    });
  });
}

function menuSheet() {
  let saved = {}; try { saved = JSON.parse(store.get('groove-rack.saved') || '{}'); } catch (e) {}
  const savedHtml = Object.entries(saved).sort((a, b) => b[1].at - a[1].at).map(([k, v]) => `<div class="saved"><span>${esc(v.name)} <small>· ${new Date(v.at).toLocaleDateString()}</small></span><button class="b sm" data-open="${esc(k)}">Open</button><button class="b sm warn" data-rm="${esc(k)}" aria-label="Delete ${esc(v.name)}">✕</button></div>`).join('') || '<p class="hint" style="text-align:left;padding:0;margin:0">Nothing saved yet.</p>';
  openSheet('Groove Rack', `
    <div class="sh-sec"><h4>Project name</h4><input class="txt" id="m_name" value="${esc(P.name)}" maxlength="40" autocomplete="off"></div>
    <div class="sh-sec"><h4>Start from a genre</h4><div class="cards">${GR.PRESETS.map(p => `<button class="card" data-preset="${p.id}"><b>${p.name}</b><i class="bpm">${p.bpm} BPM · ${p.bars} bars</i><span>${p.mood}</span></button>`).join('')}</div>
      <div class="btns" style="margin-top:8px"><button class="b sm" data-act="blank">Blank project</button></div></div>
    <div class="sh-sec"><h4>Saved in this browser</h4><div class="btns" style="margin-bottom:8px"><button class="b sm gold" data-act="save">Save “${esc(P.name)}”</button></div>${savedHtml}</div>
    <div class="sh-sec"><h4>Export</h4><div class="btns">
      <button class="b sm" data-wav="1">WAV loop</button><button class="b sm" data-wav="2">WAV × 2</button><button class="b sm" data-wav="4">WAV × 4</button>
      <button class="b sm" data-act="stems">WAV stems</button><button class="b sm" data-act="midi">MIDI file</button></div>
      <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">WAV files loop cleanly: reverb and echo tails wrap around to the start. MIDI has a track per instrument, drums on channel 10.</p></div>
    <div class="sh-sec"><h4>Share</h4><div class="btns"><button class="b sm" data-act="link">Copy share link</button><button class="b sm" data-act="json">Project file</button><button class="b sm" data-act="import">Open project file…</button></div></div>
    <div class="sh-sec"><h4>History</h4><div class="btns"><button class="b sm" data-act="undo">Undo</button><button class="b sm" data-act="redo">Redo</button></div></div>
    <div class="sh-sec"><h4>Keyboard</h4><div class="keys-list">
      <kbd>Space</kbd><span>Play / stop</span><kbd>← →</kbd><span>Previous / next bar</span><kbd>↑ ↓</kbd><span>Select track</span>
      <kbd>G</kbd><span>Switch Drums / Audio rack</span><kbd>M</kbd><span>Mute selected track</span><kbd>S</kbd><span>Solo selected track</span>
      <kbd>Delete</kbd><span>Clear the bar on the selected track</span><kbd>Ctrl Z</kbd><span>Undo (Shift for redo)</span></div></div>`, sh => {
    const nm = sh.querySelector('#m_name');
    nm.addEventListener('change', () => edit(() => { P.name = nm.value.trim() || 'Untitled beat'; }));
    sh.addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.preset) {
        const pr = GR.PRESETS.find(p => p.id === b.dataset.preset);
        commit(); load(GR.buildPreset(pr), true); ui.group = 'drums'; ui.sel = (groupTracks('drums')[0] || {}).id; ui.bar = 0; renderAll();
        closeSheet(); toast(`${pr.name} loaded · ${pr.bpm} BPM`);
        if (S.playing) { S.st = GR.newState(); }
      } else if (b.dataset.open) {
        const v = saved[b.dataset.open]; if (!v) return;
        commit(); load(JSON.parse(v.data), true); closeSheet(); toast(`Opened ${v.name}`);
      } else if (b.dataset.rm) {
        delete saved[b.dataset.rm]; store.set('groove-rack.saved', JSON.stringify(saved)); b.closest('.saved').remove(); toast('Deleted from this browser');
      } else if (b.dataset.wav) exportWav(+b.dataset.wav);
      else {
        const a = b.dataset.act;
        if (a === 'blank') { commit(); load(GR.emptyProject(), true); closeSheet(); toast('Blank project. Undo brings the old one back.'); }
        else if (a === 'save') {
          const key = P.name.toLowerCase(); saved[key] = { name: P.name, at: Date.now(), data: snap() };
          toast(store.set('groove-rack.saved', JSON.stringify(saved)) ? `Saved “${P.name}”` : 'This browser blocks saving'); menuSheet();
        }
        else if (a === 'midi') { download(GR.midi(P), fileName('mid')); toast('MIDI file ready'); }
        else if (a === 'stems') exportStems();
        else if (a === 'json') download(new Blob([snap()], { type: 'application/json' }), fileName('json'));
        else if (a === 'import') $('#projIn').click();
        else if (a === 'link') shareLink();
        else if (a === 'undo') undo();
        else if (a === 'redo') redo();
      }
    });
  });
}

/* ---------- files ---------- */
const fileName = ext => `${(P.name || 'beat').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'beat'}_${P.bpm}bpm.${ext}`;
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
async function exportWav(loops) {
  toast('Bouncing…', 6000);
  try {
    await waitSamples();
    const buf = await GR.render(P, { loops, tail: 3 });
    download(GR.wav(buf), fileName(loops > 1 ? `x${loops}.wav` : 'wav'));
    toast(`WAV ready · ${buf.duration.toFixed(1)} s`);
  } catch (e) { console.error(e); toast('Could not bounce: ' + e.message); }
}
async function exportStems() {
  toast('Bouncing stems…', 8000);
  try {
    await waitSamples();
    for (const tr of P.tracks) {
      if (!tr.notes.length) continue;
      const solo = Object.assign({}, P, { tracks: P.tracks.map(t => Object.assign({}, t, { mute: t.id !== tr.id, solo: false })) });
      const buf = await GR.render(solo, { loops: 1, tail: 3 });
      download(GR.wav(buf), fileName('wav').replace('.wav', `_${tr.name.replace(/[^\w]+/g, '')}.wav`));
      await new Promise(r => setTimeout(r, 350));
    }
    toast('Stems ready');
  } catch (e) { console.error(e); toast('Could not bounce: ' + e.message); }
}
async function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let out = bytes, tag = 'j';
  if (window.CompressionStream) {
    try { out = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); tag = 'z'; } catch (e) { out = bytes; tag = 'j'; }
  }
  let s = ''; out.forEach(c => { s += String.fromCharCode(c); });
  return tag + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function unb64url(s) {
  const tag = s[0], b = atob(s.slice(1).replace(/-/g, '+').replace(/_/g, '/'));
  let bytes = Uint8Array.from(b, c => c.charCodeAt(0));
  if (tag === 'z') bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  return new TextDecoder().decode(bytes);
}
async function shareLink() {
  const data = JSON.parse(snap()); data.tracks.forEach(t => { delete t.sample; delete t.sampleName; });
  const url = location.href.split('#')[0] + '#p=' + await b64url(JSON.stringify(data));
  try { await navigator.clipboard.writeText(url); toast('Link copied. Sound files you loaded stay on this device.'); }
  catch (e) { openSheet('Share link', `<p class="hint" style="text-align:left;padding:0">Copy this link:</p><textarea class="txt" rows="5" readonly style="font-size:12px">${esc(url)}</textarea>`, sh => { const t = sh.querySelector('textarea'); t.focus(); t.select(); }); }
}

/* samples live in IndexedDB so they survive a reload */
const idb = {
  db: null,
  open() {
    if (this.db) return this.db;
    this.db = new Promise((res, rej) => {
      const r = indexedDB.open('groove-rack', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('samples');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async put(k, v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('samples', 'readwrite'); tx.objectStore('samples').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction('samples').objectStore('samples').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
};
let sampleTarget = null;
function pickSample(tr, isNew) { sampleTarget = { tr, isNew }; $('#fileIn').value = ''; $('#fileIn').click(); }
async function onSampleFile(file) {
  if (!file || !sampleTarget) return;
  const { tr, isNew } = sampleTarget; sampleTarget = null;
  try {
    audio();
    const ab = await file.arrayBuffer();
    const buf = await new Promise((res, rej) => ctx.decodeAudioData(ab.slice(0), res, rej));
    const id = 's' + Date.now().toString(36);
    GR.samples.set(id, buf);
    try { await idb.put(id, { name: file.name, data: ab }); } catch (e) { console.warn(e); }
    const nm = file.name.replace(/\.[^.]+$/, '').slice(0, 20);
    edit(() => {
      tr.sample = id; tr.sampleName = nm;
      if (isNew) { tr.name = nm.slice(0, 14) || 'Sample'; P.tracks.push(tr); }
    });
    if (isNew) { ui.group = tr.group; ui.sel = tr.id; waves.clear(); changed(); }
    closeSheet(); audition(tr); toast(`Loaded ${file.name}`);
  } catch (e) { console.error(e); toast('That file is not audio this browser can play'); }
}
let samplesP = Promise.resolve();
function loadSamples() {
  samplesP = (async () => {
    for (const tr of P.tracks) {
      if (!tr.sample || GR.samples.has(tr.sample)) continue;
      try {
        const rec = await idb.get(tr.sample);
        if (!rec) { toast(`The sound file for ${tr.name} is not in this browser. It plays its synth sound.`); continue; }
        audio();
        const buf = await new Promise((res, rej) => ctx.decodeAudioData(rec.data.slice(0), res, rej));
        GR.samples.set(tr.sample, buf);
      } catch (e) { console.warn(e); }
    }
    wavesSoon();
  })();
  return samplesP;
}
const waitSamples = () => samplesP;

/* ---------- small UI helpers ---------- */
let toastT = 0, toastEl = null;
function toast(msg, ms) {
  if (toastEl) toastEl.remove();
  toastEl = document.createElement('div'); toastEl.className = 'toast'; toastEl.setAttribute('role', 'status'); toastEl.textContent = msg;
  document.body.appendChild(toastEl);
  clearTimeout(toastT); toastT = setTimeout(() => { if (toastEl) { toastEl.remove(); toastEl = null; } }, ms || 2200);
}
let hudEl = null;
function hud(msg) {
  if (!msg) { if (hudEl) { hudEl.remove(); hudEl = null; } return; }
  if (!hudEl) { hudEl = document.createElement('div'); hudEl.className = 'toast'; document.body.appendChild(hudEl); }
  hudEl.textContent = msg;
}

/* ---------- wiring ---------- */
function wire() {
  $('#playBtn').addEventListener('click', toggle);
  $('#undoBtn').addEventListener('click', undo);
  $('#groupBtn').addEventListener('click', () => {
    ui.group = other(ui.group);
    const g = groupTracks(ui.group); if (g.length && !g.some(t => t.id === ui.sel)) ui.sel = g[0].id;
    renderAll(); wavesSoon();
  });
  $('#menuBtn').addEventListener('click', menuSheet);
  $('#muteBtn').addEventListener('click', () => { ui.muted = !ui.muted; if (mix) GR.updateMix(mix, P, ui.muted); renderRackHead(); });
  $('#barBtn').addEventListener('click', barSheet);
  $('#mixBtn').addEventListener('click', () => { ui.view = ui.view === 'mix' ? 'steps' : 'mix'; renderRackHead(); renderRack(); });
  $('#stepBtn').addEventListener('click', () => { ui.view = ui.view === 'steps' ? 'mix' : 'steps'; renderRackHead(); renderRack(); });
  $('#foldBtn').addEventListener('click', () => { ui.folded = !ui.folded; renderRackHead(); renderRoll(); });
  $('#bpmBtn').addEventListener('click', songSheet);
  $('#tracksBtn').addEventListener('click', addSheet);
  $('#soundBtn').addEventListener('click', () => {
    const tr = selTrack(); if (!tr) return addSheet();
    const keys = Object.keys(I[tr.inst].sounds);
    edit(() => { tr.sound = keys[(keys.indexOf(tr.sound) + 1) % keys.length]; tr.sample = null; tr.sampleName = null; });
    audition(tr);
  });
  $('#progress').addEventListener('click', e => { const b = e.target.closest('[data-bar]'); if (b) seek(+b.dataset.bar); });

  // master knob: drag up or down
  const knob = $('#knob');
  knob.addEventListener('pointerdown', e => {
    e.preventDefault(); const y0 = e.clientY, m0 = P.master; commit();
    try { knob.setPointerCapture(e.pointerId); } catch (err) {}
    const mv = ev => { P.master = clamp(m0 - (ev.clientY - y0) / 160, 0, 1); if (mix) GR.updateMix(mix, P, ui.muted); renderRackHead(); hud(`master ${Math.round(P.master * 100)}%`); };
    const up = () => { knob.removeEventListener('pointermove', mv); knob.removeEventListener('pointerup', up); knob.removeEventListener('pointercancel', up); hud(null); settle(); autosave(); };
    knob.addEventListener('pointermove', mv); knob.addEventListener('pointerup', up); knob.addEventListener('pointercancel', up);
  });
  knob.addEventListener('dblclick', () => edit(() => { P.master = 0.8; }));
  knob.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); edit(() => { P.master = clamp(P.master + 0.05, 0, 1); }); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); edit(() => { P.master = clamp(P.master - 0.05, 0, 1); }); }
  });

  const rg = $('#rackGrid');
  rg.addEventListener('pointerdown', onLaneDown);
  rg.addEventListener('click', e => onRowClick(e, false));
  rg.addEventListener('contextmenu', e => { if (e.target.closest('.lane')) e.preventDefault(); });
  rg.addEventListener('input', onMixInput);
  rg.addEventListener('change', onMixChange);
  // hold a track name for its settings
  let holdT = 0;
  rg.addEventListener('pointerdown', e => {
    const b = e.target.closest('.tname'); if (!b) return;
    const tr = track(b.closest('.row').dataset.id);
    holdT = setTimeout(() => { holdT = -1; select(tr.id, false); channelSheet(tr); }, 520);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => rg.addEventListener(ev, () => { if (holdT > 0) clearTimeout(holdT); }, true));
  rg.addEventListener('click', e => { if (holdT === -1 && e.target.closest('.tname')) { e.stopImmediatePropagation(); holdT = 0; } }, true);

  const pg = $('#plGrid');
  pg.addEventListener('click', e => {
    const lane = e.target.closest('.lane');
    if (lane) { const r = lane.getBoundingClientRect(); seek(clamp(Math.floor((e.clientX - r.left) / r.width * P.bars), 0, P.bars - 1)); return; }
    const num = e.target.closest('.nums span');
    if (num) { seek(Array.from(num.parentNode.children).indexOf(num)); return; }
    onRowClick(e, true);
  });

  const roll = $('#roll');
  roll.addEventListener('pointerdown', onRollDown);
  roll.addEventListener('click', onRollClick);
  roll.addEventListener('contextmenu', e => { if (e.target.closest('#rcanvas')) e.preventDefault(); });

  $('#fileIn').addEventListener('change', e => onSampleFile(e.target.files[0]));
  $('#projIn').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const data = JSON.parse(await f.text()); commit(); load(data, true); closeSheet(); toast(`Opened ${f.name}`); }
    catch (err) { toast('That file is not a Groove Rack project'); }
    e.target.value = '';
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sheetEl) { closeSheet(); return; }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || sheetEl) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;
    const tr = selTrack();
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek((ui.bar - 1 + P.bars) % P.bars); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek((ui.bar + 1) % P.bars); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault(); const g = groupTracks(ui.group); if (!g.length) return;
      const i = g.findIndex(t => t.id === ui.sel); const n = g[clamp(i + (e.key === 'ArrowUp' ? -1 : 1), 0, g.length - 1)];
      select(n.id, I[n.inst].pitched);
    }
    else if (e.key === 'g' || e.key === 'G') $('#groupBtn').click();
    else if ((e.key === 'm' || e.key === 'M') && tr) { edit(() => { tr.mute = !tr.mute; }); toast(tr.mute ? `${tr.name} muted` : `${tr.name} on`); }
    else if ((e.key === 's' || e.key === 'S') && tr) { edit(() => { tr.solo = !tr.solo; }); toast(tr.solo ? `${tr.name} solo` : `${tr.name} solo off`); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && tr) { e.preventDefault(); edit(() => clearBar(tr, ui.bar)); toast(`Cleared bar ${ui.bar + 1} of ${tr.name}`); }
  });

  let rsT = 0;
  window.addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => groupTracks(other(ui.group)).forEach(t => drawWave(t.id)), 120); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) autosave(); });
}

/* ---------- start ---------- */
async function init() {
  let start = null;
  const m = /#p=([\w-]+)/.exec(location.hash);
  if (m) { try { start = JSON.parse(await unb64url(m[1])); history.replaceState(null, '', location.pathname + location.search); } catch (e) { console.warn(e); } }
  if (!start) { try { start = JSON.parse(store.get('groove-rack.current') || 'null'); } catch (e) { start = null; } }
  if (!start || !start.tracks) start = GR.buildPreset(GR.PRESETS[0]);
  load(start);
  if (m && start) toast('Opened shared beat · press play');
  wire();
  requestAnimationFrame(frame);
}
init();
GR.app = { get P() { return P; }, ui, play, stop, load, seek };
})();
