/* Liftoff risers: a sample in (the part you cut), a finished riser out.
   The sample fills the build (looped, or for a one-shot, retriggered faster and faster: 1/4 up to 1/32 notes),
   the Liftoff core (dsp.js) turns it into the riser with chorus and tremolo, and the backverb is an FFT convolution
   with the reversed reverb. The riser ends where your drop goes; the effects ring on for a short tail.
   The same code renders in the browser, in the plugin's window and in node (tests/transition-test.js). */
function LiftoffTransition(G) {
  'use strict';
  const LF = G.Liftoff;

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

  /* sample: { chans: [Float32Array, Float32Array?], sr } (already cut to the part to use)   P: the Liftoff parameters
     o: { bpm, bpb, signal: { cancelled }, async, reverse, normalize }
     The riser lasts BUILD LENGTH and ends at `endAt`, where your drop goes; the effects ring on for a tail after it. */
  async function renderTransition(sample, P, o) {
    const sr = sample.sr, bpm = o.bpm || 120, bpb = o.bpb || 4, spb = 60 / bpm * sr;
    const srcL = sample.chans[0], srcR = sample.chans[1] || sample.chans[0], len = srcL.length;
    const buildB = LF.LENGTH_BARS[P.length] * bpb, buildN = Math.round(buildB * spb), tailN = Math.round(sr * 1.5);
    const L = P.verb ? Math.round(LF.VERB_BEATS[P.verbLen] * spb) : 0;
    const N = buildN + tailN, NL = N + L;
    const oneShot = len < spb;
    const xL = new Float32Array(NL), xR = new Float32Array(NL);
    const fadeN = Math.max(1, Math.round(sr * 0.004));

    // put the sample down over the build
    const place = (at, maxLen, gain, fadeIn) => {
      const n = Math.min(maxLen, len, NL - at);
      for (let i = 0; i < n; i++) {
        let w = gain;
        if (fadeIn && i < fadeN) w *= i / fadeN;
        if (i > n - fadeN) w *= (n - i) / fadeN;
        xL[at + i] += srcL[i] * w; xR[at + i] += srcR[i] * w;
      }
    };
    if (oneShot) {
      for (let t = 0; t < buildN;) {
        const raw = t / buildN, steps = [1, 2, 4, 8][Math.min(3, Math.floor(raw * 4))], step = Math.round(spb / steps);
        place(t, Math.min(step, buildN - t), 0.55 + 0.45 * raw, false);
        t += step;
      }
    } else {
      for (let t = 0; t < buildN; t += len) place(t, buildN - t, 1, t > 0);
    }

    // the Liftoff core, triggered at the start: the build lasts BUILD LENGTH
    const core = new LF.Core(sr);
    core.setParams({ ...P, mode: LF.MODE.TRIGGER, drop: 0 });
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
    const endSwell = P.verb && P.verbMode === LF.VERB_MODE.DROP;
    if (L > 0) {
      const ir = LF.makeReverseIR(sr, L, P.verbSize, P.verbTone);
      const cL = convolve(sL, ir[0]); if (o.signal && o.signal.cancelled) return null; if (o.async !== false) await tick();
      const cR = convolve(sR, ir[1]);
      for (let m = 0; m < N; m++) { outL[m] += cL[m + L]; outR[m] += cR[m + L]; }
      // END: the sample's first 1/8 note, as if it hit right at the end, swells up to it and stops there
      if (endSwell) {
        const win = Math.round(0.5 * spb), g = P.verbMix * 1.5 * P.mix * Math.pow(10, P.output / 20);
        const hL = new Float32Array(2 * L + win), hR = new Float32Array(2 * L + win);   // the swell of a hit at L peaks at 2L
        for (let i = 0; i < win && i < len; i++) {
          const w = g * (i < 0.6 * win ? 1 : 0.5 * (1 + Math.cos(Math.PI * (i - 0.6 * win) / (0.4 * win))));
          hL[L + i] = srcL[i] * w; hR[L + i] = srcR[i] * w;
        }
        const eL = convolve(hL, ir[0]), eR = convolve(hR, ir[1]), fade = Math.round(sr * 0.004);
        // eL[L + k] is the swell k samples after the hit's time; the hit sits at the end of the build
        for (let k = -L; k < fade; k++) {
          const m = buildN + k; if (m < 0 || m >= N) continue;
          const w = k < 0 ? 1 : 1 - k / fade;
          outL[m] += eL[2 * L + k] * w; outR[m] += eR[2 * L + k] * w;
        }
      }
    }
    const fo = Math.round(sr * 0.3);
    for (let i = 0; i < fo; i++) { const w = i / fo; outL[N - 1 - i] *= w; outR[N - 1 - i] *= w; }

    let r = {
      L: outL, R: outR, dryL: xL.subarray(0, N), dryR: xR.subarray(0, N), sr, N, spb, bpm, bpb, oneShot,
      buildN, endAt: buildN, verbStart: endSwell ? buildN - L : -1, buildBars: buildB / bpb, reversed: false, gain: 1
    };
    if (o.reverse) r = reverseRender(r);
    if (o.normalize) {   // the loudest peak at -1 dBFS
      let pk = 0; for (let i = 0; i < r.N; i++) pk = Math.max(pk, Math.abs(r.L[i]), Math.abs(r.R[i]));
      if (pk > 1e-6) { const g = 0.8913 / pk; for (let i = 0; i < r.N; i++) { r.L[i] *= g; r.R[i] *= g; } r.gain = g; }
    }
    return r;
  }

  /* REVERSE: the whole thing backwards, a downlifter. The tail turns into a one-beat swell into the drop (END),
     then the riser falls away from it for BUILD LENGTH. The clip starts on a beat, one beat before the drop. */
  function reverseRender(r) {
    const lead = Math.min(Math.round(r.spb), r.N - r.buildN), start = r.N - r.buildN - lead, n = lead + r.buildN;
    const rev = a => { const b = new Float32Array(n); for (let i = 0; i < n; i++) b[i] = a[r.N - 1 - (start + i)]; return b; };
    const L = rev(r.L), R = rev(r.R), fi = Math.round(r.sr * 0.01), fo = Math.round(r.sr * 0.005);
    for (let i = 0; i < fi; i++) { const w = i / fi; L[i] *= w; R[i] *= w; }
    for (let i = 0; i < fo; i++) { const w = i / fo; L[n - 1 - i] *= w; R[n - 1 - i] *= w; }
    return { ...r, L, R, dryL: rev(r.dryL), dryR: rev(r.dryR), N: n, endAt: lead, verbStart: -1, reversed: true };
  }

  /* The tempo of a loop: an onset curve (spectral flux), its autocorrelation over 70..180 BPM with a gentle pull
     toward 120, then, if the sound is a whole number of bars at about that tempo, the exact tempo that makes it so.
     Returns { bpm, offset (samples to the first beat), confidence 0..1, exact } or null for sounds too short to tell. */
  function detectBpm(chans, sr, near) {
    const n = chans[0].length, sec = n / sr;
    if (sec < 1.5) return null;
    const hop = Math.round(sr / 100), F = 1024, frames = Math.floor((n - F) / hop);
    if (frames < 50) return null;
    const re = new Float64Array(F), im = new Float64Array(F), prev = new Float64Array(F / 2), prevLin = new Float64Array(F / 2), flux = new Float64Array(frames), low = new Float64Array(frames);
    const lowK = Math.max(2, Math.round(160 * F / sr));   // the kick's band, for where the beats fall
    const win = new Float64Array(F); for (let i = 0; i < F; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / F);
    for (let t = 0; t < frames; t++) {
      re.fill(0); im.fill(0);
      for (let i = 0; i < F; i++) { let v = 0; for (const c of chans) v += c[t * hop + i]; re[i] = v * win[i]; }
      fft(re, im, false);
      let f = 0, lf = 0;
      for (let k = 1; k < F / 2; k++) {
        const mag = Math.hypot(re[k], im[k]), m = Math.log(1 + 100 * mag);
        if (m > prev[k]) f += m - prev[k];
        if (k <= lowK && mag > prevLin[k]) lf += mag - prevLin[k];   // linear, so the loud low hits (kicks) rule
        prev[k] = m; prevLin[k] = mag;
      }
      flux[t] = f; low[t] = lf;
    }
    // remove the slow trend, keep the hits
    const detrend = x => {
      const e = new Float64Array(frames), w = 8;
      for (let t = 0; t < frames; t++) { let s = 0, c = 0; for (let k = Math.max(0, t - w); k <= Math.min(frames - 1, t + w); k++) { s += x[k]; c++; } e[t] = Math.max(0, x[t] - s / c); }
      return e;
    };
    const env = detrend(flux), lowEnv = detrend(low);
    let lowSum = 0, allSum = 0; for (let t = 0; t < frames; t++) { lowSum += lowEnv[t]; allSum += env[t]; }
    const beatEnv = lowSum > 0.01 * allSum ? lowEnv : env;
    const fps = sr / hop, ac = lag => { let s = 0; for (let t = 0; t + lag < frames; t++) s += env[t] * env[t + lag]; return s / (frames - lag); };
    let e0 = ac(0); if (e0 <= 0) return null;
    const score = bpm => {
      const lag = 60 / bpm * fps, l0 = Math.floor(lag), fr = lag - l0, at = l => ac(l) + (ac(l + 1) - ac(l)) * fr;
      return at(l0) + 0.5 * (2 * lag + 1 < frames ? ac(Math.round(2 * lag)) : 0) + 0.25 * (4 * lag + 1 < frames ? ac(Math.round(4 * lag)) : 0);
    };
    const prior = bpm => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    let best = -1, bpm = 0;
    for (let b = 70; b <= 180; b += 0.25) { const sc = score(b) * prior(b); if (sc > best) { best = sc; bpm = b; } }
    // loops are a whole number of bars: prefer a tempo that makes this one so, if the onsets agree with it
    let exact = false, bestBar = -1;
    for (const nb of [4, 8, 16, 32, 64]) {
      const b = nb * 60 / sec; if (b < 70 || b > 180) continue;
      const sc = score(b) * prior(b); if (sc > bestBar) { bestBar = sc; if (sc >= 0.6 * best) { bpm = b; exact = true; } }
    }
    if (!exact) { const beats = sec * bpm / 60; for (const nb of [12, 24, 48]) if (Math.abs(beats - nb) / nb < 0.04) { bpm = nb * 60 / sec; exact = true; break; } }
    // half and double time are the same groove: take the one nearest the session's tempo
    if (near) { for (const b of [bpm / 2, bpm * 2]) if (b >= 60 && b <= 200 && Math.abs(Math.log(b / near)) < Math.abs(Math.log(bpm / near))) bpm = b; }
    bpm = Math.abs(bpm - Math.round(bpm)) < 0.15 ? Math.round(bpm) : Math.round(bpm * 10) / 10;
    // where the beats fall: the phase of the beat grid that lines up with the most onsets
    const lag = 60 / bpm * fps;
    let bestPh = 0, phSc = -1;
    for (let ph = 0; ph < lag; ph++) { let t = 0; for (let k = ph; k < frames; k += lag) t += beatEnv[Math.round(k)] || 0; if (t > phSc) { phSc = t; bestPh = ph; } }
    // an onset shows when it reaches the middle of the frame; the phase is taken within (-1/2, 1/2] beat
    const spbS = 60 / bpm * sr;
    let ph = (bestPh * hop + F / 2) % spbS; if (ph > spbS / 2) ph -= spbS;
    let offset = Math.round(ph < 0 ? ph + spbS : ph);
    if (exact && Math.abs(ph) < spbS / 8) offset = 0;   // a loop starts on its first beat
    return { bpm, offset, confidence: Math.min(1, score(bpm) / (1.75 * e0)), exact };
  }

  /* Time-stretch (WSOLA): longer or shorter by `ratio` without changing the pitch. Each 50 ms grain is taken from where
     the input best continues the previous one (within 10 ms), and overlap-added with Hann windows. */
  function stretch(chans, ratio, sr) {
    const n = chans[0].length;
    if (Math.abs(ratio - 1) < 0.002 || n < sr * 0.1) return chans.map(c => c.slice());
    const N = Math.round(0.05 * sr) & ~1, Hs = N / 2, Ha = Hs / ratio, D = Math.round(0.01 * sr), out = Math.round(n * ratio);
    const ys = chans.map(() => new Float32Array(out + N)), wsum = new Float32Array(out + N);
    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const mono = new Float32Array(n); for (const c of chans) for (let i = 0; i < n; i++) mono[i] += c[i];
    let prevA = 0;
    for (let k = 0; k * Hs < out; k++) {
      const nominal = Math.round(k * Ha);
      let a = Math.min(Math.max(0, nominal), Math.max(0, n - N));
      if (k > 0) {   // match the natural continuation of the previous grain over the overlap
        const want = prevA + Hs, lo = Math.max(0, nominal - D), hi = Math.min(n - N, nominal + D);
        let best = -Infinity;
        for (let c = lo; c <= hi; c++) {
          let xy = 0, yy = 0;
          for (let i = 0; i < Hs && want + i < n; i += 4) { const b = mono[c + i]; xy += mono[want + i] * b; yy += b * b; }
          const sc = xy / Math.sqrt(yy + 1e-9);
          if (sc > best) { best = sc; a = c; }
        }
      }
      const at = k * Hs;
      for (let ch = 0; ch < chans.length; ch++) { const x = chans[ch], y = ys[ch]; for (let i = 0; i < N && a + i < n; i++) y[at + i] += x[a + i] * win[i]; }
      for (let i = 0; i < N; i++) wsum[at + i] += win[i];
      prevA = a;
    }
    return ys.map(y => { const r = new Float32Array(out); for (let i = 0; i < out; i++) r[i] = wsum[i] > 0.1 ? y[i] / wsum[i] : y[i]; return r; });
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

  Object.assign(LF, { renderTransition, convolve, fft, trimSilence, peaks, wav24, detectBpm, stretch, reverseRender });
}
LiftoffTransition(typeof globalThis !== 'undefined' ? globalThis : this);
