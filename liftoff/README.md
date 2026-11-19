# 🛫 Liftoff

**Record or load a sample, cut the part you want, and Liftoff turns it into a riser.** Your sound pitches up, thins out, stutters, washes out and widens, with a noise riser on top, a chorus to thicken it and a tremolo pulsing on your grid. A one-shot (a snare, a chop) is retriggered faster and faster into a roll. A reverse swell made from the sound's own first hit rises into the end of the riser, right where your drop goes. Preview it, then drag it into your DAW or export the WAV.

It runs in the browser (open `index.html`) and as a **VST3 / Audio Unit** plugin, with the same interface in both. The plugin also has a **LIVE** mode: an insert effect that builds into every drop on your DAW's bars.

![Liftoff](docs/liftoff.png)

## How it works

1. **Get a sample.** Press **REC**. The browser records your microphone; the plugin records the audio coming down its own track, so play your loop, vocal or synth in the DAW and press REC again to stop. Recordings are trimmed to the sound. Or **Load** a file, drop one anywhere, or try a demo (a house loop, a snare that becomes a roll, a chord stab).
2. **Cut the part you want.** The **SOURCE** lane under the screen shows your whole sample. Drag across it to choose the part to use, drag its edges to fine-tune, drag the bar on top to move it, and double-click for all of it. **PART** (or `A`) plays just that part.
3. **Shape it.** Pick the **RISER LENGTH** (½ to 8 bars), then dial in RISE, BACKVERB, TREMOLO and CHORUS, or pick a preset. Every change re-renders in the background.
4. **Hear it.** **PREVIEW** (or Space) plays the riser. In the plugin it plays through the plugin's output, so you hear it through your DAW and your interface. Click anywhere on the screen to play from there.
5. **Use it.** In the plugin, drag the riser from the clip strip under the window straight onto a track. It shows the waveform as soon as it's rendered. In the browser, drag **DRAG OUT** into a DAW, a folder or the desktop (Chrome, Edge), or press **EXPORT WAV** for a 24-bit WAV.

## The screen

The screen shows the riser's real waveform. It warms from dark to bright gold as it rises, its last beat turns violet where the reverse swell comes in, the **END** line marks where your drop goes, and the effects' tail fades out after it. The part of the sample you cut is a faint ghost behind it, the build curve runs through it like an automation lane, and the swell's shape is drawn on top. While it plays, the part already heard lights up, a playhead sweeps across, and the countdown reads LIFTOFF IN T–2 BARS, T–3… then LIFTOFF. In LIVE mode the screen follows your DAW's bars instead.

## The modules

- **RISE:** pitch up to +24 semitones, a high-pass sweep with rising resonance, a gate that speeds up from 1/4 to 1/32 notes, a reverb wash the sound dissolves into, stereo width, and a white-noise riser. One **CURVE** shapes the whole build: late (a slow start that rushes at the end) or early (it jumps up, then hangs).
- **BACKVERB:** a reverse reverb that lands on time. Normally that means bouncing audio, reversing it and lining it up by hand; Liftoff convolves the sound with a time-reversed reverb and pulls it back by the reverb's length. **END** swells from your sample's first hit into the end of the riser, **BUILD** puts reverse swells on everything, growing with the build, and **ALWAYS** puts them on every sound.
- **TREMOLO:** volume pulses locked to the grid: 1/4 to 1/32 notes, and 1/8 and 1/16 triplets. Shapes: **SINE**, **SQUARE** (hard chops), **RAMP** (pumping) or **PAN** (left and right take turns). **DEPTH** sets how deep.
- **CHORUS:** two modulated voices per side for width and thickness, with **RATE**, **DEPTH** and **MIX**.

## Presets

Liftoff · Festival Build · Trap Lift · Vocal Backverb · Afro Swell · Chorus Bloom · Washout · Stutter Riser · Reverse Into The 1 · Subtle Lift. Presets set the sound. Your timing (mode, phrase), MIX and OUTPUT stay as they are.

## In the browser

Open `liftoff/index.html`. Nothing to install. It opens with the demo loop, or with the last sample you used (kept in your browser). Set the **BPM** to your session's tempo so the bars line up; a BPM in the file name, like `vox_140bpm.wav`, is picked up. Your settings and samples stay in your browser and are never uploaded.

Shortcuts: `Space` preview · `R` record · `A` play the part you cut · `←` `→` presets. On knobs: drag up/down (`Shift` for fine), scroll, arrow keys, double-click to reset.

## As a plugin

Download the installer for your computer from the [releases](https://github.com/8unionn-creator/cool_projects404/releases) and follow [`plugin/INSTALL.md`](plugin/INSTALL.md). Put Liftoff on the track you want to sample. It opens in **SAMPLE** mode, passes that track through untouched, and takes the tempo from your DAW. The riser appears as a clip under the window: drag it onto a track. [Build it yourself →](plugin/README.md)

## Code

| File | |
|---|---|
| `dsp.js` | The DSP core, sample by sample: timeline, pitch shifter, SVF filters, stutter gate, chorus, 8-line FDN wash, noise riser, tremolo, width, and the backverb send. Also makes the reversed reverb. |
| `transition.js` | The part of the sample you cut in, a riser out: lays it over the build (looped, or a one-shot as a roll), runs the core, adds the backverb (and the END swell) by FFT convolution, and writes WAVs. |
| `params.js` | The 24 parameters and the presets. The plugin builds its DAW parameters from this same file. |
| `app.js`, `index.html` | The interface: the screen, the SOURCE lane, recording, loading, preview, drag out, export, presets, and the bridge to the plugin. |
| `plugin/Source/Core.cpp` | The same core in C++, for LIVE mode, plus the delay and JUCE's convolution. |
| `plugin/Source/PluginProcessor.cpp` | SAMPLE mode: records the track, plays the preview (or the part you cut) on top of it, and saves the sample's path with your session. The editor's clip strip drags the riser into the DAW. |

## Tests

```
node liftoff/tests/core-test.js         # the build, riser, tremolo, chorus, backverb, timing modes (23 checks)
node liftoff/tests/transition-test.js   # a sample becomes a riser: loop, roll, END swell, tremolo, chorus, FFT convolution (12 checks)
```

The plugin has two more, run by CI on Windows, macOS and Linux: `LiftoffEngineTest` (alignment of the swell with its hit, latency, block sizes, MIDI triggers) with `tests/parity.js` (the C++ engine and `dsp.js` produce the same samples), and `LiftoffHostTest`, which loads the built VST3 like a DAW (it opens in SAMPLE mode with no latency and passes the track through untouched). On macOS the Audio Unit also goes through `auval`.
