// Checks the Liftoff DSP core (dsp.js): node liftoff/tests/core-test.js
'use strict';
const path = require('path');
require(path.join(__dirname, '..', 'dsp.js'));
const { Core, makeReverseIR, MODE, VERB_MODE, GAP_STYLE } = globalThis.Liftoff;

const SR = 48000, BLOCK = 256;
let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const OFF = { rise: 0, verb: 0, drop: 0, trem: 0, chorus: 0, mix: 1, output: 0 };

// runs the core over an input, as a host would, and returns everything it produced
function run(params, seconds, input, opts = {}) {
  const c = new Core(SR); c.setParams(params); c.snapSmoothing();
  const N = Math.round(seconds * SR), bpm = opts.bpm || 120, bpb = opts.bpb || 4;
  const out = { L: new Float32Array(N), R: new Float32Array(N), sL: new Float32Array(N), sR: new Float32Array(N), drops: [], core: c };
  const inL = new Float32Array(BLOCK), inR = new Float32Array(BLOCK);
  let drops = 0;
  for (let i = 0; i < N; i += BLOCK) {
    const n = Math.min(BLOCK, N - i);
    for (let j = 0; j < n; j++) { const v = input(i + j); inL[j] = Array.isArray(v) ? v[0] : v; inR[j] = Array.isArray(v) ? v[1] : v; }
    if (opts.onBlock) opts.onBlock(c, i);
    const tp = { playing: opts.playing !== false, ppq: (opts.startBeat || 0) + i * bpm / 60 / SR, bpm, bpb };
    c.process(inL, inR, out.L.subarray(i, i + n), out.R.subarray(i, i + n), out.sL.subarray(i, i + n), out.sR.subarray(i, i + n), n, tp);
    if (c.drops !== drops) { out.drops.push(i); drops = c.drops; }
  }
  return out;
}
const sine = f => i => 0.5 * Math.sin(2 * Math.PI * f * i / SR);
const rms = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / Math.max(1, e - s)); };
const db = x => 20 * Math.log10(Math.max(1e-12, x));
function freq(a, s, e) {   // zero-crossing frequency estimate
  let z = 0; for (let i = s + 1; i < e; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) z++;
  return z / 2 / ((e - s) / SR);
}
const beat = b => Math.round(b * 60 / 120 * SR);   // at 120 BPM

console.log('Liftoff core');

{ // with every module off the plugin is a wire
  const o = run(OFF, 1, sine(330));
  let maxErr = 0; for (let i = 0; i < o.L.length; i++) maxErr = Math.max(maxErr, Math.abs(o.L[i] - sine(330)(i)));
  check('everything off passes audio through untouched', maxErr < 1e-6, `max error ${maxErr}`);
}

{ // AUTO: phrase of 4 bars, 1 bar build: drops on beats 16 and 32
  const o = run({ ...OFF, mode: MODE.AUTO, phrase: 0, length: 1, rise: 1, drop: 1, gap: 3 }, 17, sine(220));
  const want = [beat(16), beat(32)];
  check('AUTO drops on every phrase downbeat', o.drops.length === 2 && o.drops.every((d, k) => Math.abs(d - want[k]) < BLOCK),
    `drops at ${o.drops.join(', ')}, want ${want.join(', ')}`);
}

{ // a build that starts mid-song still drops where the phrase ends
  const o = run({ ...OFF, mode: MODE.AUTO, phrase: 1, length: 2, rise: 1 }, 9, sine(220), { startBeat: 26 });
  check('AUTO from the middle of the song drops at the next phrase', o.drops.length === 1 && Math.abs(o.drops[0] - beat(32 - 26)) < BLOCK, `drops at ${o.drops}`);
}

{ // gap: CUT silences the last beat before the drop, the drop comes back at full level
  const o = run({ ...OFF, mode: MODE.AUTO, phrase: 0, length: 1, drop: 1, gap: 3, gapStyle: GAP_STYLE.CUT, impact: 0 }, 9, sine(440));
  const g = rms(o.L, beat(15) + 480, beat(16) - 10), after = rms(o.L, beat(16) + 10, beat(16.5)), before = rms(o.L, beat(14), beat(15) - 10);
  check('CUT: silence in the gap', db(g) < -60, `${db(g).toFixed(1)} dB`);
  check('CUT: full level before the gap and on the drop', Math.abs(db(before) - db(after)) < 0.5 && Math.abs(db(after) - db(0.5 / Math.SQRT2)) < 0.5,
    `before ${db(before).toFixed(1)} dB, after ${db(after).toFixed(1)} dB`);
}

{ // TAPE: the pitch falls through the gap
  const o = run({ ...OFF, mode: MODE.AUTO, phrase: 0, length: 1, drop: 1, gap: 4, gapStyle: GAP_STYLE.TAPE, impact: 0 }, 9, sine(880));
  const s = beat(14), q = beat(0.5);
  const f1 = freq(o.L, s, s + q), f2 = freq(o.L, s + 2 * q, s + 3 * q);
  check('TAPE: slows down like a tape stop', f1 > 600 && f2 < f1 * 0.7, `${f1.toFixed(0)} Hz then ${f2.toFixed(0)} Hz`);
}

{ // STUTTER in the gap repeats the first 1/16 of it
  const saw = i => ((i % 997) / 997) - 0.5;
  const o = run({ ...OFF, mode: MODE.AUTO, phrase: 0, length: 1, drop: 1, gap: 3, gapStyle: GAP_STYLE.STUTTER, impact: 0 }, 9, saw);
  const s = beat(15), sl = beat(0.25);
  let err = 0; for (let i = 200; i < sl - 200; i++) err = Math.max(err, Math.abs(o.L[s + i] - o.L[s + 2 * sl + i]));
  check('STUTTER: the gap repeats its first slice', err < 1e-4, `max difference ${err}`);
}

{ // FILTER: the gap dives into a low-pass
  const o = run({ ...OFF, mode: MODE.AUTO, phrase: 0, length: 1, drop: 1, gap: 4, gapStyle: GAP_STYLE.FILTER, impact: 0 }, 9, sine(3000));
  const early = rms(o.L, beat(14), beat(14.3)), late = rms(o.L, beat(15.6), beat(16) - 10);
  check('FILTER: high end fades out through the gap', db(late) < db(early) - 30, `${db(early).toFixed(1)} → ${db(late).toFixed(1)} dB`);
}

{ // pitch rise: +12 at the top of the build doubles the frequency
  const o = run({ ...OFF, mode: MODE.MANUAL, build: 1, rise: 1, pitch: 12, filter: 0, wash: 0, stutter: 0, noise: 0, width: 0 }, 1, sine(440));
  const f = freq(o.L, SR / 2, SR);
  check('RISE pitch: +12 semitones is an octave up', Math.abs(f / 880 - 1) < 0.03, `${f.toFixed(1)} Hz`);
}

{ // the shifter splices where the waveform matches: a shifted tone keeps a steady level (no 20-60 Hz flutter)
  const tone = i => { let v = 0; for (let h = 1; h <= 10; h++) v += Math.sin(2 * Math.PI * 220 * h * i / SR) / h; return 0.3 * v; };
  const worst = [5, 12, 24].map(st => {
    const o = run({ ...OFF, mode: MODE.MANUAL, build: 1, rise: 1, pitch: st, filter: 0, wash: 0, stutter: 0, noise: 0, width: 0 }, 2, tone);
    const F = 960, v = []; for (let s = SR / 2; s + F <= o.L.length; s += F) v.push(rms(o.L, s, s + F));
    const mean = v.reduce((a, b) => a + b) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) / mean;
  });
  check('RISE pitch: a shifted tone stays steady (+5, +12, +24)', Math.max(...worst) < 0.04, worst.map(w => (w * 100).toFixed(1) + '%').join(', '));
}

{ // the high-pass sweep thins the low end out
  const o = run({ ...OFF, mode: MODE.MANUAL, build: 1, rise: 1, pitch: 0, filter: 1, wash: 0, stutter: 0, noise: 0, width: 0 }, 1, sine(150));
  check('RISE filter: 150 Hz is gone at the top of the build', db(rms(o.L, SR / 2, SR)) < db(0.35) - 30, `${db(rms(o.L, SR / 2, SR)).toFixed(1)} dB`);
}

{ // the stutter gate chops on the beat grid at the top of the build (1/32 notes)
  const o = run({ ...OFF, mode: MODE.MANUAL, build: 1, rise: 1, pitch: 0, filter: 0, wash: 0, stutter: 1, noise: 0, width: 0 }, 2, () => 0.5);
  const step = beat(1 / 8);
  const on = rms(o.L, step * 8 + 40, step * 8 + step / 2 - 40), off = rms(o.L, step * 8 + step / 2 + 120, step * 9 - 10);
  check('RISE stutter: 1/32 gate at full build', db(on) > -7 && db(off) < -30, `on ${db(on).toFixed(1)} dB, off ${db(off).toFixed(1)} dB`);
}

{ // the noise riser gets louder and brighter
  const o = run({ ...OFF, mode: MODE.AUTO, phrase: 0, length: 3, rise: 1, pitch: 0, filter: 0, wash: 0, stutter: 0, noise: 1, width: 0 }, 8, () => 0);
  const a = rms(o.L, beat(4), beat(6)), b = rms(o.L, beat(12), beat(14));
  check('RISE noise: rises through the build', db(b) > db(a) + 12 && db(b) < -3, `${db(a).toFixed(1)} → ${db(b).toFixed(1)} dB`);
}

{ // the impact lands on the drop
  const o = run({ ...OFF, mode: MODE.AUTO, phrase: 0, length: 1, drop: 1, gap: 0, impact: 1 }, 9, () => 0);
  const pre = rms(o.L, beat(15), beat(16) - 1), post = rms(o.L, beat(16), beat(16.5));
  check('DROP impact: a boom on the downbeat', db(pre) < -100 && db(post) > -12, `before ${db(pre).toFixed(1)} dB, after ${db(post).toFixed(1)} dB`);
}

{ // backverb DROP: only the drop's first 1/8 note is sent to the reverse reverb
  const o = run({ ...OFF, mode: MODE.AUTO, phrase: 0, length: 1, verb: 1, verbMode: VERB_MODE.DROP, verbMix: 1 }, 9, sine(500));
  const before = rms(o.sL, 0, beat(16) - 1), inWin = rms(o.sL, beat(16), beat(16.25)), after = rms(o.sL, beat(16.5) + 1, beat(17));
  check('BACKVERB drop: sends only the drop hit', before === 0 && after === 0 && inWin > 0.3, `before ${before}, window ${inWin.toFixed(3)}, after ${after}`);
}

{ // the reverse IR swells up to its last sample and has unit energy
  const N = 48000, [h] = makeReverseIR(SR, N, 0.5, 0.6);
  let e = 0; for (const v of h) e += v * v;
  const first = rms(h, 0, N / 10), last = rms(h, N * 0.9, N);
  check('reverse IR: unit energy', Math.abs(e - 1) < 1e-3, `energy ${e}`);
  check('reverse IR: swells by ~36 dB toward the hit', db(last) - db(first) > 25, `${(db(last) - db(first)).toFixed(1)} dB`);
  const [a] = makeReverseIR(SR, 4800, 0.3, 0.2), [b] = makeReverseIR(SR, 4800, 0.3, 0.2);
  check('reverse IR: the same every time (seeded)', a.every((v, i) => v === b[i]));
}

{ // LAUNCH waits for the next bar line, then drops LENGTH later
  const o = run({ ...OFF, mode: MODE.TRIGGER, length: 1, rise: 1 }, 7, sine(220), { onBlock: (c, i) => { if (i === beat(1.5) - (beat(1.5) % BLOCK)) c.launch(); } });
  check('LAUNCH: starts on the next bar and drops a bar later', o.drops.length === 1 && Math.abs(o.drops[0] - beat(8)) < BLOCK, `drops at ${o.drops}`);
}

{ // MANUAL: ride BUILD up, hold it, pull it down = drop
  const o = run({ ...OFF, mode: MODE.MANUAL, rise: 1, drop: 1, gap: 2 }, 3, sine(220), { onBlock: (c, i) => c.setParam('build', i < SR ? i / SR : i < 2 * SR ? 1 : 0) });
  check('MANUAL: pulling BUILD down drops', o.drops.length === 1 && o.drops[0] > 2 * SR && o.drops[0] < 2.1 * SR, `drops at ${o.drops}`);
}


{ // tremolo: a square 1/8 at full depth chops a steady tone on the beat grid
  const o = run({ ...OFF, trem: 1, tremRate: 1, tremDepth: 1, tremShape: 1 }, 2, () => 0.5);
  const e = beat(1 / 2);
  const on = rms(o.L, e * 2 + 100, e * 2 + e / 2 - 100), off = rms(o.L, e * 2 + e / 2 + 150, e * 3 - 10);
  check('TREMOLO square 1/8: on, then off, on the grid', db(on) > -7 && db(off) < -30, `on ${db(on).toFixed(1)} dB, off ${db(off).toFixed(1)} dB`);
  const p2 = run({ ...OFF, trem: 1, tremRate: 1, tremDepth: 1, tremShape: 3 }, 1, () => 0.5);
  const i = beat(1 / 4) + 7;   // a quarter of the way through an 1/8: L down, R up
  check('TREMOLO pan: left and right move in opposite directions', Math.abs(p2.L[i] + p2.R[i] - 0.5) < 0.02 && Math.abs(p2.L[i] - p2.R[i]) > 0.2, `L ${p2.L[i].toFixed(3)} R ${p2.R[i].toFixed(3)}`);
}

{ // chorus: thickens the sound without changing its level, and stays finite
  const o = run({ ...OFF, chorus: 1, chorusRate: 1.5, chorusDepth: 1, chorusMix: 0.6 }, 2, sine(440));
  const dry = run(OFF, 2, sine(440));
  let diff = 0; for (let i = SR; i < 2 * SR; i++) diff = Math.max(diff, Math.abs(o.L[i] - dry.L[i]));
  const lv = db(rms(o.L, SR, 2 * SR)) - db(rms(dry.L, SR, 2 * SR));
  check('CHORUS: changes the sound, keeps the level (±4 dB)', diff > 0.05 && Math.abs(lv) < 4, `max change ${diff.toFixed(3)}, level ${lv.toFixed(1)} dB`);
}

{ // stress: random settings never blow up
  let worst = 0, bad = false;
  const r = globalThis.Liftoff.rng(7);
  for (let k = 0; k < 12; k++) {
    const P = { mode: k % 3, phrase: k % 4, length: k % 5, build: (r() + 1) / 2, curve: r(), rise: 1, pitch: 24 * (r() + 1) / 2, filter: (r() + 1) / 2,
      wash: 1, stutter: (r() + 1) / 2, noise: 1, width: 1, verb: 1, verbMode: k % 3, verbLen: k % 4, verbMix: 1, drop: 1, gap: k % 5, gapStyle: k % 4, impact: 1,
      trem: 1, tremRate: k % 6, tremDepth: 1, tremShape: k % 4, chorus: 1, chorusRate: 5, chorusDepth: 1, chorusMix: 1, mix: 1, output: 0 };
    const o = run(P, 9, i => [r() * 0.5, r() * 0.5], { onBlock: (c, i) => { if (k % 3 === 2 && i % beat(16) < BLOCK) c.trigger(); } });
    for (let i = 0; i < o.L.length; i++) { const v = o.L[i]; if (!Number.isFinite(v)) bad = true; worst = Math.max(worst, Math.abs(v)); }
  }
  check('random settings stay finite and bounded', !bad && worst < 8, `peak ${worst.toFixed(2)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
