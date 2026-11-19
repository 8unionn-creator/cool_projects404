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
  dice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>'
};
/* ---------- plugin bridge ----------
   Inside the Groove Rack plugin the page runs in the plugin's web view: the plugin plays the
   sounds in sync with the DAW, and the page talks to it through JUCE's native functions. */
const HOST = (() => {
  const J = window.__JUCE__; if (!J || !J.backend) return null;
  let next = 1; const waiting = new Map();
  J.backend.addEventListener('__juce__complete', m => { const r = waiting.get(m.promiseId); if (r) { waiting.delete(m.promiseId); r(m.result); } });
  return {
    call(name, ...params) { return new Promise(res => { const id = next++; waiting.set(id, res); J.backend.emitEvent('__juce__invoke', { name, params, resultId: id }); }); },
    on(ev, fn) { J.backend.addEventListener(ev, fn); }
  };
})();
GR.HOST = HOST;
const H = { playing: false, tick: 0, at: 0, bpm: 0, levels: {} };
function bufToB64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64) { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; }
const RES_LABEL = { 12: '1/8 triplet', 16: '1/16', 24: '1/16 triplet', 32: '1/32' };

/* ---------- state ---------- */
let P = null;
const ui = { gen: { complexity: 1, scope: 'all' }, queued: null, queuedFrom: -1, sel: null, bar: 0, follow: true, rollOpen: false, chord: 0, scaleOnly: false, metro: false, muted: false };
const hist = { undo: [], redo: [] };
const snap = () => JSON.stringify(P);
function commit() { hist.undo.push(snap()); if (hist.undo.length > 200) hist.undo.shift(); hist.redo.length = 0; }
function settle() { if (hist.undo.length && hist.undo[hist.undo.length - 1] === snap()) hist.undo.pop(); }
function edit(fn) { commit(); fn(); changed(); settle(); }
const track = id => P.tracks.find(t => t.id === id);
const selTrack = () => track(ui.sel);

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
  if (HOST) { HOST.call('audition', tr.id, note && note.p != null ? note.p : defaultPitch(tr), note ? note.vel : 0.85); return; }
  resume();
  const s = mix.strips[tr.id] || (GR.updateMix(mix, P, ui.muted), mix.strips[tr.id]);
  const inst = I[tr.inst];
  const v = ctx.createGain(); v.connect(s.in);
  const p = note && note.p != null ? note.p : defaultPitch(tr);
  GR.voice(ctx, v, ctx.currentTime + 0.01, tr, { vel: note ? note.vel : 0.85, p, dur: inst.pitched ? 0.32 : 0.1, from: null });
}

/* ---------- transport ---------- */
const S = { playing: false, nextTick: 0, nextTime: 0, aTick: 0, aTime: 0, timer: 0, st: null, map: null, pend: null, landing: null };
function tickMap() { if (!S.map) S.map = GR.buildTickMap(P); return S.map; }
function play() {
  if (HOST) { HOST.call('setPlaying', true); S.playing = true; H.playing = true; H.tick = 0; H.at = performance.now(); renderTransport(); return; }
  resume();
  S.st = GR.newState(); S.playing = true;
  S.nextTick = 0; S.nextTime = ctx.currentTime + 0.08; S.aTick = 0; S.aTime = S.nextTime; S.pend = null; ui.queued = null;
  clearInterval(S.timer); S.timer = setInterval(sched, 25); sched();
  renderTransport();
}
function stop() {
  if (HOST) { HOST.call('setPlaying', false); S.playing = false; H.playing = false; renderTransport(); return; }
  S.playing = false; clearInterval(S.timer);
  if (ctx && S.st) {
    const now = ctx.currentTime;
    S.st.voices.forEach(x => { if (x.end > now) { try { x.v.gain.cancelScheduledValues(now); x.v.gain.setTargetAtTime(0, now, 0.02); } catch (e) {} } });
  }
  renderTransport();
}
function toggle() { S.playing ? stop() : play(); }
// Pick a bar. While the loop plays, playback moves there on the next bar line, so the groove never stumbles.
function seek(bar) {
  ui.bar = clamp(bar, 0, P.bars - 1);
  const p = pos();
  if (S.playing && !(HOST && H.host)) {
    ui.queued = ui.bar; ui.queuedFrom = p == null ? -1 : Math.floor(p / TPB);
    if (HOST) HOST.call('seek', ui.bar);
  } else ui.queued = null;
  refreshBar(); renderBars();
}
function sched() {
  if (!S.playing) return;
  const td = GR.tickDur(P), loopT = P.bars * TPB, map = tickMap(), now = ctx.currentTime, horizon = now + 0.12;
  if (S.nextTime < now - 0.25) {  // the tab slept: jump ahead instead of playing a burst
    const skip = Math.ceil((now - S.nextTime) / td); S.nextTick += skip; S.nextTime += skip * td; S.aTick = S.nextTick; S.aTime = S.nextTime;
  }
  while (S.nextTime < horizon) {
    if (ui.queued != null && S.nextTick % TPB === 0) {   // a bar line: jump to the bar that was picked
      const target = ui.queued * TPB, cur = S.nextTick % loopT;
      S.nextTick += target - cur; S.landing = ui.queued; ui.queued = null;
      S.pend = { tick: S.nextTick, time: S.nextTime };
    }
    const tick = S.nextTick % loopT, ev = map.get(tick);
    if (ev) {
      const t = S.nextTime + GR.swing(P, tick, td);
      ev.forEach(([tr, n]) => { const s = mix.strips[tr.id]; if (s) GR.playEvent(ctx, s.in, S.st, tr, n, t + GR.nudge(n) * td, td); });
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
  if (HOST) {
    if (!H.playing) return null;
    const td = 60 / (H.bpm || P.bpm) * 4 / TPB, loopT = P.bars * TPB;
    const p = H.tick + (performance.now() - H.at) / 1000 / td;
    return ((p % loopT) + loopT) % loopT;
  }
  if (!S.playing || !ctx) return null;
  if (S.pend && ctx.currentTime - (ctx.outputLatency || 0) >= S.pend.time) { S.aTick = S.pend.tick; S.aTime = S.pend.time; S.pend = null; }
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
let syncT = 0;
function syncHost() {
  if (!HOST) return;
  clearTimeout(syncT);
  syncT = setTimeout(async () => {
    let midi = '';
    try { midi = bufToB64(await GR.midi(P).arrayBuffer()); } catch (e) {}
    HOST.call('setProject', JSON.stringify(GR.pluginProject(P)), midi);
  }, 40);
}
function changed() {
  S.map = null;
  syncHost();
  if (mix) GR.updateMix(mix, P, ui.muted);
  if (ui.bar >= P.bars) ui.bar = P.bars - 1;
  clearTimeout(saveT); saveT = setTimeout(autosave, 400);
  renderAll();
}
function autosave() { store.set('groove-rack.current', snap()); }
// loops are 4 or 8 bars; anything else is filled out to the next one by repeating what is there
const MIN_BARS = 4, MAX_BARS = 8;
const snapBars = n => (n <= MIN_BARS ? MIN_BARS : MAX_BARS);
function load(project, keepHistory) {
  P = sanitize(project);
  if (P.bars !== snapBars(P.bars)) extendLoop(snapBars(P.bars));
  if (!Array.isArray(P.chords)) P.chords = GR.inferChords(P);
  takeTaste(P.taste);
  if (!keepHistory) { hist.undo.length = 0; hist.redo.length = 0; }
  if (!track(ui.sel)) ui.sel = (P.tracks[0] || {}).id || null;
  ui.bar = clamp(ui.bar, 0, P.bars - 1);
  loadSamples();
  changed();
}
function sanitize(p) {
  p = Object.assign(GR.emptyProject(), { tracks: [] }, p);
  p.bpm = clamp(+p.bpm || 120, 40, 240); p.bars = clamp(p.bars | 0 || 4, 1, 8); p.swing = clamp(+p.swing || 0, 0, 100);
  p.master = clamp(p.master == null ? 0.8 : +p.master, 0, 1); p.key = clamp(p.key | 0, 0, 11);
  p.chords = Array.isArray(p.chords) ? p.chords.slice(0, 8).map(c => (c && isFinite(c.r) ? { r: ((c.r | 0) % 12 + 12) % 12, q: String(c.q || '') } : null)) : null;
  if (!GR.SCALES[p.scale]) p.scale = 'minor';
  p.style = typeof p.style === 'string' ? p.style : ''; p.chordLock = !!p.chordLock;
  if (!(p.taste && typeof p.taste === 'object')) delete p.taste;
  p.tracks = (p.tracks || []).filter(t => t && I[t.inst]).map(t => {
    const n = GR.newTrack(t.inst, t.sound, t);
    if (!I[n.inst].sounds[n.sound]) n.sound = I[n.inst].def;
    if (![12, 16, 24, 32].includes(n.res)) n.res = 16;
    n.notes = (t.notes || []).filter(x => x && isFinite(x.t)).map(x => {
      const y = Object.assign({}, x);
      if (y.nudge != null) { y.nudge = clamp(+y.nudge || 0, -1.5, 1.5); if (Math.abs(y.nudge) < 0.02) delete y.nudge; }
      return y;
    });
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

/* ---------- rendering: the GR-16 machine ---------- */
const DICE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor"/></svg>';
const PLAY_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#49e8d0" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>';
const PAUSE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#49e8d0" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>';
const drumTracks = () => P.tracks.filter(t => !I[t.inst].pitched);
const bassTracks = () => P.tracks.filter(t => I[t.inst].pitched);
const two = n => String(n).padStart(2, '0');
const SCALE_SHORT = { minor: 'm', major: '', dorian: ' dor', phrygian: ' phr', 'harmonic minor': ' hm', mixolydian: ' mix', 'minor pentatonic': 'm pent', 'major pentatonic': ' pent', chromatic: ' chr' };
const keyLabel = () => GR.NOTE_NAMES[P.key] + (SCALE_SHORT[P.scale] != null ? SCALE_SHORT[P.scale] : '');

function renderAll() { renderOled(); renderTransport(); renderDensity(); renderDeck(); renderChan(); renderRoll(); renderFoot(); }
function renderStyleTag() {
  const t = $('#styleTag'); if (!t) return;
  const [lo, hi] = GR.styleBpm(genreOf(), P.style), L = learnedLoops();
  t.textContent = `${styleLabel().toUpperCase()} · ${lo}–${hi} BPM${L ? ` · ${L} LEARNED` : ''}`;
}
function renderOled() {
  $('#oledGenre').textContent = GR.GROOVES[genreOf()].name.toUpperCase();
  $('#oledGenreLbl').textContent = 'GENRE · ' + styleOf().name.toUpperCase();
  renderStyleTag();
  $('#oledTempo').textContent = (+P.bpm).toFixed(2);
  const daw = !!(HOST && H.daw);
  $('#syncTag').textContent = daw ? 'DAW SYNC' : 'INTERNAL';
  $('#tempoBox').classList.toggle('locked', daw);
  $('#tempoBox').title = daw ? 'Tempo follows your DAW. Tap for loop and key settings' : 'Drag or scroll to change the tempo, tap for tempo and loop settings';
  $('#oledBar').textContent = `${two(ui.bar + 1)} / ${two(P.bars)}`;
  $('#oledSwingKey').textContent = `${two(Math.round(P.swing))}% · ${keyLabel()}`;
  const prog = $('#oledProg');
  if (!prog.children.length) prog.innerHTML = Array.from({ length: 16 }, (_, s) => `<i class="${s % 4 === 0 ? 'beat' : ''}" data-p="${s}"></i>`).join('');
  renderStatus();
}
function renderStatus() {
  $('#oledStatus').textContent = S.playing ? `RUNNING · ${HOST && H.host ? 'DAW' : 'INTERNAL'}` : `READY · ${P.tracks.length} CH`;
}
function renderTransport() {
  const b = $('#playBtn');
  b.innerHTML = S.playing ? PAUSE_ICON : PLAY_ICON;
  b.classList.toggle('is-playing', S.playing);
  b.setAttribute('aria-label', S.playing ? 'Stop' : 'Play');
  renderStatus();
}
function renderDensity() { document.querySelectorAll('.density-pill').forEach(p => p.classList.toggle('active', +p.dataset.cx === ui.gen.complexity)); }
const rowCls = tr => (tr.id === ui.sel ? ' sel' : '') + (tr.mute ? ' muted' : '') + (tr.solo ? ' soloed' : '');
function chInfo(tr, n, sub) {
  return `<div class="ch"><div class="ch-id"><span class="ch-num">${two(n + 1)}</span><div class="ch-txt">
    <button class="ch-name" data-act="name" title="Tap to hear ${esc(tr.name)} · hold or double-tap for its settings">${esc(tr.name)}</button>
    <button class="ch-sample" data-act="sound" title="Change the sound or use your own sample">${esc(sub)}</button></div></div>
    <div class="ch-ms"><button class="ms-btn${tr.mute ? ' mute-on' : ''}" data-act="mute" aria-pressed="${tr.mute}" aria-label="Mute ${esc(tr.name)}" title="Mute">M</button><button class="ms-btn${tr.solo ? ' solo-on' : ''}" data-act="solo" aria-pressed="${tr.solo}" aria-label="Solo ${esc(tr.name)}" title="Solo">S</button></div></div>`;
}
const chRight = tr => `<div class="ch-right"><button class="dice-btn" data-act="dice" aria-label="New ${esc(tr.name)} pattern" title="New ${esc(tr.name)} pattern in the genre's style (hold for options)">${DICE}</button><div class="level-meter" data-meter="${tr.id}" aria-hidden="true">${'<i></i>'.repeat(8)}</div></div>`;
function padsInner(tr) {
  const stepT = TPB / tr.res, b0 = ui.bar * TPB, per = tr.res / 4, byStep = new Map();
  tr.notes.forEach(n => { if (n.t >= b0 && n.t < b0 + TPB) byStep.set(Math.floor((n.t - b0) / stepT), n); });
  let h = '';
  for (let s = 0; s < tr.res; s++) {
    const n = byStep.get(s), alt = Math.floor(s / per) % 2 === 1;
    const st = n ? (n.vel < 0.5 ? ' state-ghost' : ' state-full') : '';
    h += `<button class="step-pad${alt ? ' beat-group-alt' : ''}${st}" data-s="${s}" tabindex="-1" aria-label="${esc(tr.name)} step ${s + 1} ${n ? (n.vel < 0.5 ? 'ghost' : 'on') : 'off'}"${n && n.roll > 1 ? ` data-roll="${n.roll}"` : ''}></button>`;
  }
  return h;
}
function bassInner(tr) {
  const b0 = ui.bar * TPB, b1 = b0 + TPB, stepT = TPB / tr.res;
  if (!tr.notes.length) return '';
  const ps = tr.notes.map(n => n.p), lo = Math.min(...ps), span = Math.max(Math.max(...ps) - lo, 7);
  return tr.notes.filter(n => n.t < b1 && n.t + (n.len || stepT) > b0).map(n => {
    const a = Math.max(n.t, b0), e = Math.min(n.t + (n.len || stepT), b1);
    return `<span class="bass-note-bar${n.slide ? ' slide' : ''}" data-t="${n.t}" data-p="${n.p}" style="left:calc(${(a - b0) / TPB * 100}% + 1px);width:calc(${(e - a) / TPB * 100}% - 2px);bottom:${Math.round(3 + (n.p - lo) / span * 20)}px">${GR.noteName(n.p)}</span>`;
  }).join('');
}
function renderDeck() {
  const head = $('#stepHead');
  if (!head.children.length) head.innerHTML = Array.from({ length: 16 }, (_, s) => `<div class="sh"><span class="led${s % 4 === 0 ? ' beat' : ''}" data-led="${s}"></span><span class="num${s % 4 === 0 ? ' beat' : ''}">${s + 1}</span></div>`).join('');
  const drums = drumTracks();
  $('#drumRows').innerHTML = drums.map((tr, i) => `<div class="deck-row${rowCls(tr)}" data-id="${tr.id}">${chInfo(tr, i, GR.soundLabel(tr))}<div class="pads" data-pads="${tr.id}" style="--res:${tr.res}">${padsInner(tr)}</div>${chRight(tr)}</div>`).join('')
    || '<p class="deck-empty">No drum channels yet. Add one with + CHANNEL.</p>';
  $('#bassRows').innerHTML = bassTracks().map((tr, i) => `<div class="deck-row bass${rowCls(tr)}" data-id="${tr.id}">${chInfo(tr, drums.length + i, GR.soundLabel(tr) + ' · ' + keyLabel())}<div class="bass-lane" data-lane="${tr.id}" title="Tap empty space to add a note, tap a note to raise it, hold it for length and slide. Tap the channel name for the full piano roll"><div class="bass-grid-guides"><div></div><div></div><div></div><div></div></div><div class="bass-notes">${bassInner(tr)}</div></div>${chRight(tr)}</div>`).join('');
  lastStep = -1;
}
function renderFoot() {
  renderBars();
  setKnob('swing', P.swing / 100, Math.round(P.swing) + '%');
  setKnob('master', P.master, Math.round(P.master * 100) + '%');
  $('#midiPadText').innerHTML = HOST ? '<strong>SAVE MIDI</strong> · or drag from the strip below' : '<strong>DRAG MIDI</strong> into your DAW';
}
// eight bar tiles, each a little map of its hits: drum channels as rows, the bass as the bottom row
function barMap(b) {
  const rows = drumTracks().slice(0, 6), bass = bassTracks()[0], b0 = b * TPB;
  const cells = [];
  rows.forEach(tr => {
    const line = new Array(16).fill('');
    tr.notes.forEach(n => { if (n.t >= b0 && n.t < b0 + TPB) { const c = Math.floor((n.t - b0) / 6); line[c] = n.vel < 0.5 && line[c] !== 'h' ? 'g' : 'h'; } });
    line.forEach((v, i) => cells.push(v || (i % 4 === 0 ? 'beat' : '')));
  });
  if (bass) {
    const line = new Array(16).fill('');
    bass.notes.forEach(n => {
      const a = Math.max(n.t, b0), e = Math.min(n.t + (n.len || 6), b0 + TPB);
      for (let t = a; t < e; t += 6) line[Math.floor((t - b0) / 6)] = 'b';
    });
    line.forEach((v, i) => cells.push(v || (i % 4 === 0 ? 'beat' : '')));
  }
  return cells.map(c => `<i${c ? ` class="${c}"` : ''}></i>`).join('');
}
function renderBars() {
  const rows = Math.max(1, Math.min(6, drumTracks().length) + (bassTracks().length ? 1 : 0));
  const segs = Array.from({ length: 8 }, (_, i) => i < P.bars
    ? `<button class="bar-tile${i === ui.bar ? ' active' : ''}${i === ui.queued || i === S.landing ? ' queued' : ''}" data-bar="${i}" aria-label="Bar ${i + 1}" title="${S.playing ? 'Play bar ' + (i + 1) + ' from the next bar line' : 'Show bar ' + (i + 1)}"><span class="bt-top">${two(i + 1)}<small>${i === ui.queued || i === S.landing ? 'NEXT' : 'PLAY'}</small></span><span class="bt-map" style="--rows:${rows}">${barMap(i)}</span></button>`
    : `<button class="bar-tile beyond" data-bar="${i}" aria-label="Make the loop 8 bars" title="Make the loop 8 bars: bars 5–8 repeat 1–4"><b>+</b></button>`).join('');
  $('#bars').innerHTML = `<div class="loop-bracket" id="loopBracket" style="--n:${P.bars}"><span class="lb-label">LOOP 1–${P.bars}</span><span class="lb-handle" id="loopHandle" role="slider" tabindex="0" aria-label="Loop length in bars" aria-valuemin="4" aria-valuemax="8" aria-valuenow="${P.bars}" title="Drag to switch the loop between 4 and 8 bars (or use the arrow keys)"></span></div><div class="lane" id="lane">${segs}<i class="lane-head" id="laneHead" hidden></i></div>`;
  $('#psLoop').textContent = `LOOP · ${two(P.bars)} BAR${P.bars > 1 ? 'S' : ''}`;
  $('#followBtn').classList.toggle('on', ui.follow);
  $('#followBtn').setAttribute('aria-pressed', ui.follow);
  document.querySelectorAll('.loop-seg [data-tool]').forEach(b => { const on = b.dataset.tool === 'len' + P.bars; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
}
function setLoopLength(n) {
  n = snapBars(n); if (n === P.bars) return;
  const grow = n > P.bars;
  edit(() => { if (grow) extendLoop(n); else P.bars = n; });
  toast(grow ? `Loop is now ${n} bars: bars 5–8 repeat 1–4` : `Loop is now ${n} bars. Bars 5–8 are kept for when you go back to 8`);
}
function onLoopHandleDown(e) {
  const hd = e.target.closest('#loopHandle'); if (!hd) return;
  e.preventDefault(); e.stopPropagation();
  const lane = $('#lane').getBoundingClientRect(), br = $('#loopBracket');
  let n = P.bars;
  br.classList.add('drag');
  try { hd.setPointerCapture(e.pointerId); } catch (err) {}
  const mv = ev => {
    n = (ev.clientX - lane.left) / lane.width * 8 >= 6 ? MAX_BARS : MIN_BARS;
    br.style.setProperty('--n', n); br.querySelector('.lb-label').textContent = `LOOP 1–${n}`;
  };
  const up = () => { hd.removeEventListener('pointermove', mv); hd.removeEventListener('pointerup', up); hd.removeEventListener('pointercancel', up); br.classList.remove('drag'); if (n !== P.bars) setLoopLength(n); };
  hd.addEventListener('pointermove', mv); hd.addEventListener('pointerup', up); hd.addEventListener('pointercancel', up);
}

/* ---------- the selected channel: sound screen and knobs ---------- */
const CP = [
  { k: 'vol', label: 'VOL', to: v => v, from: n => Math.round(n * 100) / 100, fmt: v => Math.round(v * 100) + '%', def: 0.8, mix: true },
  { k: 'pan', label: 'PAN', to: v => (v + 1) / 2, from: n => Math.round((n * 2 - 1) * 50) / 50, fmt: v => (Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)), def: 0, mix: true },
  { k: 'pitch', label: 'PITCH', to: v => (v + 24) / 48, from: n => Math.round(n * 48 - 24), fmt: v => (v > 0 ? '+' : '') + v + ' st', def: 0 },
  { k: 'decay', label: 'LENGTH', to: v => (v - 0.3) / 1.7, from: n => Math.round((0.3 + n * 1.7) * 20) / 20, fmt: v => v.toFixed(2) + '×', def: 1 },
  { k: 'tone', label: 'TONE', to: v => v, from: n => Math.round(n * 100) / 100, fmt: v => (v >= 0.99 ? 'OPEN' : Math.round(v * 100) + '%'), def: 1, mix: true },
  { k: 'rev', label: 'REVERB', to: v => v, from: n => Math.round(n * 100) / 100, fmt: v => Math.round(v * 100) + '%', def: 0, mix: true },
  { k: 'echo', label: 'ECHO', to: v => v, from: n => Math.round(n * 100) / 100, fmt: v => Math.round(v * 100) + '%', def: 0, mix: true }
];
function knobVisual(el, norm) {
  const deg = clamp(norm, 0, 1) * 270;
  el.style.setProperty('--ring-deg', deg + 'deg');
  const ind = el.querySelector('.enc-ind'); if (ind) ind.style.transform = `rotate(${-135 + deg}deg)`;
}
function renderChan() {
  const box = $('#chanPanel'), tr = selTrack();
  if (!tr) { box.innerHTML = ''; return; }
  const inst = I[tr.inst], map = GR.midiMap(P)[tr.id] || {}, n = P.tracks.indexOf(tr);
  const midi = map.note != null ? `MIDI NOTE ${map.note}` : `MIDI CH ${(map.ch || 0) + 1}`;
  const knobs = CP.map(c => {
    const v = tr[c.k], label = c.k === 'decay' && inst.pitched ? 'RELEASE' : c.label;
    return `<div class="cp-knob" data-k="${c.k}"><button class="enc-knob sm" aria-label="${label}" aria-valuetext="${c.fmt(v)}" title="Drag or scroll · double-click resets" style="--ring-deg:${clamp(c.to(v), 0, 1) * 270}deg"><span class="enc-cap"><span class="enc-ind" style="transform:rotate(${-135 + clamp(c.to(v), 0, 1) * 270}deg)"></span></span></button><span class="foot-label">${label}</span><span class="knob-val">${c.fmt(v)}</span></div>`;
  }).join('');
  box.innerHTML = `
    <div class="oled-bezel cp-screen"><div class="oled-screen cp-oled">
      <div class="cp-top"><span>CH ${two(n + 1)} · <b>${esc(tr.name.toUpperCase())}</b></span><span>${midi} · ${tr.res} STEPS</span></div>
      <div class="cp-name"><button class="silicone-btn cp-arrow" data-cp="prev" aria-label="Previous sound" title="Previous built-in sound">◀</button><span class="val" title="${esc(GR.soundLabel(tr))}">${esc(GR.soundLabel(tr))}</span><button class="silicone-btn cp-arrow" data-cp="next" aria-label="Next sound" title="Next built-in sound">▶</button></div>
      <canvas class="cp-wave" id="cpWave" title="Tap to hear it" aria-label="Waveform of ${esc(GR.soundLabel(tr))}"></canvas>
      <div class="cp-actions">
        <button class="silicone-btn tool-btn" data-cp="load">${tr.sample ? 'REPLACE SAMPLE' : 'LOAD SAMPLE…'}</button>
        <button class="silicone-btn tool-btn" data-cp="sounds">ALL SOUNDS</button>
        ${tr.sample ? '<button class="silicone-btn tool-btn" data-cp="builtin">BUILT-IN</button>' : ''}
      </div>
    </div></div>
    <div class="cp-knobs">${knobs}</div>
    <div class="cp-side">
      <div class="seg" role="group" aria-label="Steps per bar">${[12, 16, 24, 32].map(r => `<button data-res="${r}" class="${r === tr.res ? 'on' : ''}" title="${RES_LABEL[r]}">${r}</button>`).join('')}</div>
      <div class="row"><button class="ms-btn${tr.mute ? ' mute-on' : ''}" data-cp="mute" aria-pressed="${tr.mute}">MUTE</button><button class="ms-btn${tr.solo ? ' solo-on' : ''}" data-cp="solo" aria-pressed="${tr.solo}">SOLO</button></div>
      <div class="row"><button class="silicone-btn tool-btn${ui.rollOpen ? ' on' : ''}" data-cp="roll" aria-pressed="${ui.rollOpen}" title="Open ${esc(tr.name)} in the piano roll (P)">PIANO ROLL</button></div>
      <div class="row"><button class="silicone-btn tool-btn" data-cp="dice">${DICE} NEW</button><button class="silicone-btn tool-btn" data-cp="more">MORE…</button></div>
      <div class="cp-hint">${esc(tr.name)} · ${inst.pitched ? 'bass' : 'drums'}${tr.sample ? ' · your sample' : ''}</div>
    </div>`;
  drawChanWave(tr);
}
// the sound's waveform: the user's sample, or one hit of the synth rendered offline
const cpWaves = new Map();
async function drawChanWave(tr) {
  const cv = $('#cpWave'); if (!cv) return;
  const sig = JSON.stringify([tr.inst, tr.sound, tr.sample, !!GR.samples.get(tr.sample), tr.pitch, tr.decay]);
  let peaks = cpWaves.get(sig);
  if (!peaks) {
    try {
      let d;
      const buf = tr.sample && GR.samples.get(tr.sample);
      if (buf) d = buf.getChannelData(0);
      else {
        const sr = 22050, ctx = new OfflineAudioContext(1, sr * 1.4, sr);
        GR.voice(ctx, ctx.destination, 0, tr, { vel: 1, p: defaultPitch(tr), dur: 0.7, from: null });
        d = (await ctx.startRendering()).getChannelData(0);
      }
      let end = d.length; while (end > 1 && Math.abs(d[end - 1]) < 0.002) end--;
      const N = 180, per = Math.max(1, end / N); let mx = 0;
      peaks = new Float32Array(N);
      for (let i = 0; i < N; i++) { let m = 0; for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) m = Math.max(m, Math.abs(d[j] || 0)); peaks[i] = m; mx = Math.max(mx, m); }
      for (let i = 0; i < N; i++) peaks[i] /= Math.max(mx, 0.05);
      cpWaves.set(sig, peaks);
    } catch (e) { return; }
  }
  if (selTrack() !== tr || !cv.isConnected) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, Hh = cv.clientHeight; if (!W) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, Hh);
  const mid = Hh / 2;
  g.fillStyle = '#ffaa2b22'; g.fillRect(0, mid - 0.5, W, 1);
  g.fillStyle = '#ffaa2b'; g.shadowColor = '#ffaa2b'; g.shadowBlur = 6;
  const step = W / peaks.length;
  for (let i = 0; i < peaks.length; i++) { const h = Math.max(0.6, peaks[i] * (Hh * 0.44)); g.fillRect(i * step, mid - h, Math.max(1, step * 0.62), h * 2); }
}
function onChanClick(e) {
  const tr = selTrack(); if (!tr) return;
  const b = e.target.closest('[data-cp], [data-res], #cpWave'); if (!b) return;
  if (b.id === 'cpWave') { audition(tr); return; }
  if (b.dataset.res) { edit(() => { tr.res = +b.dataset.res; }); return; }
  const a = b.dataset.cp, keys = Object.keys(I[tr.inst].sounds);
  if (a === 'prev' || a === 'next') {
    const i = tr.sample ? (a === 'next' ? -1 : 0) : keys.indexOf(tr.sound);
    edit(() => { tr.sound = keys[(i + (a === 'next' ? 1 : -1) + keys.length) % keys.length]; tr.sample = null; tr.sampleName = null; });
    audition(tr);
  } else if (a === 'load') pickSample(tr);
  else if (a === 'sounds') soundSheet(tr);
  else if (a === 'builtin') { edit(() => { tr.sample = null; tr.sampleName = null; }); audition(tr); }
  else if (a === 'mute') edit(() => { tr.mute = !tr.mute; });
  else if (a === 'solo') edit(() => { tr.solo = !tr.solo; });
  else if (a === 'dice') newPattern(tr);
  else if (a === 'more') channelSheet(tr);
  else if (a === 'roll') toggleRoll();
}
function toggleRoll() {
  ui.rollOpen = !ui.rollOpen; renderRoll(); renderChan();
  if (ui.rollOpen) { const r = $('#roll'); if (r && r.scrollIntoView) r.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}
// the panel's knobs, by delegation (the panel is redrawn on every change)
function chanKnob(el) {
  const k = el.closest('.cp-knob').dataset.k, c = CP.find(x => x.k === k);
  return {
    c,
    get: () => clamp(c.to(selTrack()[k]), 0, 1),
    set: n => {
      const tr = selTrack(); tr[k] = c.from(clamp(n, 0, 1));
      knobVisual(el, c.to(tr[k]));
      const val = el.parentNode.querySelector('.knob-val'); if (val) val.textContent = c.fmt(tr[k]);
      if (mix) GR.updateMix(mix, P, ui.muted);
      syncHost();
    }
  };
}
function onChanKnobDown(e) {
  const el = e.target.closest('.cp-knob .enc-knob'); if (!el) return;
  e.preventDefault();
  const kn = chanKnob(el), y0 = e.clientY, v0 = kn.get(); commit();
  try { el.setPointerCapture(e.pointerId); } catch (err) {}
  const mv = ev => kn.set(v0 + (y0 - ev.clientY) / 140);
  const up = () => {
    el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    changed(); settle();
    if (!kn.c.mix) audition(selTrack());
  };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
function setKnob(id, norm, text) {
  const deg = clamp(norm, 0, 1) * 270;
  $(`#${id}Knob`).style.setProperty('--ring-deg', deg + 'deg');
  $(`#${id}Ind`).style.transform = `rotate(${-135 + deg}deg)`;
  $(`#${id}Val`).textContent = text;
  $(`#${id}Knob`).setAttribute('aria-valuetext', text);
}
// the bar on view changed: redraw what shows one bar
function refreshBar() {
  drumTracks().forEach(tr => { const el = $(`[data-pads="${tr.id}"]`); if (el) el.innerHTML = padsInner(tr); });
  bassTracks().forEach(tr => { const el = $(`[data-lane="${tr.id}"] .bass-notes`); if (el) el.innerHTML = bassInner(tr); });
  $('#oledBar').textContent = `${two(ui.bar + 1)} / ${two(P.bars)}`;
  document.querySelectorAll('.bar-tile').forEach((b, i) => b.classList.toggle('active', i === ui.bar));
  document.querySelectorAll('#roll .pr-bar').forEach((x, i) => x.classList.toggle('on', i === ui.bar));
  lastStep = -1;
}
function light(tr) {  // cheap update of one channel during a drag
  S.map = null;
  const pads = $(`[data-pads="${tr.id}"]`); if (pads) pads.innerHTML = padsInner(tr);
  const lane = $(`[data-lane="${tr.id}"] .bass-notes`); if (lane) lane.innerHTML = bassInner(tr);
  const tile = $(`.bar-tile[data-bar="${ui.bar}"] .bt-map`); if (tile) tile.innerHTML = barMap(ui.bar);
  if (!$('#roll').hidden) drawRollNotes();
}

/* ---------- piano roll: the whole loop, for every channel ----------
   Bars across the top, a chord lane, a keyboard, the notes, and a velocity lane underneath.
   Drum channels show their hits at C4 (the sound as it is); moving a hit up or down pitches it. */
const ROWH = 13, KEYW = 58;
const isPitched = tr => !!I[tr.inst].pitched;
const notePitch = (tr, n) => (n.p != null ? n.p : (isPitched(tr) ? 48 : 60));
const noteLen = (tr, n) => (isPitched(tr) ? (n.len || TPB / tr.res) : TPB / tr.res);
function rollRange(tr) {
  if (!isPitched(tr)) return [48, 72];
  const lo = tr.low != null ? tr.low : 24;
  return [lo, lo + 36];
}
function rollRows(tr) {
  const [lo, hi] = rollRange(tr), rows = [];
  for (let m = hi; m >= lo; m--) if (!ui.scaleOnly || inScale(m) || (!isPitched(tr) && m === 60)) rows.push(m);
  return rows;
}
function renderRoll() {
  const box = $('#roll'), tr = selTrack();
  const show = !!(tr && ui.rollOpen);
  box.hidden = !show; if (!show) return;
  const rows = rollRows(tr), L = P.bars, z = ui.rollZoom || 1;
  const prev = $('#prScroll'), keep = prev && ui._rollFor === tr.id ? [prev.scrollLeft, prev.scrollTop] : null;
  if (!Array.isArray(P.chords)) P.chords = GR.inferChords(P);
  const keys = rows.map(m => {
    const pc = ((m % 12) + 12) % 12, blk = [1, 3, 6, 8, 10].includes(pc);
    return `<button class="pk${blk ? ' blk' : ''}${pc === 0 ? ' c' : ''}" data-key="${m}" tabindex="-1" aria-label="Play ${GR.noteName(m)}">${pc === 0 ? GR.noteName(m) : ''}</button>`;
  }).join('');
  const bgs = rows.map(m => {
    const pc = ((m % 12) + 12) % 12;
    return `<div class="pr-rowbg${[1, 3, 6, 8, 10].includes(pc) ? ' blk' : ''}${(((m - P.key) % 12) + 12) % 12 === 0 ? ' root' : ''}${inScale(m) ? '' : ' out'}${!isPitched(tr) && m === 60 ? ' home' : ''}"></div>`;
  }).join('');
  const ruler = Array.from({ length: L }, (_, b) => `<button class="pr-bar${b === ui.bar ? ' on' : ''}" data-rbar="${b}" style="left:${b / L * 100}%;width:${100 / L}%" title="Go to bar ${b + 1}">${b + 1}</button>`).join('');
  const chords = Array.from({ length: L }, (_, b) => {
    const c = P.chords[b];
    return `<button class="pr-chord${c ? '' : ' empty'}" data-cbar="${b}" style="left:${b / L * 100}%;width:${100 / L}%" title="Chord for bar ${b + 1}: the bass follows it"><span>${c ? esc(GR.chordName(c, P)) : '+ chord'}</span></button>`;
  }).join('');
  box.innerHTML = `
    <div class="phead">
      <h2 class="ptitle">Piano roll <span>· ${esc(tr.name)} · ${isPitched(tr) ? GR.NOTE_NAMES[P.key] + ' ' + esc(P.scale) : 'move a hit up or down to pitch it'}</span></h2>
      <button class="silicone-btn chip" data-act="song" title="Key and scale">${esc(keyLabel())}</button>
      <button class="silicone-btn chip${ui.scaleOnly ? ' on' : ''}" data-act="scaleonly" aria-pressed="${ui.scaleOnly}">SCALE ONLY</button>
      <div class="seg" role="group" aria-label="Zoom">${[1, 2, 4].map(v => `<button data-zoom="${v}" class="${v === z ? 'on' : ''}" title="${v === 1 ? 'Whole loop' : v + '× wider'}">${v === 1 ? 'FIT' : v + '×'}</button>`).join('')}</div>
      <button class="silicone-btn ib" data-act="closeroll" aria-label="Close piano roll">${ICON.x}</button>
    </div>
    <div class="pr-scroll" id="prScroll">
      <div class="pr-inner" id="prInner">
        <div class="pr-row pr-top"><div class="pr-side pr-corner">BAR</div><div class="pr-lane pr-ruler">${ruler}<i class="pr-mark" id="prMark" hidden></i></div></div>
        <div class="pr-row pr-chordrow"><div class="pr-side">CHORDS</div><div class="pr-lane">${chords}</div></div>
        <div class="pr-row pr-mid"><div class="pr-side pr-keys">${keys}</div>
          <div class="pr-lane pr-grid" id="rcanvas" style="--bars:${L};--res:${tr.res};height:${rows.length * ROWH}px">${bgs}<div class="pr-lines"></div><div id="rnotes"></div><i class="pr-head" id="rHead" hidden></i></div></div>
        <div class="pr-row pr-velrow"><div class="pr-side">VEL</div><div class="pr-lane pr-vel" id="rvel" style="--bars:${L}"></div></div>
      </div>
    </div>
    <div class="rhint" id="rhint"></div>`;
  sizeRoll();
  drawRollNotes();
  const sc = $('#prScroll');
  if (keep) { sc.scrollLeft = keep[0]; sc.scrollTop = keep[1]; }
  else {
    const ps = tr.notes.map(n => notePitch(tr, n)), mid = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : (isPitched(tr) ? rollRange(tr)[0] + 12 : 60);
    const idx = rows.findIndex(m => m <= mid);
    sc.scrollTop = Math.max(0, idx * ROWH - sc.clientHeight / 2 + 60);
  }
  ui._rollFor = tr.id;
}
function sizeRoll() {
  const sc = $('#prScroll'), inner = $('#prInner'); if (!sc || !inner) return;
  inner.style.width = Math.round(KEYW + (sc.clientWidth - KEYW) * (ui.rollZoom || 1)) + 'px';
}
function drawRollNotes() {
  const tr = selTrack(), layer = $('#rnotes'), vel = $('#rvel'); if (!tr || !layer) return;
  const rows = rollRows(tr), loopT = P.bars * TPB;
  let h = '', v = '', hidden = 0;
  tr.notes.forEach(n => {
    if (n.t >= loopT) return;
    const p = notePitch(tr, n), r = rows.indexOf(p), len = Math.min(noteLen(tr, n), loopT - n.t);
    v += `<span class="vstalk${n.vel < 0.5 ? ' ghost' : ''}" style="left:${n.t / loopT * 100}%;height:${Math.round(6 + n.vel * 40)}px"></span>`;
    if (r < 0) { hidden++; return; }
    h += `<div class="rnote${n.vel < 0.5 ? ' ghost' : ''}${isPitched(tr) ? '' : ' hit'}${n.nudge ? ' off' : ''}" style="top:${r * ROWH + 1}px;left:${(n.t + GR.nudge(n)) / loopT * 100}%;width:calc(${len / loopT * 100}% - 1px);--v:${n.vel}">${n.slide ? '↗' : ''}${n.roll > 1 ? '×' + n.roll : ''}</div>`;
  });
  layer.innerHTML = h; vel.innerHTML = v;
  const hint = $('#rhint');
  if (hint) hint.textContent = hidden
    ? `${hidden} note${hidden > 1 ? 's are' : ' is'} outside the rows shown${ui.scaleOnly ? ': turn off SCALE ONLY' : ''}.`
    : isPitched(tr)
      ? 'Tap to add a note, drag right to make it longer. Drag a note to move it, its right edge to resize it, tap it to delete, hold it for slide and more. Drag the orange stalks to set velocity. Tap a chord to change it: the bass in that bar follows.'
      : 'Each hit sits at C4, the sound as it is. Drag a hit up or down to pitch it, sideways to move it. Tap empty space to add a hit, tap a hit to delete it, hold it for rolls. Drag the orange stalks to set velocity.';
}

/* ---------- animation: playhead, pad flashes, meters, follow ---------- */
const tmp = new Float32Array(256);
const lv = {};
let lastStep = -1;
function showStep(t) {
  const s16 = t == null ? -1 : Math.floor(t / 6);
  document.querySelectorAll('.step-head .led').forEach((l, i) => l.classList.toggle('now', i === s16));
  document.querySelectorAll('#oledProg i').forEach((l, i) => l.classList.toggle('now', i === s16));
  document.querySelectorAll('.step-pad.playhead-col, .step-pad.is-triggered').forEach(p => p.classList.remove('playhead-col', 'is-triggered'));
  document.querySelectorAll('.bass-note-bar.is-triggered').forEach(p => p.classList.remove('is-triggered'));
  if (t == null) return;
  drumTracks().forEach(tr => {
    const pads = $(`[data-pads="${tr.id}"]`); if (!pads) return;
    const p = pads.children[Math.floor(t / (TPB / tr.res))]; if (!p) return;
    p.classList.add('playhead-col');
    if (p.classList.contains('state-full') || p.classList.contains('state-ghost')) p.classList.add('is-triggered');
  });
  const now = ui.bar * TPB + Math.floor(t / 6) * 6;
  document.querySelectorAll('.bass-note-bar').forEach(b => { const nt = +b.dataset.t; if (nt >= now && nt < now + 6) b.classList.add('is-triggered'); });
}
function frame() {
  requestAnimationFrame(frame);
  const p = pos();
  if (p != null) {
    const bar = Math.floor(p / TPB);
    if (HOST && ui.queued != null && bar !== ui.queuedFrom) ui.queued = null;
    if (S.landing != null && bar === S.landing) S.landing = null;
    if (ui.queued == null && S.landing == null && document.querySelector('.bar-tile.queued')) renderBars();
    if (ui.follow && ui.queued == null && S.landing == null && bar !== ui.bar && !dragging) { ui.bar = bar; refreshBar(); }
    const lh = $('#laneHead'); if (lh) { lh.hidden = false; lh.style.left = (p / (8 * TPB) * 100) + '%'; }
    const rh = $('#rHead'), rm = $('#prMark'); if (rh) { const x = (p / (P.bars * TPB) * 100) + '%'; rh.hidden = false; rh.style.left = x; rm.hidden = false; rm.style.left = x; }
    document.querySelectorAll('.bar-tile').forEach((b, i) => b.classList.toggle('playing', i === bar && i < P.bars));
    const st = Math.floor((p % TPB) / 6);
    if (st !== lastStep && bar === ui.bar) { lastStep = st; showStep(p % TPB); }
  } else if (lastStep !== -2) {
    lastStep = -2; showStep(null);
    const lh = $('#laneHead'); if (lh) lh.hidden = true;
    const rh = $('#rHead'), rm = $('#prMark'); if (rh) { rh.hidden = true; rm.hidden = true; }
    if (ui.queued != null || S.landing != null) { ui.queued = null; S.landing = null; renderBars(); }
    document.querySelectorAll('.bar-tile.playing').forEach(b => b.classList.remove('playing'));
  }
  if (!mix && !HOST) return;
  document.querySelectorAll('[data-meter]').forEach(m => {
    const id = m.dataset.meter;
    let pk = 0, rms = 0;
    if (HOST) { const l = H.levels[id]; if (l) { pk = l[0]; rms = l[1]; } }
    else {
      const s = mix.strips[id]; if (!s || !s.an) return;
      s.an.getFloatTimeDomainData(tmp);
      let sq = 0; for (let i = 0; i < tmp.length; i++) { const v = Math.abs(tmp[i]); if (v > pk) pk = v; sq += v * v; }
      rms = Math.sqrt(sq / tmp.length);
    }
    const o = lv[id] || (lv[id] = { a: 0 });
    o.a = Math.max(Math.min(1, pk * 1.3 + rms), o.a * 0.86);
    const lit = Math.round(o.a * 8);
    if (o.lit === lit) return;
    o.lit = lit;
    Array.from(m.children).forEach((seg, i) => { seg.className = i < lit ? (i >= 7 ? 'r' : i >= 5 ? 'a' : 'g') : ''; });
  });
}

/* ---------- deck interactions ---------- */
let dragging = false;
function select(id, openRoll) {
  ui.sel = id;
  if (openRoll != null) ui.rollOpen = openRoll;
  document.querySelectorAll('.deck-row[data-id]').forEach(r => r.classList.toggle('sel', r.dataset.id === id));
  renderChan(); renderRoll();
}
const nextState = n => (!n ? 'full' : n.vel >= 0.5 ? 'ghost' : 'off');
function setStepState(tr, s, state) {
  const ex = stepNotes(tr, ui.bar, s);
  if (state === 'off') { ex.forEach(n => removeNote(tr, n)); return null; }
  const vel = state === 'ghost' ? 0.42 : 0.9;
  if (ex.length) { ex[0].vel = vel; return ex[0]; }
  return addNote(tr, ui.bar * TPB + s * (TPB / tr.res), { vel });
}
// pads: tap cycles on → ghost → off, drag across paints, drag up/down sets velocity, hold opens the note
function onPadDown(e) {
  const pad = e.target.closest('.step-pad'); if (!pad) return;
  const row = pad.closest('.deck-row'), tr = track(row.dataset.id); if (!tr) return;
  e.preventDefault();
  if (ui.sel !== tr.id) select(tr.id, false);
  const s0 = +pad.dataset.s, first = stepNotes(tr, ui.bar, s0)[0];
  if (e.button === 2) { if (first) noteSheet(tr, first); return; }
  const pads = pad.parentNode, rect = pads.getBoundingClientRect();
  const stepAt = x => clamp(Math.floor((x - rect.left) / rect.width * tr.res), 0, tr.res - 1);
  commit(); dragging = true;
  const x0 = e.clientX, y0 = e.clientY, target = nextState(first), done = new Set([s0]);
  let mode = 'tap', note = first, vel0 = first ? first.vel : 0.9;
  const lp = setTimeout(() => { if (mode === 'tap' && first) { mode = 'menu'; finish(); settle(); noteSheet(tr, first); } }, 480);
  try { pads.setPointerCapture(e.pointerId); } catch (err) {}
  const move = ev => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if (mode === 'tap' && Math.hypot(dx, dy) > 7) {
      clearTimeout(lp);
      if (Math.abs(dy) > Math.abs(dx) && first) mode = 'vel';
      else { mode = 'paint'; setStepState(tr, s0, target); light(tr); }
    }
    if (mode === 'vel') {
      note.vel = clamp(Math.round((vel0 - dy / 90) * 100) / 100, 0.05, 1);
      light(tr); hud(`velocity ${Math.round(note.vel * 100)}%`);
    } else if (mode === 'paint') {
      const s = stepAt(ev.clientX); if (done.has(s)) return;
      done.add(s); setStepState(tr, s, target); light(tr);
    }
  };
  const up = () => {
    clearTimeout(lp);
    if (mode === 'tap') { const n = setStepState(tr, s0, target); if (n) audition(tr, n); }
    finish();
    if (mode !== 'menu') { changed(); settle(); }
  };
  function finish() {
    dragging = false; hud(null);
    pads.removeEventListener('pointermove', move); pads.removeEventListener('pointerup', up); pads.removeEventListener('pointercancel', up);
  }
  pads.addEventListener('pointermove', move); pads.addEventListener('pointerup', up); pads.addEventListener('pointercancel', up);
}
// bass lane: tap empty space adds a note (drag right to lengthen), tap a note raises it a scale step, hold it for its options
function onLaneDown(e) {
  const lane = e.target.closest('.bass-lane'); if (!lane) return;
  const tr = track(lane.dataset.lane); if (!tr) return;
  e.preventDefault();
  if (ui.sel !== tr.id) select(tr.id, ui.rollOpen);
  const rect = lane.getBoundingClientRect(), stepT = TPB / tr.res, b0 = ui.bar * TPB;
  const stepAt = x => clamp(Math.floor((x - rect.left) / rect.width * tr.res), 0, tr.res - 1);
  const bar = e.target.closest('.bass-note-bar');
  const hit = bar && tr.notes.find(n => n.t === +bar.dataset.t && n.p === +bar.dataset.p);
  if (e.button === 2) { if (hit) noteSheet(tr, hit); return; }
  commit(); dragging = true;
  const x0 = e.clientX, s0 = stepAt(e.clientX);
  let mode = hit ? 'tap' : 'new', note = hit;
  if (!hit) {
    stepNotes(tr, ui.bar, s0).forEach(n => removeNote(tr, n));
    note = addNote(tr, b0 + s0 * stepT, { len: tr.lastLen || stepT * 2 });
    audition(tr, note); light(tr);
  }
  const lp = setTimeout(() => { if (mode === 'tap') { mode = 'menu'; finish(); settle(); noteSheet(tr, hit); } }, 480);
  try { lane.setPointerCapture(e.pointerId); } catch (err) {}
  const move = ev => {
    if (mode === 'tap' && Math.abs(ev.clientX - x0) > 7) { clearTimeout(lp); mode = 'len'; }
    if (mode === 'new' || mode === 'len') {
      const startStep = Math.floor((note.t - b0) / stepT);
      note.len = Math.max(stepT, (stepAt(ev.clientX) - startStep + 1) * stepT);
      light(tr);
    }
  };
  const up = () => {
    clearTimeout(lp);
    if (mode === 'tap') {
      const sc = GR.SCALES[P.scale];
      let p = note.p + 1; while (!sc.includes(((p - P.key) % 12 + 12) % 12)) p++;
      if (p > (tr.low != null ? tr.low : 24) + 24) p = nearestInScale((tr.low != null ? tr.low : 24) + 12) - 12;
      note.p = p; tr.lastP = p; audition(tr, note);
    }
    if (mode === 'new' || mode === 'len') tr.lastLen = note.len;
    finish();
    if (mode !== 'menu') { sortNotes(tr); changed(); settle(); }
  };
  function finish() {
    dragging = false;
    lane.removeEventListener('pointermove', move); lane.removeEventListener('pointerup', up); lane.removeEventListener('pointercancel', up);
  }
  lane.addEventListener('pointermove', move); lane.addEventListener('pointerup', up); lane.addEventListener('pointercancel', up);
}
function onDeckClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const row = b.closest('.deck-row'), tr = row && track(row.dataset.id); if (!tr) return;
  const act = b.dataset.act;
  if (act === 'dice') newPattern(tr);
  else if (act === 'mute') { edit(() => { tr.mute = !tr.mute; }); toast(tr.mute ? `${tr.name} muted` : `${tr.name} on`); }
  else if (act === 'solo') edit(() => { tr.solo = !tr.solo; });
  else if (act === 'sound') { select(tr.id); audition(tr); }
  else if (act === 'name') {
    const pitched = I[tr.inst].pitched;
    if (pitched) select(tr.id, !(ui.rollOpen && ui.sel === tr.id)); else select(tr.id);
    audition(tr);
  }
}
// a knob: drag up or down, scroll, arrow keys; double-click resets
function knob(el, get, set, reset) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); const y0 = e.clientY, v0 = get(); commit();
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    const mv = ev => { set(clamp(v0 + (y0 - ev.clientY) / 140, 0, 1)); };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); changed(); settle(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  el.addEventListener('wheel', e => { e.preventDefault(); edit(() => set(clamp(get() + (e.deltaY < 0 ? 0.04 : -0.04), 0, 1))); }, { passive: false });
  el.addEventListener('keydown', e => {
    const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 0.05 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -0.05 : 0;
    if (d) { e.preventDefault(); e.stopPropagation(); edit(() => set(clamp(get() + d, 0, 1))); }
  });
  el.addEventListener('dblclick', () => edit(() => set(reset)));
}
function transposeBy(d) {
  P.key = (P.key + d + 12) % 12;
  P.tracks.forEach(t => { if (I[t.inst].pitched) t.notes.forEach(n => { n.p = clamp(n.p + d, 0, 127); }); });
  if (Array.isArray(P.chords)) P.chords.forEach(c => { if (c) c.r = ((c.r + d) % 12 + 12) % 12; });
}
// make the loop longer by repeating what is there: each new bar copies the bar it lines up with
function extendLoop(to) {
  const L = P.bars;
  P.tracks.forEach(t => {
    t.notes = t.notes.filter(n => n.t < L * TPB);
    const add = [];
    for (let b = L; b < to; b++) {
      const src = b % L;
      t.notes.forEach(n => { if (Math.floor(n.t / TPB) === src) add.push(Object.assign({}, n, { t: n.t + (b - src) * TPB })); });
    }
    t.notes = t.notes.concat(add); sortNotes(t);
  });
  if (Array.isArray(P.chords)) for (let b = L; b < to; b++) P.chords[b] = P.chords[b % L] ? Object.assign({}, P.chords[b % L]) : null;
  P.bars = to;
}

/* ---------- piano roll interactions ---------- */
function onRollDown(e) {
  if (e.target.closest('#rvel')) return onVelDown(e);
  const cv = e.target.closest('#rcanvas'); if (!cv) return;
  const tr = selTrack(); if (!tr) return;
  e.preventDefault();
  const pitched = isPitched(tr), rows = rollRows(tr), rect = cv.getBoundingClientRect(), stepT = TPB / tr.res, loopT = P.bars * TPB, nSteps = P.bars * tr.res;
  const colAt = x => clamp(Math.floor((x - rect.left) / rect.width * nSteps), 0, nSteps - 1);
  const rowAt = y => clamp(Math.floor((y - rect.top) / ROWH), 0, rows.length - 1);
  const c0 = colAt(e.clientX), r0 = rowAt(e.clientY), p0 = rows[r0], tick0 = c0 * stepT;
  const hit = tr.notes.find(n => n.t < loopT && notePitch(tr, n) === p0 && n.t <= tick0 && tick0 < n.t + noteLen(tr, n));
  if (e.button === 2) { if (hit) noteSheet(tr, hit); return; }
  commit(); dragging = true;
  const setP = (n, p) => { if (pitched || p !== 60) n.p = p; else delete n.p; };
  let mode, note = hit, moved = false;
  if (hit) {
    const endX = rect.left + (hit.t + noteLen(tr, hit)) / loopT * rect.width;
    mode = pitched && e.clientX > endX - Math.min(10, rect.width / nSteps * 0.45) ? 'resize' : 'move';
  } else if (!pitched) {
    // drums keep one hit per step: an empty row at a step that has a hit re-pitches that hit
    const same = tr.notes.find(n => n.t >= tick0 && n.t < tick0 + stepT);
    if (same) { note = same; setP(same, p0); mode = 'move'; moved = true; }
    else { note = addNote(tr, tick0, { vel: 0.9 }); setP(note, p0); mode = 'new'; }
    audition(tr, note);
  } else {
    note = addNote(tr, tick0, { p: p0, len: tr.lastLen || stepT * 2, vel: 0.85 }); mode = 'new';
    audition(tr, note);
  }
  light(tr);
  const orig = { t: note.t, p: notePitch(tr, note), len: note.len }, ri0 = rows.indexOf(orig.p);
  const lp = setTimeout(() => { if (!moved && hit) { mode = 'menu'; finish(); settle(); noteSheet(tr, hit); } }, 480);
  try { cv.setPointerCapture(e.pointerId); } catch (err) {}
  let lastP = orig.p;
  const move = ev => {
    const c = colAt(ev.clientX), r = rowAt(ev.clientY);
    if (!moved && (c !== c0 || r !== r0)) { moved = true; clearTimeout(lp); }
    if (!moved) return;
    if (mode === 'resize' || (mode === 'new' && pitched)) {
      note.len = Math.max(stepT, (c - Math.floor(orig.t / stepT) + 1) * stepT);
    } else if (mode === 'move' || mode === 'new') {
      note.t = clamp(orig.t + (c - c0) * stepT, 0, loopT - stepT);
      if (ri0 >= 0) setP(note, rows[clamp(ri0 + (r - r0), 0, rows.length - 1)]);
      const np = notePitch(tr, note); if (np !== lastP) { lastP = np; audition(tr, note); }
    }
    light(tr);
  };
  const up = () => {
    clearTimeout(lp);
    if (mode === 'move' && !moved && hit) removeNote(tr, hit);
    if (!pitched && tr.notes.includes(note)) tr.notes = tr.notes.filter(n => n === note || Math.floor(n.t / stepT) !== Math.floor(note.t / stepT));
    if (pitched && mode !== 'menu' && tr.notes.includes(note)) { tr.lastLen = note.len; tr.lastP = note.p; }
    sortNotes(tr); finish();
    if (mode !== 'menu') { changed(); settle(); }
  };
  function finish() {
    dragging = false;
    cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up);
  }
  cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
}
// velocity lane: drag the stalks up or down; sweep across to shape several
function onVelDown(e) {
  const lane = e.target.closest('#rvel'), tr = selTrack(); if (!lane || !tr) return;
  e.preventDefault();
  const rect = lane.getBoundingClientRect(), loopT = P.bars * TPB, stepT = TPB / tr.res, nSteps = P.bars * tr.res;
  commit(); dragging = true;
  const setAt = (x, y) => {
    const col = clamp(Math.floor((x - rect.left) / rect.width * nSteps), 0, nSteps - 1);
    const v = clamp(Math.round((1 - (y - rect.top - 6) / (rect.height - 12)) * 100) / 100, 0.05, 1);
    let any = false;
    tr.notes.forEach(n => { if (n.t < loopT && Math.floor(n.t / stepT) === col) { n.vel = v; any = true; } });
    if (any) { light(tr); hud(`velocity ${Math.round(v * 100)}%`); }
  };
  setAt(e.clientX, e.clientY);
  try { lane.setPointerCapture(e.pointerId); } catch (err) {}
  const move = ev => setAt(ev.clientX, ev.clientY);
  const up = () => {
    dragging = false; hud(null);
    lane.removeEventListener('pointermove', move); lane.removeEventListener('pointerup', up); lane.removeEventListener('pointercancel', up);
    changed(); settle();
  };
  lane.addEventListener('pointermove', move); lane.addEventListener('pointerup', up); lane.addEventListener('pointercancel', up);
}
function onRollClick(e) {
  const b = e.target.closest('[data-act],[data-key],[data-zoom],[data-cbar],[data-rbar]'); if (!b) return;
  const tr = selTrack(); if (!tr) return;
  if (b.dataset.key) { audition(tr, { p: +b.dataset.key, vel: 0.85 }); return; }
  if (b.dataset.zoom) { ui.rollZoom = +b.dataset.zoom; document.querySelectorAll('#roll [data-zoom]').forEach(x => x.classList.toggle('on', x === b)); sizeRoll(); return; }
  if (b.dataset.cbar) { chordSheet(+b.dataset.cbar); return; }
  if (b.dataset.rbar) { seek(+b.dataset.rbar); return; }
  const a = b.dataset.act;
  if (a === 'closeroll') { ui.rollOpen = false; renderRoll(); renderChan(); }
  else if (a === 'scaleonly') { ui.scaleOnly = !ui.scaleOnly; ui._rollFor = null; renderRoll(); }
  else if (a === 'song') songSheet();
}
// pick the chord for a bar; the bass in that bar moves with it
function chordSheet(bar) {
  const { triads, sevenths } = GR.diatonicChords(P), cur = P.chords && P.chords[bar];
  const btn = (c, i, set) => `<button class="b sm${cur && cur.r === c.r && cur.q === c.q ? ' on' : ''}" data-set="${set}" data-ci="${i}"><span style="opacity:.55;font-family:var(--mono);font-size:9.5px">${c.roman}</span>&nbsp; ${esc(GR.chordName(c, P))}</button>`;
  openSheet(`Bar ${bar + 1} chord`, `
    <div class="sh-sec"><h4>In ${GR.NOTE_NAMES[P.key]} ${esc(P.scale)}</h4><div class="btns">${triads.map((c, i) => btn(c, i, 't')).join('')}</div></div>
    ${sevenths.length ? `<div class="sh-sec"><h4>Sevenths</h4><div class="btns">${sevenths.map((c, i) => btn(c, i, 's')).join('')}</div></div>` : ''}
    <div class="sh-sec"><div class="btns"><button class="b sm" data-clear>No chord</button><button class="b sm" data-all>Use for every bar</button>${P.chordLock ? '<button class="b sm" data-unlock>Let the style pick chords again</button>' : ''}</div>
      <p class="hint" style="margin:8px 0 0">The bass notes in this bar move to the new chord. The dice and GENERATE keep your chords and follow them.</p></div>`, sh => {
    sh.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.ci != null) { applyChord(bar, Object.assign({}, (b.dataset.set === 's' ? sevenths : triads)[+b.dataset.ci])); closeSheet(); }
      else if (b.dataset.clear != null) { edit(() => { P.chords[bar] = null; P.chordLock = true; }); closeSheet(); }
      else if (b.dataset.unlock != null) { edit(() => { P.chordLock = false; }); closeSheet(); toast('GENERATE picks new chords from the style again'); }
      else if (b.dataset.all != null && cur) { commit(); for (let i = 0; i < P.bars; i++) shiftChord(i, cur); changed(); settle(); closeSheet(); toast(`Every bar is ${GR.chordName(cur, P)}`); }
    });
  });
}
function shiftChord(bar, c) {
  if (!Array.isArray(P.chords)) P.chords = GR.inferChords(P);
  const old = P.chords[bar] || GR.inferChords(P)[bar];
  P.chords[bar] = { r: c.r, q: c.q }; P.chordLock = true;
  if (!old) return;
  const d = (((c.r - old.r) % 12) + 18) % 12 - 6;
  if (d) P.tracks.forEach(t => { if (isPitched(t)) t.notes.forEach(n => { if (Math.floor(n.t / TPB) === bar) n.p = clamp(n.p + d, 0, 127); }); });
}
function applyChord(bar, c) {
  edit(() => shiftChord(bar, c));
  const tr = bassTracks()[0]; if (tr) audition(tr, { p: (() => { let r = c.r; while (r < 28) r += 12; return r; })(), vel: 0.85 });
  toast(`Bar ${bar + 1}: ${GR.chordName(c, P)} · the bass moved with it`);
}

/* ---------- groove generator ---------- */
const genreOf = () => (GR.GROOVES[P.genre] ? P.genre : 'trap');
const styleOf = () => GR.styleOf(genreOf(), P.style);
const styleLabel = () => `${GR.GROOVES[genreOf()].name} · ${styleOf().name}`;
function genOpts() { return { genre: genreOf(), style: styleOf().id, complexity: ui.gen.complexity, bar: ui.gen.scope === 'bar' ? ui.bar : null }; }
const dawTempo = () => !!(HOST && H.daw);
// a genre or style change brings the tempo into the style's range (the DAW keeps its own)
function setStyle(genre, id) {
  P.genre = genre; P.style = GR.styleOf(genre, id).id;
  const [lo, hi] = GR.styleBpm(genre, P.style);
  if (!dawTempo() && (P.bpm < lo || P.bpm > hi)) { P.bpm = Math.round((lo + hi) / 2); S.map = null; }
}
function styleTempoNote() {
  const [lo, hi] = GR.styleBpm(genreOf(), P.style), ok = P.bpm >= lo - 0.5 && P.bpm <= hi + 0.5;
  return `${styleOf().name} sits at ${lo}–${hi} BPM${ok ? '' : ` · you are at ${Math.round(P.bpm)}${dawTempo() ? ' (your DAW sets the tempo)' : ''}`}`;
}
/* what you taught the generator: learned loops and liked patterns, kept in this browser and in the project */
function takeTaste(t) {
  if (!t) return;
  Object.entries(t.learn || {}).forEach(([k, v]) => { if (v && (!GR.LEARN[k] || (v.n || 0) > (GR.LEARN[k].n || 0))) GR.LEARN[k] = v; });
  Object.entries(t.weights || {}).forEach(([k, v]) => { if (GR.WEIGHTS[k] == null && isFinite(v)) GR.WEIGHTS[k] = +v; });
}
function saveTaste() {
  store.set('groove-rack.learn', JSON.stringify(GR.LEARN)); store.set('groove-rack.weights', JSON.stringify(GR.WEIGHTS));
  P.taste = { learn: JSON.parse(JSON.stringify(GR.LEARN)), weights: Object.assign({}, GR.WEIGHTS) };
}
const learnedLoops = () => { const L = GR.LEARN[genreOf() + ':' + styleOf().id]; return L ? L.n : 0; };
const pickKeys = () => Object.values(GR.lastPicks).filter(Boolean);
function likeGroove() {
  edit(() => { GR.rate(pickKeys(), true); GR.learnProject(P, genreOf(), styleOf().id); saveTaste(); });
  toast(`Liked · ${styleLabel()} will lean towards this groove (${learnedLoops()} learned)`);
  renderStyleTag();
}
function skipGroove() {
  GR.rate(pickKeys(), false); saveTaste();
  newGroove(true);
  toast(`Skipped · less of that one in ${styleLabel()}`);
}
async function learnMidiFiles() {
  const f = await chooseFile('.mid,.midi,audio/midi', '*.mid;*.midi');
  if (!f) return;
  let mf; try { mf = GR.parseMidi(f.buf); } catch (e) { toast('That file is not a MIDI file Groove Rack can read'); return; }
  const T = JSON.parse(JSON.stringify(P));
  const r = readMidi(T, mf, null);
  if (!r) { toast('That MIDI file has no notes'); return; }
  const got = GR.learnProject(T, genreOf(), styleOf().id);
  if (!got) { toast('No drums or bass Groove Rack could read in that file'); return; }
  edit(() => saveTaste());
  toast(`Learned ${f.name} · ${styleLabel()} now knows ${got.n} loop${got.n > 1 ? 's' : ''}. Press GENERATE`, 3600);
  if (sheetEl) grooveSheet(selTrack());
  renderStyleTag();
}
function spinDice(id) {
  document.querySelectorAll(`.deck-row[data-id="${id}"] .dice-btn`).forEach(d => { d.classList.remove('spin'); void d.offsetWidth; d.classList.add('spin'); });
}
function newPattern(tr, scope) {
  const o = genOpts(); if (scope) o.bar = scope === 'bar' ? ui.bar : null;
  edit(() => GR.generateTrack(P, tr, o));
  spinDice(tr.id);
  toast(`New ${tr.name} pattern · ${styleLabel()}${o.bar != null ? ' · bar ' + (o.bar + 1) : ''}`);
}
function newGroove(quiet) {
  const o = genOpts();
  edit(() => GR.generateAll(P, o));
  P.tracks.forEach(t => spinDice(t.id));
  if (!quiet) toast(`New ${styleLabel()} groove${o.bar != null ? ' for bar ' + (o.bar + 1) : ''}${o.bar == null ? ' · swing ' + P.swing + '% · ' + P.chords.map(c => GR.chordName(c, P)).join(' ') : ''}`, 2600);
}
function grooveSheet(tr) {
  const styleBtns = () => GR.stylesOf(genreOf()).map(s => `<button class="b sm${s.id === styleOf().id ? ' on' : ''}" data-style="${s.id}">${esc(s.name)} <i class="bpmr">${s.bpm[0]}–${s.bpm[1]}</i></button>`).join('');
  const L = learnedLoops();
  const sh = openSheet('Groove generator', `
    <div class="sh-sec"><h4>Genre</h4><select class="txt" id="g_genre" aria-label="Genre">${GR.GENRES.map(k => `<option value="${k}"${k === genreOf() ? ' selected' : ''}>${GR.GROOVES[k].name}</option>`).join('')}</select></div>
    <div class="sh-sec"><h4>Style</h4><div class="btns" id="g_styles">${styleBtns()}</div>
      <p class="hint" style="text-align:left;margin:8px 0 0;padding:0" id="g_tempo"></p>
      <div class="btns" style="margin-top:6px" id="g_fit"></div>
      <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">Each style has its own kicks, backbeats, hats and percussion, its own feel (which parts push ahead or sit back, and how they accent), its own chord progressions and bass phrases. Loops play as phrases: the same idea, a variation in bar 3, a fill at the end.</p></div>
    <div class="sh-sec"><h4>Chords</h4><div class="seg" role="group" aria-label="Chords">${[[0, 'The style picks them'], [1, 'Keep mine']].map(([k, l]) => `<button data-lock="${k}" class="${+!!P.chordLock === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">Now: ${P.chords && P.chords.some(Boolean) ? P.chords.map(c => (c ? GR.chordName(c, P) : '–')).join(' · ') : 'none yet'}. Pick a chord in the piano roll's chord lane and GENERATE keeps your chords.</p></div>
    <div class="sh-sec"><h4>Busyness</h4><div class="seg" role="group" aria-label="Busyness">${['Simple', 'Medium', 'Busy'].map((l, i) => `<button data-cx="${i}" class="${ui.gen.complexity === i ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="sh-sec"><h4>Change</h4><div class="seg" role="group" aria-label="Which bars">${[['all', 'Whole loop'], ['bar', 'Bar ' + (ui.bar + 1) + ' only']].map(([k, l]) => `<button data-scope="${k}" class="${ui.gen.scope === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="sh-sec"><h4>Teach ${esc(styleLabel())}</h4><div class="btns">
      <button class="b sm" data-learn>Learn from a MIDI loop…</button><button class="b sm" data-like>👍 Like this groove</button><button class="b sm" data-skip>👎 Skip it</button>${L ? `<button class="b sm warn" data-forget>Forget ${L} learned loop${L > 1 ? 's' : ''}</button>` : ''}</div>
      <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">Drop in drum or bass MIDI loops you like for this style: the generator learns how often each part hits on each step and mixes that with its own patterns. 👍 learns the groove you have now and picks its patterns more often; 👎 makes a new one and picks those less. It is remembered in this browser and saved with the project.</p></div>
    <div class="sh-sec"><div class="btns">
      ${tr ? `<button class="b gold" data-go="track">${ICON.dice.replace('<svg', '<svg width="16" height="16" style="vertical-align:-3px;margin-right:4px"')}New ${esc(tr.name)} pattern</button>` : ''}
      <button class="b${tr ? '' : ' gold'}" data-go="all">Generate the whole groove</button></div>
      <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">Every result can be undone. The 🎲 on each track makes a new pattern for that track alone. Shortcuts: <b>R</b> for the selected track, <b>Shift R</b> for the whole groove.</p></div>`, sh => {
    const tempo = () => {
      sh.querySelector('#g_tempo').textContent = styleTempoNote();
      const [lo, hi] = GR.styleBpm(genreOf(), P.style), out = P.bpm < lo - 0.5 || P.bpm > hi + 0.5;
      sh.querySelector('#g_fit').innerHTML = out && !dawTempo() ? `<button class="b sm" data-fit>Set ${Math.round((lo + hi) / 2)} BPM</button>` : '';
    };
    tempo();
    sh.querySelector('#g_genre').addEventListener('change', e => { edit(() => setStyle(e.target.value)); sh.querySelector('#g_styles').innerHTML = styleBtns(); tempo(); toast(`${styleLabel()} · ${Math.round(P.bpm)} BPM`); });
    sh.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.style) { edit(() => setStyle(genreOf(), b.dataset.style)); sh.querySelectorAll('[data-style]').forEach(x => x.classList.toggle('on', x === b)); tempo(); toast(`${styleLabel()} · ${Math.round(P.bpm)} BPM`); }
      else if (b.dataset.fit != null) { const [lo, hi] = GR.styleBpm(genreOf(), P.style); edit(() => { P.bpm = Math.round((lo + hi) / 2); S.map = null; }); tempo(); }
      else if (b.dataset.lock) { edit(() => { P.chordLock = b.dataset.lock === '1'; }); sh.querySelectorAll('[data-lock]').forEach(x => x.classList.toggle('on', x === b)); }
      else if (b.dataset.cx) { ui.gen.complexity = +b.dataset.cx; sh.querySelectorAll('[data-cx]').forEach(x => x.classList.toggle('on', x === b)); saveGen(); renderDensity(); }
      else if (b.dataset.scope) { ui.gen.scope = b.dataset.scope; sh.querySelectorAll('[data-scope]').forEach(x => x.classList.toggle('on', x === b)); saveGen(); }
      else if (b.dataset.learn != null) learnMidiFiles();
      else if (b.dataset.like != null) { likeGroove(); closeSheet(); }
      else if (b.dataset.skip != null) { skipGroove(); closeSheet(); }
      else if (b.dataset.forget != null) { GR.forget(genreOf(), styleOf().id); edit(() => saveTaste()); toast(`${styleLabel()} forgot what it learned`); closeSheet(); renderStyleTag(); }
      else if (b.dataset.go === 'track') newPattern(tr);
      else if (b.dataset.go === 'all') newGroove();
    });
  });
}
function saveGen() { store.set('groove-rack.gen', JSON.stringify(ui.gen)); }

/* ---------- sheets ---------- */
let sheetEl = null;
function openSheet(title, html, mount) {
  closeSheet();
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div>
    <div class="sh-head"><h3>${esc(title)}</h3><button class="silicone-btn ib" data-close aria-label="Close">${ICON.x}</button></div>${html}</div>`;
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
  const daw = HOST && H.daw;
  const sh = openSheet('Song', `
    <div class="big-bpm">${daw ? '' : '<button class="b" data-d="-1" aria-label="Slower">−</button>'}<span><span id="sBpm">${P.bpm}</span><small>BPM</small></span>${daw ? '' : '<button class="b" data-d="1" aria-label="Faster">+</button>'}</div>
    ${daw ? '<p class="hint" style="margin:4px auto 10px">The tempo follows your DAW. Change it there and the groove, its echo and your exports follow.</p>' : `${ctlRow('s_bpm', 'Tempo', 50, 200, 1, P.bpm)}
    <div class="btns" style="justify-content:center"><button class="b" id="tapBtn">Tap tempo</button><button class="b sm" data-half>½×</button><button class="b sm" data-dbl>2×</button></div>`}
    ${ctlRow('s_swing', 'Swing', 0, 100, 1, P.swing)}
    ${ctlRow('s_master', 'Master', 0, 1, 0.01, P.master)}
    <div class="sh-sec"><h4>Key</h4>
      <div class="btns"><select class="txt" id="s_key" style="width:auto">${GR.NOTE_NAMES.map((n, i) => `<option value="${i}"${i === P.key ? ' selected' : ''}>${n}</option>`).join('')}</select>
      <select class="txt" id="s_scale" style="width:auto">${Object.keys(GR.SCALES).map(s => `<option${s === P.scale ? ' selected' : ''}>${s}</option>`).join('')}</select>
      <button class="b sm" data-tr="-1">Transpose −1</button><button class="b sm" data-tr="1">Transpose +1</button></div>
      <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">Key and scale light up the piano roll and steer chord mode. Transpose moves every melodic note and the key together.</p>
    </div>
    <div class="sh-sec"><h4>Loop length</h4><div class="seg" role="group" aria-label="Bars">${[4, 8].map(n => `<button data-bars="${n}" class="${n === P.bars ? 'on' : ''}">${n}</button>`).join('')}</div>
      <div class="btns" style="margin-top:8px"><button class="b sm" data-double>Double the loop</button></div></div>
    <div class="sh-sec"><h4>Playback</h4><div class="btns">
      <button class="b sm${ui.metro ? ' on' : ''}" data-metro>Metronome ${ui.metro ? 'on' : 'off'}</button>
      <button class="b sm${ui.follow ? ' on' : ''}" data-follow>Follow playhead ${ui.follow ? 'on' : 'off'}</button></div></div>`, sh => {
    const refreshBpm = () => { sh.querySelector('#sBpm').textContent = P.bpm; if (sh.querySelector('#s_bpm')) sh.querySelector('#s_bpm').value = P.bpm; };
    if (!daw) slider(sh, 's_bpm', v => { setBpm(v); sh.querySelector('#sBpm').textContent = P.bpm; }, v => v);
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
      else if (b.dataset.bars) { setLoopLength(+b.dataset.bars); sh.querySelectorAll('[data-bars]').forEach(x => x.classList.toggle('on', +x.dataset.bars === P.bars)); }
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
    <div class="sh-sec"><h4>Loop length</h4><div class="seg">${[4, 8].map(n => `<button data-bars="${n}" class="${n === P.bars ? 'on' : ''}">${n}</button>`).join('')}</div></div>
    <div class="sh-sec"><h4>This bar, every track</h4><div class="btns">
      <button class="b sm" data-copy="next">Copy to next bar</button>
      <button class="b sm" data-copy="all">Copy to all bars</button>
      <button class="b sm warn" data-clear>Clear this bar</button></div></div>
    <div class="sh-sec"><div class="btns"><button class="b sm${ui.follow ? ' on' : ''}" data-follow>Follow playhead ${ui.follow ? 'on' : 'off'}</button></div></div>`, sh => {
    const lab = () => { sh.querySelector('#bLabel').textContent = `bar ${ui.bar + 1} of ${P.bars}`; sh.querySelectorAll('[data-bars]').forEach(x => x.classList.toggle('on', +x.dataset.bars === P.bars)); };
    sh.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.go) { seek((ui.bar + +b.dataset.go + P.bars) % P.bars); lab(); }
      else if (b.dataset.bars) { setLoopLength(+b.dataset.bars); lab(); }
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
        <button class="b sm gold" data-act="file">${tr.sample ? 'Replace sample…' : 'Use your own sample…'}</button>
        ${tr.sample ? `<button class="b sm" data-act="unsample">Back to synth (${esc(tr.sampleName || 'file')})</button>` : ''}</div>
      <div class="btns">${sounds}</div></div>
    <div class="sh-sec"><h4>Steps per bar</h4><div class="seg">${[12, 16, 24, 32].map(r => `<button data-res="${r}" class="${r === tr.res ? 'on' : ''}" title="${RES_LABEL[r]}">${r}</button>`).join('')}</div>
      <span style="color:var(--muted);font-size:12.5px;margin-left:8px">${RES_LABEL[tr.res]} — 12 and 24 give triplet grids</span></div>
    <div class="sh-sec"><h4>Channel</h4>
      ${ctlRow('c_vol', 'Volume', 0, 1, 0.01, tr.vol)}${ctlRow('c_pan', 'Pan', -1, 1, 0.02, tr.pan)}
      ${ctlRow('c_pitch', 'Pitch', -24, 24, 1, tr.pitch)}${ctlRow('c_decay', inst.pitched ? 'Release' : 'Length', 0.3, 2, 0.05, tr.decay)}
      ${ctlRow('c_tone', 'Tone', 0, 1, 0.01, tr.tone)}${ctlRow('c_rev', 'Reverb', 0, 1, 0.01, tr.rev)}${ctlRow('c_echo', 'Echo', 0, 1, 0.01, tr.echo)}
      <div class="btns"><button class="b sm${tr.mute ? ' on' : ''}" data-act="mute">${tr.mute ? 'Muted' : 'Mute'}</button><button class="b sm${tr.solo ? ' on' : ''}" data-act="solo">${tr.solo ? 'Soloed' : 'Solo'}</button>
</div></div>
    <div class="sh-sec"><h4>Pattern · bar ${ui.bar + 1}</h4><div class="btns">
      <button class="b sm" data-fill="1">Every step</button><button class="b sm" data-fill="2">Every 2</button><button class="b sm" data-fill="4">Every 4</button><button class="b sm" data-fill="8">Every 8</button>
      <button class="b sm" data-shift="-1" aria-label="Shift left">◀ Shift</button><button class="b sm" data-shift="1" aria-label="Shift right">Shift ▶</button>
      <button class="b sm" data-act="random">New pattern (${esc(GR.GROOVES[genreOf()].name)})</button><button class="b sm" data-act="copyall">Copy to all bars</button>
      <button class="b sm warn" data-act="clearbar">Clear bar</button><button class="b sm warn" data-act="clearall">Clear all bars</button></div></div>
    <div class="sh-sec"><h4>MIDI</h4><div class="btns"><button class="b sm" data-act="midiin">Import MIDI into ${esc(tr.name)}…</button><button class="b sm" data-act="midiout">Export ${esc(tr.name)} as MIDI</button></div>
      <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">In the plugin this track plays from MIDI ${midiLabel(tr)}, and sends the same notes out.</p></div>
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
        else if (a === 'midiin') importMidiFile(tr);
        else if (a === 'midiout') { download(GR.midi(P, tr.id), fileName('mid').replace('.mid', `_${tr.name.replace(/[^\w]+/g, '')}.mid`)); toast('MIDI file ready'); }
        else if (a === 'unsample') { edit(() => { tr.sample = null; tr.sampleName = null; }); channelSheet(tr); }
        else if (a === 'mute') { edit(() => { tr.mute = !tr.mute; }); b.classList.toggle('on', tr.mute); b.textContent = tr.mute ? 'Muted' : 'Mute'; }
        else if (a === 'solo') { edit(() => { tr.solo = !tr.solo; }); b.classList.toggle('on', tr.solo); b.textContent = tr.solo ? 'Soloed' : 'Solo'; }
        else if (a === 'random') newPattern(tr, 'bar');
        else if (a === 'copyall') { edit(() => copyBar(tr, ui.bar, Array.from({ length: P.bars }, (_, i) => i).filter(i => i !== ui.bar))); toast('Copied to every bar'); }
        else if (a === 'clearbar') edit(() => clearBar(tr, ui.bar));
        else if (a === 'clearall') edit(() => { tr.notes = []; });
        else if (a === 'dup') {
          const c = JSON.parse(JSON.stringify(tr)); c.id = GR.newId(); c.name = tr.name + ' 2'; c.solo = false;
          edit(() => P.tracks.splice(P.tracks.indexOf(tr) + 1, 0, c)); ui.sel = c.id; closeSheet(); renderAll(); toast('Duplicated');
        } else if (a === 'del') {
          edit(() => { P.tracks.splice(P.tracks.indexOf(tr), 1); }); ui.sel = (P.tracks[0] || {}).id || null;
          closeSheet(); changed(); toast(`Deleted ${tr.name}. Undo brings it back.`);
        }
      }
    });
  });
}
function noteSheet(tr, n) {
  const inst = I[tr.inst];
  const sh = openSheet(`${tr.name} · ${inst.pitched ? GR.noteName(n.p) : 'step ' + (Math.floor((n.t % TPB) / (TPB / tr.res)) + 1)}`, `
    ${ctlRow('n_vel', 'Velocity', 0.05, 1, 0.01, n.vel)}
    ${ctlRow('n_nudge', 'Timing', -1.5, 1.5, 0.05, n.nudge || 0)}
    ${!inst.pitched ? `<div class="sh-sec"><h4>Roll (hits inside the step)</h4><div class="seg">${[1, 2, 3, 4].map(r => `<button data-roll="${r}" class="${(n.roll || 1) === r ? 'on' : ''}">${r === 1 ? 'off' : r + '×'}</button>`).join('')}</div></div>` : `
    <div class="sh-sec"><h4>Pitch</h4><div class="btns"><button class="b sm" data-p="-12">−oct</button><button class="b sm" data-p="-1">−1</button><b id="nP" style="min-width:52px;text-align:center;align-self:center">${GR.noteName(n.p)}</b><button class="b sm" data-p="1">+1</button><button class="b sm" data-p="12">+oct</button></div></div>
    <div class="sh-sec"><h4>Length</h4><div class="btns"><button class="b sm" data-l="-1">shorter</button><b id="nL" style="min-width:64px;text-align:center;align-self:center"></b><button class="b sm" data-l="1">longer</button></div></div>
    ${inst.mono ? `<div class="sh-sec"><div class="btns"><button class="b sm${n.slide ? ' on' : ''}" data-slide>Slide into this note ${n.slide ? 'on' : 'off'}</button></div></div>` : ''}`}
    <div class="sh-sec"><div class="btns"><button class="b sm" data-ghost>${n.vel < 0.5 ? 'Make it full' : 'Make it a ghost note'}</button><button class="b sm warn" data-del>Delete note</button></div></div>`, sh => {
    const stepT = TPB / tr.res;
    const lab = () => { const l = sh.querySelector('#nL'); if (l) l.textContent = `${+(n.len / stepT).toFixed(2)} step${n.len === stepT ? '' : 's'}`; const p = sh.querySelector('#nP'); if (p) p.textContent = GR.noteName(n.p); };
    lab();
    slider(sh, 'n_vel', v => { n.vel = v; }, pct);
    slider(sh, 'n_nudge', v => { if (Math.abs(v) < 0.02) delete n.nudge; else n.nudge = v; }, v => {
      const ms = Math.round(Math.abs(v) * GR.tickDur(P) * 1000);
      return Math.abs(v) < 0.02 || !ms ? 'on the grid' : `${ms} ms ${v < 0 ? 'early' : 'late'}`;
    });
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

function soundSheet(tr) {
  const inst = I[tr.inst];
  const sounds = Object.entries(inst.sounds).map(([k, v]) => `<button class="b sm${!tr.sample && k === tr.sound ? ' on' : ''}" data-snd="${k}">${v[0]}</button>`).join('');
  openSheet(`${tr.name} · sound`, `
    <div class="sh-sec"><h4>Your own sample</h4><div class="btns">
      <button class="b sm gold" data-act="file">${tr.sample ? 'Replace sample…' : 'Choose a sample…'}</button>
      ${tr.sample ? `<button class="b sm on" disabled>${esc(tr.sampleName || 'sample')}</button><button class="b sm" data-act="unsample">Back to built-in</button>` : ''}</div>
      <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">WAV, AIFF, MP3 or FLAC. You can also drop a file straight onto a track. ${inst.pitched ? 'A melodic sample is treated as C3 and pitched to each note.' : ''}</p></div>
    <div class="sh-sec"><h4>Built-in ${esc(inst.label.toLowerCase())} sounds</h4><div class="btns">${sounds}</div></div>
    <div class="sh-sec"><div class="btns"><button class="b sm" data-act="more">All settings for ${esc(tr.name)}</button></div></div>`, sh => {
    sh.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.snd) {
        edit(() => { tr.sound = b.dataset.snd; tr.sample = null; tr.sampleName = null; });
        sh.querySelectorAll('[data-snd]').forEach(x => x.classList.toggle('on', x === b)); audition(tr);
      } else if (b.dataset.act === 'file') pickSample(tr);
      else if (b.dataset.act === 'unsample') { edit(() => { tr.sample = null; tr.sampleName = null; }); soundSheet(tr); }
      else if (b.dataset.act === 'more') channelSheet(tr);
    });
  });
}

/* ---------- MIDI import ---------- */
// pick a file: a hidden input in the browser, the plugin's own dialog inside a DAW
let pickRes = null;
function chooseFile(accept, pattern) {
  if (HOST) return HOST.call('openFile', pattern).then(r => (r && r.data ? { name: r.name, buf: b64ToBuf(r.data) } : null));
  return new Promise(res => {
    pickRes = res; const inp = $('#anyIn'); inp.accept = accept; inp.value = ''; inp.click();
  });
}
function findSoundForGm(note) {
  for (const inst of Object.values(I)) {
    if (inst.pitched) continue;
    for (const [k, v] of Object.entries(inst.sounds)) if (v[2] && v[2].gm === note) return [inst.id, k];
  }
  const alias = { 35: 'kick', 36: 'kick', 37: 'rim', 38: 'snare', 40: 'snare', 39: 'clap', 42: 'hat', 44: 'hat', 46: 'openhat', 49: 'cymbal', 57: 'cymbal', 51: 'cymbal', 59: 'cymbal',
    41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom', 54: 'shaker', 56: 'bell', 69: 'shaker', 70: 'shaker', 31: 'snap', 75: 'block', 76: 'block', 77: 'block' };
  return alias[note] ? [alias[note], null] : null;
}
async function importMidiFile(target) {
  const f = await chooseFile('.mid,.midi,audio/midi', '*.mid;*.midi');
  if (f) importMidi(f.buf, target, f.name);
}
function importMidi(buf, target, fileName) {
  let mf;
  try { mf = GR.parseMidi(buf); } catch (e) { toast('That file is not a MIDI file Groove Rack can read'); return; }
  commit();
  const r = readMidi(P, mf, target);
  if (!r) { hist.undo.pop(); toast('That MIDI file has no notes'); return; }
  if (P.bars !== snapBars(P.bars)) extendLoop(snapBars(P.bars));
  if (!target) P.chords = GR.inferChords(P);
  changed(); settle(); closeSheet();
  toast(`Imported ${fileName || 'MIDI'}${target ? ' into ' + target.name : ''} · ${r.bars} bar${r.bars > 1 ? 's' : ''}${r.skipped ? ` · ${r.skipped} notes had no matching drum` : ''}`, 3200);
}
// read a parsed MIDI file into project T (into one track, or across its tracks by drum note and channel)
function readMidi(T, mf, target) {
  const k = TPB / (mf.ppq * 4), all = [];
  mf.tracks.forEach(t => t.notes.forEach(n => all.push(Object.assign({ track: t.name }, n))));
  if (!all.length) return null;
  const last = Math.max(...all.map(n => n.tick * k));
  const bars = clamp(Math.ceil((last + 1) / TPB), 1, 8);
  let skipped = 0;
  const sw = (T.swing / 100) * 3;
  // a note's distance from its step, kept as its own timing when it is small (a played or humanized feel)
  const feel = (x, t) => { const d = Math.round((x - t) * 100) / 100; return Math.abs(d) >= 0.05 && Math.abs(d) <= 1.5 ? d : 0; };
  const put = (tr, n) => {
    const stepT = TPB / tr.res;
    let x = n.tick * k;
    if (sw && Math.abs(((x - sw) % 12 + 12) % 12 - 6) < 0.6) x -= sw;   // undo swing on off-beat 16ths
    const exact = x / stepT, near = Math.round(exact);
    if (I[tr.inst].pitched) {
      const t = near * stepT; if (t >= bars * TPB) return;
      const note = { t, p: n.p, len: Math.max(stepT, Math.round(n.len * k / stepT) * stepT), vel: n.vel }, d = feel(x, t);
      if (d) note.nudge = d;
      tr.notes.push(note);
      return;
    }
    if (Math.abs(exact - near) > 0.2) {   // a hit between steps: part of a roll in the step before it
      const t = Math.floor(exact) * stepT; if (t >= bars * TPB) return;
      const host = tr.notes.find(y => y.t === t);
      if (host) host.roll = Math.min(4, (host.roll || 1) + 1); else tr.notes.push({ t, vel: n.vel });
      return;
    }
    const t = near * stepT; if (t >= bars * TPB) return;
    const ex = tr.notes.find(y => y.t === t);
    if (!ex) { const note = { t, vel: n.vel }, d = feel(x, t); if (d) note.nudge = d; tr.notes.push(note); }
  };
  T.bars = Math.max(bars, target ? T.bars : 1);
  if (target) {
    target.notes = [];
    all.forEach(n => put(target, n));
    sortNotes(target);
  } else {
    if (mf.bpm) T.bpm = clamp(mf.bpm, 40, 240);
    const map = GR.midiMap(T), touched = new Set();
    const touch = tr => { if (!touched.has(tr.id)) { touched.add(tr.id); tr.notes = []; } return tr; };
    const byNote = {}, byCh = {};
    T.tracks.forEach(tr => { const m = map[tr.id]; if (!m) return; if (m.note != null) byNote[m.note] = tr; else byCh[m.ch] = tr; });
    all.forEach(n => {
      let tr = n.track && T.tracks.find(t => t.name.toLowerCase() === n.track.toLowerCase());
      if (!tr) tr = byCh[n.ch] && n.ch !== 9 ? byCh[n.ch] : null;
      if (!tr && (n.ch === 9 || byNote[n.p])) {
        tr = byNote[n.p];
        if (!tr) {
          const s = findSoundForGm(n.p);
          if (s) { tr = GR.newTrack(s[0], s[1]); T.tracks.push(tr); byNote[n.p] = tr; }
        }
      }
      if (!tr && n.ch !== 9) {
        tr = T.tracks.find(t => I[t.inst].pitched);
        if (!tr) { tr = GR.newTrack('b808', 'clean'); T.tracks.push(tr); }
        byCh[n.ch] = tr;
      }
      if (!tr) { skipped++; return; }
      put(touch(tr), n);
    });
    T.tracks.forEach(sortNotes);
    if (T !== P) T.tracks = T.tracks.filter(t => touched.has(t.id));   // learning: only the parts the file has
  }
  return { bars, skipped };
}
function midiLabel(tr) {
  const m = GR.midiMap(P)[tr.id]; if (!m) return '';
  return m.note != null ? `note ${GR.noteName(m.note)} (${m.note}) on any channel` : `channel ${m.ch + 1}, notes at their pitch`;
}

function addSheet() {
  const cats = {};
  Object.values(I).forEach(x => { (cats[x.cat] = cats[x.cat] || []).push(x); });
  const html = Object.entries(cats).map(([cat, list]) => `<div class="sh-sec"><h4>${cat}</h4>${list.map(x => `<div class="inst"><b>${x.label}</b><div class="btns">${Object.entries(x.sounds).map(([k, v]) => `<button class="b sm" data-inst="${x.id}" data-s="${k}">${v[0]}</button>`).join('')}</div></div>`).join('')}</div>`).join('')
    + `<div class="sh-sec"><h4>Your own sample</h4><div class="btns"><button class="b sm" data-file="fx">Drum or one-shot from a file</button><button class="b sm" data-file="bass">Bass from a file</button></div>
       <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">A bass sample is treated as C3 and pitched across the piano roll.</p></div>`;
  openSheet(`${P.tracks.length} tracks · add one`, html, sh => {
    sh.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.inst) {
        const t = GR.newTrack(b.dataset.inst, b.dataset.s);
        if (I[t.inst].pitched) t.low = I[t.inst].base;
        edit(() => P.tracks.push(t)); ui.sel = t.id; ui.rollOpen = !!I[t.inst].pitched;
        closeSheet(); changed(); audition(t); toast(`Added ${t.name}`);
      } else if (b.dataset.file) {
        const t = GR.newTrack(b.dataset.file, null, { name: 'Sample', group: b.dataset.file === 'fx' ? 'drums' : 'audio' });
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
      <div class="btns" style="margin-top:8px"><button class="b sm gold" data-act="generator">Groove generator…</button><button class="b sm" data-act="blank">Blank project</button></div></div>
    <div class="sh-sec"><h4>Saved in this browser</h4><div class="btns" style="margin-bottom:8px"><button class="b sm gold" data-act="save">Save “${esc(P.name)}”</button></div>${savedHtml}</div>
    <div class="sh-sec"><h4>Export</h4><div class="btns">
      <button class="b sm" data-wav="1">WAV loop</button><button class="b sm" data-wav="2">WAV × 2</button><button class="b sm" data-wav="4">WAV × 4</button>
      <button class="b sm" data-act="stems">WAV stems</button><button class="b sm" data-act="midi">MIDI file</button></div>
      <h4 style="margin-top:14px">MIDI in</h4><div class="btns"><button class="b sm" data-act="midiimport">Import MIDI file…</button></div>
      <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">Drum notes go to the track with the same note (General MIDI numbers, or the names of tracks exported from here). Other channels go to the bass. You can also drop a .mid file on the page, or on one track.</p>
      <p class="hint" style="text-align:left;margin:8px 0 0;padding:0">WAV files loop cleanly: reverb and echo tails wrap around to the start. MIDI has a track per instrument, drums on channel 10.</p></div>
    <div class="sh-sec"><h4>Share</h4><div class="btns">${HOST ? '' : '<button class="b sm" data-act="link">Copy share link</button>'}<button class="b sm" data-act="json">Project file</button><button class="b sm" data-act="import">Open project file…</button></div></div>
    <div class="sh-sec"><h4>History</h4><div class="btns"><button class="b sm" data-act="undo">Undo</button><button class="b sm" data-act="redo">Redo</button></div></div>
    <div class="sh-sec"><h4>Keyboard</h4><div class="keys-list">
      <kbd>Space</kbd><span>Play / stop</span><kbd>← →</kbd><span>Previous / next bar</span><kbd>↑ ↓</kbd><span>Select track</span>
      <kbd>G</kbd><span>Switch Drums / Audio rack</span><kbd>P</kbd><span>Piano roll for the selected channel</span><kbd>R</kbd><span>New pattern for the selected track</span><kbd>Shift R</kbd><span>Generate the whole groove</span><kbd>M</kbd><span>Mute selected track</span><kbd>S</kbd><span>Solo selected track</span>
      <kbd>Delete</kbd><span>Clear the bar on the selected track</span><kbd>Ctrl Z</kbd><span>Undo (Shift for redo)</span></div></div>`, sh => {
    const nm = sh.querySelector('#m_name');
    nm.addEventListener('change', () => edit(() => { P.name = nm.value.trim() || 'Untitled beat'; }));
    sh.addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.preset) {
        const pr = GR.PRESETS.find(p => p.id === b.dataset.preset);
        commit(); load(GR.buildPreset(pr), true); ui.sel = (P.tracks[0] || {}).id; ui.bar = 0; ui.rollOpen = false; renderAll();
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
        if (a === 'generator') grooveSheet(selTrack());
        else if (a === 'blank') { commit(); load(GR.emptyProject(), true); closeSheet(); toast('Blank project. Undo brings the old one back.'); }
        else if (a === 'save') {
          const key = P.name.toLowerCase(); saved[key] = { name: P.name, at: Date.now(), data: snap() };
          toast(store.set('groove-rack.saved', JSON.stringify(saved)) ? `Saved “${P.name}”` : 'This browser blocks saving'); menuSheet();
        }
        else if (a === 'midi') { download(GR.midi(P), fileName('mid')); toast('MIDI file ready'); }
        else if (a === 'midiimport') importMidiFile(null);
        else if (a === 'stems') exportStems();
        else if (a === 'json') download(new Blob([snap()], { type: 'application/json' }), fileName('json'));
        else if (a === 'import') chooseFile('.json,application/json', '*.json').then(f => { if (!f) return; try { const data = JSON.parse(new TextDecoder().decode(f.buf)); commit(); load(data, true); closeSheet(); toast(`Opened ${f.name}`); } catch (err) { toast('That file is not a Groove Rack project'); } });
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
  if (HOST) {
    blob.arrayBuffer().then(b => HOST.call('saveFile', name, bufToB64(b))).then(p => { if (p) toast('Saved ' + p); });
    return;
  }
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
function pickSample(tr, isNew) {
  if (HOST) {
    HOST.call('pickSample').then(r => { if (r && r.path) hostSample(tr, isNew, r); });
    return;
  }
  sampleTarget = { tr, isNew }; $('#fileIn').value = ''; $('#fileIn').click();
}
function applySample(tr, isNew, id, fileName) {
  const nm = fileName.replace(/\.[^.]+$/, '').slice(0, 20);
  edit(() => {
    tr.sample = id; tr.sampleName = nm;
    if (isNew) { tr.name = nm.slice(0, 14) || 'Sample'; P.tracks.push(tr); }
  });
  if (isNew) ui.sel = tr.id;
  changed();
  closeSheet(); audition(tr); toast(`${tr.name} now plays ${fileName}`);
}
// the plugin reads the file from disk; the page gets the audio only to draw it and bounce WAVs
async function hostSampleBuffer(path) {
  const r = await HOST.call('getSample', path);
  if (!r || !r.frames) return null;
  const pcm = new Int16Array(b64ToBuf(r.data)), buf = new AudioBuffer({ length: r.frames, numberOfChannels: r.channels, sampleRate: r.sampleRate });
  for (let c = 0; c < r.channels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < r.frames; i++) d[i] = pcm[i * r.channels + c] / 32768; }
  return buf;
}
async function hostSample(tr, isNew, r) {
  const id = 'file:' + r.path;
  try { const buf = await hostSampleBuffer(r.path); if (buf) GR.samples.set(id, buf); } catch (e) { console.warn(e); }
  applySample(tr, isNew, id, r.name);
}
async function onSampleFile(file, target) {
  if (target) sampleTarget = target;
  if (!file || !sampleTarget) return;
  const { tr, isNew } = sampleTarget; sampleTarget = null;
  try {
    const ab = await file.arrayBuffer();
    if (HOST) {
      const r = await HOST.call('storeSample', file.name, bufToB64(ab));
      if (!r || !r.path) throw new Error('the plugin could not read it');
      return hostSample(tr, isNew, r);
    }
    audio();
    const buf = await new Promise((res, rej) => ctx.decodeAudioData(ab.slice(0), res, rej));
    const id = 's' + Date.now().toString(36);
    GR.samples.set(id, buf);
    try { await idb.put(id, { name: file.name, data: ab }); } catch (e) { console.warn(e); }
    applySample(tr, isNew, id, file.name);
  } catch (e) { console.error(e); toast('That file is not audio Groove Rack can play'); }
}
let samplesP = Promise.resolve();
function loadSamples() {
  samplesP = (async () => {
    for (const tr of P.tracks) {
      if (!tr.sample || GR.samples.has(tr.sample)) continue;
      try {
        if (tr.sample.startsWith('file:')) {
          const buf = HOST ? await hostSampleBuffer(tr.sample.slice(5)) : null;
          if (buf) GR.samples.set(tr.sample, buf);
          else toast(`${tr.name} uses a file from the plugin. Here it plays its built-in sound.`);
          continue;
        }
        const rec = await idb.get(tr.sample);
        if (!rec) { toast(`The sound file for ${tr.name} is not in this browser. It plays its synth sound.`); continue; }
        audio();
        const buf = await new Promise((res, rej) => ctx.decodeAudioData(rec.data.slice(0), res, rej));
        GR.samples.set(tr.sample, buf);
      } catch (e) { console.warn(e); }
    }
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
  $('#stopBtn').addEventListener('click', () => { stop(); seek(0); });
  $('#undoBtn').addEventListener('click', undo);
  $('#menuBtn').addEventListener('click', menuSheet);
  $('#addBtn').addEventListener('click', addSheet);
  $('#generateBtn').addEventListener('click', e => { if (holdT === -1) { holdT = 0; return; } newGroove(); });
  document.querySelectorAll('.density-pill').forEach(p => p.addEventListener('click', () => {
    ui.gen.complexity = +p.dataset.cx; saveGen(); renderDensity();
  }));

  // the screen
  $('#genreBox').addEventListener('click', e => {
    if (holdT === -1) { holdT = 0; return; }
    const i = GR.GENRES.indexOf(genreOf());
    edit(() => setStyle(GR.GENRES[(i + (e.shiftKey ? GR.GENRES.length - 1 : 1)) % GR.GENRES.length]));
    toast(`${styleLabel()} · ${Math.round(P.bpm)} BPM · press GENERATE, hold for styles`);
  });
  $('#barBox').addEventListener('click', barSheet);
  $('#styleBtn').addEventListener('click', () => grooveSheet(selTrack()));
  $('#likeBtn').addEventListener('click', likeGroove);
  $('#skipBtn').addEventListener('click', skipGroove);
  $('#keyBox').addEventListener('click', e => {
    if (e.shiftKey) { songSheet(); return; }
    edit(() => transposeBy(P.key === 11 ? -11 : 1));
    toast(`Key: ${keyLabel()} · the bass moved with it`);
  });
  const tb = $('#tempoBox');
  tb.addEventListener('pointerdown', e => {
    if (HOST && H.daw) return;
    const y0 = e.clientY, b0 = P.bpm; let moved = false, started = false;
    try { tb.setPointerCapture(e.pointerId); } catch (err) {}
    const mv = ev => {
      const dy = y0 - ev.clientY;
      if (!moved && Math.abs(dy) < 4) return;
      if (!started) { commit(); started = true; }
      moved = true; setBpm(Math.round(b0 + dy * 0.4)); renderOled(); S.map = null; hud(`${P.bpm} BPM`);
    };
    const up = () => { tb.removeEventListener('pointermove', mv); tb.removeEventListener('pointerup', up); tb.removeEventListener('pointercancel', up); hud(null); if (moved) { changed(); settle(); tb._dragged = true; } };
    tb.addEventListener('pointermove', mv); tb.addEventListener('pointerup', up); tb.addEventListener('pointercancel', up);
  });
  tb.addEventListener('click', () => { if (tb._dragged) { tb._dragged = false; return; } songSheet(); });
  tb.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); songSheet(); } });
  tb.addEventListener('wheel', e => { if (HOST && H.daw) return; e.preventDefault(); edit(() => setBpm(P.bpm + (e.deltaY < 0 ? 1 : -1))); }, { passive: false });

  // the deck
  const deck = $('.sequencer-deck');
  deck.addEventListener('pointerdown', e => { if (e.target.closest('.step-pad')) onPadDown(e); else if (e.target.closest('.bass-lane')) onLaneDown(e); });
  deck.addEventListener('click', onDeckClick);
  deck.addEventListener('dblclick', e => { const n = e.target.closest('.ch-name'); if (n) channelSheet(track(n.closest('.deck-row').dataset.id)); });
  deck.addEventListener('contextmenu', e => {
    if (e.target.closest('.pads, .bass-lane')) { e.preventDefault(); return; }
    const d = e.target.closest('.dice-btn'); if (d) { e.preventDefault(); grooveSheet(track(d.closest('.deck-row').dataset.id)); return; }
    const n = e.target.closest('.ch-name'); if (n) { e.preventDefault(); channelSheet(track(n.closest('.deck-row').dataset.id)); }
  });
  // hold a channel name for its settings, a dice or GENERATE for the generator, the genre for the generator
  const hold = (sel, fn) => {
    document.addEventListener('pointerdown', e => {
      const el = e.target.closest(sel); if (!el) return;
      clearTimeout(holdTimer);
      holdT = 1;
      holdTimer = setTimeout(() => { holdT = -1; fn(el); }, 520);
    });
  };
  hold('.ch-name', el => channelSheet(track(el.closest('.deck-row').dataset.id)));
  hold('.dice-btn', el => grooveSheet(track(el.closest('.deck-row').dataset.id)));
  hold('#generateBtn', () => grooveSheet(selTrack()));
  hold('#genreBox', () => grooveSheet(selTrack()));
  ['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, () => { if (holdT === 1) { clearTimeout(holdTimer); holdT = 0; } }, true));
  document.addEventListener('pointermove', e => { if (holdT === 1 && e.buttons && (Math.abs(e.movementX) + Math.abs(e.movementY) > 6)) { clearTimeout(holdTimer); holdT = 0; } }, true);
  document.addEventListener('click', e => { if (holdT === -1 && e.target.closest('.ch-name, .dice-btn, #generateBtn, #genreBox')) { e.stopPropagation(); e.preventDefault(); holdT = 0; } }, true);

  // the bottom strip
  $('#bars').addEventListener('click', e => {
    const b = e.target.closest('[data-bar]'); if (!b) return;
    const i = +b.dataset.bar;
    if (i >= P.bars) setLoopLength(MAX_BARS);
    seek(i);
  });
  $('#bars').addEventListener('pointerdown', onLoopHandleDown);
  $('#bars').addEventListener('keydown', e => {
    if (!e.target.closest('#loopHandle')) return;
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (d) { e.preventDefault(); e.stopPropagation(); setLoopLength(d > 0 ? MAX_BARS : MIN_BARS); const h2 = $('#loopHandle'); if (h2) h2.focus(); }
  });
  $('.ps-tools').addEventListener('click', e => {
    const b = e.target.closest('[data-tool]'); if (!b) return;
    const t = b.dataset.tool;
    if (t === 'copy') {
      if (P.bars < 2) { toast('Make the loop longer first: tap a + bar'); return; }
      const to = (ui.bar + 1) % P.bars;
      edit(() => P.tracks.forEach(tr => copyBar(tr, ui.bar, [to]))); toast(`Bar ${ui.bar + 1} copied onto bar ${to + 1}`); seek(to);
    } else if (t === 'clear') { edit(() => P.tracks.forEach(tr => clearBar(tr, ui.bar))); toast(`Bar ${ui.bar + 1} cleared`); }
    else if (t === 'len4') setLoopLength(MIN_BARS);
    else if (t === 'len8') setLoopLength(MAX_BARS); else if (t === 'follow') { ui.follow = !ui.follow; renderBars(); toast(ui.follow ? 'The pads follow the playing bar' : 'The pads stay on the bar you pick'); }
  });
  const cp = $('#chanPanel');
  cp.addEventListener('click', onChanClick);
  cp.addEventListener('pointerdown', onChanKnobDown);
  cp.addEventListener('wheel', e => {
    const el = e.target.closest('.cp-knob .enc-knob'); if (!el) return;
    e.preventDefault(); const kn = chanKnob(el); commit(); kn.set(kn.get() + (e.deltaY < 0 ? 0.03 : -0.03)); changed(); settle();
  }, { passive: false });
  cp.addEventListener('dblclick', e => {
    const el = e.target.closest('.cp-knob .enc-knob'); if (!el) return;
    const kn = chanKnob(el); commit(); kn.set(kn.c.to(kn.c.def)); changed(); settle();
  });
  cp.addEventListener('keydown', e => {
    const el = e.target.closest('.cp-knob .enc-knob'); if (!el) return;
    const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 0.03 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -0.03 : 0;
    if (d) { e.preventDefault(); e.stopPropagation(); const kn = chanKnob(el); commit(); kn.set(kn.get() + d); changed(); settle(); }
  });
  knob($('#swingKnob'), () => P.swing / 100, v => { P.swing = Math.round(v * 100); S.map = null; setKnob('swing', P.swing / 100, P.swing + '%'); renderOled(); syncHost(); }, 0);
  knob($('#masterKnob'), () => P.master, v => { P.master = Math.round(v * 100) / 100; setKnob('master', P.master, Math.round(P.master * 100) + '%'); if (mix) GR.updateMix(mix, P, ui.muted); syncHost(); }, 0.8);
  const mp = $('#midiPad');
  mp.addEventListener('click', () => { download(GR.midi(P), fileName('mid')); if (!HOST) toast('MIDI file saved'); });
  mp.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); mp.click(); } });
  mp.addEventListener('dragstart', e => {
    if (HOST) { e.preventDefault(); return; }
    const url = URL.createObjectURL(GR.midi(P));
    e.dataTransfer.setData('DownloadURL', `audio/midi:${fileName('mid')}:${url}`);
    e.dataTransfer.effectAllowed = 'copy';
  });

  const roll = $('#roll');
  roll.addEventListener('pointerdown', onRollDown);
  roll.addEventListener('click', onRollClick);
  roll.addEventListener('contextmenu', e => { if (e.target.closest('#rcanvas')) e.preventDefault(); });
  window.addEventListener('resize', () => { if (!$('#roll').hidden) sizeRoll(); });

  $('#fileIn').addEventListener('change', e => onSampleFile(e.target.files[0]));
  $('#anyIn').addEventListener('change', async e => {
    const f = e.target.files[0], res = pickRes; pickRes = null;
    if (res) res(f ? { name: f.name, buf: await f.arrayBuffer() } : null);
  });
  // drop a sample on a channel to replace its sound; drop a .mid on a channel or anywhere to import it
  let dropRow = null;
  const clearDrop = () => { document.querySelectorAll('.deck-row.drop').forEach(r => r.classList.remove('drop')); dropRow = null; };
  document.addEventListener('dragover', e => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    const row = e.target.closest && e.target.closest('.deck-row[data-id]');
    if (row !== dropRow) { clearDrop(); dropRow = row; if (row) row.classList.add('drop'); }
  });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) clearDrop(); });
  document.addEventListener('drop', async e => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); clearDrop();
    const f = e.dataTransfer.files[0];
    const row = e.target.closest && e.target.closest('.deck-row[data-id]'), tr = row ? track(row.dataset.id) : null;
    if (/\.midi?$/i.test(f.name)) { importMidi(await f.arrayBuffer(), tr, f.name); return; }
    if (/\.json$/i.test(f.name)) { try { const data = JSON.parse(await f.text()); commit(); load(data, true); toast(`Opened ${f.name}`); } catch (err) { toast('That file is not a Groove Rack project'); } return; }
    const target = tr || selTrack();
    if (!target) { onSampleFile(f, { tr: GR.newTrack('fx', null, { name: 'Sample', group: 'drums' }), isNew: true }); return; }
    onSampleFile(f, { tr: target, isNew: false });
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
      e.preventDefault(); const all = drumTracks().concat(bassTracks()); if (!all.length) return;
      const i = all.findIndex(t => t.id === ui.sel);
      select(all[clamp(i + (e.key === 'ArrowUp' ? -1 : 1), 0, all.length - 1)].id);
    }
    else if (e.key === 'R') newGroove();
    else if ((e.key === 'p' || e.key === 'P') && tr) toggleRoll();
    else if (e.key === 'r' && tr) newPattern(tr);
    else if ((e.key === 'm' || e.key === 'M') && tr) { edit(() => { tr.mute = !tr.mute; }); toast(tr.mute ? `${tr.name} muted` : `${tr.name} on`); }
    else if ((e.key === 's' || e.key === 'S') && tr) { edit(() => { tr.solo = !tr.solo; }); toast(tr.solo ? `${tr.name} solo` : `${tr.name} solo off`); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && tr) { e.preventDefault(); edit(() => clearBar(tr, ui.bar)); toast(`Cleared bar ${ui.bar + 1} of ${tr.name}`); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) autosave(); });
}
let holdT = 0, holdTimer = 0;

/* ---------- start ---------- */
async function init() {
  try { Object.assign(ui.gen, JSON.parse(store.get('groove-rack.gen') || '{}')); } catch (e) {}
  try { Object.assign(GR.LEARN, JSON.parse(store.get('groove-rack.learn') || '{}')); Object.assign(GR.WEIGHTS, JSON.parse(store.get('groove-rack.weights') || '{}')); } catch (e) {}
  let start = null;
  if (HOST) {
    document.documentElement.classList.add('in-plugin');
    HOST.on('state', s => {
      const was = S.playing;
      H.playing = !!s.playing; H.tick = s.tick || 0; H.at = performance.now(); H.bpm = s.bpm || 0; H.levels = s.levels || {}; H.host = !!s.host; H.daw = !!s.daw;
      // the DAW sets the tempo: keep the project (exports, waveforms, saved state) on it
      if (H.daw && H.bpm && Math.abs(H.bpm - P.bpm) > 0.005) { P.bpm = Math.round(H.bpm * 100) / 100; S.map = null; syncHost(); }
      S.playing = H.playing;
      if (was !== S.playing) renderTransport();
      if (H.daw !== H.lastDaw || $('#oledTempo').textContent !== (+P.bpm).toFixed(2)) { H.lastDaw = H.daw; renderOled(); }
    });
    try { const saved = await HOST.call('getProject'); if (saved) start = JSON.parse(saved); } catch (e) { start = null; }
  }
  const m = /#p=([\w-]+)/.exec(location.hash);
  if (m) { try { start = JSON.parse(await unb64url(m[1])); history.replaceState(null, '', location.pathname + location.search); } catch (e) { console.warn(e); } }
  if (!start && !HOST) { try { start = JSON.parse(store.get('groove-rack.current') || 'null'); } catch (e) { start = null; } }
  if (!start || !start.tracks) start = GR.buildPreset(GR.PRESETS[0]);
  load(start);
  if (m && start) toast('Opened shared beat · press play');
  wire();
  requestAnimationFrame(frame);
}
init();
GR.app = { get P() { return P; }, ui, play, stop, load, seek, importMidi };
})();
