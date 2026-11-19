# 🛫 Liftoff

**Load a sample or record one, and Liftoff turns it into a transition.** Your sound becomes the riser: it pitches up, thins out, stutters, washes out and widens, with a noise riser on top. A one-shot (a snare, a chop) is retriggered faster and faster into a roll. The last beat before the drop cuts, tape-stops, filter-dives or stutters. A reverse swell made from the drop's own first hit rises out of that gap and lands exactly on it, and a sub boom hits on the one. Preview it, then export the WAV, or in the plugin, drag it straight into your session.

It runs in the browser (open `index.html`) and as a **VST3 / Audio Unit** plugin, with the same interface in both. The plugin also has a **LIVE** mode that builds into every drop as an insert effect, following your DAW's bars.

![Liftoff](docs/liftoff.png)

## How it works

1. **Get a sample.** Press **REC**. The browser records your microphone; the plugin records the audio coming down its own track, so play your loop, vocal or synth in the DAW and press REC again to stop. Recordings are trimmed to the sound. Or **Load** a file, drop one anywhere, or try a demo (a house loop, a snare that becomes a roll, a chord stab).
2. **Shape it.** Pick how many bars the **BUILD** lasts (½ to 8) and how long the transition goes on **AFTER THE DROP** (1, 2 or 4 bars), then dial in RISE, BACKVERB and DROP, or pick a preset. Every change re-renders in the background.
3. **Hear it.** **PREVIEW** (or Space) plays the transition. In the plugin it plays through the plugin's output, so you hear it through your DAW and your interface. Click anywhere on the screen to play from there.
4. **Use it.** **EXPORT WAV** saves a 24-bit WAV. In the plugin you can also drag the WAV from the strip under the window into a track.

## The screen

The screen shows the transition's real waveform, coloured by what happens where. The build warms from dark to bright gold as it rises, the gap is violet where the reverse swell fills it, the drop glows, and the tail fades out. The sample as it went in is a faint ghost behind it, the build curve runs through it like an automation lane, and the swell's shape is drawn over the gap. While it plays, the part already heard lights up, a playhead sweeps across, and the countdown reads T–2 BARS, T–3, HOLD, then DROP. In LIVE mode the screen follows your DAW's bars instead.

## Why it's different

- **The backverb lands on the beat, every time.** Reverse reverb normally means bouncing audio, reversing it and lining it up by hand. Liftoff convolves the sound with a time-reversed reverb and pulls the result back by the reverb's length, so each swell ends exactly on the sound it came from. In **DROP** mode only the drop's first 1/8 note feeds it, so the swell is made from the actual hit that's coming.
- **Any sound becomes the riser.** Instead of a stock noise sweep, your own sound is pitched up (to +24 semitones), high-passed with rising resonance, gated from 1/4 up to 1/32 notes, ducked into a reverb wash and widened, with a white-noise riser sweeping underneath. One-shots shorter than a beat become a roll that speeds up through 1/4, 1/8, 1/16 and 1/32 notes.
- **The moment before the drop is designed too.** The gap can be **cut**, **tape** (the beat slows to a stop), **filter** (it sinks into a low-pass) or **stutter** (the first 1/16 repeats).
- **One CURVE for the whole build.** Late (a slow start that rushes at the end) or early (it jumps up, then hangs). Every module follows it, and while the transition plays, the knobs show how much of each amount is in play.
- **LIVE mode (plugin).** Liftoff can also sit on a track as an effect. **AUTO** builds into the first bar of every 4, 8, 16 or 32 bar phrase, **MANUAL** follows the BUILD automation, and **TRIGGER** starts a build on a MIDI note or LAUNCH. The backverb length is reported as latency, so your DAW keeps everything in time.

## Presets

Liftoff · Festival Build · Trap Pre-Drop · Vocal Backverb · Afro Swell · Tape Stop Drop · Washout · Stutter Riser · Reverse Into Drop · Subtle Lift. Presets set the sound. Your timing (mode, phrase), MIX and OUTPUT stay as they are.

## In the browser

Open `liftoff/index.html`. Nothing to install. It opens with the demo loop, or with the last sample you used (kept in your browser). Set the **BPM** to your session's tempo so the bars line up; a BPM in the file name, like `vox_140bpm.wav`, is picked up. Your settings and samples stay in your browser and are never uploaded.

Shortcuts: `Space` preview · `R` record · `←` `→` presets. On knobs: drag up/down (`Shift` for fine), scroll, arrow keys, double-click to reset.

## As a plugin

Download the installer for your computer from the [releases](https://github.com/8unionn-creator/cool_projects404/releases) and follow [`plugin/INSTALL.md`](plugin/INSTALL.md). Put Liftoff on the track you want to sample. It opens in **SAMPLE** mode, passes that track through untouched, and takes the tempo from your DAW. [Build it yourself →](plugin/README.md)

## Code

| File | |
|---|---|
| `dsp.js` | The DSP core, sample by sample: timeline (build, gap, drop), pitch shifter, SVF filters, stutter gate, gap styles, impact, 8-line FDN wash, noise riser, width, and the backverb send. Also makes the reversed reverb. |
| `transition.js` | A sample in, a transition out: lays the sample (looped, or a one-shot as a roll) over the build and the drop, runs the core, adds the backverb by FFT convolution, and writes WAVs. |
| `params.js` | The 24 parameters and the presets. The plugin builds its DAW parameters from this same file. |
| `app.js`, `index.html` | The interface: the screen, recording, loading, preview, export, presets, and the bridge to the plugin. |
| `plugin/Source/Core.cpp` | The same core in C++, for LIVE mode, plus the delay and JUCE's convolution. |
| `plugin/Source/PluginProcessor.cpp` | SAMPLE mode: records the track, plays the preview on top of it, and saves the sample's path with your session. |

## Tests

```
node liftoff/tests/core-test.js         # the build, riser, gap styles, impact, backverb, timing modes (20 checks)
node liftoff/tests/transition-test.js   # a sample becomes a transition: loop, roll, gap, swell, FFT convolution (11 checks)
```

The plugin has two more, run by CI on Windows, macOS and Linux: `LiftoffEngineTest` (alignment of the swell with its hit, latency, block sizes, MIDI triggers) with `tests/parity.js` (the C++ engine and `dsp.js` produce the same samples), and `LiftoffHostTest`, which loads the built VST3 like a DAW (it opens in SAMPLE mode with no latency and passes the track through untouched). On macOS the Audio Unit also goes through `auval`.
