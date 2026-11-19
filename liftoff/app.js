/* Liftoff page: load or record a sample, and Liftoff turns it into a transition (the riser, the gap, the reverse
   swell and the drop) to preview and export. In the plugin the same page also runs LIVE mode, where the C++ engine
   follows the DAW's bars; the page talks to it through native functions. */
(() => {
'use strict';
const LF = globalThis.Liftoff;
const { PHRASE_BARS, LENGTH_BARS, VERB_BEATS, GAP_BEATS, MODE, VERB_MODE } = LF;
const DEFS = {}; for (const p of LIFTOFF_PARAMS) DEFS[p.id] = p;
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ---------- plugin bridge ---------- */
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
const UI = { view: 'sample', sel: [0, 1] };        // settings of the page, not DAW parameters (sel: the part of the sample used, 0..1)
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('liftoff.' + k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('liftoff.' + k, JSON.stringify(v)); } catch (e) {} }
};
let bpm = 124, bpb = 4, presetIdx = 0;
const HS = { sr: 48000, previewPos: 0, previewing: false, recording: false, recSeconds: 0, recLevel: 0, at: 0, hostBpm: 0 };
if (!HOST) {
  const saved = store.get('params'); if (saved) for (const k in saved) if (k in V) V[k] = saved[k];
  bpm = store.get('bpm') || bpm; presetIdx = store.get('preset') ?? 0;
  const ui = store.get('ui'); if (ui && Array.isArray(ui.sel)) UI.sel = ui.sel;
}

/* ---------- formatting ---------- */
function fmt(id, v) {
  const d = DEFS[id];
  if (id === 'pitch') return (v >= 0.05 ? '+' : '') + v.toFixed(v < 10 ? 1 : 0) + ' st';
  if (id === 'output') return (v > 0.05 ? '+' : '') + v.toFixed(1) + ' dB';
  if (id === 'curve') return Math.abs(v) < 0.03 ? 'linear' : (v > 0 ? 'late ' : 'early ') + Math.round(Math.abs(v) * 100);
  if (d.unit === '%') return Math.round(v * 100) + '%';
  if (d.unit === 'Hz') return v.toFixed(2) + ' Hz';
  return v.toFixed(2);
}
const KNOB_LABEL = { pitch: 'PITCH', filter: 'FILTER', wash: 'WASH', stutter: 'STUTTER', noise: 'NOISE', width: 'WIDTH',
  verbSize: 'SIZE', verbTone: 'TONE', verbMix: 'MIX', impact: 'IMPACT', mix: 'MIX', output: 'OUTPUT', curve: 'CURVE',
  tremDepth: 'DEPTH', chorusRate: 'RATE', chorusDepth: 'DEPTH', chorusMix: 'MIX' };
const KNOB_TIP = {
  pitch: 'How far the sound pitches up by the drop', filter: 'High-pass sweep that thins the sound out', wash: 'Reverb that swallows the sound as it rises',
  stutter: 'Gate that speeds up from 1/4 to 1/32 notes', noise: 'A white-noise riser that sweeps up', width: 'Stereo widening toward the drop',
  verbSize: 'Longer, fuller tail', verbTone: 'Darker or brighter swell', verbMix: 'Level of the reverse swell', impact: 'Sub boom and crack on the drop',
  mix: 'Dry/wet for the whole effect', output: 'Output level', curve: 'Late: slow start, rushes at the end. Early: jumps up, then hangs',
  tremDepth: 'How deep the tremolo pulses', chorusRate: 'How fast the chorus moves', chorusDepth: 'How far the chorus detunes', chorusMix: 'How much chorus'
};
const SEG_LABEL = {
  mode: ['AUTO', 'MANUAL', 'TRIGGER'], phrase: ['4', '8', '16', '32'], length: ['½', '1', '2', '4', '8'],
  verbMode: ['END', 'BUILD', 'ALWAYS'], verbLen: ['1/8', '1/4', '1/2', '1 BAR'], gap: ['OFF', '1/16', '1/8', '1/4', '1/2'],
  tremRate: ['1/4', '1/8', '1/16', '1/32', '1/8T', '1/16T'], tremShape: ['SINE', 'SQUARE', 'RAMP', 'PAN'],
  gapStyle: ['CUT', 'TAPE', 'FILTER', 'STUTTER']
};
const SEG_TIP = {
  mode: ['The build fills the end of every phrase and drops on its first bar', 'Ride or automate BUILD yourself: pull it down to drop', 'LAUNCH or a MIDI note starts a build; it drops BUILD LENGTH later'],
  length: ['Half a bar', '1 bar', '2 bars', '4 bars', '8 bars'],
  verbMode: ['A reverse swell made from your sample’s first hit, landing at the end of the riser (LIVE: on the drop)', 'Reverse swells on everything, growing through the build', 'Reverse swell on every sound, all the time'],
  tremShape: ['Smooth pulses', 'Hard on/off chops', 'Pumping: each pulse starts loud and fades', 'Auto-pan: left and right take turns'],
  gapStyle: ['Silence before the drop', 'The beat slows to a stop', 'The beat sinks into a low-pass', 'The first 1/16 of the gap repeats']
};

/* ---------- controls (a parameter can have several controls, e.g. BUILD LENGTH in both strips) ---------- */
const views = {};
const addView = (id, v) => (views[id] = views[id] || []).push(v);
const showValue = (id, v) => (views[id] || []).forEach(x => x.update(v));

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
  addView(id, {
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
  });
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

// a row of choices; `get`/`set` let the same control drive a page setting instead of a parameter
function seg(host, id, labels, tips, get, set) {
  host.innerHTML = labels.map((l, i) => `<button type="button" role="radio" data-i="${i}" title="${(tips && tips[i]) || l}">${l}</button>`).join('');
  const btns = [...host.children];
  host.addEventListener('click', e => { const b = e.target.closest('button'); if (b) set(+b.dataset.i); });
  host.addEventListener('keydown', e => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!dir) return;
    e.preventDefault(); e.stopPropagation();
    const i = clamp(get() + dir, 0, labels.length - 1); set(i); btns[i].focus();
  });
  const view = { update(v) { btns.forEach((b, i) => { b.setAttribute('aria-checked', i === v); b.tabIndex = i === v ? 0 : -1; }); } };
  if (id) addView(id, view);
  return view;
}
function paramSeg(host, id) {
  seg(host, id, SEG_LABEL[id] || DEFS[id].choices, SEG_TIP[id], () => V[id], i => { gesture(id, true); setParam(id, i); gesture(id, false); });
}

// a stepped rotary switch: a knob with its positions printed around it; click a position, drag, scroll or use the arrows
const STEP_LABEL = { verbMode: ['END', 'BUILD', 'ALWAYS'], verbLen: ['1/8', '1/4', '1/2', '1 BAR'], tremRate: ['1/4', '1/8', '1/16', '1/32', '1/8T', '1/16T'],
  tremShape: ['SINE', 'SQR', 'RAMP', 'PAN'] };
const STEP_NAME = { verbMode: 'SWELL', verbLen: 'LENGTH', tremRate: 'RATE', tremShape: 'SHAPE' };
function stepKnob(host, id) {
  const d = DEFS[id], labels = STEP_LABEL[id] || d.choices, n = labels.length;
  const span = n <= 3 ? 180 : n <= 4 ? 210 : 250, a0 = -90 - span / 2, ang = i => a0 + (n === 1 ? 0 : i / (n - 1) * span);
  host.classList.add('step'); host.tabIndex = 0; host.setAttribute('role', 'slider'); host.setAttribute('aria-label', d.name);
  host.setAttribute('aria-valuemin', 0); host.setAttribute('aria-valuemax', n - 1);
  const cx = 56, cy = 40, r = 31;   // just outside the cap; each label grows away from the knob
  host.innerHTML = labels.map((l, i) => {
    const a = ang(i) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
    const tx = c < -0.35 ? '-100%' : c > 0.35 ? '0%' : '-50%', ty = sn < -0.7 ? '-100%' : '-50%';
    return `<span class="pos" data-i="${i}" style="left:${(cx + r * c).toFixed(1)}px;top:${(cy + r * sn).toFixed(1)}px;transform:translate(${tx},${ty})" title="${(SEG_TIP[id] && SEG_TIP[id][i]) || d.choices[i]}">${l}</span>`;
  }).join('') + `<div class="kn"><div class="cap"></div><div class="ind"></div></div><span class="k-lbl">${STEP_NAME[id] || d.name.toUpperCase()}</span>`;
  const pos = [...host.querySelectorAll('.pos')], ind = host.querySelector('.ind');
  const choose = i => { i = clamp(i, 0, n - 1); if (i !== V[id]) { gesture(id, true); setParam(id, i); gesture(id, false); } };
  host.addEventListener('click', e => { const p = e.target.closest('.pos'); if (p) choose(+p.dataset.i); });
  let startY = 0, startV = 0, dragging = false;
  host.addEventListener('pointerdown', e => { if (e.target.closest('.pos') || e.button !== 0) return; host.focus(); host.setPointerCapture(e.pointerId); dragging = true; startY = e.clientY; startV = V[id]; e.preventDefault(); });
  host.addEventListener('pointermove', e => { if (dragging) choose(startV + Math.round((startY - e.clientY) / 22)); });
  const end = () => { dragging = false; };
  host.addEventListener('pointerup', end); host.addEventListener('pointercancel', end);
  host.addEventListener('wheel', e => { e.preventDefault(); choose(V[id] + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  host.addEventListener('keydown', e => {
    const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
    if (dir) { choose(V[id] + dir); e.preventDefault(); e.stopPropagation(); }
  });
  addView(id, { update(v) {
    ind.style.transform = `rotate(${(ang(v) + 90).toFixed(1)}deg)`;
    pos.forEach((p, i) => p.classList.toggle('on', i === v));
    host.setAttribute('aria-valuenow', v); host.setAttribute('aria-valuetext', d.choices[v]);
  } });
}

function toggle(btn, id) {
  btn.addEventListener('click', () => { gesture(id, true); setParam(id, V[id] ? 0 : 1); gesture(id, false); });
  const mod = btn.closest('.mod');
  addView(id, { update(v) { btn.setAttribute('aria-checked', !!v); if (mod) mod.classList.toggle('off', !v); } });
}

function fader(el, id) {
  const fill = el.querySelector('i'), val = $('#buildVal');   // fill and value
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
  addView(id, { update(v) { fill.style.width = (v * 100) + '%'; val.textContent = Math.round(v * 100) + '%'; el.setAttribute('aria-valuenow', Math.round(v * 100)); } });
}

document.querySelectorAll('[data-knob]').forEach(el => knob(el, el.dataset.knob));
document.querySelectorAll('.seg[data-param]').forEach(el => paramSeg(el, el.dataset.param));
document.querySelectorAll('[data-step]').forEach(el => stepKnob(el, el.dataset.step));
document.querySelectorAll('[data-toggle]').forEach(el => toggle(el, el.dataset.toggle));
fader($('#buildFader'), 'build');

/* ---------- parameters ---------- */
// parameters that change the rendered transition (everything except the live-only timing)
const LIVE_ONLY = new Set(['mode', 'phrase', 'build']);
function setParam(id, v, fromHost) {
  const d = DEFS[id]; if (!d) return;
  v = d.type === 'float' ? clamp(+v, d.min, d.max) : Math.round(+v);
  if (V[id] === v) return;
  V[id] = v;
  showValue(id, v);
  if (!fromHost) { engine.set(id, v); markEdited(); }
  if (id === 'mode') modeChanged();
  if (!LIVE_ONLY.has(id)) scheduleRender();
  saveSoon();
}
function gesture(id, begin) { engine.gesture(id, begin); }
function modeChanged() {
  const manual = V.mode === MODE.MANUAL, trig = V.mode === MODE.TRIGGER;
  $('#buildFader').setAttribute('aria-disabled', !manual);
  $('#launch').disabled = !trig;
  $('#launch').title = trig ? 'Start a build on the next bar. L' : 'Switch MODE to TRIGGER to launch builds by hand or with MIDI notes';
  document.querySelector('[data-param="phrase"]').closest('.tgroup').style.opacity = V.mode === MODE.AUTO ? '' : '.4';
}
let saveT = 0;
function saveSoon() { if (HOST) return; clearTimeout(saveT); saveT = setTimeout(() => { store.set('params', V); store.set('bpm', bpm); store.set('preset', presetIdx); }, 300); }
function saveUi() { if (HOST) HOST.call('setUi', JSON.stringify(UI)); else store.set('ui', UI); }
function refreshAll() { for (const id in views) showValue(id, V[id]); modeChanged(); }

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
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2800); }

/* ---------- PCM helpers (the plugin passes audio as base64 16-bit PCM) ---------- */
function b64ToBytes(b64) { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
function bytesToB64(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function fromPCM(o) {
  const pcm = new Int16Array(b64ToBytes(o.data).buffer), ch = o.channels, n = o.frames, chans = [];
  for (let c = 0; c < ch; c++) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = pcm[i * ch + c] / 32767; chans.push(a); }
  return { chans, sr: o.sampleRate };
}
function toPCM(chans) {
  const ch = chans.length, n = chans[0].length, pcm = new Int16Array(n * ch);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) pcm[i * ch + c] = Math.round(clamp(chans[c][i], -1, 1) * 32767);
  return bytesToB64(new Uint8Array(pcm.buffer));
}
async function resample(s, sr) {
  if (s.sr === sr) return s;
  const n = Math.ceil(s.chans[0].length * sr / s.sr), oc = new OfflineAudioContext(s.chans.length, n, sr);
  const b = oc.createBuffer(s.chans.length, s.chans[0].length, s.sr); s.chans.forEach((c, i) => b.copyToChannel(c, i));
  const src = oc.createBufferSource(); src.buffer = b; src.connect(oc.destination); src.start();
  const out = await oc.startRendering();
  return { chans: s.chans.map((_, i) => out.getChannelData(i).slice()), sr };
}
async function decode(bytes, sr) {
  const oc = new OfflineAudioContext(2, 1, sr);
  const b = await oc.decodeAudioData(bytes);
  return { chans: [...Array(Math.min(2, b.numberOfChannels)).keys()].map(i => b.getChannelData(i).slice()), sr: b.sampleRate };
}

/* ---------- the sample and its transition ---------- */
const SM = { sample: null, name: '', source: '', render: null, signal: null, rendering: false, renderT: 0, playFrom: 0 };
const renderSr = () => HOST ? (HS.sr || 48000) : 48000;

async function setSample(s, name, source, opts = {}) {
  if (source === 'rec') s = { ...s, chans: LF.trimSilence(s.chans, s.sr) };
  const maxN = s.sr * 60;
  if (s.chans[0].length > maxN) s = { ...s, chans: s.chans.map(c => c.slice(0, maxN)) };   // a minute is plenty
  SM.sample = s; SM.name = name; SM.source = source; SM.laneFor = null; SM.autoplay = !!opts.autoplay;
  UI.sel = opts.sel && opts.sel[1] - opts.sel[0] > 0.001 ? opts.sel : [0, 1];
  if (opts.sel === undefined) saveUi();
  $('#sampleName').textContent = name;
  sampleInfo();
  $('#empty').hidden = true;
  if (opts.persist !== false) persistSample(s, name, source);
  stopPreview();
  scheduleRender(0);
}

// the part of the sample that is used
function selRange() { const n = SM.sample.chans[0].length; return [Math.floor(UI.sel[0] * n), Math.max(Math.floor(UI.sel[0] * n) + 1, Math.round(UI.sel[1] * n))]; }
function selectedSample() { const [a, b] = selRange(); return { chans: SM.sample.chans.map(c => c.subarray(a, b)), sr: SM.sample.sr }; }
function sampleInfo() {
  if (!SM.sample) return;
  const [a, b] = selRange(), sr = SM.sample.sr, sec = (b - a) / sr, all = SM.sample.chans[0].length / sr;
  const f = t => t < 10 ? t.toFixed(2) : t.toFixed(1);
  const how = sec < 60 / bpm ? 'one-shot → roll' : 'loops';
  $('#sampleInfo').textContent = `${f(all)} s`;
  $('#selInfo').innerHTML = b - a < SM.sample.chans[0].length ? `cut ${f(a / sr)}–${f(b / sr)} s · ${(sec * bpm / 60).toFixed(1)} beats · ${how}` : `all of it · drag across it to cut · ${how}`;
}

function scheduleRender(delay = 140) {
  if (!SM.sample) return;
  clearTimeout(SM.renderT);
  SM.renderT = setTimeout(doRender, delay);
}
async function doRender() {
  if (SM.signal) SM.signal.cancelled = true;
  const signal = { cancelled: false }; SM.signal = signal; SM.rendering = true;
  const sample = await resample(selectedSample(), renderSr());
  if (signal.cancelled) return;
  const r = await LF.renderTransition(sample, { ...V }, { bpm, bpb, signal });
  if (!r || signal.cancelled) return;
  const pos = previewPos();
  SM.render = r; SM.rendering = false; SM.layersFor = null;
  engine.renderReady(r, pos);
  if (SM.autoplay) { SM.autoplay = false; engine.play(0); showReady(); }
  if (!HOST) {   // ready to drag out of the browser
    if (SM.wavURL) URL.revokeObjectURL(SM.wavURL);
    SM.wavURL = URL.createObjectURL(new Blob([LF.wav24([r.L, r.R], r.sr)], { type: 'audio/wav' }));
    $('#dragOut').setAttribute('aria-disabled', 'false');
  }
}

/* ---------- engines: the browser plays and records itself, the plugin does it in C++ ---------- */
const engine = HOST ? pluginEngine() : browserEngine();
function previewPos() { return engine.pos(); }
function stopPreview() { engine.stop(); }

function pluginEngine() {
  let latency = 0;
  HOST.on('state', st => {
    if (st.bpm && Math.abs(st.bpm - HS.hostBpm) > 0.01) { HS.hostBpm = st.bpm; bpm = st.bpm; if (UI.view === 'sample') scheduleRender(300); }
    bpb = st.bpb || bpb; latency = st.latency || 0;
    if (st.sr && st.sr !== HS.sr) { HS.sr = st.sr; scheduleRender(0); }
    HS.previewPos = st.previewPos || 0; HS.previewing = !!st.previewing; HS.recording = !!st.recording; HS.recSeconds = st.recSeconds || 0;
    HS.recLevel = st.recLevel || 0; HS.at = performance.now();
    $('#hostInfo').textContent = `${st.hostPlaying ? '▶' : '■'} DAW · ${bpm.toFixed(bpm % 1 ? 1 : 0)} BPM · ${Math.round(bpb)}/4${UI.view === 'live' && latency ? ` · ${Math.round(latency / HS.sr * 1000)} ms` : ''}`;
    receive(st, UI.view === 'live' ? latency / HS.sr * 1000 : 0);
    setPreviewButton(HS.previewing);
  });
  HOST.on('params', vals => { for (const k in vals) setParam(k, vals[k], true); markEdited(); });
  return {
    set(id, v) { HOST.call('setParam', id, v); },
    unlock() {},
    gesture(id, begin) { HOST.call('gesture', id, begin); },
    launch() { HOST.call('launch'); },
    renderReady(r) {
      HOST.call('setRender', toPCM([r.L, r.R]), r.sr, SM.name.replace(/\.[^.]+$/, '') + ' - Liftoff');
    },
    play(from) { if (SM.render) { SM.audition = null; setPartButton(false); HOST.call('preview', true, from || 0); } },
    stop() { HOST.call('preview', false, 0); },
    playPart(s) { const c = s.chans.length > 1 ? s.chans : [s.chans[0], s.chans[0]]; HOST.call('audition', toPCM(c), s.sr); },
    stopPart() { HOST.call('preview', false, 0); },
    toggle() { HS.previewing ? this.stop() : this.play(0); },
    pos() { return HS.previewing ? (HS.previewPos + (performance.now() - HS.at) / 1000) * (SM.render ? SM.render.sr : 48000) : -1; },
    playing: () => HS.previewing,
    async record() {
      if (!HS.recording) { await HOST.call('recStart'); toast('Recording what comes into Liftoff’s track: play it in your DAW, then press REC again'); return; }
      const o = await HOST.call('recStop');
      if (!o || !o.frames) { toast('Nothing was recorded: play some audio into the track while REC is on'); return; }
      setSample(fromPCM(o), o.name || 'Recording', 'rec', { persist: false, autoplay: true });
    },
    async load() {
      const o = await HOST.call('pickSample');
      if (o && o.frames) setSample(fromPCM(o), o.name, 'file', { persist: false, autoplay: true });
    },
    async exportWav() { const p = await HOST.call('saveRender'); if (p) toast('Saved ' + p); },
    persist(bytes, name) { HOST.call('storeSample', name, bytesToB64(new Uint8Array(bytes))); },
    async init() {
      const r = await HOST.call('getParams');
      if (r && r.values) for (const k in r.values) setParam(k, r.values[k], true);
      if (r && typeof r.preset === 'number') { presetIdx = r.preset; presetSel.value = presetIdx; }
      if (r && r.ui) { try { const u = JSON.parse(r.ui); if (u.view) UI.view = u.view; if (Array.isArray(u.sel)) UI.sel = u.sel; } catch (e) {} }
      if (r && r.sr) HS.sr = r.sr;
      if (r && r.bpm) { bpm = r.bpm; HS.hostBpm = r.bpm; }
      markEdited(); refreshAll(); setView(UI.view);
      const s = await HOST.call('getSample');
      if (s && s.frames) setSample(fromPCM(s), s.name, 'file', { persist: false, sel: UI.sel });
      else $('#empty').hidden = false;
    }
  };
}

function browserEngine() {
  const A = { ctx: null, src: null, start: 0, from: 0, rec: null };
  const ensure = () => { if (!A.ctx) A.ctx = new (window.AudioContext || window.webkitAudioContext)(); return A.ctx; };
  function toBuffer(r) { const b = ensure().createBuffer(2, r.N, r.sr); b.copyToChannel(r.L, 0); b.copyToChannel(r.R, 1); return b; }
  function stopPart() { if (A.part) { const p = A.part; A.part = null; try { p.stop(); } catch (e) {} } }
  function play(from = 0) {
    if (!SM.render) return;
    stop(true); stopPart(); SM.audition = null; setPartButton(false);
    const ctx = ensure(); ctx.resume();
    const r = SM.render, src = ctx.createBufferSource();
    src.buffer = toBuffer(r); src.connect(ctx.destination);
    const off = clamp(from / r.sr, 0, r.N / r.sr);
    src.start(0, off); A.src = src; A.start = ctx.currentTime - off;
    src.onended = () => { if (A.src === src) { A.src = null; setPreviewButton(false); } };
    setPreviewButton(true);
  }
  function stop(quiet) { if (A.src) { const s = A.src; A.src = null; try { s.stop(); } catch (e) {} } if (!quiet) setPreviewButton(false); }
  return {
    set() {}, gesture() {}, launch() {},
    unlock() { ensure().resume(); },
    renderReady(r, pos) { if (pos >= 0 && A.src) play(Math.min(pos, r.N - 1)); },
    play, stop, stopPart,
    playPart(s) {
      stop(); stopPart();
      const ctx = ensure(); ctx.resume();
      const b = ctx.createBuffer(s.chans.length, s.chans[0].length, s.sr); s.chans.forEach((c, i) => b.copyToChannel(c, i));
      const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start(); A.part = src;
      src.onended = () => { if (A.part === src) A.part = null; };
    },
    toggle() { A.src ? stop() : play(0); },
    pos() { return A.src && SM.render ? (A.ctx.currentTime - A.start) * SM.render.sr : -1; },
    playing: () => !!A.src,
    async record() {
      if (A.rec) { A.rec.stop(); return; }
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
      catch (e) { toast('No microphone: allow microphone access to record a sample'); return; }
      stop();
      const ctx = ensure(); ctx.resume();
      const an = ctx.createAnalyser(); an.fftSize = 2048; ctx.createMediaStreamSource(stream).connect(an);
      const mr = new MediaRecorder(stream), parts = [];
      A.rec = mr; A.recAn = an; A.recStart = performance.now(); A.recWave = [];
      HS.recording = true; $('#recBtn').setAttribute('aria-pressed', 'true');
      mr.ondataavailable = e => parts.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        A.rec = null; HS.recording = false; $('#recBtn').setAttribute('aria-pressed', 'false');
        try {
          const s = await decode(await new Blob(parts).arrayBuffer(), renderSr());
          const n = (store.get('recs') || 0) + 1; store.set('recs', n);
          setSample(s, `Recording ${n}`, 'rec', { autoplay: true });
        } catch (e) { toast('The recording could not be decoded'); }
      };
      mr.start();
      A.recTimer = setTimeout(() => { if (A.rec === mr) mr.stop(); }, 30000);
      toast('Recording… press REC again to stop (30 s max)');
    },
    recLevel() { if (!A.recAn) return 0; const d = new Float32Array(A.recAn.fftSize); A.recAn.getFloatTimeDomainData(d); let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); return m; },
    recSeconds: () => (performance.now() - A.recStart) / 1000,
    load() { $('#fileIn').click(); },
    exportWav() {
      if (!SM.render) return;
      const r = SM.render, name = `${SM.name.replace(/\.[^.]+$/, '')} - Liftoff ${Math.round(bpm)}bpm.wav`;
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([LF.wav24([r.L, r.R], r.sr)], { type: 'audio/wav' })); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('Saved ' + name);
    },
    persist() {},
    async init() {
      refreshAll(); setView('sample', false);
      $('#bpm').value = bpm;
      const s = await idb.get();
      if (s) setSample({ chans: s.chans, sr: s.sr }, s.name, s.source, { persist: false, sel: UI.sel });
      else loadDemo('loop');
    }
  };
}

// after a new sound: point at the way out
function showReady() {
  const el = HOST ? $('#trayHint') : $('#dragOut');
  el.classList.remove('ready'); void el.offsetWidth; el.classList.add('ready');
}

function setPreviewButton(on) {
  const b = $('#previewBtn'); if ((b.getAttribute('aria-pressed') === 'true') === on) return;
  b.setAttribute('aria-pressed', on); $('#previewIcon').setAttribute('d', on ? 'M6 5h4.5v14H6zM13.5 5H18v14h-4.5z' : 'M7 4.5v15l13-7.5z');
}

/* the browser remembers the last sample (IndexedDB) */
const idb = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('liftoff', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async put(v) { try { const db = await this.open(); db.transaction('s', 'readwrite').objectStore('s').put(v, 'last'); } catch (e) {} },
  async get() { try { const db = await this.open(); return await new Promise(res => { const q = db.transaction('s').objectStore('s').get('last'); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch (e) { return null; } }
};
function persistSample(s, name, source) { if (!HOST) idb.put({ chans: s.chans, sr: s.sr, name, source }); }

async function loadFile(file, autoplay) {
  try {
    const bytes = await file.arrayBuffer();
    const s = await decode(bytes.slice(0), renderSr());
    const m = file.name.match(/(\d{2,3}(?:\.\d+)?)\s*bpm/i);
    if (m && +m[1] >= 60 && +m[1] <= 200 && !HOST) { bpm = +m[1]; $('#bpm').value = bpm; toast(`${file.name} · ${bpm} BPM from the file name`); }
    if (HOST) engine.persist(bytes, file.name);
    setSample(s, file.name, 'file', { autoplay });
  } catch (e) { toast('That file could not be decoded. Try a WAV, MP3 or AIFF.'); }
}

/* ---------- demo samples, made in the browser ---------- */
async function loadDemo(kind, autoplay) {
  const sr = renderSr(), B = 60 / 124;
  const make = { loop: [2 * 4 * B, demoLoop], snare: [0.32, demoSnare], chord: [2 * B, demoChord] }[kind];
  const oc = new OfflineAudioContext(2, Math.round(make[0] * sr), sr);
  make[1](oc, B);
  const b = await oc.startRendering();
  if (!HOST && bpm !== 124 && kind === 'loop') { bpm = 124; $('#bpm').value = bpm; }
  setSample({ chans: [b.getChannelData(0).slice(), b.getChannelData(1).slice()], sr }, { loop: 'Demo · house loop', snare: 'Demo · snare', chord: 'Demo · chord stab' }[kind], 'demo', { autoplay });
}
function noiseBuf(oc) { const n = oc.createBuffer(1, oc.sampleRate, oc.sampleRate), d = n.getChannelData(0), r = LF.rng(99); for (let i = 0; i < d.length; i++) d[i] = r(); return n; }
const envGain = (g, t, a, peak, dec) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec); };
const midi = m => 440 * Math.pow(2, (m - 69) / 12);
function demoSnare(oc) {
  const noise = noiseBuf(oc), s = oc.createBufferSource(), bp = oc.createBiquadFilter(), g = oc.createGain();
  s.buffer = noise; bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.8;
  envGain(g, 0, 0.001, 0.7, 0.18); s.connect(bp).connect(g).connect(oc.destination); s.start(0);
  const o = oc.createOscillator(), og = oc.createGain(); o.frequency.setValueAtTime(240, 0); o.frequency.exponentialRampToValueAtTime(160, 0.08);
  envGain(og, 0, 0.001, 0.6, 0.09); o.connect(og).connect(oc.destination); o.start(0); o.stop(0.3);
}
function demoChord(oc, B) {
  const fl = oc.createBiquadFilter(), g = oc.createGain();
  fl.type = 'lowpass'; fl.Q.value = 2; fl.frequency.setValueAtTime(2400, 0); fl.frequency.exponentialRampToValueAtTime(900, 2 * B);
  g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.2, 0.01); g.gain.setValueAtTime(0.2, 2 * B - 0.08); g.gain.linearRampToValueAtTime(0, 2 * B);
  fl.connect(g).connect(oc.destination);
  [57, 60, 64, 67, 71].forEach((m, i) => { for (const det of [-9, 9]) { const o = oc.createOscillator(), p = oc.createStereoPanner(); o.type = 'sawtooth'; o.frequency.value = midi(m); o.detune.value = det + i; p.pan.value = det > 0 ? 0.4 : -0.4; o.connect(p).connect(fl); o.start(0); o.stop(2 * B); } });
}
function demoLoop(oc, B) {
  const bars = 2, sr = oc.sampleRate;
  const bus = oc.createDynamicsCompressor(); bus.threshold.value = -14; bus.ratio.value = 3; bus.connect(oc.destination);
  const noise = noiseBuf(oc);
  const kick = t => { const o = oc.createOscillator(), g = oc.createGain(); o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.08); envGain(g, t, 0.002, 0.95, 0.38); o.connect(g).connect(bus); o.start(t); o.stop(t + 0.5); };
  const hit = (t, type, f, q, peak, dec, pan = 0) => {
    const s = oc.createBufferSource(), fl = oc.createBiquadFilter(), g = oc.createGain(), p = oc.createStereoPanner();
    s.buffer = noise; fl.type = type; fl.frequency.value = f; fl.Q.value = q; p.pan.value = pan;
    envGain(g, t, 0.001, peak, dec); s.connect(fl).connect(g).connect(p).connect(bus); s.start(t, (t * 7.3) % 0.5); s.stop(t + dec + 0.05);
  };
  const clap = t => { for (let k = 0; k < 3; k++) hit(t + k * 0.011, 'bandpass', 1400, 1.4, 0.55, k < 2 ? 0.02 : 0.18); };
  const stab = (t, notes, dur) => {
    const fl = oc.createBiquadFilter(), g = oc.createGain();
    fl.type = 'lowpass'; fl.Q.value = 3; fl.frequency.setValueAtTime(3800, t); fl.frequency.exponentialRampToValueAtTime(700, t + dur);
    envGain(g, t, 0.004, 0.16, dur); fl.connect(g).connect(bus);
    notes.forEach((m, i) => { for (const det of [-7, 7]) { const o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(m); o.detune.value = det + i; o.connect(fl); o.start(t); o.stop(t + dur + 0.1); } });
  };
  const bass = (t, m, dur) => { const o = oc.createOscillator(), g = oc.createGain(), fl = oc.createBiquadFilter(); o.type = 'triangle'; o.frequency.value = midi(m); fl.type = 'lowpass'; fl.frequency.value = 600; envGain(g, t, 0.005, 0.5, dur); o.connect(fl).connect(g).connect(bus); o.start(t); o.stop(t + dur + 0.1); };
  const chords = [[57, 60, 64, 67, 71], [53, 57, 60, 64, 67]], roots = [33, 29];
  for (let bar = 0; bar < bars; bar++) for (let b = 0; b < 4; b++) {
    const t = (bar * 4 + b) * B;
    kick(t); if (b % 2 === 1) clap(t);
    hit(t + B / 2, 'highpass', 8000, 0.7, 0.32, 0.05, 0.2);
    hit(t + B / 4, 'highpass', 9000, 0.7, 0.12, 0.025, -0.3); hit(t + 3 * B / 4, 'highpass', 9000, 0.7, 0.14, 0.025, -0.3);
    if (b === 3 && bar === 1) hit(t + B / 2, 'highpass', 6000, 0.7, 0.25, 0.3, 0.2);
    stab(t + B / 2, chords[bar], B * 0.42); if (b === 0) stab(t, chords[bar], B * 0.3);
    bass(t + B / 2, roots[bar] + 12, B * 0.4);
  }
  void sr;
}

/* ---------- view: SAMPLE or LIVE (plugin) ---------- */
function setView(v, tell = true) {
  UI.view = HOST ? v : 'sample';
  document.documentElement.classList.toggle('view-live', UI.view === 'live');
  $('#tabSample').setAttribute('aria-selected', UI.view === 'sample'); $('#tabLive').setAttribute('aria-selected', UI.view === 'live');
  if (UI.view === 'live') stopPreview();
  if (tell) { saveUi(); if (HOST) HOST.call('setView', UI.view); }
  T.queue.length = 0;
}
$('#tabSample').addEventListener('click', () => setView('sample'));
$('#tabLive').addEventListener('click', () => setView('live'));

/* ---------- sample strip ---------- */
$('#recBtn').addEventListener('click', () => { engine.unlock(); engine.record(); });
const loadMenu = $('#loadMenu');
const closeMenu = () => { loadMenu.hidden = true; $('#loadBtn').setAttribute('aria-expanded', 'false'); };
$('#loadBtn').addEventListener('click', e => {
  e.stopPropagation(); engine.unlock();
  loadMenu.hidden = !loadMenu.hidden; $('#loadBtn').setAttribute('aria-expanded', String(!loadMenu.hidden));
  if (!loadMenu.hidden) loadMenu.querySelector('button').focus();
});
loadMenu.addEventListener('click', e => {
  const b = e.target.closest('[data-load]'); if (!b) return;
  closeMenu();
  if (b.dataset.load === 'file') engine.load(); else loadDemo(b.dataset.load, true);
});
document.addEventListener('click', e => { if (!loadMenu.hidden && !e.target.closest('#loadMenu')) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !loadMenu.hidden) { closeMenu(); $('#loadBtn').focus(); } });
$('#fileIn').addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0], true); e.target.value = ''; });
$('#previewBtn').addEventListener('click', () => engine.toggle());
$('#dragOut').addEventListener('dragstart', e => {
  if (!SM.wavURL) { e.preventDefault(); toast('Load or record a sample first'); return; }
  const name = `${SM.name.replace(/\.[^.]+$/, '')} - Liftoff riser ${Math.round(bpm)}bpm.wav`;
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('DownloadURL', `audio/wav:${name}:${SM.wavURL}`);
  e.dataTransfer.setData('text/uri-list', SM.wavURL);
});
$('#exportBtn').addEventListener('click', () => SM.render ? engine.exportWav() : toast('Load or record a sample first'));
$('#bpm').addEventListener('change', e => { bpm = clamp(+e.target.value || 120, 40, 300); e.target.value = +bpm.toFixed(2); saveSoon(); scheduleRender(0); });
$('#launch').addEventListener('click', () => engine.launch());
let dragDepth = 0;
window.addEventListener('dragenter', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('#dropZone').classList.add('on'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropZone').classList.remove('on'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#dropZone').classList.remove('on'); const f = e.dataTransfer.files[0]; if (f) { engine.unlock(); if (UI.view === 'live') setView('sample'); loadFile(f, true); } });

/* ---------- telemetry (LIVE mode) ---------- */
const T = { st: null, at: 0, queue: [], drops: -1, dropAt: -1e9 };
function receive(st, delayMs) { T.queue.push({ st, due: performance.now() + Math.max(0, delayMs) }); }
function pump(now) {
  while (T.queue.length && T.queue[0].due <= now) {
    const { st } = T.queue.shift();
    if (T.drops >= 0 && st.drops > T.drops) { T.dropAt = now; if (UI.view === 'live') flash(); }
    T.drops = st.drops; T.st = st; T.at = now;
  }
}
function flash() { const f = $('#flash'); f.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on'))); }

/* ---------- the screen ---------- */
const cv = $('#path'), g2 = cv.getContext('2d');
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COL = { gold: css('--gold'), goldHi: css('--gold-hi'), goldLo: css('--gold-lo'), pink: css('--pink'), violet: css('--violet'), text: css('--text'), muted: css('--muted'), dim: css('--dim'), faint: css('--faint') };
const MONO = css('--mono');

function hud(label, big, sub, hot, pct, cls) {
  const lbl = $('#countLbl'), el = $('#count'), s = $('#countSub');
  if (lbl.textContent !== label) lbl.textContent = label;
  if (el.textContent !== big) el.textContent = big;
  el.classList.toggle('hot', !!hot); el.classList.toggle('rec', cls === 'rec');
  if (s.textContent !== sub) s.textContent = sub;
  const p = Math.round(pct * 100); $('#alt').textContent = p; $('#altBar').style.width = p + '%';
}

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); SM.layersFor = null; }
  return { dpr, W, H };
}

// the screen's frame: dark glass, a warm glow, scanlines
function screenBase(g, W, H) {
  g.fillStyle = '#070605'; g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * 0.55, H * 0.55, 10, W * 0.55, H * 0.55, W * 0.6);
  glow.addColorStop(0, 'rgba(227,176,98,.07)'); glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
}
function scanlines(g, W, H) { g.fillStyle = 'rgba(0,0,0,.18)'; for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1); }

// geometry of the transition on the screen
function geom(W, H) { const padX = 18, top = H < 260 ? 86 : 100, bot = H - 30; return { padX, top, bot, mid: (top + bot) / 2, half: (bot - top) / 2, w: W - padX * 2 }; }

// the waveform layers are drawn once per render (and per resize): bright = played / at rest, dim = still to come
function buildLayers(W, H, dpr) {
  const r = SM.render, G = geom(W, H);
  const mk = () => { const c = document.createElement('canvas'); c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); return [c, x]; };
  const [bg, gb] = mk(), [hi, gh] = mk(), [lo, gl] = mk();
  const xs = n => G.padX + n / r.N * G.w;
  const spb = r.spb, xe = xs(r.endAt);

  // background: bar grid, the riser warming up toward its end, labels
  screenBase(gb, W, H);
  gb.font = `700 10px ${MONO}`; gb.textBaseline = 'middle';
  const bars = Math.ceil(r.N / (spb * bpb));
  for (let k = 0; k <= bars; k++) {
    const n = k * bpb * spb; if (n > r.N) break;
    gb.fillStyle = 'rgba(255,240,210,.07)'; gb.fillRect(Math.round(xs(n)), G.top - 6, 1, G.bot - G.top + 6);
    for (let b = 1; b < bpb; b++) { const nb = n + b * spb; if (nb < r.endAt && r.N / spb < 40) { gb.fillStyle = 'rgba(255,240,210,.025)'; gb.fillRect(Math.round(xs(nb)), G.top, 1, G.bot - G.top); } }
    if (n < r.endAt - 1) { gb.fillStyle = COL.faint; gb.textAlign = 'left'; gb.fillText(`${k + 1}`, xs(n) + 4, G.bot + 14); }
  }
  gb.fillStyle = 'rgba(255,240,210,.06)'; gb.fillRect(G.padX, Math.round(G.mid), G.w, 1);
  const warm = gb.createLinearGradient(xs(0), 0, xe, 0); warm.addColorStop(0, 'rgba(227,176,98,0)'); warm.addColorStop(1, 'rgba(227,176,98,.12)');
  gb.fillStyle = warm; gb.fillRect(xs(0), G.top, xe - xs(0), G.bot - G.top);
  gb.fillStyle = 'rgba(0,0,0,.25)'; gb.fillRect(xe, G.top, xs(r.N) - xe, G.bot - G.top);
  gb.fillStyle = 'rgba(160,150,135,.7)'; gb.textAlign = 'center'; gb.fillText('TAIL', (xe + xs(r.N)) / 2, G.top - 10);
  // the build curve, like an automation lane
  gb.setLineDash([3, 4]); gb.strokeStyle = 'rgba(227,176,98,.45)'; gb.lineWidth = 1.2; gb.beginPath();
  for (let i = 0; i <= 100; i++) { const t = i / 100, x = xs(t * r.buildN), y = G.bot - LF.shape(t, V.curve) * (G.bot - G.top); i ? gb.lineTo(x, y) : gb.moveTo(x, y); }
  gb.stroke(); gb.setLineDash([]);

  // the ghost: the sample as it went in
  const cols = Math.max(50, Math.floor(G.w / 3));
  const dry = LF.peaks(r.dryL, r.dryR, 0, r.N, cols), wet = LF.peaks(r.L, r.R, 0, r.N, cols);
  let mx = 0.05; for (let i = 0; i < wet.length; i++) mx = Math.max(mx, Math.abs(wet[i]), Math.abs(dry[i]));
  const sc = G.half * 0.95 / mx, cw = G.w / cols;
  gb.fillStyle = 'rgba(255,240,210,.07)';
  for (let c = 0; c < cols; c++) { const y0 = G.mid - dry[c * 2 + 1] * sc, y1 = G.mid - dry[c * 2] * sc; gb.fillRect(G.padX + c * cw, y0, Math.max(1, cw - 1), Math.max(1, y1 - y0)); }

  // the riser, from dark gold to bright as it rises; the reverse swell's last beat in violet; the tail in grey
  const swellFrom = r.verbStart >= 0 ? Math.max(r.verbStart, r.endAt - spb) : r.endAt;
  const colour = (n, played) => {
    let rgb, a;
    if (n < swellFrom) { const p = LF.shape(n / r.buildN, V.curve); rgb = [Math.round(143 + (247 - 143) * p), Math.round(100 + (217 - 100) * p), Math.round(38 + (150 - 38) * p)]; a = 0.6 + 0.4 * p; }
    else if (n < r.endAt) { const k = (n - swellFrom) / Math.max(1, r.endAt - swellFrom); rgb = [Math.round(247 - 70 * k), Math.round(217 - 60 * k), Math.round(150 + 105 * k)]; a = 1; }
    else { rgb = [130, 122, 108]; a = 0.7; }
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${played ? a : a * 0.32})`;
  };
  for (const [g, played] of [[gh, true], [gl, false]]) {
    for (let c = 0; c < cols; c++) {
      const n = (c + 0.5) / cols * r.N, y0 = G.mid - wet[c * 2 + 1] * sc, y1 = G.mid - wet[c * 2] * sc;
      g.fillStyle = colour(n, played); g.fillRect(G.padX + c * cw, y0, Math.max(1, cw - 1), Math.max(1, y1 - y0));
    }
    if (r.verbStart >= 0 && V.verb) {   // the reverse swell's shape, rising into the end
      const tail = Math.pow(10, (-60 + 48 * V.verbSize) / 20);
      g.strokeStyle = played ? 'rgba(190,170,255,.9)' : 'rgba(190,170,255,.35)'; g.lineWidth = 1.5; g.beginPath();
      for (let i = 0; i <= 50; i++) { const t = i / 50, n = r.verbStart + t * (r.endAt - r.verbStart), y = G.mid - Math.pow(tail, 1 - t) * G.half * 0.9; i ? g.lineTo(xs(n), y) : g.moveTo(xs(n), y); }
      g.stroke();
    }
    // the end of the riser: where your drop goes
    const dl = g.createLinearGradient(0, G.top, 0, G.bot); dl.addColorStop(0, 'rgba(255,246,220,.95)'); dl.addColorStop(1, 'rgba(227,176,98,.25)');
    g.fillStyle = dl; g.fillRect(Math.round(xe) - 1, G.top - 14, 2, G.bot - G.top + 14);
    g.font = `800 11px ${MONO}`; g.textBaseline = 'middle'; g.textAlign = 'right'; g.fillStyle = COL.goldHi; g.fillText('END', xe - 6, G.top - 10);
  }
  SM.layers = { bg, hi, lo, G, xs };
  SM.layersFor = SM.render;
}

let lastPhase = '';
function drawSample(now) {
  const { dpr, W, H } = sizeCanvas();
  const g = g2; g.setTransform(1, 0, 0, 1, 0, 0);
  const r = SM.render, playing = engine.playing();
  drawLane();

  if (H_recording()) { drawRec(g, W, H, dpr, now); return; }
  if (!r) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0); screenBase(g, W, H);
    const G = geom(W, H); g.fillStyle = 'rgba(255,240,210,.08)'; g.fillRect(G.padX, Math.round(G.mid), G.w, 1);
    scanlines(g, W, H);
    hud(SM.sample ? 'RENDERING' : '', SM.sample ? '…' : '', '', false, 0);
    modulation(0); return;
  }
  if (SM.layersFor !== r) buildLayers(W, H, dpr);
  const L = SM.layers, G = L.G;
  const pos = engine.pos();
  g.drawImage(L.bg, 0, 0);
  if (playing && pos >= 0) {
    const px = L.xs(pos) * dpr;
    g.drawImage(L.lo, 0, 0);
    g.save(); g.beginPath(); g.rect(0, 0, px, cv.height); g.clip(); g.drawImage(L.hi, 0, 0); g.restore();
  } else g.drawImage(L.hi, 0, 0);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  // where we are
  let label = 'RISER', big = `${fmtBars(r.buildBars)}`, sub = playing ? '' : W < 600 ? '▶ PREVIEW · or tap the screen' : '▶ PREVIEW or Space · click the screen to play from there', hot = false, pct = 0, phase = 'rest';
  if (playing && pos >= 0) {
    const x = L.xs(pos);
    g.fillStyle = 'rgba(255,246,220,.9)'; g.shadowColor = COL.gold; g.shadowBlur = 14; g.fillRect(Math.round(x), G.top - 14, 1.5, G.bot - G.top + 14); g.shadowBlur = 0;
    g.beginPath(); g.moveTo(x - 5, G.top - 20); g.lineTo(x + 5, G.top - 20); g.lineTo(x, G.top - 13); g.fillStyle = COL.goldHi; g.fill();
    const beats = (r.endAt - pos) / r.spb;
    if (pos < r.endAt) {
      phase = 'build'; label = 'LIFTOFF IN'; hot = true; pct = LF.shape(pos / r.buildN, V.curve);
      big = beats > bpb ? `T–${Math.ceil(beats / bpb - 1e-6)} BAR${Math.ceil(beats / bpb - 1e-6) > 1 ? 'S' : ''}` : `T–${Math.max(1, Math.ceil(beats - 1e-6))}`;
      sub = beats > bpb ? 'rising' : 'beats to the end';
    } else if (pos < r.endAt + 1.5 * r.spb) { phase = 'end'; label = 'END'; big = 'LIFTOFF'; sub = 'your drop goes here'; hot = true; pct = 1; }
    else { phase = 'tail'; label = 'TAIL'; big = 'TAIL'; sub = 'the effects ring out'; }
    if (phase === 'end' && lastPhase !== 'end') flash();
  }
  lastPhase = phase;
  if (SM.rendering) sub = 'rendering…';
  hud(label, big, sub, hot, pct);
  modulation(phase === 'build' ? pct : 0);
  scanlines(g, W, H);
}

/* ---------- the source lane: your whole sample, and the part you cut from it ---------- */
const lane = $('#srcLane'), lg = lane.getContext('2d');
let laneDrag = null;
function laneGeom() { return { pad: 12, w: lane.clientWidth - 24, h: lane.clientHeight }; }
function drawLane() {
  const dpr = window.devicePixelRatio || 1, W = lane.clientWidth, Hh = lane.clientHeight;
  if (!W) return;
  if (lane.width !== Math.round(W * dpr) || lane.height !== Math.round(Hh * dpr)) { lane.width = Math.round(W * dpr); lane.height = Math.round(Hh * dpr); SM.laneFor = null; }
  const g = lg; g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { pad, w } = laneGeom(), mid = Hh / 2 - 2;
  if (!SM.sample) { g.fillStyle = '#070605'; g.fillRect(0, 0, W, Hh); g.fillStyle = 'rgba(255,240,210,.08)'; g.fillRect(pad, Math.round(mid), w, 1); return; }
  if (SM.laneFor !== SM.sample) {   // the sample's peaks, once
    const s = SM.sample, cols = Math.max(50, Math.floor(w / 2));
    SM.lanePeaks = LF.peaks(s.chans[0], s.chans[1] || null, 0, s.chans[0].length, cols);
    let mx = 0.05; for (const v of SM.lanePeaks) mx = Math.max(mx, Math.abs(v)); SM.laneMax = mx; SM.laneFor = s;
  }
  g.fillStyle = '#070605'; g.fillRect(0, 0, W, Hh);
  const pk = SM.lanePeaks, cols = pk.length / 2, cw = w / cols, sc = (Hh / 2 - 8) / SM.laneMax;
  const xa = pad + UI.sel[0] * w, xb = pad + UI.sel[1] * w;
  g.fillStyle = 'rgba(227,176,98,.08)'; g.fillRect(xa, 2, xb - xa, Hh - 4);
  for (let c = 0; c < cols; c++) {
    const x = pad + c * cw, inSel = x + cw / 2 >= xa && x + cw / 2 <= xb;
    g.fillStyle = inSel ? 'rgba(247,217,150,.9)' : 'rgba(255,240,210,.18)';
    const y0 = mid - pk[c * 2 + 1] * sc, y1 = mid - pk[c * 2] * sc; g.fillRect(x, y0, Math.max(1, cw - 0.6), Math.max(1, y1 - y0));
  }
  if (!(UI.sel[0] <= 0 && UI.sel[1] >= 1)) {   // the bar on top: drag it to move the part
    g.fillStyle = 'rgba(227,176,98,.55)'; g.fillRect(xa, 2, xb - xa, 10);
    g.fillStyle = '#1d1407'; for (let k = -2; k <= 2; k++) g.fillRect(Math.round((xa + xb) / 2 + k * 4), 5, 2, 4);
  }
  // the handles
  for (const x of [xa, xb]) {
    g.fillStyle = COL.goldHi; g.fillRect(Math.round(x) - 1, 2, 2, Hh - 4);
    g.beginPath(); g.roundRect ? g.roundRect(x - 5, Hh / 2 - 12, 10, 24, 3) : g.rect(x - 5, Hh / 2 - 12, 10, 24); g.fill();
    g.fillStyle = '#1d1407'; g.fillRect(Math.round(x) - 2, Hh / 2 - 5, 1, 10); g.fillRect(Math.round(x) + 1, Hh / 2 - 5, 1, 10);
  }
  // the part playing on its own
  if (SM.audition) {
    const t = (performance.now() - SM.audition.at) / 1000 / SM.audition.dur;
    if (t >= 1) { SM.audition = null; setPartButton(false); }
    else { const x = xa + t * (xb - xa); g.fillStyle = '#fff6dc'; g.fillRect(Math.round(x), 2, 1.5, Hh - 4); }
  }
}
const laneT = e => { const r = lane.getBoundingClientRect(), { pad, w } = laneGeom(); return clamp(((e.clientX - r.left) / r.width * lane.clientWidth - pad) / w, 0, 1); };
lane.addEventListener('pointerdown', e => {
  if (!SM.sample) return;
  const t = laneT(e), { w } = laneGeom(), near = 8 / w, lr = lane.getBoundingClientRect(), y = (e.clientY - lr.top) / lr.height * lane.clientHeight;
  const whole = UI.sel[0] <= 0 && UI.sel[1] >= 1;
  lane.setPointerCapture(e.pointerId);
  if (!whole && Math.abs(t - UI.sel[0]) < near) laneDrag = { kind: 'a' };
  else if (!whole && Math.abs(t - UI.sel[1]) < near) laneDrag = { kind: 'b' };
  else if (!whole && y < 16 && t > UI.sel[0] && t < UI.sel[1]) laneDrag = { kind: 'move', from: t, sel: UI.sel.slice() };   // the bar on top
  else { laneDrag = { kind: 'new', from: t }; UI.sel = [t, t]; }
});
lane.addEventListener('pointermove', e => {
  const t = laneT(e), { w } = laneGeom(), near = 8 / w;
  if (!laneDrag) {
    const lr = lane.getBoundingClientRect(), y = (e.clientY - lr.top) / lr.height * lane.clientHeight, whole = UI.sel[0] <= 0 && UI.sel[1] >= 1;
    lane.style.cursor = !SM.sample || whole ? 'crosshair' : Math.abs(t - UI.sel[0]) < near || Math.abs(t - UI.sel[1]) < near ? 'ew-resize' : y < 16 && t > UI.sel[0] && t < UI.sel[1] ? 'grab' : 'crosshair';
    return;
  }
  const min = 0.02 * SM.sample.sr / SM.sample.chans[0].length;   // 20 ms at the least
  if (laneDrag.kind === 'a') UI.sel = [clamp(t, 0, UI.sel[1] - min), UI.sel[1]];
  else if (laneDrag.kind === 'b') UI.sel = [UI.sel[0], clamp(t, UI.sel[0] + min, 1)];
  else if (laneDrag.kind === 'move') { const len = laneDrag.sel[1] - laneDrag.sel[0], a = clamp(laneDrag.sel[0] + t - laneDrag.from, 0, 1 - len); UI.sel = [a, a + len]; }
  else UI.sel = [Math.min(laneDrag.from, t), Math.max(laneDrag.from, t)];
  sampleInfo();
});
const laneUp = () => {
  if (!laneDrag) return;
  const min = 0.02 * SM.sample.sr / SM.sample.chans[0].length;
  if (UI.sel[1] - UI.sel[0] < min) UI.sel = [0, 1];   // a click, not a drag: the whole sample
  laneDrag = null; sampleInfo(); saveUi(); stopPreview(); scheduleRender(0);
};
lane.addEventListener('pointerup', laneUp); lane.addEventListener('pointercancel', laneUp);
lane.addEventListener('dblclick', () => { if (!SM.sample) return; UI.sel = [0, 1]; sampleInfo(); saveUi(); scheduleRender(0); });
$('#selAll').addEventListener('click', () => { if (!SM.sample) return; UI.sel = [0, 1]; sampleInfo(); saveUi(); scheduleRender(0); });
function setPartButton(on) { $('#selPlayIcon').setAttribute('d', on ? 'M6 5h4.5v14H6zM13.5 5H18v14h-4.5z' : 'M7 4.5v15l13-7.5z'); }
function playPart() {
  if (!SM.sample) return;
  if (SM.audition) { engine.stopPart(); SM.audition = null; setPartButton(false); return; }
  stopPreview();
  const s = selectedSample();
  engine.playPart(s);
  SM.audition = { at: performance.now(), dur: s.chans[0].length / s.sr }; setPartButton(true);
}
$('#selPlay').addEventListener('click', playPart);

const fmtBars = b => b < 1 ? '½ BAR' : `${b} BAR${b > 1 ? 'S' : ''}`;
const H_recording = () => HOST ? HS.recording : !!engine.recSeconds && HS.recording;

// recording: the input scrolls across the screen
const recWave = [];
function drawRec(g, W, H, dpr, now) {
  g.setTransform(dpr, 0, 0, dpr, 0, 0); screenBase(g, W, H);
  const G = geom(W, H), lvl = HOST ? HS.recLevel : engine.recLevel();
  recWave.push(lvl); if (recWave.length > 400) recWave.shift();
  const cw = G.w / 400;
  for (let i = 0; i < recWave.length; i++) {
    const h = Math.min(1, recWave[i] * 1.4) * G.half * 0.95, x = G.padX + G.w - (recWave.length - i) * cw;
    g.fillStyle = `rgba(255,90,90,${0.35 + 0.65 * i / recWave.length})`; g.fillRect(x, G.mid - h, Math.max(1, cw - 0.5), Math.max(1, h * 2));
  }
  scanlines(g, W, H);
  const sec = HOST ? HS.recSeconds : engine.recSeconds();
  hud('RECORDING', `● ${sec.toFixed(1)} s`, HOST ? 'play it in your DAW · press REC to stop' : 'press REC again to stop', false, 0, 'rec');
  void now;
}

// click the screen to play from there
cv.addEventListener('click', e => {
  if (UI.view !== 'sample' || !SM.render || !SM.layers) return;
  const rect = cv.getBoundingClientRect(), G = SM.layers.G;
  const t = clamp(((e.clientX - rect.left) / rect.width * cv.clientWidth - G.padX) / G.w, 0, 1);
  engine.play(Math.round(t * SM.render.N));
});

/* ---------- LIVE mode: the build following the DAW (plugin) ---------- */
function live(now) {
  const st = T.st; if (!st) return null;
  const dt = (now - T.at) / 1000, playing = !!(st.playing ?? st.hostPlaying);
  return { st, playing, beat: st.beat + (playing ? dt * bpm / 60 : 0) };
}
function viewState(now) {
  const L = live(now);
  const phraseB = PHRASE_BARS[V.phrase] * bpb;
  const buildB = V.mode === MODE.AUTO ? Math.min(LENGTH_BARS[V.length] * bpb, phraseB) : LENGTH_BARS[V.length] * bpb;
  const gapB = V.drop ? Math.min(GAP_BEATS[V.gap], buildB) : 0;
  const s = { phraseB, buildB, gapB, cur: -1, after: -1, toDrop: -1, inGap: false, p: 0, barInPhrase: -1, pending: false, idle: false };
  if (!L) { s.idle = true; return s; }
  const sinceDrop = (now - T.dropAt) / 1000 * bpm / 60;
  if (V.mode === MODE.AUTO) {
    if (!L.playing) { s.idle = true; return s; }
    const t = LF.autoTimeline(V, L.beat, bpb);
    s.barInPhrase = Math.floor(t.pos / bpb); s.toDrop = t.toDrop;
    if (t.raw >= 0) { s.cur = t.raw * buildB; s.p = LF.shape(t.raw, V.curve); s.inGap = t.inGap; }
    else if (t.pos < bpb) s.after = t.pos;
  } else if (V.mode === MODE.TRIGGER) {
    const st = L.st; s.pending = st.pending;
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
function liveHud(s, now) {
  const sinceDrop = (now - T.dropAt) / 1000 * bpm / 60;
  let label = 'NEXT DROP', text = '—', hot = false, sub = '';
  if (sinceDrop < 1.5) { text = 'DROP'; hot = true; sub = 'and it lands'; }
  else if (s.inGap) { text = 'HOLD'; hot = true; sub = ['cut', 'tape stop', 'filter dive', 'stutter'][V.gapStyle]; }
  else if (V.mode === MODE.MANUAL) { label = 'MANUAL'; text = s.p > 0 ? 'RIDING' : 'READY'; sub = s.p > 0 ? 'pull BUILD down to drop' : 'push BUILD up to build'; }
  else if (V.mode === MODE.TRIGGER && s.toDrop < 0) { text = s.pending ? 'ARMED' : 'STANDBY'; hot = s.pending; sub = s.pending ? 'starts on the next bar' : 'LAUNCH or a MIDI note'; }
  else if (s.toDrop >= 0) {
    const bars = Math.ceil(s.toDrop / bpb - 1e-6);
    text = s.toDrop > bpb ? `T–${bars} BAR${bars > 1 ? 'S' : ''}` : `T–${Math.max(1, Math.ceil(s.toDrop - 1e-6))}`;
    hot = s.cur >= 0;
    const until = Math.ceil((s.toDrop - s.buildB) / bpb - 1e-6);
    sub = s.cur >= 0 ? (s.toDrop > bpb ? 'building' : 'beats to the drop') : `build starts in ${until} bar${until > 1 ? 's' : ''}`;
  } else sub = 'press play in your DAW';
  hud(label, text, sub, hot, s.p);
}
function drawLive(now) {
  const { dpr, W, H } = sizeCanvas();
  const g = g2; g.setTransform(dpr, 0, 0, dpr, 0, 0); screenBase(g, W, H);
  const s = viewState(now);
  liveHud(s, now); modulation(s.p); showValue('build', V.mode === MODE.MANUAL ? V.build : s.p);
  const padX = 18, stripY = 72, stripH = 12, gy0 = stripY + 36, gy1 = H - 26, gh = gy1 - gy0, gw = W - padX * 2;
  const buildB = s.buildB, after = Math.max(0.5, Math.min(bpb, buildB * 0.3)), span = buildB + after;
  const x = b => padX + b / span * gw, xd = x(buildB);
  g.font = `700 10px ${MONO}`; g.textBaseline = 'middle';
  if (V.mode === MODE.AUTO) {
    const bars = PHRASE_BARS[V.phrase], cw = gw / bars, buildBars = buildB / bpb;
    for (let k = 0; k < bars; k++) {
      const inBuild = k >= bars - buildBars - 1e-6 || (buildBars < 1 && k === bars - 1);
      g.fillStyle = k === s.barInPhrase ? COL.goldHi : inBuild ? 'rgba(227,176,98,.38)' : 'rgba(255,240,210,.07)';
      g.fillRect(padX + k * cw + 1, stripY, Math.max(1, cw - 2), stripH);
    }
    g.fillStyle = COL.muted; g.textAlign = 'left';
    g.fillText(`PHRASE · ${bars} BARS${s.barInPhrase >= 0 ? ` · BAR ${s.barInPhrase + 1}` : ''}`, padX, stripY + stripH + 10);
  } else {
    g.fillStyle = COL.dim; g.textAlign = 'left';
    g.fillText(V.mode === MODE.MANUAL ? 'MANUAL · ride or automate BUILD · hold it at 100% for the gap · pull it down to drop' : 'TRIGGER · a MIDI note or LAUNCH starts a build · it drops BUILD LENGTH later', padX, stripY + 6);
  }
  for (let b = 0; b <= Math.ceil(span); b++) {
    if (b > span) break;
    const bar = b % bpb === 0; if (!bar && buildB > 32) continue;
    g.fillStyle = bar ? 'rgba(255,240,210,.09)' : 'rgba(255,240,210,.03)'; g.fillRect(Math.round(x(b)), gy0, 1, gh);
    if (bar && b < buildB) { g.fillStyle = COL.faint; g.textAlign = 'left'; g.fillText(V.mode === MODE.MANUAL ? `${Math.round(b / buildB * 100)}%` : `${b / bpb + 1}`, x(b) + 4, gy1 + 13); }
  }
  const curvePath = () => { g.beginPath(); g.moveTo(x(0), gy1); for (let i = 0; i <= 120; i++) { const r = i / 120; g.lineTo(x(r * buildB), gy1 - LF.shape(r, V.curve) * gh * 0.92); } };
  curvePath(); g.lineTo(xd, gy1); g.closePath();
  const fill = g.createLinearGradient(0, gy0, 0, gy1); fill.addColorStop(0, 'rgba(227,176,98,.16)'); fill.addColorStop(1, 'rgba(227,176,98,.01)');
  g.fillStyle = fill; g.fill();
  if (s.cur > 0) {
    g.save(); g.beginPath(); g.rect(x(0), gy0 - 10, x(s.cur) - x(0), gh + 10); g.clip();
    curvePath(); g.lineTo(xd, gy1); g.closePath();
    const f2 = g.createLinearGradient(0, gy0, 0, gy1); f2.addColorStop(0, 'rgba(247,217,150,.42)'); f2.addColorStop(1, 'rgba(227,176,98,.06)');
    g.fillStyle = f2; g.fill(); g.restore();
  }
  const grad = g.createLinearGradient(x(0), 0, xd, 0); grad.addColorStop(0, COL.goldLo); grad.addColorStop(0.55, COL.gold); grad.addColorStop(1, COL.goldHi);
  curvePath(); g.strokeStyle = grad; g.lineWidth = 2.5; g.stroke();
  if (V.verb && V.verbMode === VERB_MODE.DROP) {
    const vb = Math.min(VERB_BEATS[V.verbLen], span), tail = Math.pow(10, (-60 + 48 * V.verbSize) / 20), hgt = gh * 0.75 * (0.4 + 0.6 * V.verbMix);
    g.strokeStyle = 'rgba(157,130,255,.85)'; g.lineWidth = 1.6; g.fillStyle = 'rgba(157,130,255,.16)';
    g.beginPath(); g.moveTo(x(buildB - vb), gy1);
    for (let i = 0; i <= 40; i++) { const r = i / 40; g.lineTo(x(buildB - vb + r * vb), gy1 - hgt * Math.pow(tail, 1 - r)); }
    g.lineTo(xd, gy1); g.closePath(); g.fill(); g.stroke();
  }
  if (s.gapB > 0) {
    const xg = x(buildB - s.gapB);
    g.fillStyle = s.inGap ? 'rgba(227,176,98,.22)' : 'rgba(227,176,98,.06)'; g.fillRect(xg, gy0, xd - xg, gh);
  }
  g.fillStyle = COL.goldHi; g.fillRect(Math.round(xd) - 1, gy0 - 6, 2, gh + 6);
  g.textAlign = 'left'; g.font = `800 11px ${MONO}`; g.fillText('DROP', xd + 6, gy0 + 2);
  const ph = s.cur >= 0 ? s.cur : s.after >= 0 ? buildB + Math.min(s.after, after) : -1;
  if (ph >= 0) {
    const px = x(ph), py = s.cur >= 0 ? gy1 - s.p * gh * 0.92 : gy1;
    g.fillStyle = 'rgba(255,240,210,.55)'; g.fillRect(Math.round(px), gy0 - 4, 1, gh + 4);
    g.shadowColor = COL.gold; g.shadowBlur = 16; g.fillStyle = COL.goldHi; g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
  }
  if (s.idle) { g.fillStyle = 'rgba(10,9,8,.35)'; g.fillRect(padX, gy0, gw, gh); }
  scanlines(g, W, H);
}

// knobs show how much of each amount is in play right now
function modulation(p) {
  for (const id of ['pitch', 'filter', 'wash', 'stutter', 'noise', 'width']) (views[id] || []).forEach(v => v.mod && v.mod(V.rise ? (V[id] - DEFS[id].min) / (DEFS[id].max - DEFS[id].min) * p : 0));
  (views.verbMix || []).forEach(v => v.mod && v.mod(V.verb && V.verbMode === VERB_MODE.BUILD ? V.verbMix * p : 0));
}

function meters() {
  let pin = 0, pout = 0;
  if (UI.view === 'live') { const st = T.st; pin = st ? st.peakIn : 0; pout = st ? st.peakOut : 0; }
  else if (H_recording()) pin = HOST ? HS.recLevel : engine.recLevel();
  else if (SM.render && engine.playing()) {
    const r = SM.render, n = Math.round(engine.pos()), w = Math.round(r.sr / 30);
    for (let i = Math.max(0, n - w); i < Math.min(r.N, n); i++) { pin = Math.max(pin, Math.abs(r.dryL[i])); pout = Math.max(pout, Math.abs(r.L[i]), Math.abs(r.R[i])); }
  }
  const w = v => Math.max(0, Math.min(100, (20 * Math.log10(Math.max(1e-6, v || 0)) + 48) / 48 * 100)) + '%';
  $('#mIn').style.height = w(pin); $('#mOut').style.height = w(pout);
}

function frame(now) {
  pump(now);
  if (UI.view === 'live') drawLive(now); else drawSample(now);
  meters();
  requestAnimationFrame(frame);
}

/* ---------- keys ---------- */
window.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space' && UI.view === 'sample') { e.preventDefault(); engine.toggle(); }
  else if ((e.key === 'r' || e.key === 'R') && UI.view === 'sample') engine.record();
  else if ((e.key === 'a' || e.key === 'A') && UI.view === 'sample') playPart();
  else if (e.key === 'l' || e.key === 'L') { if (UI.view === 'live' && V.mode === MODE.TRIGGER) engine.launch(); }
  else if (e.key === 'ArrowLeft' && !e.target.closest('.knob, .seg, .fader')) loadPreset(presetIdx - 1);
  else if (e.key === 'ArrowRight' && !e.target.closest('.knob, .seg, .fader')) loadPreset(presetIdx + 1);
});
window.addEventListener('resize', () => { SM.layersFor = null; });

/* ---------- the unit scales to the window, like a plugin GUI; narrow screens stack it instead ---------- */
function fit() {
  const unit = $('#deck'), stage = $('#stage'), W = window.innerWidth, Hh = window.innerHeight;
  if (!HOST && W < 760) { unit.style.transform = ''; stage.style.width = ''; stage.style.height = ''; return; }   // stacked (CSS)
  const h = unit.offsetHeight, s = HOST ? Math.min(W / 1200, Hh / h) : Math.min(1, (W - 24) / 1200);
  unit.style.transform = `scale(${s})`;
  stage.style.width = `${1200 * s}px`; stage.style.height = `${h * s}px`;
}
window.addEventListener('resize', fit);
fit();

refreshAll();
presetSel.value = clamp(presetIdx, 0, LIFTOFF_PRESETS.length - 1);
markEdited();
engine.init();
requestAnimationFrame(frame);
})();
