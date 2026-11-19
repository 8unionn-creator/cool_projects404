/* Liftoff transitions: a sample in, a finished transition out.
   The sample fills the build (looped, or for a one-shot, retriggered faster and faster: 1/4 up to 1/32 notes),
   the Liftoff core (dsp.js) turns it into the riser, cuts the gap and hits the drop, and the backverb is an FFT
   convolution with the reversed reverb. On the drop the sample plays again from its start, dry, for the AFTER bars.
   The same code renders in the browser, in the plugin's window and in node (tests/transition-test.js). */
function LiftoffTransition(G) {
  'use strict';
  const LF = G.Liftoff;
  const AFTER_BARS = [1, 2, 4];

  // in-place radix-2 FFT
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // y = x * h (overlap-add), the first x.length samples
  function convolve(x, h) {
    const M = h.length, N = x.length, y = new Float32Array(N);
    let B = 1; while (B < M) B <<= 1;
    const F = B * 2;
    const Hr = new Float64Array(F), Hi = new Float64Array(F);
    for (let i = 0; i < M; i++) Hr[i] = h[i];
    fft(Hr, Hi, false);
    const re = new Float64Array(F), im = new Float64Array(F);
    for (let start = 0; start < N; start += B) {
      re.fill(0); im.fill(0);
      let any = false;
      for (let i = 0; i < B && start + i < N; i++) { re[i] = x[start + i]; if (re[i] !== 0) any = true; }
      if (!any) continue;
      fft(re, im, false);
      for (let i = 0; i < F; i++) { const r = re[i] * Hr[i] - im[i] * Hi[i]; im[i] = re[i] * Hi[i] + im[i] * Hr[i]; re[i] = r; }
      fft(re, im, true);
      for (let i = 0; i < F && start + i < N; i++) y[start + i] += re[i];
    }
    return y;
  }

  // recordings start and end on the sound
  function trimSilence(chans, sr) {
    const n = chans[0].length, peak = i => { let m = 0; for (const c of chans) m = Math.max(m, Math.abs(c[i])); return m; };
    let a = 0, b = n - 1;
    while (a < n && peak(a) < 0.0056) a++;          // -45 dB
    while (b > a && peak(b) < 0.001) b--;           // -60 dB
    if (a >= b) return chans;
    a = Math.max(0, a - Math.round(sr * 0.005)); b = Math.min(n, b + Math.round(sr * 0.05));
    return chans.map(c => c.slice(a, b));
  }

  const tick = () => new Promise(r => setTimeout(r, 0));

  /* sample: { chans: [Float32Array, Float32Array?], sr }   P: the Liftoff parameters
     o: { bpm, bpb, after (index into AFTER_BARS), signal: { cancelled } }  */
  async function renderTransition(sample, P, o) {
    const sr = sample.sr, bpm = o.bpm || 120, bpb = o.bpb || 4, spb = 60 / bpm * sr;
    const srcL = sample.chans[0], srcR = sample.chans[1] || sample.chans[0], len = srcL.length;
    const buildB = LF.LENGTH_BARS[P.length] * bpb, buildN = Math.round(buildB * spb);
    const afterN = Math.round(AFTER_BARS[o.after || 0] * bpb * spb), tailN = Math.round(sr * 1.5);
    const L = P.verb ? Math.round(LF.VERB_BEATS[P.verbLen] * spb) : 0;
    const N = buildN + afterN + tailN, NL = N + L;
    const oneShot = len < spb;
    const xL = new Float32Array(NL), xR = new Float32Array(NL);
    const fadeN = Math.max(1, Math.round(sr * 0.004));

    // put the sample down: the build, then the drop
    const place = (at, maxLen, gain, fadeIn) => {
      const n = Math.min(maxLen, len, NL - at);
      for (let i = 0; i < n; i++) {
        let w = gain;
        if (fadeIn && i < fadeN) w *= i / fadeN;
        if (n < len && i > n - fadeN) w *= (n - i) / fadeN;
        xL[at + i] += srcL[i] * w; xR[at + i] += srcR[i] * w;
      }
    };
    if (oneShot) {
      for (let t = 0; t < buildN;) {
        const raw = t / buildN, steps = [1, 2, 4, 8][Math.min(3, Math.floor(raw * 4))], step = Math.round(spb / steps);
        place(t, Math.min(step, buildN - t), 0.55 + 0.45 * raw, false);
        t += step;
      }
      place(buildN, afterN, 1, false);
    } else {
      for (let t = 0; t < buildN; t += len) place(t, buildN - t, 1, t > 0);
      for (let t = buildN; t < buildN + afterN; t += len) place(t, buildN + afterN - t, 1, t > buildN);
      const fo = Math.round(sr * 0.03), e = buildN + afterN;
      for (let i = 0; i < fo; i++) { const w = i / fo; xL[e - 1 - i] *= w; xR[e - 1 - i] *= w; }
    }

    // the Liftoff core, triggered at the start: the build lasts BUILD LENGTH and drops at buildN
    const core = new LF.Core(sr);
    core.setParams({ ...P, mode: LF.MODE.TRIGGER });
    core.snapSmoothing();
    core.trigger();
    const yL = new Float32Array(NL), yR = new Float32Array(NL), sL = new Float32Array(NL), sR = new Float32Array(NL);
    const BLOCK = 1024, slice = Math.round(sr * 0.4);
    for (let i = 0, since = 0; i < NL; i += BLOCK) {
      const n = Math.min(BLOCK, NL - i);
      core.process(xL.subarray(i, i + n), xR.subarray(i, i + n), yL.subarray(i, i + n), yR.subarray(i, i + n),
                   sL.subarray(i, i + n), sR.subarray(i, i + n), n, { playing: true, ppq: i / spb, bpm, bpb });
      if ((since += n) >= slice) { since = 0; if (o.signal && o.signal.cancelled) return null; if (o.async !== false) await tick(); }
    }

    // the backverb: the send convolved with the reversed reverb lands one length L later, so pull it back by L
    const outL = yL.slice(0, N), outR = yR.slice(0, N);
    if (L > 0) {
      const ir = LF.makeReverseIR(sr, L, P.verbSize, P.verbTone);
      const cL = convolve(sL, ir[0]); if (o.signal && o.signal.cancelled) return null; if (o.async !== false) await tick();
      const cR = convolve(sR, ir[1]);
      for (let m = 0; m < N; m++) { outL[m] += cL[m + L]; outR[m] += cR[m + L]; }
    }
    const fo = Math.round(sr * 0.3);
    for (let i = 0; i < fo; i++) { const w = i / fo; outL[N - 1 - i] *= w; outR[N - 1 - i] *= w; }

    const gapB = P.drop ? Math.min(LF.GAP_BEATS[P.gap], buildB) : 0;
    return {
      L: outL, R: outR, dryL: xL.subarray(0, N), dryR: xR.subarray(0, N), sr, N, spb, bpm, bpb, oneShot,
      buildN, afterN, dropAt: buildN, gapStart: Math.round(buildN - gapB * spb),
      verbStart: P.verb && P.verbMode === LF.VERB_MODE.DROP ? buildN - L : -1,
      buildBars: buildB / bpb, afterBars: AFTER_BARS[o.after || 0]
    };
  }

  // min/max of a channel per column, for drawing
  function peaks(a, b, from, to, cols) {
    const out = new Float32Array(cols * 2), span = (to - from) / cols;
    for (let c = 0; c < cols; c++) {
      const s = Math.floor(from + c * span), e = Math.max(s + 1, Math.floor(from + (c + 1) * span));
      let mn = 0, mx = 0;
      for (let i = s; i < e && i < a.length; i++) { const v = b ? (a[i] + b[i]) * 0.5 : a[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      out[c * 2] = mn; out[c * 2 + 1] = mx;
    }
    return out;
  }

  // 24-bit stereo WAV
  function wav24(chans, sr) {
    const n = chans[0].length, ch = chans.length, bytes = n * ch * 3;
    const buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * ch * 3, true); v.setUint16(32, ch * 3, true); v.setUint16(34, 24, true); str(36, 'data'); v.setUint32(40, bytes, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
      const s = Math.round(Math.max(-1, Math.min(1, chans[c][i])) * 8388607);
      v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3;
    }
    return buf;
  }

  Object.assign(LF, { renderTransition, convolve, fft, trimSilence, peaks, wav24, AFTER_BARS });
}
LiftoffTransition(typeof globalThis !== 'undefined' ? globalThis : this);
