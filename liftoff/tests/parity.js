// Checks that the plugin's C++ core and dsp.js make the same sound.
//   LiftoffEngineTest --dump core.raw && node liftoff/tests/parity.js core.raw
'use strict';
const fs = require('fs'), path = require('path');
require(path.join(__dirname, '..', 'dsp.js'));
const { Core, rng } = globalThis.Liftoff;

const file = process.argv[2];
if (!file) { console.error('usage: node parity.js <dump from LiftoffEngineTest --dump>'); process.exit(2); }
const buf = fs.readFileSync(file);
const cpp = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

const SR = 48000, bpm = 128, spb = 60 / bpm * SR, block = 256, N = 9 * SR;
const scenarios = [
  {},
  { gapStyle: 1, verbMode: 1, stutter: 1, pitch: 12 },
  { gapStyle: 2, verbMode: 2, curve: -0.5, width: 1 },
  { gapStyle: 3, gap: 4, impact: 1, noise: 1, output: -6, mix: 0.7 }
];
const names = ['cut, drop swell', 'tape, build swells, stutter, octave', 'filter, swells always, early curve, wide', 'stutter gap, impact, noise, -6 dB, 70% mix'];
let off = 0, failed = 0;
console.log('C++ core vs dsp.js');
scenarios.forEach((sc, s) => {
  const c = new Core(SR); c.setParams({ phrase: 0, length: 2, ...sc }); c.snapSmoothing();
  const r = rng(1234);
  const inL = new Float32Array(block), inR = new Float32Array(block), o = [0, 1, 2, 3].map(() => new Float32Array(block));
  let maxErr = 0, maxAbs = 0;
  for (let i = 0; i < N; i += block) {
    for (let j = 0; j < block; j++) {
      const k = i + j, v = r(), click = k % Math.round(spb) === 0 ? 0.5 : 0;
      inL[j] = 0.3 * Math.sin(6.283185307179586 * 220 * k / SR) + 0.05 * v + click;
      inR[j] = 0.3 * Math.sin(6.283185307179586 * 330 * k / SR) - 0.05 * v;
    }
    c.process(inL, inR, o[0], o[1], o[2], o[3], block, { playing: true, ppq: i * bpm / 60 / SR, bpm, bpb: 4 });
    for (let j = 0; j < block; j++) for (let q = 0; q < 4; q++) {
      const a = o[q][j], b = cpp[off++];
      maxErr = Math.max(maxErr, Math.abs(a - b)); maxAbs = Math.max(maxAbs, Math.abs(a));
    }
  }
  const ok = maxErr < 1e-4;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${names[s]}: max difference ${maxErr.toExponential(2)} (peak ${maxAbs.toFixed(2)})`);
});
if (off !== cpp.length) { console.log(`  FAIL dump has ${cpp.length} values, expected ${off}`); failed++; }
process.exit(failed ? 1 : 0);
