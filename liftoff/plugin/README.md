# Liftoff plugin

The Liftoff plugin (VST3, AU on macOS, standalone) built with [JUCE 8](https://juce.com).

- **UI:** the web page from `liftoff/` (`index.html`, `params.js`, `dsp.js`, `worklet.js`, `app.js`), bundled into the plugin and shown in JUCE's `WebBrowserComponent`. The page talks to C++ through native functions (`getParams`, `setParam`, `gesture`, `launch`, `setPreset`) and gets `state` (build progress, countdown, meters, tempo, latency) and `params` (host automation) events. It shows what you *hear*: the state is delayed by the plugin's latency.
- **Parameters:** built at load time from the list in `params.js`, so the page and the DAW always agree. 24 automatable parameters, including **Build** for riding the build by hand.
- **Sound:** `Source/Core.cpp` is a sample-for-sample port of `dsp.js`. `Engine` adds the delay line and `juce::dsp::Convolution` (non-uniform partitioned, zero latency) with the reversed reverb. The reverb's length is the backverb length at the DAW's tempo. It is rebuilt off the audio thread when the length, size, tone or tempo change, and reported with `setLatencySamples` so the DAW compensates.
- **MIDI:** in **Trigger** mode a note-on starts a build, sample-accurately, that drops *Build length* later. The AU is a music effect (`aumf`) so Logic can send it MIDI through the side-chain MIDI menu. VST3 MIDI-CC emulation is off, so the DAW's parameter list has only Liftoff's own parameters.

## Build

```
cmake -B build -DCMAKE_BUILD_TYPE=Release          # downloads JUCE 8.0.15; or add -DJUCE_DIR=/path/to/JUCE
cmake --build build --config Release --target Liftoff_VST3 Liftoff_Standalone
```

Add `--target Liftoff_AU` on macOS. Windows needs the WebView2 SDK: `nuget install Microsoft.Web.WebView2 -Version 1.0.3485.44 -OutputDirectory C:\webview2`, then configure with `-DJUCE_WEBVIEW2_PACKAGE_LOCATION=C:/webview2`. Linux needs `libwebkit2gtk-4.1-dev` and the usual JUCE packages (see `.github/workflows/liftoff.yml`).

## Test

```
cmake -B build -DLF_TESTS=ON && cmake --build build --target LiftoffEngineTest LiftoffHostTest Liftoff_VST3
build/LiftoffEngineTest_artefacts/Release/LiftoffEngineTest --dump core.raw
node ../tests/parity.js core.raw
build/LiftoffHostTest_artefacts/Release/LiftoffHostTest build/Liftoff_artefacts/Release/VST3/Liftoff.vst3
```

- **Engine test:** everything off is a wire with no latency. The latency equals the backverb length and follows the tempo. A hit on the drop comes out exactly one latency later, with a swell rising from silence into it and nothing after it. Any block size gives the same output. AUTO drops on the phrase's downbeat, and a MIDI note drops a bar later.
- **Parity:** the C++ core and `dsp.js` render four scenarios (every gap style and backverb mode, pitch, stutter, width, impact, noise, mix, output) and must agree to 1e-4. They agree to about 1e-7.
- **Host test:** loads the built VST3 the way a DAW does. It checks for exactly 24 parameters, the reported latency, 10 seconds of audio through it, and that its state saves and loads.

## Release

GitHub Actions builds and tests every change. To publish a release with the installers, push a tag such as `liftoff-v0.1.0`, or open **Actions → liftoff plugin → Run workflow** and fill in **release_tag**.
