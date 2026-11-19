/* Liftoff page: controls, the flight path display, presets, and either the browser's audio engine
   (a worklet running dsp.js, a delay and a convolver) or, inside the plugin, the bridge to the C++ engine. */
(() => {
'use strict';
const LF = globalThis.Liftoff;
const { PHRASE_BARS, LENGTH_BARS, VERB_BEATS, GAP_BEATS, MODE, VERB_MODE } = LF;
const DEFS = {}; for (const p of LIFTOFF_PARAMS) DEFS[p.id] = p;
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ---------- plugin bridge ----------
   Inside the plugin the page runs in JUCE's web view; the C++ engine does the sound and the page calls it
   through native functions. */
const HOST = (() => {
  const J = window.__JUCE__; if (!J || !J.backend) return null;
  let next = 1; const waiting = new Map();
  J.backend.addEventListener('__juce__complete', m => { const r = waiting.get(m.promiseId); if (r) { waiting.delete(m.promiseId); r(m.result); } });
  return {
    call(name, ...params) { return new Promise(res => { const id = next++; waiting.set(id, res); J.backend.emitEvent('__juce__invoke', { name, params, resultId: id }); }); },
    on(ev, fn) { J.backend.addEventListener(ev, fn); }
  };
})();
if (HOST) document.documentElement.classList.add('in-plugin');

/* ---------- state ---------- */
const V = {}; for (const p of LIFTOFF_PARAMS) V[p.id] = p.def;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('liftoff.' + k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('liftoff.' + k, JSON.stringify(v)); } catch (e) {} }
};
let bpm = 124, bpb = 4, presetIdx = 0;
if (!HOST) {
  const saved = store.get('params'); if (saved) for (const k in saved) if (k in V) V[k] = saved[k];
  bpm = store.get('bpm') || bpm; presetIdx = store.get('preset') ?? 0;
}

/* ---------- formatting ---------- */
function fmt(id, v) {
  const d = DEFS[id];
  if (id === 'pitch') return (v >= 0.05 ? '+' : '') + v.toFixed(v < 10 ? 1 : 0) + ' st';
  if (id === 'output') return (v > 0.05 ? '+' : '') + v.toFixed(1) + ' dB';
  if (id === 'curve') return Math.abs(v) < 0.03 ? 'linear' : (v > 0 ? 'late ' : 'early ') + Math.round(Math.abs(v) * 100);
  if (d.unit === '%') return Math.round(v * 100) + '%';
  return v.toFixed(2);
}
const KNOB_LABEL = { pitch: 'PITCH', filter: 'FILTER', wash: 'WASH', stutter: 'STUTTER', noise: 'NOISE', width: 'WIDTH',
  verbSize: 'SIZE', verbTone: 'TONE', verbMix: 'MIX', impact: 'IMPACT', mix: 'MIX', output: 'OUTPUT', curve: 'CURVE' };
const KNOB_TIP = {
  pitch: 'How far the sound pitches up by the drop', filter: 'High-pass sweep that thins the sound out', wash: 'Reverb that swallows the sound as it rises',
  stutter: 'Gate that speeds up from 1/4 to 1/32 notes', noise: 'A white-noise riser that sweeps up', width: 'Stereo widening toward the drop',
  verbSize: 'Longer, fuller tail', verbTone: 'Darker or brighter swell', verbMix: 'Level of the reverse swell', impact: 'Sub boom and crack on the drop',
  mix: 'Dry/wet for the whole effect', output: 'Output level', curve: 'Late: slow start, rushes at the end. Early: jumps up, then hangs'
};
const SEG_LABEL = {
  mode: ['AUTO', 'MANUAL', 'TRIGGER'], phrase: ['4', '8', '16', '32'], length: ['½', '1', '2', '4', '8'],
  verbMode: ['DROP', 'BUILD', 'ALWAYS'], verbLen: ['1/8', '1/4', '1/2', '1 BAR'], gap: ['OFF', '1/16', '1/8', '1/4', '1/2'],
  gapStyle: ['CUT', 'TAPE', 'FILTER', 'STUTTER']
};
const SEG_TIP = {
  mode: ['The build fills the end of every phrase and drops on its first bar', 'Ride or automate BUILD yourself: pull it down to drop', 'LAUNCH or a MIDI note starts a build; it drops BUILD LENGTH later'],
  verbMode: ['Reverse swell made from the drop’s first hit, landing on it', 'Reverse swells on everything, growing through the build', 'Reverse swell on every sound, all the time'],
  gapStyle: ['Silence before the drop', 'The beat slows to a stop', 'The beat sinks into a low-pass', 'The first 1/16 of the gap repeats']
};

/* ---------- controls ---------- */
const views = {};   // id -> { update(v) }
function knob(host, id) {
  const d = DEFS[id], span = d.max - d.min;
  host.classList.add('knob'); host.tabIndex = 0;
  host.setAttribute('role', 'slider'); host.setAttribute('aria-label', d.name);
  host.setAttribute('aria-valuemin', d.min); host.setAttribute('aria-valuemax', d.max);
  if (KNOB_TIP[id]) host.title = KNOB_TIP[id];
  // a machined cap on a ring of ticks; the lit arc runs in a groove between them
  const R = 28, C = 38, a0 = -225, a1 = 45;
  const pt = (deg, r) => [C + r * Math.cos(deg * Math.PI / 180), C + r * Math.sin(deg * Math.PI / 180)];
  const arc = (from, to, r) => {
    if (to - from < 0.5) return '';
    const [x0, y0] = pt(from, r), [x1, y1] = pt(to, r);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  let ticks = '';
  for (let k = 0; k <= 30; k++) {
    const a = a0 + k / 30 * (a1 - a0), major = k % 5 === 0, [x0, y0] = pt(a, major ? 33 : 33.5), [x1, y1] = pt(a, 37);
    ticks += `<line class="tick${major ? ' major' : ''}" x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}" stroke-width="${major ? 1.4 : 0.9}" stroke-linecap="round"/>`;
  }
  const bipolar = d.min < 0 && d.max > 0;
  host.innerHTML = `<div class="kn"><svg viewBox="0 0 76 76">${ticks}
    <path class="trk" d="${arc(a0, a1, R)}" fill="none" stroke-width="5" stroke-linecap="round"/>
    <path class="arc" fill="none" stroke-width="3.2" stroke-linecap="round"/><path class="mod-arc" fill="none" stroke-width="1.3" stroke-linecap="round"/></svg>
    <div class="cap"><div class="ind"></div></div></div>
    <span class="k-lbl">${KNOB_LABEL[id] || d.name.toUpperCase()}</span><span class="k-val"></span>`;
  const [arcEl, modEl, ind, val] = [host.querySelector('.arc'), host.querySelector('.mod-arc'), host.querySelector('.ind'), host.querySelector('.k-val')];
  const toDeg = v => a0 + (v - d.min) / span * (a1 - a0);
  const zeroDeg = bipolar ? toDeg(0) : a0;
  let shownMod = -1;
  const view = {
    update(v) {
      const deg = toDeg(v);
      arcEl.setAttribute('d', deg >= zeroDeg ? arc(zeroDeg, deg, R) : arc(deg, zeroDeg, R));
      ind.style.transform = `rotate(${(deg + 90).toFixed(2)}deg)`;
      val.textContent = fmt(id, v); host.setAttribute('aria-valuenow', v.toFixed(3)); host.setAttribute('aria-valuetext', fmt(id, v));
    },
    mod(m) {   // live modulation: how much of the knob's amount is in play right now
      const q = Math.round(m * 200) / 200; if (q === shownMod) return; shownMod = q;
      modEl.setAttribute('d', q > 0 ? arc(a0, a0 + q * (a1 - a0), R - 4.5) : '');
    }
  };
  views[id] = view;
  let startY = 0, startV = 0, dragging = false;
  host.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    host.focus(); host.setPointerCapture(e.pointerId); dragging = true; startY = e.clientY; startV = V[id];
    gesture(id, true); e.preventDefault();
  });
  host.addEventListener('pointermove', e => {
    if (!dragging) return;
    const k = e.shiftKey ? 900 : 220;
    setParam(id, clamp(startV + (startY - e.clientY) / k * span, d.min, d.max));
  });
  const end = () => { if (dragging) { dragging = false; gesture(id, false); } };
  host.addEventListener('pointerup', end); host.addEventListener('pointercancel', end);
  host.addEventListener('dblclick', () => { gesture(id, true); setParam(id, d.def); gesture(id, false); });
  host.addEventListener('wheel', e => { e.preventDefault(); setParam(id, clamp(V[id] + (e.deltaY < 0 ? 1 : -1) * span / (e.shiftKey ? 200 : 50), d.min, d.max)); }, { passive: false });
  host.addEventListener('keydown', e => {
    const step = span / (e.shiftKey ? 200 : 40);
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setParam(id, clamp(V[id] + step, d.min, d.max)); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setParam(id, clamp(V[id] - step, d.min, d.max)); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'Home') { setParam(id, d.min); e.preventDefault(); } else if (e.key === 'End') { setParam(id, d.max); e.preventDefault(); }
  });
}

function seg(host, id) {
  const d = DEFS[id], labels = SEG_LABEL[id] || d.choices;
  host.innerHTML = labels.map((l, i) => `<button type="button" role="radio" data-i="${i}" title="${(SEG_TIP[id] && SEG_TIP[id][i]) || d.choices[i]}">${l}</button>`).join('');
  const btns = [...host.children];
  host.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { gesture(id, true); setParam(id, +b.dataset.i); gesture(id, false); } });
  host.addEventListener('keydown', e => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!dir) return;
    e.preventDefault(); e.stopPropagation();
    const i = clamp(V[id] + dir, 0, labels.length - 1); setParam(id, i); btns[i].focus();
  });
  views[id] = { update(v) { btns.forEach((b, i) => { b.setAttribute('aria-checked', i === v); b.tabIndex = i === v ? 0 : -1; }); } };
}

function toggle(btn, id) {
  btn.addEventListener('click', () => { gesture(id, true); setParam(id, V[id] ? 0 : 1); gesture(id, false); });
  const mod = btn.closest('.mod');
  views[id] = { update(v) { btn.setAttribute('aria-checked', !!v); if (mod) mod.classList.toggle('off', !v); } };
}

function fader(el, id) {
  const fill = el.querySelector('i'), val = $('#buildVal');
  let dragging = false;
  const at = e => { const r = el.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
  el.addEventListener('pointerdown', e => { if (V.mode !== MODE.MANUAL) return; el.setPointerCapture(e.pointerId); dragging = true; gesture(id, true); setParam(id, at(e)); });
  el.addEventListener('pointermove', e => { if (dragging) setParam(id, at(e)); });
  const end = () => { if (dragging) { dragging = false; gesture(id, false); } };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', e => {
    if (V.mode !== MODE.MANUAL) return;
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (dir) { setParam(id, clamp(V[id] + dir * 0.05, 0, 1)); e.preventDefault(); e.stopPropagation(); }
  });
  views[id] = { update(v) { fill.style.width = (v * 100) + '%'; val.textContent = Math.round(v * 100) + '%'; el.setAttribute('aria-valuenow', Math.round(v * 100)); } };
}

document.querySelectorAll('[data-knob]').forEach(el => knob(el, el.dataset.knob));
document.querySelectorAll('.seg[data-param]').forEach(el => seg(el, el.dataset.param));
document.querySelectorAll('[data-toggle]').forEach(el => toggle(el, el.dataset.toggle));
fader($('#buildFader'), 'build');

/* ---------- parameters ---------- */
function setParam(id, v, fromHost) {
  const d = DEFS[id]; if (!d) return;
  v = d.type === 'float' ? clamp(+v, d.min, d.max) : Math.round(+v);
  if (V[id] === v) return;
  V[id] = v;
  if (views[id]) views[id].update(v);
  if (!fromHost) { engine.set(id, v); markEdited(); }
  if (id === 'mode') modeChanged();
  if (['verb', 'verbLen', 'verbSize', 'verbTone'].includes(id)) engine.irChanged();
  saveSoon();
}
function gesture(id, begin) { engine.gesture(id, begin); }
function modeChanged() {
  const manual = V.mode === MODE.MANUAL, trig = V.mode === MODE.TRIGGER;
  $('#buildFader').setAttribute('aria-disabled', !manual);
  $('#launch').disabled = !trig;
  $('#launch').title = trig ? 'Start a build on the next bar. L' : 'Switch MODE to TRIGGER to launch builds by hand or with MIDI notes';
  document.querySelector('[data-param="phrase"]').closest('.grp').style.opacity = V.mode === MODE.AUTO ? '' : '.4';
}
let saveT = 0;
function saveSoon() { if (HOST) return; clearTimeout(saveT); saveT = setTimeout(() => { store.set('params', V); store.set('bpm', bpm); store.set('preset', presetIdx); }, 300); }
function refreshAll() { for (const id in views) views[id].update(V[id]); modeChanged(); }

/* ---------- presets ---------- */
const presetSel = $('#preset');
presetSel.innerHTML = LIFTOFF_PRESETS.map((p, i) => `<option value="${i}" title="${p.tag}">${p.name}</option>`).join('');
let edited = false;
function markEdited() {
  const p = LIFTOFF_PRESETS[presetIdx]; if (!p) return;
  const same = Object.keys(p.values).every(k => Math.abs(V[k] - p.values[k]) < 1e-6);
  if (same === !edited) return;
  edited = !same;
  presetSel.options[presetIdx].textContent = p.name + (edited ? ' *' : '');
}
function loadPreset(i) {
  presetIdx = (i + LIFTOFF_PRESETS.length) % LIFTOFF_PRESETS.length;
  const p = LIFTOFF_PRESETS[presetIdx];
  for (const k in p.values) { gesture(k, true); setParam(k, p.values[k]); gesture(k, false); }
  for (const o of presetSel.options) o.textContent = LIFTOFF_PRESETS[o.value].name;
  edited = false; presetSel.value = presetIdx; presetSel.title = p.tag;
  toast(`${p.name}: ${p.tag}`);
  saveSoon(); if (HOST) HOST.call('setPreset', presetIdx);
}
presetSel.addEventListener('change', () => loadPreset(+presetSel.value));
$('#prevPreset').addEventListener('click', () => loadPreset(presetIdx - 1));
$('#nextPreset').addEventListener('click', () => loadPreset(presetIdx + 1));

/* ---------- toast ---------- */
let toastT = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }

/* ---------- telemetry: what the engine is doing, shown in time with what you hear ---------- */
const T = { st: null, at: 0, queue: [], drops: -1, dropAt: -1e9, playing: false };
function receive(st, delayMs) {
  T.queue.push({ st, due: performance.now() + Math.max(0, delayMs) });
}
function pump(now) {
  while (T.queue.length && T.queue[0].due <= now) {
    const { st } = T.queue.shift();
    if (T.drops >= 0 && st.drops > T.drops) { T.dropAt = now; flash(); }
    T.drops = st.drops; T.st = st; T.at = now;
  }
}
function flash() { const f = $('#flash'); f.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on'))); }

/* ---------- engines ---------- */
const engine = HOST ? pluginEngine() : browserEngine();

function pluginEngine() {
  let latency = 0, sr = 48000;
  HOST.on('state', st => {
    bpm = st.bpm || bpm; bpb = st.bpb || bpb; latency = st.latency || 0; sr = st.sr || sr;
    $('#hostInfo').textContent = `${st.hostPlaying ? '▶' : '■'} DAW · ${bpm.toFixed(bpm % 1 ? 1 : 0)} BPM · ${Math.round(bpb)}/4${latency ? ` · ${Math.round(latency / sr * 1000)} ms latency` : ''}`;
    receive(st, latency / sr * 1000);
  });
  HOST.on('params', vals => { for (const k in vals) setParam(k, vals[k], true); markEdited(); });
  HOST.call('getParams').then(r => {
    if (r && r.values) { for (const k in r.values) setParam(k, r.values[k], true); }
    if (r && typeof r.preset === 'number') { presetIdx = r.preset; presetSel.value = presetIdx; }
    markEdited();
  });
  return {
    set(id, v) { HOST.call('setParam', id, v); },
    gesture(id, begin) { HOST.call('gesture', id, begin); },
    irChanged() {}, launch() { HOST.call('launch'); },
    get latencyBeats() { return latency / sr * bpm / 60; }
  };
}

function browserEngine() {
  const A = { ctx: null, node: null, delay: null, conv: null, master: null, src: null, buffer: null, playing: false, start: 0, irKey: '', ready: null, name: 'Demo loop' };
  let irT = 0;
  // the audio thread gets dsp.js and worklet.js as one module; a blob URL works from a web server,
  // a data URL from a page opened straight from disk (file://)
  const moduleSrc = () => `(${LiftoffDSP.toString()})(globalThis);\n(${LiftoffWorklet.toString()})();\n`;
  async function addModule(ctx) {
    try { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([moduleSrc()], { type: 'text/javascript' }))); }
    catch (e) { await ctx.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(moduleSrc())); }
  }
  async function build(ctx) {
    await addModule(ctx);
    const node = new AudioWorkletNode(ctx, 'liftoff', { numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [2, 2], channelCount: 2, channelCountMode: 'explicit' });
    const delay = ctx.createDelay(8), conv = ctx.createConvolver(), master = ctx.createGain();
    conv.normalize = false;
    node.connect(delay, 0); node.connect(conv, 1); delay.connect(master); conv.connect(master);
    node.port.postMessage({ type: 'params', params: { ...V }, snap: true });
    return { node, delay, conv, master };
  }
  function latencySamples(sr) { return V.verb ? Math.round(VERB_BEATS[V.verbLen] * 60 / bpm * sr) : 0; }
  function applyIR(g, sr) {
    const N = latencySamples(sr);
    if (N > 0) {
      const ir = LF.makeReverseIR(sr, N, V.verbSize, V.verbTone);
      const b = new AudioBuffer({ length: ir[0].length, numberOfChannels: 2, sampleRate: sr });
      b.copyToChannel(ir[0], 0); b.copyToChannel(ir[1], 1);
      g.conv.buffer = b;
    }
    g.delay.delayTime.value = N / sr;
    return N;
  }
  function ensure() {
    if (A.ready) return A.ready;
    A.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    A.ready = (async () => {
      const g = await build(A.ctx);
      Object.assign(A, g);
      A.master.connect(A.ctx.destination);
      A.node.port.onmessage = e => {
        const st = e.data; if (st.type !== 'state') return;
        const sr = A.ctx.sampleRate, lat = latencySamples(sr) / sr + (A.ctx.outputLatency || A.ctx.baseLatency || 0);
        st.beat = st.playing ? (st.frame - A.start) * bpm / 60 / sr : st.beat;
        receive(st, lat * 1000);
      };
      A.irKey = ''; refreshIR();
      if (!A.buffer) A.buffer = await demoLoop(A.ctx.sampleRate);
    })();
    return A.ready;
  }
  function refreshIR() {
    if (!A.ctx) return;
    const key = [V.verb, V.verbLen, V.verbSize.toFixed(3), V.verbTone.toFixed(3), bpm, A.ctx.sampleRate].join('|');
    if (key === A.irKey) return;
    A.irKey = key; applyIR(A, A.ctx.sampleRate);
  }
  async function play() {
    await ensure(); await A.ctx.resume();
    if (A.playing) return;
    const src = A.ctx.createBufferSource(); src.buffer = A.buffer; src.loop = true; src.connect(A.node);
    const t0 = A.ctx.currentTime + 0.06;
    src.start(t0); A.src = src; A.playing = true; A.start = Math.round(t0 * A.ctx.sampleRate);
    A.node.port.postMessage({ type: 'transport', playing: true, start: A.start, bpm, bpb });
    $('#play').setAttribute('aria-pressed', 'true'); $('#play').setAttribute('aria-label', 'Stop');
    $('#playIcon').setAttribute('d', 'M6 5h4.5v14H6zM13.5 5H18v14h-4.5z');
  }
  function stop() {
    if (!A.playing) return;
    try { A.src.stop(); } catch (e) {}
    A.src.disconnect(); A.src = null; A.playing = false;
    A.node.port.postMessage({ type: 'transport', playing: false });
    $('#play').setAttribute('aria-pressed', 'false'); $('#play').setAttribute('aria-label', 'Play');
    $('#playIcon').setAttribute('d', 'M7 4.5v15l13-7.5z');
  }
  function setBpm(v) {
    v = clamp(+v || 120, 40, 300);
    if (A.playing) {   // keep the beat position where it is
      const sr = A.ctx.sampleRate, now = A.ctx.currentTime * sr, beat = (now - A.start) * bpm / 60 / sr;
      A.start = Math.round(now - beat * 60 / v * sr);
      A.node.port.postMessage({ type: 'transport', playing: true, start: A.start, bpm: v, bpb });
    }
    bpm = v; $('#bpm').value = +v.toFixed(2); refreshIR(); saveSoon();
  }
  async function load(file) {
    await ensure();
    try {
      const buf = await A.ctx.decodeAudioData(await file.arrayBuffer());
      const wasPlaying = A.playing; stop();
      A.buffer = buf; A.name = file.name.replace(/\.[^.]+$/, '');
      $('#srcName').textContent = A.name;
      const m = file.name.match(/(\d{2,3}(?:\.\d+)?)\s*bpm/i) || file.name.match(/(?:^|[^\d])(\d{2,3})(?:[^\d]|$)/);
      if (m && +m[1] >= 60 && +m[1] <= 200) { setBpm(+m[1]); toast(`${A.name} · ${bpm} BPM from the file name`); }
      else toast(`${A.name} loaded. Set its BPM so the build lines up with its bars.`);
      if (wasPlaying) play();
    } catch (e) { toast('That file could not be decoded. Try a WAV or MP3.'); }
  }

  /* offline render through the same chain; AUTO timing, from the top of the loop */
  async function render(fromBeat, toBeat) {
    await ensure();
    const sr = 48000, spb = 60 / bpm * sr, L = latencySamples(sr), tail = Math.round(sr * 2);
    const frames = Math.ceil(toBeat * spb) + L + tail;
    const oc = new OfflineAudioContext(2, frames, sr);
    const g = await build(oc);
    g.node.port.postMessage({ type: 'params', params: { ...V, mode: MODE.AUTO }, snap: true });
    g.node.port.postMessage({ type: 'transport', playing: true, start: 0, bpm, bpb });
    applyIR(g, sr);
    g.master.connect(oc.destination);
    const src = oc.createBufferSource(); src.buffer = A.buffer; src.loop = true; src.connect(g.node); src.start(0);
    const out = await oc.startRendering();
    const a = Math.round(fromBeat * spb) + L, b = Math.min(out.length, Math.round(toBeat * spb) + L);
    return { chans: [out.getChannelData(0).slice(a, b), out.getChannelData(1).slice(a, b)], sr };
  }
  async function exportWav(kind) {
    const btns = [$('#exportTrans'), $('#exportPhrase')]; btns.forEach(b => b.disabled = true);
    toast('Rendering…');
    try {
      const phraseB = PHRASE_BARS[V.phrase] * bpb, buildB = Math.min(LENGTH_BARS[V.length] * bpb, phraseB);
      const from = kind === 'phrase' ? 0 : Math.max(0, phraseB - buildB - bpb), to = phraseB + 2 * bpb;
      const { chans, sr } = await render(from, to);
      const name = `${A.name} - Liftoff ${kind === 'phrase' ? 'phrase' : 'transition'} ${Math.round(bpm)}bpm.wav`;
      download(wav24(chans, sr), name);
      toast(`Saved ${name}${V.mode !== MODE.AUTO ? ' (rendered with AUTO timing)' : ''}`);
    } catch (e) { console.error(e); toast('Export failed: ' + e.message); }
    btns.forEach(b => b.disabled = false);
  }

  $('#play').addEventListener('click', () => A.playing ? stop() : play());
  $('#bpm').value = bpm;
  $('#bpm').addEventListener('change', e => setBpm(e.target.value));
  $('#srcBtn').addEventListener('click', () => $('#fileIn').click());
  $('#fileIn').addEventListener('change', e => { if (e.target.files[0]) load(e.target.files[0]); e.target.value = ''; });
  $('#exportTrans').addEventListener('click', () => exportWav('transition'));
  $('#exportPhrase').addEventListener('click', () => exportWav('phrase'));
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('#dropZone').classList.add('on'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropZone').classList.remove('on'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#dropZone').classList.remove('on'); const f = e.dataTransfer.files[0]; if (f) load(f); });

  return {
    set(id, v) { if (A.node) A.node.port.postMessage({ type: 'params', params: { [id]: v } }); },
    gesture() {},
    irChanged() { clearTimeout(irT); irT = setTimeout(refreshIR, 60); },
    launch() { ensure().then(() => A.node.port.postMessage({ type: 'launch' })); if (!A.playing) play(); },
    toggle() { A.playing ? stop() : play(); },
    get playing() { return A.playing; },
    get latencyBeats() { return latencySamples(A.ctx ? A.ctx.sampleRate : 48000) / (A.ctx ? A.ctx.sampleRate : 48000) * bpm / 60; }
  };
}

/* ---------- WAV ---------- */
function wav24(chans, sr) {
  const n = chans[0].length, ch = chans.length, bytes = n * ch * 3;
  const buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * 3, true); v.setUint16(32, ch * 3, true); v.setUint16(34, 24, true); str(36, 'data'); v.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.round(clamp(chans[c][i], -1, 1) * 8388607);
    v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------- demo loop: two bars of house at 124 BPM, made in the browser ---------- */
async function demoLoop(sr) {
  const B = 60 / 124, bars = 2, len = Math.round(bars * 4 * B * sr);
  const oc = new OfflineAudioContext(2, len, sr);
  const bus = oc.createDynamicsCompressor(); bus.threshold.value = -14; bus.ratio.value = 3; bus.connect(oc.destination);
  const noise = oc.createBuffer(1, sr, sr); { const d = noise.getChannelData(0), r = LF.rng(99); for (let i = 0; i < d.length; i++) d[i] = r(); }
  const env = (g, t, a, peak, dec) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec); };
  const kick = t => {
    const o = oc.createOscillator(), g = oc.createGain();
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.08);
    env(g, t, 0.002, 0.95, 0.38); o.connect(g).connect(bus); o.start(t); o.stop(t + 0.5);
  };
  const hit = (t, type, f, q, peak, dec, pan = 0) => {
    const s = oc.createBufferSource(), fl = oc.createBiquadFilter(), g = oc.createGain(), p = oc.createStereoPanner();
    s.buffer = noise; fl.type = type; fl.frequency.value = f; fl.Q.value = q; p.pan.value = pan;
    env(g, t, 0.001, peak, dec); s.connect(fl).connect(g).connect(p).connect(bus); s.start(t, Math.random() * 0.5); s.stop(t + dec + 0.05);
  };
  const clap = t => { for (let k = 0; k < 3; k++) hit(t + k * 0.011, 'bandpass', 1400, 1.4, 0.55, k < 2 ? 0.02 : 0.18); };
  const midi = m => 440 * Math.pow(2, (m - 69) / 12);
  const stab = (t, notes, dur) => {
    const fl = oc.createBiquadFilter(), g = oc.createGain();
    fl.type = 'lowpass'; fl.Q.value = 3; fl.frequency.setValueAtTime(3800, t); fl.frequency.exponentialRampToValueAtTime(700, t + dur);
    env(g, t, 0.004, 0.16, dur); fl.connect(g).connect(bus);
    notes.forEach((m, i) => { for (const det of [-7, 7]) { const o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(m); o.detune.value = det + i; o.connect(fl); o.start(t); o.stop(t + dur + 0.1); } });
  };
  const bass = (t, m, dur) => {
    const o = oc.createOscillator(), g = oc.createGain(), fl = oc.createBiquadFilter();
    o.type = 'triangle'; o.frequency.value = midi(m); fl.type = 'lowpass'; fl.frequency.value = 600;
    env(g, t, 0.005, 0.5, dur); o.connect(fl).connect(g).connect(bus); o.start(t); o.stop(t + dur + 0.1);
  };
  const chords = [[57, 60, 64, 67, 71], [53, 57, 60, 64, 67]];   // Am9, Fmaj9
  const roots = [33, 29];
  for (let bar = 0; bar < bars; bar++) for (let b = 0; b < 4; b++) {
    const t = (bar * 4 + b) * B;
    kick(t);
    if (b % 2 === 1) clap(t);
    hit(t + B / 2, 'highpass', 8000, 0.7, 0.32, 0.05, 0.2);
    hit(t + B / 4, 'highpass', 9000, 0.7, 0.12, 0.025, -0.3); hit(t + 3 * B / 4, 'highpass', 9000, 0.7, 0.14, 0.025, -0.3);
    if (b === 3 && bar === 1) hit(t + B / 2, 'highpass', 6000, 0.7, 0.25, 0.3, 0.2);
    stab(t + B / 2, chords[bar], B * 0.42);
    if (b === 0) stab(t, chords[bar], B * 0.3);
    bass(t + B / 2, roots[bar] + 12, B * 0.4);
  }
  return oc.startRendering();
}

/* ---------- flight path display ---------- */
const cv = $('#path'), g2 = cv.getContext('2d');
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COL = { gold: css('--gold'), goldHi: css('--gold-hi'), goldLo: css('--gold-lo'), pink: css('--pink'), violet: css('--violet'), text: css('--text'), muted: css('--muted'), dim: css('--dim'), faint: css('--faint') };

function live(now) {
  // where we are right now, carried forward smoothly between engine updates
  const st = T.st;
  if (!st) return null;
  const dt = (now - T.at) / 1000;
  const playing = !!(st.playing ?? st.hostPlaying);
  const beat = st.beat + (playing ? dt * bpm / 60 : 0);
  return { st, playing, beat };
}

function viewState(now) {
  const L = live(now);
  const phraseB = PHRASE_BARS[V.phrase] * bpb;
  const buildB = V.mode === MODE.AUTO ? Math.min(LENGTH_BARS[V.length] * bpb, phraseB) : LENGTH_BARS[V.length] * bpb;
  const gapB = V.drop ? Math.min(GAP_BEATS[V.gap], buildB) : 0;
  const s = { phraseB, buildB, gapB, cur: -1, after: -1, toDrop: -1, inGap: false, p: 0, text: '', barInPhrase: -1, pending: false, idle: false };
  if (!L) { s.idle = true; return s; }
  const sinceDrop = (now - T.dropAt) / 1000 * bpm / 60;
  if (V.mode === MODE.AUTO) {
    if (!L.playing) { s.idle = true; return s; }
    const t = LF.autoTimeline(V, L.beat, bpb);
    s.barInPhrase = Math.floor(t.pos / bpb);
    s.toDrop = t.toDrop;
    if (t.raw >= 0) { s.cur = t.raw * buildB; s.p = LF.shape(t.raw, V.curve); s.inGap = t.inGap; }
    else if (t.pos < bpb) s.after = t.pos;
  } else if (V.mode === MODE.TRIGGER) {
    const st = L.st;
    s.pending = st.pending;
    if (st.raw >= 0 && st.trig) {
      const elapsed = st.raw * buildB + (now - T.at) / 1000 * bpm / 60;
      s.cur = Math.min(buildB, elapsed); s.p = LF.shape(s.cur / buildB, V.curve); s.toDrop = Math.max(0, buildB - elapsed);
      s.inGap = gapB > 0 && elapsed >= buildB - gapB;
    } else { s.idle = true; if (sinceDrop < bpb) { s.after = sinceDrop; s.idle = false; } }
  } else {
    const b = L.st.raw >= 0 ? L.st.raw : 0;
    s.cur = b * buildB; s.p = LF.shape(b, V.curve); s.inGap = gapB > 0 && b >= 0.995;
    if (b <= 0 && sinceDrop < bpb) s.after = sinceDrop;
  }
  return s;
}

function countdown(s, now) {
  const sinceDrop = (now - T.dropAt) / 1000 * bpm / 60;
  const el = $('#count'), sub = $('#countSub'), lbl = $('#countLbl');
  let text = '—', hot = false, subT = '';
  lbl.textContent = 'NEXT DROP';
  if (sinceDrop < 1.5) { text = 'DROP'; hot = true; subT = 'and it lands'; }
  else if (s.inGap) { text = 'HOLD'; hot = true; subT = ['', 'cut', 'tape stop', 'filter dive', 'stutter'][V.gapStyle + 1]; }
  else if (V.mode === MODE.MANUAL) {
    lbl.textContent = 'MANUAL';
    text = s.p > 0 ? 'RIDING' : 'READY'; subT = s.p > 0 ? 'pull BUILD down to drop' : 'push BUILD up to build';
  } else if (V.mode === MODE.TRIGGER && s.toDrop < 0) {
    text = s.pending ? 'ARMED' : 'STANDBY'; hot = s.pending;
    subT = s.pending ? 'starts on the next bar' : HOST ? 'LAUNCH or a MIDI note' : 'press LAUNCH';
  } else if (s.toDrop >= 0) {
    const bars = s.toDrop / bpb;
    text = s.toDrop > bpb ? `T–${Math.ceil(bars - 1e-6)} BAR${Math.ceil(bars - 1e-6) > 1 ? 'S' : ''}` : `T–${Math.max(1, Math.ceil(s.toDrop - 1e-6))}`;
    hot = s.cur >= 0;
    subT = s.cur >= 0 ? (s.toDrop > bpb ? 'building' : 'beats to the drop') : `build starts in ${Math.ceil((s.toDrop - s.buildB) / bpb - 1e-6)} bar${Math.ceil((s.toDrop - s.buildB) / bpb - 1e-6) > 1 ? 's' : ''}`;
  } else subT = HOST ? 'press play in your DAW' : 'press play';
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('hot', hot);
  if (sub.textContent !== subT) sub.textContent = subT;
  const pct = Math.round(s.p * 100);
  $('#alt').textContent = pct; $('#altBar').style.width = pct + '%';
}

function draw(now) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = g2; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const s = viewState(now);
  countdown(s, now);
  modulation(s);

  const padX = 18, stripY = 14, stripH = 18, gy0 = 50, gy1 = H - 26, gh = gy1 - gy0, gw = W - padX * 2;
  const buildB = s.buildB, after = Math.max(0.5, Math.min(bpb, buildB * 0.3)), span = buildB + after;
  const x = b => padX + b / span * gw;
  const xd = x(buildB);
  g.font = `700 10px ${css('--mono')}`; g.textBaseline = 'middle';

  // strip: the phrase (AUTO) or what the mode is waiting for
  if (V.mode === MODE.AUTO) {
    const bars = PHRASE_BARS[V.phrase], cw = gw / bars, buildBars = buildB / bpb;
    for (let k = 0; k < bars; k++) {
      const inBuild = k >= bars - buildBars - 1e-6 || (buildBars < 1 && k === bars - 1);
      g.fillStyle = k === s.barInPhrase ? COL.goldHi : inBuild ? 'rgba(227,176,98,.38)' : 'rgba(255,240,210,.07)';
      g.fillRect(padX + k * cw + 1, stripY, Math.max(1, cw - 2), stripH * (k === s.barInPhrase ? 1 : 0.6));
    }
    g.fillStyle = COL.muted; g.textAlign = 'left';
    g.fillText(`PHRASE · ${bars} BARS${s.barInPhrase >= 0 ? ` · BAR ${s.barInPhrase + 1}` : ''}`, padX, stripY + stripH + 9);
    if (W > 560) g.textAlign = 'right', g.fillText(`DROP ON BAR ${bars + 1} · ${bars * 2 + 1} · …`, W - padX, stripY + stripH + 9);
  } else {
    g.fillStyle = COL.dim; g.textAlign = 'left';
    const msg = V.mode === MODE.MANUAL ? 'MANUAL · ride or automate BUILD · hold it at 100% for the gap · pull it down to drop'
      : HOST ? 'TRIGGER · a MIDI note or LAUNCH starts a build · it drops BUILD LENGTH later' : 'TRIGGER · LAUNCH starts a build on the next bar · it drops BUILD LENGTH later';
    g.fillText(msg, padX, stripY + 8);
  }

  // grid: beats and bars across the build and one bar after the drop
  const beats = Math.ceil(span);
  for (let b = 0; b <= beats; b++) {
    if (b > span) break;
    const bar = b % bpb === 0;
    if (!bar && buildB > 32) continue;
    g.fillStyle = bar ? 'rgba(255,240,210,.10)' : 'rgba(255,240,210,.035)';
    g.fillRect(Math.round(x(b)), gy0, 1, gh);
    if (bar && b < buildB) { g.fillStyle = COL.faint; g.textAlign = 'left'; g.fillText(V.mode === MODE.MANUAL ? `${Math.round(b / buildB * 100)}%` : `${b / bpb + 1}`, x(b) + 4, gy1 + 13); }
  }
  g.fillStyle = 'rgba(255,240,210,.14)'; g.fillRect(padX, gy1, gw, 1);

  // the build curve
  const curvePath = () => { g.beginPath(); g.moveTo(x(0), gy1); for (let i = 0; i <= 120; i++) { const r = i / 120; g.lineTo(x(r * buildB), gy1 - LF.shape(r, V.curve) * gh * 0.92); } };
  const grad = g.createLinearGradient(x(0), 0, xd, 0); grad.addColorStop(0, COL.goldLo); grad.addColorStop(0.55, COL.gold); grad.addColorStop(1, COL.goldHi);
  curvePath(); g.lineTo(xd, gy1); g.closePath();
  const fill = g.createLinearGradient(0, gy0, 0, gy1); fill.addColorStop(0, 'rgba(227,176,98,.16)'); fill.addColorStop(1, 'rgba(227,176,98,.01)');
  g.fillStyle = fill; g.fill();
  if (s.cur > 0) {   // the part already flown, brighter
    g.save(); g.beginPath(); g.rect(x(0), gy0 - 10, x(s.cur) - x(0), gh + 10); g.clip();
    curvePath(); g.lineTo(xd, gy1); g.closePath();
    const f2 = g.createLinearGradient(0, gy0, 0, gy1); f2.addColorStop(0, 'rgba(247,217,150,.42)'); f2.addColorStop(1, 'rgba(227,176,98,.06)');
    g.fillStyle = f2; g.fill(); g.restore();
  }
  curvePath(); g.strokeStyle = grad; g.lineWidth = 2.5; g.globalAlpha = V.rise ? 1 : 0.35; g.stroke(); g.globalAlpha = 1;

  // backverb: the reverse swell rising into the drop
  if (V.verb) {
    const vb = VERB_BEATS[V.verbLen];
    g.strokeStyle = 'rgba(157,130,255,.85)'; g.lineWidth = 1.6; g.fillStyle = 'rgba(157,130,255,.16)';
    const swell = (end, len, hgt) => {
      const tail = Math.pow(10, (-60 + 48 * V.verbSize) / 20);
      g.beginPath(); g.moveTo(x(end - len), gy1);
      for (let i = 0; i <= 40; i++) { const r = i / 40; g.lineTo(x(end - len + r * len), gy1 - hgt * Math.pow(tail, 1 - r)); }
      g.lineTo(x(end), gy1); g.closePath(); g.fill(); g.stroke();
    };
    if (V.verbMode === VERB_MODE.DROP) swell(buildB, Math.min(vb, span), gh * 0.75 * (0.4 + 0.6 * V.verbMix));
    else {
      const every = Math.max(1, Math.min(vb, bpb));
      for (let b = every; b <= buildB + 1e-6; b += every) {
        const r = b / buildB, h = V.verbMode === VERB_MODE.BUILD ? LF.shape(r, V.curve) : 0.6;
        swell(b, Math.min(vb, every), gh * 0.5 * h * (0.4 + 0.6 * V.verbMix));
      }
    }
  }

  // the gap before the drop
  if (s.gapB > 0) {
    const xg = x(buildB - s.gapB);
    g.save(); g.beginPath(); g.rect(xg, gy0, xd - xg, gh); g.clip();
    g.fillStyle = s.inGap ? 'rgba(227,176,98,.22)' : 'rgba(227,176,98,.06)'; g.fillRect(xg, gy0, xd - xg, gh);
    g.strokeStyle = 'rgba(227,176,98,.30)'; g.lineWidth = 1;
    for (let k = -gh; k < xd - xg; k += 7) { g.beginPath(); g.moveTo(xg + k, gy1); g.lineTo(xg + k + gh, gy0); g.stroke(); }
    g.restore();
    g.fillStyle = COL.gold; g.textAlign = 'center';
    if (xd - xg > 34) g.fillText(['CUT', 'TAPE', 'FILTER', 'STUTTER'][V.gapStyle], (xg + xd) / 2, gy0 + 10);
  }

  // the drop and the impact
  g.fillStyle = COL.goldHi; g.fillRect(Math.round(xd) - 1, gy0 - 6, 2, gh + 6);
  g.textAlign = 'left'; g.font = `800 11px ${css('--mono')}`; g.fillStyle = COL.goldHi; g.fillText('DROP', xd + 6, gy0 + 2);
  g.beginPath(); g.arc(xd, gy1 - gh * 0.92, 4.5, 0, Math.PI * 2); g.fillStyle = COL.goldHi; g.fill();
  if (V.drop && V.impact > 0) {
    g.beginPath(); g.moveTo(xd, gy1);
    for (let i = 0; i <= 40; i++) { const r = i / 40; g.lineTo(x(buildB + r * after), gy1 - gh * 0.7 * V.impact * Math.exp(-r * 3.5)); }
    g.lineTo(x(span), gy1); g.closePath(); g.fillStyle = 'rgba(255,240,210,.07)'; g.fill();
  }

  // playhead
  const ph = s.cur >= 0 ? s.cur : s.after >= 0 ? buildB + Math.min(s.after, after) : -1;
  if (ph >= 0) {
    const px = x(ph), py = s.cur >= 0 ? gy1 - s.p * gh * 0.92 : gy1;
    g.fillStyle = 'rgba(255,240,210,.55)'; g.fillRect(Math.round(px), gy0 - 4, 1, gh + 4);
    g.shadowColor = COL.gold; g.shadowBlur = 16; g.fillStyle = COL.goldHi;
    g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
  }
  if (s.idle) {
    g.fillStyle = 'rgba(10,9,8,.35)'; g.fillRect(padX, gy0, gw, gh);
  }
}

// knobs show how much of each amount is in play right now
function modulation(s) {
  const p = s.p;
  for (const id of ['pitch', 'filter', 'wash', 'stutter', 'noise', 'width']) views[id].mod(V.rise ? (V[id] - DEFS[id].min) / (DEFS[id].max - DEFS[id].min) * p : 0);
  views.verbMix.mod(V.verb && V.verbMode === VERB_MODE.BUILD ? V.verbMix * p : 0);
  views.build.update(V.mode === MODE.MANUAL ? V.build : p);
}

function meters() {
  const st = T.st;
  const w = v => Math.max(0, Math.min(100, (20 * Math.log10(Math.max(1e-6, v || 0)) + 48) / 48 * 100)) + '%';
  $('#mIn').style.width = w(st && st.peakIn); $('#mOut').style.width = w(st && st.peakOut);
}

function frame(now) { pump(now); draw(now); meters(); requestAnimationFrame(frame); }

/* ---------- launch, keys ---------- */
$('#launch').addEventListener('click', () => engine.launch());
window.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space' && !HOST) { e.preventDefault(); engine.toggle(); }
  else if (e.key === 'l' || e.key === 'L') { if (V.mode === MODE.TRIGGER) engine.launch(); else toast('LAUNCH works in TRIGGER mode'); }
  else if (e.key === 'ArrowLeft' && !e.target.closest('.knob, .seg, .fader')) loadPreset(presetIdx - 1);
  else if (e.key === 'ArrowRight' && !e.target.closest('.knob, .seg, .fader')) loadPreset(presetIdx + 1);
});

refreshAll();
presetSel.value = clamp(presetIdx, 0, LIFTOFF_PRESETS.length - 1);
markEdited();
requestAnimationFrame(frame);
})();
