// Checks the sample-to-transition renderer (transition.js): node liftoff/tests/transition-test.js
'use strict';
const path = require('path');
require(path.join(__dirname, '..', 'dsp.js'));
require(path.join(__dirname, '..', 'transition.js'));
const LF = globalThis.Liftoff;

let failed = 0, passed = 0;
const check = (name, ok, detail) => { if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } };
const rms = (a, s, e) => { let t = 0; s = Math.max(0, Math.floor(s)); e = Math.floor(e); for (let i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / Math.max(1, e - s)); };
const db = x => 20 * Math.log10(Math.max(1e-12, x));
const SR = 48000, BPM = 120, SPB = 60 / BPM * SR;
const DEF = {}; for (const k in LF.DEFAULTS) DEF[k] = LF.DEFAULTS[k];
const OFF = { ...DEF, rise: 0, verb: 0, drop: 0, impact: 0, mix: 1, output: 0, length: 2 };   // a 2 bar build
const loop = (sec, f) => { const n = Math.round(sec * SR), a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { a[i] = 0.4 * Math.sin(2 * Math.PI * f * i / SR) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 2 * i / SR)); b[i] = a[i] * 0.9; } return { chans: [a, b], sr: SR }; };

(async () => {
  console.log('Liftoff transitions');

  { // the FFT convolution matches a direct one
    const r = LF.rng(3), x = new Float32Array(3000).map(() => r()), h = new Float32Array(700).map(() => r());
    const y = LF.convolve(x, h); let err = 0;
    for (let n = 0; n < x.length; n += 7) { let s = 0; for (let k = 0; k < h.length && k <= n; k++) s += h[k] * x[n - k]; err = Math.max(err, Math.abs(s - y[n])); }
    check('FFT convolution equals direct convolution', err < 1e-3, `max error ${err}`);
  }

  { // with every module off the transition is the sample: looped through the build, from the top on the drop
    const s = loop(1.3, 330), t = await LF.renderTransition(s, OFF, { bpm: BPM, after: 0, async: false });
    const buildN = Math.round(8 * SPB);
    check('length: build + after + tail', t.N === buildN + Math.round(4 * SPB) + Math.round(1.5 * SR) && t.dropAt === buildN, `${t.N}`);
    let err = 0;
    for (let i = 200; i < s.chans[0].length - 300; i++) err = Math.max(err, Math.abs(t.L[buildN + i] - s.chans[0][i]));
    check('on the drop the sample starts again from its top, untouched', err < 1e-5, `max error ${err}`);
    err = 0;
    for (let i = 300; i < s.chans[0].length - 300; i++) err = Math.max(err, Math.abs(t.L[s.chans[0].length + i] - s.chans[0][i]));
    check('the build loops it', err < 1e-5 && !t.oneShot, `max error ${err}`);
  }

  { // the gap cuts the last beat before the drop
    const t = await LF.renderTransition(loop(2, 220), { ...OFF, drop: 1, gap: 3, gapStyle: 0 }, { bpm: BPM, after: 0, async: false });
    const g = rms(t.L, t.gapStart + 0.01 * SR, t.dropAt - 10), before = rms(t.L, t.gapStart - SPB, t.gapStart - 10), after = rms(t.L, t.dropAt + 10, t.dropAt + SPB);
    check('gap: silence on the last beat, full level either side', db(g) < -60 && db(before) > -15 && db(after) > -15,
      `${db(before).toFixed(1)} / ${db(g).toFixed(1)} / ${db(after).toFixed(1)} dB`);
  }

  { // the reverse swell rises out of the gap into the drop
    const P = { ...OFF, drop: 1, gap: 3, verb: 1, verbMode: 0, verbLen: 2, verbMix: 1 };
    const t = await LF.renderTransition(loop(2, 220), P, { bpm: BPM, after: 0, async: false });
    const dry = await LF.renderTransition(loop(2, 220), { ...P, verb: 0 }, { bpm: BPM, after: 0, async: false });
    const sw = t.L.map((v, i) => v - dry.L[i]);   // the swell on its own
    const L = Math.round(2 * SPB), early = rms(sw, t.dropAt - L, t.dropAt - L * 7 / 8), late = rms(sw, t.dropAt - SPB / 4, t.dropAt - 10);
    check('backverb: the swell grows into the drop', t.verbStart === t.dropAt - L && db(late) - db(early) > 15 && db(late) > -40,
      `${db(early).toFixed(1)} → ${db(late).toFixed(1)} dB`);
  }

  { // a one-shot becomes a roll: 1/4 → 1/8 → 1/16 → 1/32 notes over the build
    const n = Math.round(0.08 * SR), a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = Math.exp(-i / (0.01 * SR)) * Math.sin(i * 0.3);
    const t = await LF.renderTransition({ chans: [a], sr: SR }, OFF, { bpm: BPM, after: 0, async: false });
    let hits = 0, lastLoud = -1e9;
    for (let i = 0; i < t.dropAt; i++) if (Math.abs(t.dryL[i]) > 0.1) { if (i - lastLoud > 300) hits++; lastLoud = i; }
    check('one-shot: retriggered as a roll (2 + 4 + 8 + 16 hits over 2 bars)', t.oneShot && hits === 30, `${hits} hits`);
  }

  { // the full effect on a long loop: finite, bounded, fast enough
    const t0 = Date.now(), t = await LF.renderTransition(loop(4, 110), { ...DEF, length: 3 }, { bpm: 124, after: 1 });
    let bad = false, peak = 0; for (let i = 0; i < t.N; i++) { const v = t.L[i]; if (!Number.isFinite(v)) bad = true; peak = Math.max(peak, Math.abs(v)); }
    const ms = Date.now() - t0;
    check('full effect, 4 bar build + 2 bars: finite and bounded', !bad && peak < 4 && peak > 0.1, `peak ${peak.toFixed(2)}`);
    check('renders in under 5 s', ms < 5000, `${ms} ms`);
  }

  { // recordings are trimmed to the sound
    const a = new Float32Array(SR); for (let i = 12000; i < 30000; i++) a[i] = 0.5 * Math.sin(i * 0.05);
    const [b] = LF.trimSilence([a], SR);
    check('recordings are trimmed to the sound', b.length < 22000 && b.length > 18000 && Math.abs(b[Math.round(0.005 * SR) + 50]) > 0, `${b.length} samples`);
  }

  { // a render can be cancelled
    const signal = { cancelled: false }, p = LF.renderTransition(loop(2, 220), { ...DEF, length: 4 }, { bpm: 120, signal });
    signal.cancelled = true;
    check('a render can be cancelled', (await p) === null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
