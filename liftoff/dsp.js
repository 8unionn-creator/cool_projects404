/* Liftoff DSP core: the build, the riser, chorus and tremolo, sample by sample.
   The same algorithm runs in C++ in the plugin (plugin/Source/Core.cpp); keep the two in step.

   Signal path for each sample x:
     pitch rise -> high-pass sweep -> stutter gate -> pre-drop gap (cut / tape stop / filter dive / stutter; off unless drop)
     -> chorus -> + impact (off unless drop) -> + wash reverb (FDN) -> + noise riser -> tremolo -> stereo width
     -> mix with dry -> output gain
   Backverb: the dry input, gated by its mode, is sent out separately. Convolving it with a time-reversed reverb
   of length L and delaying everything else by L makes the swell of every sound end exactly on that sound,
   so a reverse swell made from the drop's own first hit rises out of the gap and lands on the drop.
   In the browser the convolution and the delay are a ConvolverNode and a DelayNode; in the plugin they are in C++
   and the plugin reports L as its latency, so the DAW lines everything up. */
function LiftoffDSP(G) {
  'use strict';

  const PHRASE_BARS = [4, 8, 16, 32];
  const LENGTH_BARS = [0.5, 1, 2, 4, 8];
  const VERB_BEATS = [0.5, 1, 2, 4];
  const GAP_BEATS = [0, 0.25, 0.5, 1, 2];
  const MODE = { AUTO: 0, MANUAL: 1, TRIGGER: 2 };
  const VERB_MODE = { DROP: 0, BUILD: 1, ALWAYS: 2 };
  const GAP_STYLE = { CUT: 0, TAPE: 1, FILTER: 2, STUTTER: 3 };
  const TREM_STEPS = [1, 2, 4, 8, 3, 6];   // per beat: 1/4, 1/8, 1/16, 1/32, 1/8 triplets, 1/16 triplets
  const TREM_SHAPE = { SINE: 0, SQUARE: 1, RAMP: 2, PAN: 3 };
  const TAU = Math.PI * 2;

  // xorshift32, identical in C++, so both versions make the same reverb
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 * 2 - 1; };
  }

  // progress 0..1 shaped by the curve: > 0 starts slow and rushes at the end, < 0 jumps up early
  function shape(x, curve) {
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    return curve >= 0 ? Math.pow(x, 1 + 3 * curve) : 1 - Math.pow(1 - x, 1 - 3 * curve);
  }

  /* Where a beat position sits in AUTO mode: the build fills the last LENGTH bars of every PHRASE,
     the gap is the last GAP of it, and the drop is the phrase's first downbeat. Used by the core and by the UI. */
  function autoTimeline(P, beat, bpb) {
    const phraseB = PHRASE_BARS[P.phrase] * bpb;
    const buildB = Math.min(LENGTH_BARS[P.length] * bpb, phraseB);
    const gapB = P.drop ? Math.min(GAP_BEATS[P.gap], buildB) : 0;
    if (beat < 0) return { idx: -1, pos: 0, raw: -1, inGap: false, gapPos: 0, toDrop: phraseB - beat, phraseB, buildB, gapB };
    const idx = Math.floor(beat / phraseB), pos = beat - idx * phraseB;
    const start = phraseB - buildB;
    return {
      idx, pos, phraseB, buildB, gapB,
      raw: pos >= start ? (pos - start) / buildB : -1,
      inGap: gapB > 0 && pos >= phraseB - gapB,
      gapPos: pos - (phraseB - gapB),
      toDrop: phraseB - pos
    };
  }

  /* The backverb's impulse response: decaying stereo noise that darkens as it decays, normalised to unit energy
     and reversed, so it swells from the tail (quiet, dark) to the peak (loud, bright) at its last sample. */
  function makeReverseIR(sr, N, size, tone, seed) {
    N = Math.max(64, Math.round(N));
    const tailDb = -60 + 48 * size;                       // level the swell starts from
    const k = Math.log(Math.pow(10, -tailDb / 20)) / N;
    const bright = 2000 * Math.pow(8, tone);              // 2 kHz .. 16 kHz at the peak
    const fadeN = Math.min(N >> 2, Math.round(sr * 0.005));
    const out = [];
    for (let ch = 0; ch < 2; ch++) {
      const r = rng((seed || 0x5eed) + ch * 7919);
      const h = new Float32Array(N);
      let lp = 0, energy = 0;
      for (let t = 0; t < N; t++) {
        const fc = Math.min(bright * (1 - 0.8 * t / N), sr * 0.45);
        const a = Math.exp(-TAU * fc / sr);
        lp = lp * a + (1 - a) * r();
        h[t] = lp * Math.exp(-k * t);
      }
      for (let i = 0; i < fadeN; i++) h[N - 1 - i] *= i / fadeN;
      for (let t = 0; t < N; t++) energy += h[t] * h[t];
      const g = energy > 0 ? 1 / Math.sqrt(energy) : 0;
      const rev = new Float32Array(N);
      for (let t = 0; t < N; t++) rev[t] = h[N - 1 - t] * g;
      out.push(rev);
    }
    return out;
  }

  // Simper's trapezoidal state-variable filter
  class SVF {
    constructor() { this.ic1 = 0; this.ic2 = 0; this.a1 = 1; this.a2 = 0; this.a3 = 0; this.k = 1.4; }
    set(fc, q, sr) {
      const g = Math.tan(Math.PI * Math.min(fc, sr * 0.45) / sr);
      this.k = 1 / q; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
    }
    run(v0) {   // sets lp, bp, hp
      const v3 = v0 - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
      this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
      this.lp = v2; this.bp = v1; this.hp = v0 - this.k * v1 - v2;
    }
    reset() { this.ic1 = this.ic2 = 0; }
  }

  // An 8-line feedback delay network for the wash
  const FDN_LEN = [1031, 1327, 1523, 1801, 2063, 2357, 2671, 2999];
  class Wash {
    constructor(sr) {
      this.lines = FDN_LEN.map(l => new Float32Array(Math.round(l * sr / 48000) + 1));
      this.pos = new Int32Array(8); this.lp = new Float32Array(8); this.v = new Float32Array(8);
      const t60 = 4.0;
      this.g = this.lines.map(b => Math.pow(10, -3 * (b.length - 1) / (t60 * sr)));
      this.damp = Math.exp(-TAU * 6500 / sr);
    }
    run(inL, inR) {
      const v = this.v, L = this.lines;
      for (let i = 0; i < 8; i++) {
        const b = L[i], p = this.pos[i];
        this.lp[i] = b[p] * (1 - this.damp) + this.lp[i] * this.damp;
        v[i] = this.lp[i] * this.g[i];
      }
      // 8-point Hadamard, scaled to stay energy-preserving
      for (let h = 1; h < 8; h <<= 1)
        for (let i = 0; i < 8; i += h << 1)
          for (let j = i; j < i + h; j++) { const a = v[j], b = v[j + h]; v[j] = a + b; v[j + h] = a - b; }
      const s = 0.35355339;   // 1 / sqrt(8)
      let oL = 0, oR = 0;
      for (let i = 0; i < 8; i++) {
        const b = L[i], p = this.pos[i];
        const out = b[p];
        if (i & 1) oR += out; else oL += out;
        b[p] = v[i] * s + ((i & 1) ? inR : inL) * 0.5;
        this.pos[i] = p + 1 >= b.length ? 0 : p + 1;
      }
      this.oL = oL * 0.5; this.oR = oR * 0.5;
    }
  }

  const DEFAULTS = {
    mode: 0, phrase: 2, length: 3, build: 0, curve: 0.35,
    rise: 1, pitch: 7, filter: 0.6, wash: 0.5, stutter: 0.3, noise: 0.35, width: 0.5,
    verb: 1, verbMode: 0, verbLen: 2, verbSize: 0.5, verbTone: 0.6, verbMix: 0.6,
    drop: 0, gap: 3, gapStyle: 0, impact: 0.4,
    trem: 1, tremRate: 1, tremDepth: 0.35, tremShape: 0,
    chorus: 1, chorusRate: 0.8, chorusDepth: 0.5, chorusMix: 0.4,
    mix: 1, output: 0
  };
  // continuous parameters glide (about 20 ms) so automation and knob moves never click
  const SMOOTHED = ['build', 'curve', 'pitch', 'filter', 'wash', 'stutter', 'noise', 'width', 'verbMix', 'impact', 'mix', 'output',
                    'tremDepth', 'chorusRate', 'chorusDepth', 'chorusMix'];

  function pow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  class Core {
    constructor(sr) {
      this.sr = sr;
      this.P = Object.assign({}, DEFAULTS);
      this.S = {}; for (const k of SMOOTHED) this.S[k] = this.target(k);
      this.smoothA = 1 - Math.exp(-1 / (0.02 * sr));
      // pitch shifter
      this.W = Math.round(0.05 * sr);
      this.psN = pow2(this.W + 8); this.psL = new Float32Array(this.psN); this.psR = new Float32Array(this.psN); this.psW = 0;
      this.phase = 0;
      // history for the gap (tape stop, stutter): up to 2 beats at 40 BPM
      this.hN = pow2(Math.ceil(sr * 3.2)); this.hL = new Float32Array(this.hN); this.hR = new Float32Array(this.hN); this.hW = 0;
      this.hpL = new SVF(); this.hpR = new SVF(); this.lpL = new SVF(); this.lpR = new SVF(); this.nL = new SVF(); this.nR = new SVF();
      this.wash = new Wash(sr);
      // chorus: two modulated taps per channel; tremolo: smoothing for the square and ramp shapes
      this.chN = pow2(Math.ceil(0.05 * sr)); this.chL = new Float32Array(this.chN); this.chR = new Float32Array(this.chN); this.chW = 0; this.chPh = 0;
      this.tremSm = 1;
      this.noise = rng(0xa11ce);
      this.gate = 1;
      this.gateA = 1 - Math.exp(-1 / (0.0015 * sr));
      this.cutA = 1 - Math.exp(-1 / (0.003 * sr));
      this.gapEnv = 0;
      // timeline
      this.freeBeat = 0; this.prevIdx = null; this.prevBuilding = false;
      this.armed = false;
      this.trigActive = false; this.trigBeat = 0; this.pendingLaunch = false; this.prevBarIdx = null;
      this.inGap = false; this.gapT = 0; this.gapStart = 0; this.gapLen = 1;
      // impact and backverb drop window
      this.impT = -1; this.impPhase = 0; this.dropT = -1;
      this.drops = 0;
      this.coefT = 0;
      this.ui = { p: 0, raw: -1, inGap: false, toDrop: -1, beat: 0, building: false, trig: false, pending: false, drops: 0, peakIn: 0, peakOut: 0 };
    }

    target(k) { return k === 'output' ? Math.pow(10, this.P.output / 20) : this.P[k]; }
    setParam(id, v) { if (id in this.P) this.P[id] = +v; }
    setParams(o) { for (const k in o) this.setParam(k, o[k]); }
    snapSmoothing() { for (const k of SMOOTHED) this.S[k] = this.target(k); }
    // LAUNCH: a build that starts on the next bar line (or now, if the transport is stopped)
    launch() { this.pendingLaunch = true; }
    // MIDI note: a build that starts right now
    trigger() { this.trigActive = true; this.trigBeat = 0; this.pendingLaunch = false; }
    latencySamples(bpm) { return this.P.verb ? Math.round(VERB_BEATS[this.P.verbLen] * 60 / bpm * this.sr) : 0; }

    _drop() {
      this.impT = 0; this.impPhase = 0; this.dropT = 0; this.drops++;
      this.inGap = false; this.armed = false;
    }

    _readHist(buf, pos) {   // pos: absolute sample index (may be fractional), must be in the past
      const N = this.hN, i = Math.floor(pos), f = pos - i;
      const a = buf[i & (N - 1)], b = buf[(i + 1) & (N - 1)];
      return a + (b - a) * f;
    }

    /* tp: { playing, ppq (beat at the first sample), bpm, bpb (beats per bar) } */
    process(inL, inR, outL, outR, sendL, sendR, n, tp) {
      const P = this.P, S = this.S, sr = this.sr, A = this.smoothA;
      const bpm = Math.max(20, tp.bpm || 120), bpb = tp.bpb || 4, bps = bpm / 60 / sr;
      const W = this.W, psN = this.psN;
      const rise = !!P.rise, dropOn = !!P.drop;
      const gapBeats = dropOn ? GAP_BEATS[P.gap] : 0;
      const sliceBeats = 0.25;
      let peakIn = 0, peakOut = 0, lastP = 0, lastRaw = -1, toDrop = -1;

      for (let i = 0; i < n; i++) {
        for (const k of SMOOTHED) S[k] += (this.target(k) - S[k]) * A;
        const xL = inL[i], xR = inR[i];
        const aIn = Math.max(Math.abs(xL), Math.abs(xR)); if (aIn > peakIn) peakIn = aIn;

        // ---------- timeline: progress, gap, drop ----------
        const playing = tp.playing && tp.ppq + i * bps >= 0;
        const beat = playing ? tp.ppq + i * bps : this.freeBeat;
        this.freeBeat = beat + bps;
        let raw = -1, gapNow = false, gapLenBeats = gapBeats, drop = false;
        if (P.mode === MODE.AUTO) {
          if (playing) {
            const T = autoTimeline(P, beat, bpb);
            raw = T.raw; gapNow = T.inGap; gapLenBeats = T.gapB; toDrop = T.toDrop;
            drop = this.prevIdx !== null && T.idx === this.prevIdx + 1 && this.prevBuilding;
            this.prevIdx = T.idx; this.prevBuilding = raw >= 0;
          } else { this.prevIdx = null; this.prevBuilding = false; }
        } else if (P.mode === MODE.MANUAL) {
          const b = S.build;
          raw = b > 0.0005 ? b : -1;
          if (b >= 0.9) this.armed = true;
          if (this.armed && b < 0.1) drop = true;
          gapNow = gapBeats > 0 && b >= 0.995;
        } else {
          const barIdx = Math.floor(beat / bpb);
          if (this.pendingLaunch && (!playing || (this.prevBarIdx !== null && barIdx > this.prevBarIdx))) this.trigger();
          this.prevBarIdx = barIdx;
          if (this.trigActive) {
            const buildB = LENGTH_BARS[P.length] * bpb;
            gapLenBeats = Math.min(gapBeats, buildB);
            if (this.trigBeat >= buildB) { drop = true; this.trigActive = false; }
            else {
              raw = this.trigBeat / buildB; gapNow = gapLenBeats > 0 && this.trigBeat >= buildB - gapLenBeats;
              toDrop = buildB - this.trigBeat; this.trigBeat += bps;
            }
          }
        }
        if (drop) this._drop();
        const building = raw >= 0;
        const p = building ? shape(raw, S.curve) : 0;
        lastP = p; lastRaw = raw;

        // gap bookkeeping (entering it fixes where tape stop and stutter read from)
        if (gapNow && !this.inGap) {
          this.inGap = true; this.gapT = 0; this.gapStart = this.hW;
          this.gapLen = Math.max(1, gapLenBeats / bps);
          this.lpL.reset(); this.lpR.reset();
        } else if (!gapNow && this.inGap) this.inGap = false;

        // coefficients every 16 samples
        if ((this.coefT++ & 15) === 0) {
          if (rise && S.filter > 0) { const fc = 20 * Math.pow(150, S.filter * p), q = 0.7 + 1.5 * S.filter * p; this.hpL.set(fc, q, sr); this.hpR.set(fc, q, sr); }
          if (rise && S.noise > 0) { const fc = 300 * Math.pow(40, p); this.nL.set(fc, 1.2, sr); this.nR.set(fc, 1.2, sr); }
          if (this.inGap && P.gapStyle === GAP_STYLE.FILTER) {
            const u = Math.min(1, this.gapT / this.gapLen), fc = 9000 * Math.pow(60 / 9000, u);
            this.lpL.set(fc, 0.9, sr); this.lpR.set(fc, 0.9, sr);
          }
        }

        // ---------- rise ----------
        let sL = xL, sR = xR;
        // pitch: two crossfaded taps sweeping through a 50 ms window
        const pw = this.psW; this.psL[pw] = xL; this.psR[pw] = xR; this.psW = (pw + 1) & (psN - 1);
        const semis = rise ? S.pitch * p : 0;
        if (semis > 0.01) {
          const ratio = Math.pow(2, semis / 12);
          let ph = this.phase - (ratio - 1) / W; ph -= Math.floor(ph); this.phase = ph;
          const ph2 = ph + 0.5 - Math.floor(ph + 0.5);
          const w1 = Math.sin(Math.PI * ph) ** 2, w2 = 1 - w1;
          const r1 = pw - ph * W, r2 = pw - ph2 * W;
          const i1 = Math.floor(r1), f1 = r1 - i1, i2 = Math.floor(r2), f2 = r2 - i2, m = psN - 1;
          const yL = w1 * (this.psL[i1 & m] + (this.psL[(i1 + 1) & m] - this.psL[i1 & m]) * f1) + w2 * (this.psL[i2 & m] + (this.psL[(i2 + 1) & m] - this.psL[i2 & m]) * f2);
          const yR = w1 * (this.psR[i1 & m] + (this.psR[(i1 + 1) & m] - this.psR[i1 & m]) * f1) + w2 * (this.psR[i2 & m] + (this.psR[(i2 + 1) & m] - this.psR[i2 & m]) * f2);
          const mix = Math.min(1, semis / 1.5);
          sL += (yL - sL) * mix; sR += (yR - sR) * mix;
        }
        if (rise && S.filter > 0) { this.hpL.run(sL); this.hpR.run(sR); sL = this.hpL.hp; sR = this.hpR.hp; }
        if (rise && S.stutter > 0) {
          const steps = [1, 2, 4, 8][Math.min(3, Math.floor(p * 4))];
          const f = beat * steps - Math.floor(beat * steps);
          this.gate += ((f < 0.5 ? 1 : 0) - this.gate) * this.gateA;
          const depth = S.stutter * Math.min(1, p * 1.5);
          const g = 1 - depth * (1 - this.gate);
          sL *= g; sR *= g;
        }

        // ---------- pre-drop gap ----------
        const hw = this.hW; this.hL[hw & (this.hN - 1)] = sL; this.hR[hw & (this.hN - 1)] = sR; this.hW = hw + 1;
        this.gapEnv += ((this.inGap ? 1 : 0) - this.gapEnv) * this.cutA;
        if (this.inGap) {
          const t = this.gapT, G = this.gapLen, u = Math.min(1, t / G);
          if (P.gapStyle === GAP_STYLE.TAPE) {
            const pos = this.gapStart + (t < G ? t - t * t / (2 * G) : G / 2);
            const v = Math.sqrt(Math.max(0, 1 - u));
            sL = this._readHist(this.hL, pos) * v; sR = this._readHist(this.hR, pos) * v;
          } else if (P.gapStyle === GAP_STYLE.FILTER) {
            this.lpL.run(sL); this.lpR.run(sR); const v = 1 - 0.5 * u; sL = this.lpL.lp * v; sR = this.lpR.lp * v;
          } else if (P.gapStyle === GAP_STYLE.STUTTER) {
            const S1 = Math.max(32, Math.min(G, sliceBeats / bps)), ti = t % S1;
            const fade = Math.min(1, ti / (0.002 * sr), (S1 - ti) / (0.002 * sr));
            const pos = this.gapStart + ti;
            sL = this._readHist(this.hL, pos) * fade; sR = this._readHist(this.hR, pos) * fade;
          } else { const v = 1 - this.gapEnv; sL *= v; sR *= v; }
          this.gapT++;
        }

        // ---------- chorus ----------
        const cw = this.chW, cm = this.chN - 1; this.chL[cw] = sL; this.chR[cw] = sR; this.chW = (cw + 1) & cm;
        if (P.chorus) {
          let cp = this.chPh + S.chorusRate / sr; cp -= Math.floor(cp); this.chPh = cp;
          const base = 0.012 * sr, dep = 0.006 * sr * S.chorusDepth;
          const tap = (buf, ph) => { const r = cw - (base + dep * Math.sin(TAU * ph)), i = Math.floor(r), f = r - i, a = buf[i & cm]; return a + (buf[(i + 1) & cm] - a) * f; };
          const wL = 0.5 * (tap(this.chL, cp) + tap(this.chL, cp + 0.5)), wR = 0.5 * (tap(this.chR, cp + 0.25) + tap(this.chR, cp + 0.75));
          const m = S.chorusMix;
          sL = sL * (1 - 0.5 * m) + wL * m; sR = sR * (1 - 0.5 * m) + wR * m;
        }

        // ---------- impact on the drop ----------
        let imp = 0, crack = 0;
        if (this.impT >= 0) {
          const ts = this.impT / sr;
          const f = 42 + 80 * Math.exp(-ts / 0.03);
          this.impPhase += f / sr; this.impPhase -= Math.floor(this.impPhase);
          const atk = Math.min(1, this.impT / (0.001 * sr));
          imp = Math.sin(TAU * this.impPhase) * Math.exp(-ts / 0.45) * atk;
          crack = this.noise() * Math.exp(-ts / 0.05);
          this.impT++;
          if (ts > 2.5) this.impT = -1;
        }
        const impAmt = dropOn ? S.impact : 0;
        const impMono = impAmt * (0.75 * imp + 0.3 * crack);

        // ---------- noise riser ----------
        let nzL = 0, nzR = 0;
        if (rise && S.noise > 0 && building && !this.inGap) {
          this.nL.run(this.noise()); this.nR.run(this.noise());
          const lv = S.noise * 0.5 * Math.pow(p, 1.6);
          nzL = this.nL.bp * lv; nzR = this.nR.bp * lv;
        }

        // ---------- wash ----------
        const wAmt = rise ? S.wash * p : 0;
        this.wash.run(sL * wAmt + nzL * 0.4 + impAmt * crack * 0.5, sR * wAmt + nzR * 0.4 + impAmt * crack * 0.5);
        const duck = 1 - 0.6 * wAmt * p;
        let oL = sL * duck + this.wash.oL + nzL + impMono;
        let oR = sR * duck + this.wash.oR + nzR + impMono;

        // ---------- tremolo, on the beat grid ----------
        if (P.trem) {
          const steps = TREM_STEPS[P.tremRate], ph = beat * steps - Math.floor(beat * steps), d = S.tremDepth;
          let lL, lR;
          if (P.tremShape === TREM_SHAPE.SQUARE) { this.tremSm += ((ph < 0.5 ? 1 : 0) - this.tremSm) * this.gateA; lL = lR = this.tremSm; }
          else if (P.tremShape === TREM_SHAPE.RAMP) { this.tremSm += ((1 - ph) - this.tremSm) * this.gateA; lL = lR = this.tremSm; }
          else if (P.tremShape === TREM_SHAPE.PAN) { lL = 0.5 + 0.5 * Math.cos(TAU * ph); lR = 0.5 - 0.5 * Math.cos(TAU * ph); }
          else lL = lR = 0.5 + 0.5 * Math.cos(TAU * ph);
          oL *= 1 - d * (1 - lL); oR *= 1 - d * (1 - lR);
        }

        // ---------- width ----------
        if (rise && S.width > 0 && p > 0) {
          const mid = (oL + oR) * 0.5, side = (oL - oR) * 0.5 * (1 + 1.5 * S.width * p);
          oL = mid + side; oR = mid - side;
        }

        // ---------- mix, output ----------
        const mx = S.mix, og = S.output;
        oL = (xL + (oL - xL) * mx) * og; oR = (xR + (oR - xR) * mx) * og;
        outL[i] = oL; outR[i] = oR;
        const aOut = Math.max(Math.abs(oL), Math.abs(oR)); if (aOut > peakOut) peakOut = aOut;

        // ---------- backverb send ----------
        let sg = 0;
        if (P.verb) {
          if (P.verbMode === VERB_MODE.ALWAYS) sg = 1;
          else if (P.verbMode === VERB_MODE.BUILD) sg = p;
          else if (this.dropT >= 0) {
            const win = 0.5 / bps, t = this.dropT;
            sg = t < 0.6 * win ? 1 : t < win ? 0.5 * (1 + Math.cos(Math.PI * (t - 0.6 * win) / (0.4 * win))) : 0;
            this.dropT = t + 1 < win ? t + 1 : -1;
          }
          sg *= S.verbMix * 1.5 * mx * og;
        }
        sendL[i] = xL * sg; sendR[i] = xR * sg;
      }

      const u = this.ui;
      u.p = lastP; u.raw = lastRaw; u.inGap = this.inGap; u.toDrop = toDrop; u.beat = tp.playing ? tp.ppq + n * bps : this.freeBeat;
      u.building = lastRaw >= 0; u.trig = this.trigActive; u.pending = this.pendingLaunch; u.drops = this.drops;
      u.peakIn = Math.max(u.peakIn * 0.85, peakIn); u.peakOut = Math.max(u.peakOut * 0.85, peakOut);
    }
  }

  G.Liftoff = { Core, makeReverseIR, autoTimeline, shape, rng, DEFAULTS, PHRASE_BARS, LENGTH_BARS, VERB_BEATS, GAP_BEATS, MODE, VERB_MODE, GAP_STYLE, TREM_STEPS, TREM_SHAPE };
}
LiftoffDSP(typeof globalThis !== 'undefined' ? globalThis : this);
