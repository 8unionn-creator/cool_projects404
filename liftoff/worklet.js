/* The browser's audio thread: runs the Liftoff core (dsp.js, put into the same module by the page).
   Output 0 is the processed signal (the page delays it by the backverb length), output 1 is the backverb send
   (the page convolves it with the reversed reverb). */
function LiftoffWorklet() {
class LiftoffProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.core = new globalThis.Liftoff.Core(sampleRate);
    this.tp = { playing: false, start: 0, bpm: 120, bpb: 4 };
    this.zero = new Float32Array(128);
    this.tick = 0;
    this.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'params') { this.core.setParams(m.params); if (m.snap) this.core.snapSmoothing(); }
      else if (m.type === 'transport') Object.assign(this.tp, m);
      else if (m.type === 'launch') this.core.launch();
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0], o = outputs[0], s = outputs[1];
    const n = o[0].length;
    if (this.zero.length < n) this.zero = new Float32Array(n);
    const L = (inp && inp[0]) || this.zero, R = (inp && inp[1]) || L;
    const tp = this.tp, bps = tp.bpm / 60 / sampleRate;
    const ppq = (currentFrame - tp.start) * bps;
    this.core.process(L, R, o[0], o[1] || o[0], s[0], s[1] || s[0], n, { playing: tp.playing, ppq, bpm: tp.bpm, bpb: tp.bpb });
    if (++this.tick % 12 === 0) this.port.postMessage({ type: 'state', ...this.core.ui, playing: tp.playing, frame: currentFrame });
    return true;
  }
}
registerProcessor('liftoff', LiftoffProcessor);
}
// the page loads this file as a plain script and hands the function to the audio thread as a module
if (typeof AudioWorkletProcessor !== 'undefined') LiftoffWorklet();
