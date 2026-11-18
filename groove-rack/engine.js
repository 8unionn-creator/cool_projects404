/* Groove Rack — sound engine.
   Every instrument is synthesized with the Web Audio API, so the app needs no sample files.
   The same functions drive live playback (AudioContext) and bouncing (OfflineAudioContext). */
(function () {
'use strict';
const GR = window.GR = window.GR || {};

const TPB = 96;               // ticks per bar: divisible by 12, 16, 24 and 32 steps
GR.TPB = TPB;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
GR.NOTE_NAMES = NOTE_NAMES;
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
GR.mtof = mtof;
GR.noteName = m => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

GR.SCALES = {
  'minor': [0, 2, 3, 5, 7, 8, 10],
  'major': [0, 2, 4, 5, 7, 9, 11],
  'dorian': [0, 2, 3, 5, 7, 9, 10],
  'phrygian': [0, 1, 3, 5, 7, 8, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'mixolydian': [0, 2, 4, 5, 7, 9, 10],
  'minor pentatonic': [0, 3, 5, 7, 10],
  'major pentatonic': [0, 2, 4, 7, 9],
  'chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

/* ---------- small building blocks ---------- */
const caches = new WeakMap();
function cache(ctx) { let c = caches.get(ctx); if (!c) { c = {}; caches.set(ctx, c); } return c; }
const fq = (ctx, f) => Math.max(10, Math.min(f, ctx.sampleRate * 0.45));

function noiseBuf(ctx) {
  const c = cache(ctx);
  if (!c.noise) {
    const n = Math.floor(ctx.sampleRate * 2), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    c.noise = b;
  }
  return c.noise;
}
function noise(ctx, t, dur) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf(ctx); s.loop = true;
  s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05); return s;
}
function osc(ctx, type, f, t, dur) {
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(Math.min(f, ctx.sampleRate * 0.49), t);
  o.start(t); o.stop(t + dur + 0.05); return o;
}
function gain(ctx, v) { const g = ctx.createGain(); g.gain.value = v == null ? 1 : v; return g; }
function filt(ctx, type, f, q) {
  const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = fq(ctx, f);
  if (q != null) b.Q.value = q; return b;
}
// percussive envelope: quick attack, exponential decay
function perc(ctx, t, peak, a, d) {
  const g = ctx.createGain(); const p = Math.max(peak, 0.0002);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(p, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + Math.max(d, 0.005)); return g;
}
// sustained envelope: attack, decay to sustain, gate closes at note end with a release
function adsr(ctx, t, dur, peak, a, d, s, r) {
  const e = ctx.createGain(); const p = Math.max(peak, 0.0002);
  e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(p, t + a);
  if (s < 1) e.gain.setTargetAtTime(p * s, t + a, Math.max(d, 0.003) / 3);
  const g = ctx.createGain(); const end = t + Math.max(dur, a + 0.005);
  g.gain.setValueAtTime(1, end); g.gain.linearRampToValueAtTime(0, end + r);
  e.connect(g); return { in: e, out: g, stop: end + r + 0.05 };
}
const curves = {};
function shaper(ctx, amt) {
  const ws = ctx.createWaveShaper(); const k = Math.round(amt * 10) / 10;
  if (!curves[k]) {
    const n = 1024, c = new Float32Array(n), m = 1 + k * 8;
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(x * m) / Math.tanh(m); }
    curves[k] = c;
  }
  ws.curve = curves[k]; ws.oversample = '2x'; return ws;
}
const semi = n => Math.pow(2, (n.pitch || 0) / 12);
function lfo(ctx, t, dur, rate, depth, param) {
  const l = osc(ctx, 'sine', rate, t, dur); const g = gain(ctx, depth); l.connect(g).connect(param);
}

/* ---------- drums ---------- */
function kick(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n), dur = o.dec * n.decay;
    const s = osc(ctx, 'sine', o.f0 * ps, t, dur + 0.05);
    s.frequency.exponentialRampToValueAtTime(o.f1 * ps, t + o.sw);
    let last = s.connect(perc(ctx, t, n.vel, 0.002, dur));
    if (o.drive) last = last.connect(shaper(ctx, o.drive));
    if (o.lp) last = last.connect(filt(ctx, 'lowpass', o.lp, 0.7));
    last.connect(out);
    if (o.click) noise(ctx, t, 0.03).connect(filt(ctx, 'highpass', 2500)).connect(perc(ctx, t, n.vel * o.click, 0.001, 0.012)).connect(out);
  };
}
function snare(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n), dk = n.decay;
    const tri = osc(ctx, 'triangle', o.tone * ps, t, 0.3);
    tri.frequency.exponentialRampToValueAtTime(o.tone * ps * 0.78, t + 0.06);
    tri.connect(perc(ctx, t, n.vel * o.body, 0.001, o.td * dk)).connect(out);
    let x = noise(ctx, t, o.nd * dk + 0.1).connect(filt(ctx, 'highpass', o.hp * ps));
    if (o.lp) x = x.connect(filt(ctx, 'lowpass', o.lp));
    x.connect(perc(ctx, t, n.vel * o.snap, 0.001, o.nd * dk)).connect(out);
  };
}
function clap(o) {
  return (ctx, out, t, n) => {
    const dk = n.decay, ps = semi(n), v = n.vel * 1.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    for (let i = 0; i < 3; i++) {
      const s = t + i * o.sp; g.gain.setValueAtTime(v, s); g.gain.exponentialRampToValueAtTime(v * 0.12, s + o.sp * 0.95);
    }
    const e = t + 3 * o.sp; g.gain.setValueAtTime(v * 0.9, e); g.gain.exponentialRampToValueAtTime(0.0001, e + o.dec * dk);
    noise(ctx, t, o.dec * dk + 0.2).connect(filt(ctx, 'bandpass', o.bp * ps, o.q || 1.1)).connect(g).connect(out);
  };
}
function snapFn(ctx, out, t, n) {
  const ps = semi(n);
  noise(ctx, t, 0.15).connect(filt(ctx, 'highpass', 1200)).connect(filt(ctx, 'bandpass', 2500 * ps, 2.2))
    .connect(perc(ctx, t, n.vel * 2.2, 0.001, 0.065 * n.decay)).connect(out);
  osc(ctx, 'sine', 1900 * ps, t, 0.04).connect(perc(ctx, t, n.vel * 0.2, 0.001, 0.018)).connect(out);
}
function rimFn(ctx, out, t, n) {
  const ps = semi(n), bp = filt(ctx, 'bandpass', 1650 * ps, 2.5);
  osc(ctx, 'square', 1700 * ps, t, 0.05).connect(bp);
  osc(ctx, 'triangle', 480 * ps, t, 0.08).connect(bp);
  bp.connect(perc(ctx, t, n.vel * 0.9, 0.0005, 0.04 * n.decay)).connect(out);
}
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
function hat(o) {
  return (ctx, out, t, n) => {
    const dk = n.decay, ps = semi(n), dur = o.dec * dk;
    const hp = filt(ctx, 'highpass', o.hp * ps, 0.8);
    noise(ctx, t, dur + 0.1).connect(hp);
    if (o.metal) {
      const bp = filt(ctx, 'bandpass', 9000 * ps, 1), mg = gain(ctx, 0.18);
      METAL.forEach(f => osc(ctx, 'square', f * ps, t, dur + 0.1).connect(bp));
      bp.connect(mg).connect(hp);
    }
    hp.connect(perc(ctx, t, n.vel * o.lvl, 0.001, dur)).connect(out);
  };
}
function shaker(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n), dk = n.decay;
    noise(ctx, t, 0.2).connect(filt(ctx, 'bandpass', o.f * ps, 0.9)).connect(perc(ctx, t, n.vel * o.lvl, o.a, o.dec * dk)).connect(out);
    if (o.jingle) {
      [0, 0.014].forEach(d => noise(ctx, t + d, 0.2).connect(filt(ctx, 'bandpass', 9000 * ps, 5))
        .connect(perc(ctx, t + d, n.vel * 1.4, 0.001, 0.09 * dk)).connect(out));
    }
  };
}
function conga(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n), f = o.f * ps, dk = n.decay;
    const s = osc(ctx, 'sine', o.bend ? f * 0.75 : f * 1.25, t, o.dec * dk + 0.05);
    s.frequency.exponentialRampToValueAtTime(o.bend ? f * 1.08 : f, t + (o.bend ? 0.12 : 0.025));
    s.connect(perc(ctx, t, n.vel * 0.95, 0.002, o.dec * dk)).connect(out);
    if (o.slap) noise(ctx, t, 0.08).connect(filt(ctx, 'bandpass', 2200 * ps, 1.5)).connect(perc(ctx, t, n.vel * 0.9, 0.001, 0.04)).connect(out);
  };
}
function tom(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n), f = o.f * ps, dur = 0.45 * n.decay;
    const s = osc(ctx, 'sine', f * 1.4, t, dur + 0.05);
    s.frequency.exponentialRampToValueAtTime(f, t + 0.04);
    s.frequency.exponentialRampToValueAtTime(f * 0.75, t + dur);
    s.connect(perc(ctx, t, n.vel, 0.002, dur)).connect(out);
  };
}
function bellPerc(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n), bp = filt(ctx, 'bandpass', o.f * 1.5 * ps, 1.6);
    [o.f, o.f * 1.48].forEach(f => osc(ctx, 'square', f * ps, t, o.dec * n.decay + 0.05).connect(bp));
    bp.connect(perc(ctx, t, n.vel * 0.55, 0.001, o.dec * n.decay)).connect(out);
  };
}
function block(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n);
    osc(ctx, 'sine', o.f * ps, t, 0.1).connect(perc(ctx, t, n.vel * 0.9, 0.0005, o.dec * n.decay)).connect(out);
    noise(ctx, t, 0.03).connect(filt(ctx, 'bandpass', o.f * 2 * ps, 4)).connect(perc(ctx, t, n.vel * 0.6, 0.0005, 0.01)).connect(out);
  };
}
function cymbal(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n), dur = o.dec * n.decay;
    const hp = filt(ctx, 'highpass', o.hp * ps, 0.6);
    noise(ctx, t, dur + 0.1).connect(hp);
    const bp = filt(ctx, 'bandpass', 7000 * ps, 0.7), mg = gain(ctx, 0.15);
    METAL.forEach(f => osc(ctx, 'square', f * 1.6 * ps, t, dur + 0.1).connect(bp));
    bp.connect(mg).connect(hp);
    hp.connect(perc(ctx, t, n.vel * o.lvl, 0.003, dur)).connect(out);
  };
}

/* ---------- pitched ---------- */
function bass808(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n), f = mtof(n.p) * ps, dk = n.decay, dur = n.dur;
    const s = osc(ctx, 'sine', n.from != null ? mtof(n.from) * ps : f * 1.6, t, dur + 0.15);
    s.frequency.exponentialRampToValueAtTime(f, t + (n.from != null ? 0.09 : 0.03));
    const amp = ctx.createGain(); const v = n.vel;
    amp.gain.setValueAtTime(0.0001, t); amp.gain.linearRampToValueAtTime(v, t + 0.004);
    amp.gain.exponentialRampToValueAtTime(v * 0.18, t + 1.8 * dk);
    const gate = ctx.createGain(); const end = t + dur;
    gate.gain.setValueAtTime(1, end); gate.gain.linearRampToValueAtTime(0, end + 0.06);
    let x = s.connect(amp);
    if (o.drive) x = x.connect(shaper(ctx, o.drive)).connect(filt(ctx, 'lowpass', o.lp || 2200, 0.7));
    x.connect(gain(ctx, o.drive ? 0.42 * (o.lvl || 1) : 0.62)).connect(gate).connect(out);
  };
}
// subtractive synth voice. waves: [type, detune cents, level, ratio]
function synth(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n), f = mtof(n.p) * ps, dk = n.decay;
    const A = adsr(ctx, t, n.dur, n.vel * (o.lvl || 0.4), o.a, o.d * dk, o.s, o.r * dk);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = o.q || 0.7;
    lp.frequency.setValueAtTime(fq(ctx, o.cut + (o.env || 0)), t);
    if (o.env) lp.frequency.setTargetAtTime(fq(ctx, o.cut), t, (o.envDec || 0.1) / 3);
    const len = A.stop - t;
    o.waves.forEach(w => {
      const r = w[3] || 1, os = osc(ctx, w[0], (n.from != null ? mtof(n.from) * ps : f) * r, t, len);
      if (n.from != null) os.frequency.exponentialRampToValueAtTime(f * r, t + 0.08);
      os.detune.value = w[1];
      if (o.vib) lfo(ctx, t, len, 5.2, f * r * 0.006, os.frequency);
      os.connect(gain(ctx, w[2])).connect(lp);
    });
    if (o.breath) noise(ctx, t, len).connect(filt(ctx, 'bandpass', f * 2, 1.5)).connect(gain(ctx, o.breath)).connect(lp);
    lp.connect(A.in); A.out.connect(out);
  };
}
function piano(ctx, out, t, n) {
  const ps = semi(n), f = mtof(n.p) * ps, dk = n.decay;
  const gate = ctx.createGain(); const end = t + n.dur;
  gate.gain.setValueAtTime(1, end); gate.gain.linearRampToValueAtTime(0, end + 0.25);
  const lo = Math.max(0.4, 1.4 - (n.p - 48) / 60);  // lower notes ring longer
  [[1, 0.5, 2.2], [2, 0.22, 1.4], [3, 0.12, 0.9], [4, 0.07, 0.6], [5, 0.04, 0.4]].forEach(([r, lv, d]) => {
    osc(ctx, 'sine', f * r * (1 + (r - 1) * 0.0006), t, d * dk * lo + n.dur).connect(perc(ctx, t, n.vel * lv, 0.003, d * dk * lo)).connect(gate);
  });
  noise(ctx, t, 0.05).connect(filt(ctx, 'bandpass', 3000, 1)).connect(perc(ctx, t, n.vel * 0.05, 0.001, 0.02)).connect(gate);
  gate.connect(out);
}
function fm(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n), f = mtof(n.p) * ps, dk = n.decay;
    const gate = ctx.createGain(); const end = t + n.dur;
    gate.gain.setValueAtTime(1, end); gate.gain.linearRampToValueAtTime(0, end + o.rel);
    const len = o.dec * dk + n.dur;
    const car = osc(ctx, 'sine', f, t, len), mod = osc(ctx, 'sine', f * o.ratio, t, len);
    const idx = ctx.createGain();
    idx.gain.setValueAtTime(f * o.i0, t); idx.gain.exponentialRampToValueAtTime(Math.max(f * o.i1, 0.01), t + o.idec);
    mod.connect(idx).connect(car.frequency);
    car.connect(perc(ctx, t, n.vel * o.lvl, 0.003, o.dec * dk)).connect(gate);
    if (o.tine) osc(ctx, 'sine', f * o.tine, t, 0.3).connect(perc(ctx, t, n.vel * 0.04, 0.001, 0.12)).connect(gate);
    gate.connect(out);
  };
}
function marimba(ctx, out, t, n) {
  const ps = semi(n), f = mtof(n.p) * ps, dk = n.decay;
  osc(ctx, 'sine', f, t, 0.8).connect(perc(ctx, t, n.vel * 0.8, 0.002, 0.45 * dk)).connect(out);
  osc(ctx, 'sine', f * 3.93, t, 0.2).connect(perc(ctx, t, n.vel * 0.12, 0.001, 0.07 * dk)).connect(out);
}
// Karplus-Strong plucked string, rendered in JS once per pitch and sample rate
function ksBuffer(ctx, p, bright) {
  const c = cache(ctx), key = 'ks' + p + '_' + bright;
  if (c[key]) return c[key];
  const sr = ctx.sampleRate, len = Math.floor(sr * 1.6), b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0);
  const N = Math.max(2, Math.round(sr / mtof(p))), damp = 0.996 - Math.max(0, p - 60) * 0.0004;
  let lp = 0;
  for (let i = 0; i < N; i++) { const r = Math.random() * 2 - 1; lp += (r - lp) * bright; d[i] = lp; }
  for (let i = N; i < len; i++) d[i] = 0.5 * (d[i - N] + d[i - N - 1 < 0 ? 0 : i - N - 1]) * damp;
  c[key] = b; return b;
}
function guitar(o) {
  return (ctx, out, t, n) => {
    const s = ctx.createBufferSource(); s.buffer = ksBuffer(ctx, Math.round(n.p), o.bright);
    s.playbackRate.value = semi(n);
    const g = ctx.createGain(); g.gain.setValueAtTime(n.vel * o.lvl, t);
    const end = t + n.dur; g.gain.setValueAtTime(n.vel * o.lvl, end);
    g.gain.exponentialRampToValueAtTime(0.0001, end + 0.12 * n.decay);
    s.connect(filt(ctx, 'lowpass', o.lp, 0.5)).connect(g).connect(out);
    s.start(t); s.stop(end + 0.2);
  };
}
function logdrum(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n), f = mtof(n.p) * ps, dk = n.decay;
    const dur = Math.min(0.28 * dk + n.dur * 0.6, 2.2);
    const s = osc(ctx, 'sine', f * 2.4, t, dur + 0.05);
    s.frequency.exponentialRampToValueAtTime(f, t + 0.035);
    const tr = osc(ctx, 'triangle', f * 2, t, dur + 0.05);
    tr.frequency.exponentialRampToValueAtTime(f * 1.002, t + 0.03);
    const mix = ctx.createGain();
    s.connect(mix); tr.connect(gain(ctx, o.body)).connect(mix);
    mix.connect(perc(ctx, t, n.vel * o.lvl, 0.003, dur)).connect(shaper(ctx, o.drive)).connect(filt(ctx, 'lowpass', o.lp, 1.2)).connect(out);
  };
}
const VOWELS = { ah: [800, 1150, 2900], oh: [450, 800, 2830], ee: [290, 2200, 3000], oo: [325, 700, 2530], eh: [530, 1840, 2480] };
function vox(o) {
  return (ctx, out, t, n) => {
    const ps = semi(n), f = mtof(n.p) * ps, dk = n.decay;
    const dur = o.hey ? 0.22 * dk : n.dur;
    const A = adsr(ctx, t, dur, n.vel * o.lvl, 0.012, 0.25, 0.75, 0.1 * dk);
    const len = A.stop - t;
    const src = osc(ctx, 'sawtooth', o.hey ? f * 1.12 : f, t, len);
    if (o.hey) src.frequency.exponentialRampToValueAtTime(f * 0.88, t + dur);
    else lfo(ctx, t, len, 5.5, f * 0.008, src.frequency);
    const sum = ctx.createGain();
    const fm = VOWELS[o.v];
    fm.forEach((F, i) => {
      const bp = filt(ctx, 'bandpass', F, F / [70, 90, 120][i]);
      if (o.to) bp.frequency.linearRampToValueAtTime(fq(ctx, VOWELS[o.to][i]), t + Math.max(dur, 0.1));
      src.connect(bp).connect(gain(ctx, [1, 0.6, 0.3][i])).connect(sum);
    });
    if (o.hey) noise(ctx, t, 0.08).connect(filt(ctx, 'bandpass', 2400, 1)).connect(perc(ctx, t, 0.35, 0.002, 0.05)).connect(sum);
    sum.connect(A.in); A.out.connect(out);
  };
}

/* ---------- FX (one-shots) ---------- */
function clickAt(ctx, out, t, v, f, dec, q) {
  noise(ctx, t, dec + 0.05).connect(filt(ctx, 'bandpass', f, q || 5)).connect(perc(ctx, t, v, 0.0005, dec)).connect(out);
}
const FX = {
  squeak(ctx, out, t, n) {
    const ps = semi(n), dk = n.decay;
    [0, 0.17 * dk].forEach((d, i) => {
      const s = osc(ctx, 'sawtooth', 820 * ps, t + d, 0.2);
      s.frequency.linearRampToValueAtTime((i ? 1300 : 1500) * ps, t + d + 0.06);
      s.frequency.linearRampToValueAtTime((i ? 900 : 1100) * ps, t + d + 0.14);
      s.connect(filt(ctx, 'bandpass', 1700 * ps, 3)).connect(perc(ctx, t + d, n.vel * (i ? 1.6 : 2.2), 0.015, 0.13)).connect(out);
    });
  },
  reload(ctx, out, t, n) {
    const ps = semi(n), v = n.vel, d2 = t + 0.17 * n.decay;
    clickAt(ctx, out, t, v * 3, 3300 * ps, 0.03); clickAt(ctx, out, t + 0.006, v * 2, 1100 * ps, 0.05);
    osc(ctx, 'square', 2900 * ps, t, 0.1).connect(filt(ctx, 'bandpass', 3000 * ps, 8)).connect(perc(ctx, t, v * 0.25, 0.001, 0.06)).connect(out);
    clickAt(ctx, out, d2, v * 3, 2500 * ps, 0.04); clickAt(ctx, out, d2 + 0.008, v * 2.5, 900 * ps, 0.08, 3);
    const th = osc(ctx, 'sine', 190 * ps, d2, 0.1); th.frequency.exponentialRampToValueAtTime(90, d2 + 0.06);
    th.connect(perc(ctx, d2, v * 0.6, 0.001, 0.07)).connect(out);
  },
  shot(ctx, out, t, n) {
    const ps = semi(n), dk = n.decay, v = n.vel;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(fq(ctx, 7000 * ps), t); lp.frequency.exponentialRampToValueAtTime(300, t + 0.4 * dk);
    noise(ctx, t, 0.8 * dk).connect(shaper(ctx, 0.7)).connect(lp).connect(perc(ctx, t, v * 0.9, 0.001, 0.55 * dk)).connect(out);
    const s = osc(ctx, 'sine', 150 * ps, t, 0.3); s.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    s.connect(perc(ctx, t, v * 1.1, 0.001, 0.22 * dk)).connect(out);
  },
  airhorn(ctx, out, t, n) {
    const ps = semi(n), dur = 0.42 * n.decay, A = adsr(ctx, t, dur, n.vel * 0.45, 0.01, 0.1, 0.9, 0.06);
    const lp = filt(ctx, 'lowpass', 3200, 1.5);
    [[466, -6], [466, 7], [233, 0], [699, 3]].forEach(([f, dt]) => {
      const o = osc(ctx, 'sawtooth', f * ps, t, dur + 0.1); o.detune.value = dt;
      o.frequency.setValueAtTime(f * ps, t + dur * 0.8); o.frequency.linearRampToValueAtTime(f * ps * 0.94, t + dur);
      o.connect(lp);
    });
    lp.connect(A.in); A.out.connect(out);
  },
  siren(ctx, out, t, n) {
    const ps = semi(n), dur = 1.3 * n.decay, A = adsr(ctx, t, dur, n.vel * 0.3, 0.05, 0.1, 1, 0.2);
    const o = osc(ctx, 'triangle', 850 * ps, t, dur + 0.3); lfo(ctx, t, dur + 0.3, 3.2, 280 * ps, o.frequency);
    o.connect(A.in); A.out.connect(out);
  },
  riser(ctx, out, t, n) {
    const ps = semi(n), dur = 1.8 * n.decay;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(300 * ps, t); bp.frequency.exponentialRampToValueAtTime(fq(ctx, 8000 * ps), t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(n.vel * 2.6, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.03);
    noise(ctx, t, dur + 0.1).connect(bp).connect(g).connect(out);
  },
  laser(ctx, out, t, n) {
    const ps = semi(n), s = osc(ctx, 'square', 2400 * ps, t, 0.3);
    s.frequency.exponentialRampToValueAtTime(110 * ps, t + 0.24 * n.decay);
    s.connect(filt(ctx, 'lowpass', 4000)).connect(perc(ctx, t, n.vel * 0.3, 0.002, 0.25 * n.decay)).connect(out);
  },
  impact(ctx, out, t, n) {
    const ps = semi(n), dk = n.decay;
    const s = osc(ctx, 'sine', 95 * ps, t, 1.2 * dk); s.frequency.exponentialRampToValueAtTime(28, t + 0.9 * dk);
    s.connect(perc(ctx, t, n.vel * 1.1, 0.002, 1.1 * dk)).connect(shaper(ctx, 0.4)).connect(out);
    noise(ctx, t, 1.4 * dk).connect(filt(ctx, 'lowpass', 900)).connect(perc(ctx, t, n.vel * 0.7, 0.002, 1.2 * dk)).connect(out);
  },
  whistle(ctx, out, t, n) {
    const ps = semi(n), dur = 0.3 * n.decay, A = adsr(ctx, t, dur, n.vel * 0.25, 0.01, 0.1, 0.9, 0.04);
    const s = osc(ctx, 'sine', 2600 * ps, t, dur + 0.1); lfo(ctx, t, dur + 0.1, 28, 140 * ps, s.frequency);
    s.connect(A.in); A.out.connect(out);
  },
  scratch(ctx, out, t, n) {
    const ps = semi(n), dur = 0.28 * n.decay;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4;
    bp.frequency.setValueAtTime(700 * ps, t); bp.frequency.linearRampToValueAtTime(fq(ctx, 3200 * ps), t + dur * 0.4);
    bp.frequency.linearRampToValueAtTime(500 * ps, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(n.vel * 2, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(n.vel * 0.3, t + dur * 0.5); g.gain.linearRampToValueAtTime(n.vel * 1.6, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0, t + dur);
    noise(ctx, t, dur + 0.05).connect(bp).connect(g).connect(out);
  },
  chant(ctx, out, t, n) { vox({ v: 'eh', lvl: 2.6, hey: true })(ctx, out, t, Object.assign({}, n, { p: 57 })); }
};

/* ---------- instrument registry ---------- */
// cat: where it shows in the add-track sheet. group: which rack it starts in.
const I = GR.INST = {
  kick: { label: 'Kick', cat: 'Drums', group: 'drums', gm: 36, sounds: {
    bounce: ['bounce kick', kick({ f0: 190, f1: 50, sw: 0.06, dec: 0.34, click: 0.5, drive: 0.3 })],
    punch: ['punch kick', kick({ f0: 240, f1: 52, sw: 0.045, dec: 0.28, click: 0.8, drive: 0.5 })],
    boom: ['boom kick', kick({ f0: 150, f1: 41, sw: 0.11, dec: 0.9, click: 0.3, drive: 0.2 })],
    afro: ['afro kick', kick({ f0: 130, f1: 56, sw: 0.05, dec: 0.3, click: 0.15, lp: 900 })],
    house: ['house kick', kick({ f0: 170, f1: 48, sw: 0.08, dec: 0.45, click: 0.4, drive: 0.6 })],
    dusty: ['dusty kick', kick({ f0: 200, f1: 52, sw: 0.05, dec: 0.3, click: 0.6, drive: 0.4, lp: 1400 })]
  } },
  snare: { label: 'Snare', cat: 'Drums', group: 'drums', gm: 38, sounds: {
    tight: ['tight snare', snare({ tone: 230, td: 0.08, nd: 0.13, hp: 1800, body: 0.6, snap: 0.7 })],
    trap: ['trap snare', snare({ tone: 200, td: 0.1, nd: 0.2, hp: 2200, body: 0.5, snap: 0.9 })],
    fat: ['fat snare', snare({ tone: 170, td: 0.16, nd: 0.28, hp: 1000, lp: 7000, body: 0.8, snap: 0.7 })],
    lofi: ['dusty snare', snare({ tone: 190, td: 0.1, nd: 0.16, hp: 1200, lp: 3200, body: 0.6, snap: 0.6 })]
  } },
  clap: { label: 'Clap', cat: 'Drums', group: 'drums', gm: 39, sounds: {
    clap: ['clap', clap({ bp: 1200, dec: 0.18, sp: 0.011 })],
    big: ['big clap', clap({ bp: 1000, dec: 0.42, sp: 0.014, q: 0.8 })],
    tight: ['tight clap', clap({ bp: 1600, dec: 0.1, sp: 0.008 })]
  } },
  snap: { label: 'Snap', cat: 'Drums', group: 'drums', gm: 39, sounds: { snap: ['finger snap', snapFn] } },
  rim: { label: 'Rim', cat: 'Drums', group: 'drums', gm: 37, sounds: { rim: ['rimshot', rimFn] } },
  hat: { label: 'Hi-hat', cat: 'Drums', group: 'drums', gm: 42, choke: 'hat', sounds: {
    tight: ['tight hat', hat({ dec: 0.045, hp: 7000, lvl: 0.8 })],
    crisp: ['crisp hat', hat({ dec: 0.07, hp: 6000, metal: 1, lvl: 1.0 })],
    soft: ['soft hat', hat({ dec: 0.05, hp: 5000, lvl: 0.75 })]
  } },
  openhat: { label: 'Open Hat', cat: 'Drums', group: 'drums', gm: 46, choke: 'hat', sounds: {
    open: ['open hat', hat({ dec: 0.38, hp: 6500, metal: 1, lvl: 0.9 })],
    wash: ['washy hat', hat({ dec: 0.7, hp: 5000, lvl: 0.8 })],
    short: ['short open hat', hat({ dec: 0.2, hp: 7000, lvl: 0.9 })]
  } },
  cymbal: { label: 'Cymbal', cat: 'Drums', group: 'drums', gm: 49, sounds: {
    crash: ['crash', cymbal({ dec: 1.6, hp: 4000, lvl: 0.9 })],
    ride: ['ride', cymbal({ dec: 0.8, hp: 6000, lvl: 1.0 })]
  } },
  tom: { label: 'Tom', cat: 'Drums', group: 'drums', gm: 45, sounds: {
    low: ['low tom', tom({ f: 95 })], mid: ['mid tom', tom({ f: 135 })], high: ['high tom', tom({ f: 185 })]
  } },
  shaker: { label: 'Shaker', cat: 'Percussion', group: 'drums', gm: 70, sounds: {
    shaker: ['shaker', shaker({ f: 5500, a: 0.012, dec: 0.07, lvl: 1.4 })],
    tamb: ['tambourine', shaker({ f: 7000, a: 0.004, dec: 0.06, lvl: 0.8, jingle: 1 })],
    cabasa: ['cabasa', shaker({ f: 8000, a: 0.02, dec: 0.05, lvl: 1.2 })]
  } },
  conga: { label: 'Conga', cat: 'Percussion', group: 'drums', gm: 63, sounds: {
    high: ['conga hi', conga({ f: 330, dec: 0.22 })],
    low: ['conga lo', conga({ f: 220, dec: 0.3 })],
    bongo: ['bongo', conga({ f: 460, dec: 0.13 })],
    slap: ['conga slap', conga({ f: 300, dec: 0.1, slap: 1 })],
    talk: ['talking drum', conga({ f: 190, dec: 0.4, bend: 1 })]
  } },
  bell: { label: 'Bell', cat: 'Percussion', group: 'drums', gm: 56, sounds: {
    agogo: ['agogo bell', bellPerc({ f: 880, dec: 0.18 })],
    low: ['low agogo', bellPerc({ f: 660, dec: 0.2 })],
    cowbell: ['cowbell', bellPerc({ f: 560, dec: 0.25 })]
  } },
  block: { label: 'Woodblock', cat: 'Percussion', group: 'drums', gm: 76, sounds: {
    wood: ['woodblock', block({ f: 1000, dec: 0.06 })], clave: ['clave', block({ f: 2500, dec: 0.05 })],
    tick: ['log tick', block({ f: 700, dec: 0.04 })]
  } },
  b808: { label: '808', cat: 'Bass', group: 'audio', pitched: true, mono: true, base: 24, sounds: {
    clean: ['clean 808', bass808({})],
    dirty: ['dirty 808', bass808({ drive: 0.6, lp: 2500, lvl: 0.8 })],
    slide: ['sliding 808', bass808({ drive: 0.4, lp: 2200, lvl: 0.85 }), { autoSlide: true }],
    sub: ['sub 808', bass808({ lvl: 0.9 })]
  } },
  bass: { label: 'Bass', cat: 'Bass', group: 'audio', pitched: true, mono: true, base: 28, sounds: {
    synth: ['synth bass', synth({ waves: [['sawtooth', 0, 0.5], ['sine', 0, 0.8, 0.5]], cut: 500, env: 1400, envDec: 0.15, a: 0.004, d: 0.3, s: 0.7, r: 0.06, lvl: 0.5 })],
    pluck: ['pluck bass', synth({ waves: [['square', 0, 0.4], ['sine', 0, 0.6]], cut: 300, env: 2200, envDec: 0.1, a: 0.002, d: 0.25, s: 0.25, r: 0.05, lvl: 0.55 })],
    reese: ['reese bass', synth({ waves: [['sawtooth', -14, 0.4], ['sawtooth', 14, 0.4], ['sine', 0, 0.6, 0.5]], cut: 700, a: 0.01, d: 0.3, s: 0.9, r: 0.08, lvl: 0.45 })],
    round: ['round bass', synth({ waves: [['triangle', 0, 0.8], ['sine', 0, 0.6, 0.5]], cut: 900, a: 0.005, d: 0.4, s: 0.6, r: 0.06, lvl: 0.6 })]
  } },
  logdrum: { label: 'Log Drum', cat: 'Bass', group: 'audio', pitched: true, mono: true, base: 24, sounds: {
    log: ['log drum', logdrum({ body: 0.35, drive: 0.5, lp: 1800, lvl: 0.75 })],
    knock: ['knock log', logdrum({ body: 0.6, drive: 0.8, lp: 2600, lvl: 0.6 })]
  } },
  keys: { label: 'Keys', cat: 'Keys & synths', group: 'audio', pitched: true, base: 48, sounds: {
    piano: ['piano', piano],
    rhodes: ['rhodes', fm({ ratio: 1, i0: 1.6, i1: 0.15, idec: 0.5, dec: 2.4, rel: 0.2, lvl: 0.4, tine: 14 })],
    organ: ['organ', synth({ waves: [['sine', 0, 0.5], ['sine', 0, 0.35, 2], ['sine', 0, 0.2, 3], ['sine', 0, 0.12, 4], ['sine', 0, 0.3, 0.5]], cut: 6000, a: 0.005, d: 0.1, s: 1, r: 0.06, lvl: 0.3 })]
  } },
  pad: { label: 'Pad', cat: 'Keys & synths', group: 'audio', pitched: true, base: 48, sounds: {
    warm: ['warm pad', synth({ waves: [['sawtooth', -7, 0.3], ['sawtooth', 7, 0.3], ['triangle', 0, 0.3, 0.5]], cut: 1300, a: 0.3, d: 0.6, s: 0.8, r: 0.6, lvl: 0.9 })],
    supersaw: ['supersaw', synth({ waves: [-18, -8, 0, 8, 18].map(d => ['sawtooth', d, 0.16]), cut: 4500, a: 0.01, d: 0.4, s: 0.85, r: 0.25, lvl: 0.7 })],
    strings: ['strings', synth({ waves: [['sawtooth', -10, 0.3], ['sawtooth', 10, 0.3]], cut: 2400, a: 0.18, d: 0.4, s: 0.9, r: 0.5, lvl: 0.8, vib: 1 })]
  } },
  pluck: { label: 'Pluck', cat: 'Keys & synths', group: 'audio', pitched: true, base: 60, sounds: {
    pluck: ['pluck', synth({ waves: [['sawtooth', -4, 0.4], ['sawtooth', 4, 0.4]], cut: 350, env: 5000, envDec: 0.18, a: 0.002, d: 0.35, s: 0, r: 0.1, lvl: 1.0 })],
    bell: ['bell', fm({ ratio: 3.5, i0: 2, i1: 0.1, idec: 0.8, dec: 1.6, rel: 0.3, lvl: 0.7 })],
    marimba: ['marimba', marimba],
    guitar: ['guitar', guitar({ bright: 0.5, lp: 4500, lvl: 0.8 })],
    kalimba: ['kalimba', fm({ ratio: 5.2, i0: 0.9, i1: 0.05, idec: 0.15, dec: 0.9, rel: 0.15, lvl: 0.8 })]
  } },
  lead: { label: 'Lead', cat: 'Keys & synths', group: 'audio', pitched: true, mono: true, base: 60, sounds: {
    saw: ['saw lead', synth({ waves: [['sawtooth', -6, 0.35], ['sawtooth', 6, 0.35]], cut: 2800, env: 1500, envDec: 0.2, a: 0.008, d: 0.3, s: 0.8, r: 0.12, lvl: 0.3, vib: 1 })],
    square: ['square lead', synth({ waves: [['square', 0, 0.4]], cut: 2400, a: 0.006, d: 0.2, s: 0.8, r: 0.1, lvl: 0.28, vib: 1 })],
    flute: ['flute', synth({ waves: [['sine', 0, 0.8], ['triangle', 0, 0.2, 2]], cut: 5000, a: 0.06, d: 0.2, s: 0.9, r: 0.12, lvl: 0.4, vib: 1, breath: 0.12 })]
  } },
  vox: { label: 'Vox', cat: 'Vocals', group: 'audio', pitched: true, mono: true, base: 60, sounds: {
    ah: ['vox ah', vox({ v: 'ah', lvl: 3 })], oh: ['vox oh', vox({ v: 'oh', lvl: 3.4 })],
    ee: ['vox ee', vox({ v: 'ee', lvl: 3.4 })], oo: ['vox oo', vox({ v: 'oo', lvl: 3.8 })],
    yeah: ['vox yeah', vox({ v: 'ee', to: 'ah', lvl: 3.2 })], hey: ['vox hey', vox({ v: 'eh', lvl: 2.6, hey: true })]
  } },
  fx: { label: 'FX', cat: 'FX', group: 'audio', gm: 60, sounds: {
    squeak: ['squeak', FX.squeak], reload: ['reload', FX.reload], shot: ['shot', FX.shot],
    airhorn: ['air horn', FX.airhorn], siren: ['siren', FX.siren], riser: ['riser', FX.riser],
    laser: ['laser', FX.laser], impact: ['impact', FX.impact], whistle: ['whistle', FX.whistle],
    scratch: ['scratch', FX.scratch], chant: ['hey chant', FX.chant]
  } }
};
Object.keys(I).forEach(k => { I[k].id = k; I[k].def = Object.keys(I[k].sounds)[0]; });
GR.soundLabel = tr => tr.sample ? (tr.sampleName || 'sample') : ((I[tr.inst].sounds[tr.sound] || [])[0] || tr.sound);

/* ---------- samples the user loads ---------- */
GR.samples = new Map();  // id -> AudioBuffer (buffers work in any context)
function playSample(ctx, out, t, n, tr, buf, pitched) {
  const s = ctx.createBufferSource(); s.buffer = buf;
  const rate = Math.pow(2, ((pitched ? n.p - 60 : 0) + (n.pitch || 0)) / 12);
  s.playbackRate.setValueAtTime(n.from != null && pitched ? Math.pow(2, (n.from - 60 + (n.pitch || 0)) / 12) : rate, t);
  if (n.from != null && pitched) s.playbackRate.exponentialRampToValueAtTime(rate, t + 0.08);
  const g = ctx.createGain(); g.gain.setValueAtTime(n.vel, t);
  let end = t + buf.duration / rate;
  if (pitched) { end = Math.min(end, t + n.dur + 0.06); g.gain.setValueAtTime(n.vel, t + n.dur); g.gain.linearRampToValueAtTime(0, t + n.dur + 0.05); }
  else if (n.decay < 1) { const cut = t + (end - t) * n.decay; g.gain.setValueAtTime(n.vel, cut); g.gain.linearRampToValueAtTime(0, cut + 0.04); end = cut + 0.05; }
  s.connect(g).connect(out); s.start(t); s.stop(end + 0.05);
}

// play one note of a track into `out`
GR.voice = function (ctx, out, t, tr, n) {
  const inst = I[tr.inst]; if (!inst) return;
  n.decay = tr.decay || 1; n.pitch = tr.pitch || 0;
  const buf = tr.sample && GR.samples.get(tr.sample);
  if (buf) return playSample(ctx, out, t, n, tr, buf, inst.pitched);
  const snd = inst.sounds[tr.sound] || inst.sounds[inst.def];
  snd[1](ctx, out, t, n);
};

/* ---------- mixer ---------- */
function impulse(ctx, secs) {
  const c = cache(ctx); if (c.ir) return c.ir;
  const sr = ctx.sampleRate, len = Math.floor(sr * secs), b = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch); let lp = 0;
    for (let i = 0; i < len; i++) { const x = Math.random() * 2 - 1; lp += (x - lp) * 0.35; d[i] = lp * Math.pow(1 - i / len, 3.2); }
  }
  c.ir = b; return b;
}
GR.buildMix = function (ctx, analyse) {
  const m = { ctx, strips: {} };
  m.bus = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3; comp.attack.value = 0.008; comp.release.value = 0.2;
  m.master = ctx.createGain();
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
  m.bus.connect(comp).connect(m.master).connect(lim).connect(ctx.destination);
  m.rev = ctx.createConvolver(); m.rev.buffer = impulse(ctx, 2.4);
  m.rev.connect(gain(ctx, 0.7)).connect(m.bus);
  m.dly = ctx.createDelay(3); const dlp = filt(ctx, 'lowpass', 3200, 0.5); m.dlyFb = gain(ctx, 0.36);
  m.dly.connect(dlp); dlp.connect(m.dlyFb).connect(m.dly); dlp.connect(gain(ctx, 0.7)).connect(m.bus);
  if (analyse) { m.an = ctx.createAnalyser(); m.an.fftSize = 512; lim.connect(m.an); }
  return m;
};
GR.strip = function (m, tr, analyse) {
  const ctx = m.ctx, s = {};
  s.in = ctx.createGain(); s.tone = filt(ctx, 'lowpass', 20000, 0.6);
  s.pan = ctx.createStereoPanner(); s.out = ctx.createGain();
  s.rev = ctx.createGain(); s.dly = ctx.createGain();
  s.in.connect(s.tone).connect(s.pan).connect(s.out).connect(m.bus);
  s.out.connect(s.rev).connect(m.rev); s.out.connect(s.dly).connect(m.dly);
  if (analyse) { s.an = ctx.createAnalyser(); s.an.fftSize = 256; s.out.connect(s.an); }
  m.strips[tr.id] = s; return s;
};
GR.dropStrip = function (m, id) {
  const s = m.strips[id]; if (!s) return;
  try { s.out.disconnect(); s.in.disconnect(); } catch (e) {}
  delete m.strips[id];
};
GR.updateMix = function (m, P, muted) {
  const ctx = m.ctx, now = ctx.currentTime, anySolo = P.tracks.some(t => t.solo);
  const set = (p, v) => { if (ctx instanceof OfflineAudioContext) p.value = v; else p.setTargetAtTime(v, now, 0.015); };
  P.tracks.forEach(tr => {
    const s = m.strips[tr.id] || GR.strip(m, tr, !!m.an);
    set(s.in.gain, Math.pow(tr.vol, 2) * 1.25);
    set(s.tone.frequency, fq(ctx, 100 * Math.pow(2, tr.tone * 7.7)));
    set(s.pan.pan, tr.pan);
    set(s.out.gain, tr.mute || (anySolo && !tr.solo) ? 0 : 1);
    set(s.rev.gain, tr.rev * 0.8);
    set(s.dly.gain, tr.echo * 0.7);
  });
  Object.keys(m.strips).forEach(id => { if (!P.tracks.some(t => t.id === id)) GR.dropStrip(m, id); });
  set(m.master.gain, muted ? 0 : Math.pow(P.master, 2) * 1.2);
  set(m.dly.delayTime, Math.min(2.9, 60 / P.bpm * 0.75));
};

/* ---------- sequencing ---------- */
GR.tickDur = P => 60 / P.bpm * 4 / TPB;
GR.swing = (P, tick, td) => (tick % 12 === 6 ? (P.swing / 100) * 3 * td : 0);
GR.buildTickMap = function (P) {
  const map = new Map(), loopT = P.bars * TPB;
  P.tracks.forEach(tr => tr.notes.forEach(n => {
    if (n.t >= loopT) return;
    let a = map.get(n.t); if (!a) map.set(n.t, a = []); a.push([tr, n]);
  }));
  return map;
};
GR.newState = () => ({ mono: {}, choke: {}, voices: [] });
function choke(v, t) {
  if (!v || v._ch) return; v._ch = 1;
  v.gain.setValueAtTime(1, t); v.gain.linearRampToValueAtTime(0, t + 0.014);
}
// schedule one note (with rolls, glide and choke) at time t
GR.playEvent = function (ctx, dest, st, tr, note, t, td) {
  const inst = I[tr.inst]; if (!inst || !dest) return;
  const stepT = TPB / tr.res, roll = note.roll || 1;
  const dur = inst.pitched ? Math.max(note.len || stepT, 1) * td : stepT * td;
  const snd = inst.sounds[tr.sound] || [];
  const autoSlide = snd[2] && snd[2].autoSlide;
  const p = note.p != null ? note.p : (inst.base || 48) + 12;
  for (let r = 0; r < roll; r++) {
    const tt = t + r * stepT * td / roll;
    const vel = Math.max(0.03, Math.min(1, note.vel * (roll > 1 ? 0.6 + 0.4 * (r + 1) / roll : 1)));
    let from = null;
    if (inst.pitched && inst.mono) {
      const prev = st.mono[tr.id];
      if (prev) {
        if ((note.slide && r === 0) || (autoSlide && prev.end > tt + 0.005)) from = prev.p;
        if (prev.end > tt) choke(prev.v, tt);
      }
    }
    if (inst.choke) { (st.choke[inst.choke] || []).forEach(v => choke(v, tt)); }
    const v = ctx.createGain(); v.connect(dest);
    GR.voice(ctx, v, tt, tr, { vel, p, dur: roll > 1 ? dur / roll : dur, from });
    if (inst.pitched && inst.mono) st.mono[tr.id] = { p, end: tt + (roll > 1 ? dur / roll : dur), v };
    if (inst.choke) st.choke[inst.choke] = [v];
    st.voices.push({ v, end: tt + dur + 3 });
  }
};

// render the loop offline. only: a track id for its own waveform (dry, no mix)
GR.render = async function (P, opts) {
  opts = opts || {};
  const sr = opts.sr || 44100, ch = opts.channels || 2, loops = opts.loops || 1, tail = opts.tail == null ? 2.5 : opts.tail;
  const td = GR.tickDur(P), loopT = P.bars * TPB, loopLen = loopT * td * loops;
  const ctx = new OfflineAudioContext(ch, Math.ceil((loopLen + tail) * sr), sr);
  let dest;
  if (opts.only) {
    const g = ctx.createGain(); g.connect(ctx.destination);
    const tr = P.tracks.find(t => t.id === opts.only); g.gain.value = Math.pow(tr.vol, 2) * 1.25;
    dest = () => g;
  } else {
    const m = GR.buildMix(ctx, false); GR.updateMix(m, P, false);
    dest = tr => m.strips[tr.id] && m.strips[tr.id].in;
  }
  const map = GR.buildTickMap(P), st = GR.newState();
  for (let L = 0; L < loops; L++) {
    for (let tick = 0; tick < loopT; tick++) {
      const ev = map.get(tick); if (!ev) continue;
      const t = (L * loopT + tick) * td + GR.swing(P, tick, td);
      ev.forEach(([tr, n]) => { if (!opts.only || tr.id === opts.only) GR.playEvent(ctx, dest(tr), st, tr, n, t, td); });
    }
  }
  const buf = await ctx.startRendering();
  if (opts.fold === false) return buf;
  // fold the tail back onto the start so the file loops without a click or a gap
  const L = Math.round(loopLen * sr), out = new AudioBuffer({ numberOfChannels: ch, length: L, sampleRate: sr });
  for (let c = 0; c < ch; c++) {
    const src = buf.getChannelData(c), dst = out.getChannelData(c);
    dst.set(src.subarray(0, L));
    for (let i = L; i < src.length; i++) dst[i - L] += src[i];
  }
  return out;
};

/* ---------- file encoders ---------- */
GR.wav = function (buf) {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, len * ch * 2, true);
  const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, chans[c][i])); data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([data], { type: 'audio/wav' });
};

GR.midi = function (P) {
  const PPQ = 96, k = PPQ * 4 / TPB;   // our ticks to MIDI ticks
  const vlq = n => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
  const str = s => Array.from(s).map(c => c.charCodeAt(0) & 0x7f);
  const chunk = (id, bytes) => [...str(id), (bytes.length >>> 24) & 255, (bytes.length >>> 16) & 255, (bytes.length >>> 8) & 255, bytes.length & 255, ...bytes];
  const tracks = [];
  const us = Math.round(60000000 / P.bpm);
  tracks.push([0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255, 0, 0xff, 0x58, 4, 4, 2, 24, 8, 0, 0xff, 0x2f, 0]);
  let chan = 0;
  const loopT = P.bars * TPB;
  P.tracks.forEach(tr => {
    const inst = I[tr.inst]; const drum = !inst.pitched && tr.inst !== 'fx';
    const c = drum ? 9 : chan; if (!drum) { chan++; if (chan === 9) chan++; if (chan > 15) chan = 0; }
    const ev = []; const stepT = TPB / tr.res;
    tr.notes.forEach(n => {
      if (n.t >= loopT) return;
      const roll = n.roll || 1;
      for (let r = 0; r < roll; r++) {
        const t0 = Math.round((n.t + r * stepT / roll + (GR.swing(P, n.t, 1) && !r ? GR.swing(P, n.t, 1) : 0)) * k);
        const len = Math.max(1, Math.round((inst.pitched ? (roll > 1 ? stepT / roll : (n.len || stepT)) : stepT / roll) * k) - 1);
        const p = inst.pitched ? Math.max(0, Math.min(127, (n.p != null ? n.p : 60) + (tr.pitch || 0))) : (inst.gm || 60);
        const v = Math.max(1, Math.min(127, Math.round(n.vel * 120)));
        ev.push([t0, 1, 0x90 | c, p, v], [t0 + len, 0, 0x80 | c, p, 0]);
      }
    });
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const name = str(tr.name);
    const bytes = [0, 0xff, 0x03, ...vlq(name.length), ...name];
    let last = 0;
    ev.forEach(e => { bytes.push(...vlq(e[0] - last), e[2], e[3], e[4]); last = e[0]; });
    bytes.push(...vlq(Math.max(0, loopT * k - last)), 0xff, 0x2f, 0);
    tracks.push(bytes);
  });
  const head = chunk('MThd', [0, 1, 0, tracks.length, 0, PPQ]);
  const all = head.concat(...tracks.map(t => chunk('MTrk', t)));
  return new Blob([new Uint8Array(all)], { type: 'audio/midi' });
};
})();
