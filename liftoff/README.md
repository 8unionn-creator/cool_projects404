# 🛫 Liftoff

**Riser, reverse reverb and pre-drop cut in one effect, locked to your bars.** Put it on a beat, a vocal, a bus or the master. It follows your DAW's bars and builds into every drop. The sound pitches up, thins out, stutters, washes out and widens, with a noise riser on top. The last beat cuts, tape-stops, filter-dives or stutters. A reverse swell made from the drop's own first hit rises out of that gap and lands exactly on it, and a sub boom hits on the one.

It runs in the browser (open `index.html`) and as a **VST3 / Audio Unit** plugin, with the same interface in both.

![Liftoff](docs/liftoff.png)

## Why it's different

Transition plugins usually do one of these jobs: a reverse reverb, a riser made from your sound, or a pre-drop trick. Liftoff does all three on one timeline, so they work together:

- **The backverb lands on the beat, every time.** Reverse reverb normally means bouncing audio, reversing it and lining it up by hand. Liftoff convolves the signal with a time-reversed reverb and delays everything else by the same length, so the swell of any sound ends exactly on that sound, in real time. It reports that length to the DAW as latency, so your session stays in sync.
- **It swells from the drop itself.** In **DROP** mode only the first 1/8 note of the drop goes into the backverb, so the swell is made from the actual hit that's coming. It's the "reverse the first hit of the chorus" trick with no bouncing.
- **It knows where the drop is.** In **AUTO** mode the build fills the last 1/2–8 bars of every 4, 8, 16 or 32 bar phrase and the drop is the phrase's first downbeat. The display shows a **T-minus countdown**.
- **Any sound becomes the riser.** Instead of a stock noise sweep, your loop is pitched up (to +24 semitones), high-passed with rising resonance, gated from 1/4 up to 1/32 notes on the grid, ducked into a reverb wash and widened. A white-noise riser sweeps along underneath.
- **The moment before the drop is designed too.** The gap can be **cut** (silence), **tape** (the beat slows to a stop), **filter** (it sinks into a low-pass) or **stutter** (the first 1/16 repeats). The reverse swell and the wash tail fill it.
- **Three ways to time it.** **AUTO** follows the phrase. **MANUAL**: ride or automate **BUILD**, hold it at 100% for the gap, pull it down to drop. **TRIGGER**: a MIDI note (or **LAUNCH**) starts a build that drops *BUILD LENGTH* later.
- **One CURVE for the whole build.** Late (a slow start that rushes at the end) or early (it jumps up, then hangs). Every module follows it, and the knobs show live how much of each amount is in play.

## Presets

Liftoff · Festival Build · Trap Pre-Drop · Vocal Backverb · Afro Swell · Tape Stop Drop · Washout · Stutter Riser · Reverse Into Drop · Subtle Lift. Presets set the sound. Your timing (mode, phrase), MIX and OUTPUT stay as they are.

## In the browser

Open `liftoff/index.html`. Nothing to install. It starts with a two-bar house loop made in the browser. Drop in your own loop or song and set its BPM (a BPM in the file name, like `beat_140bpm.wav`, is picked up). **Export transition** renders the build, the gap and the first bar of the drop as a 24-bit WAV, ready to drag into a session. **Export phrase** renders a whole phrase. Your settings stay in your browser.

Shortcuts: `Space` play/stop · `L` launch · `←` `→` presets. On knobs: drag up/down (`Shift` for fine), scroll, arrow keys, double-click to reset.

## As a plugin

Download the installer for your computer from the [releases](https://github.com/8unionn-creator/cool_projects404/releases) (or the latest *liftoff plugin* run under Actions) and follow [`plugin/INSTALL.md`](plugin/INSTALL.md). [Build it yourself →](plugin/README.md)

## How it works

| File | |
|---|---|
| `dsp.js` | The DSP core, sample by sample: timeline (build, gap, drop), pitch shifter, SVF filters, stutter gate, gap styles, impact, 8-line FDN wash, noise riser, width, and the backverb send. Also makes the reversed reverb. |
| `worklet.js` | Runs the core on the browser's audio thread. The page adds a `DelayNode` and a `ConvolverNode` for the backverb. |
| `params.js` | The 24 parameters and the presets. The plugin builds its DAW parameters from this same file. |
| `app.js`, `index.html` | The interface: flight path display, countdown, controls, presets, demo loop, WAV export, and the bridge to the plugin. |
| `plugin/Source/Core.cpp` | The same core in C++, plus the delay and JUCE's convolution. |

The signal path for each sample: pitch rise → high-pass sweep → stutter gate → pre-drop gap → + impact → + wash → + noise riser → width → dry/wet → output. In parallel, the dry input (gated by the backverb mode) is convolved with the reversed reverb. Everything else is delayed by the reverb's length, so each swell peaks on the sound it came from.

## Tests

```
node liftoff/tests/core-test.js     # the build, riser, gap styles, impact, backverb, timing modes (20 checks)
```

The plugin has two more, run by CI on Windows, macOS and Linux: `LiftoffEngineTest` (alignment of the swell with its hit, latency, block sizes, MIDI triggers) with `tests/parity.js` (the C++ engine and `dsp.js` produce the same samples), and `LiftoffHostTest`, which loads the built VST3 like a DAW. On macOS the Audio Unit also goes through `auval`.
