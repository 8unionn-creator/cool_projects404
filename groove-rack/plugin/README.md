# Groove Rack plugin

The Groove Rack plugin (VST3, AU on macOS, standalone) built with [JUCE 8](https://juce.com).

- **UI:** the web app from `groove-rack/` (`index.html`, `engine.js`, `presets.js`, `groove.js`, `app.js`), bundled into the plugin and shown in JUCE's `WebBrowserComponent`. In the plugin, the page talks to C++ through native functions (`setProject`, `setPlaying`, `audition`, `pickSample`, …) instead of playing audio itself.
- **Sound:** `Source/Engine.cpp` is a sampler, sequencer and mixer. It follows the DAW's tempo and position, plays the pattern sample-accurately (swing, rolls, 808 slides, hi-hat choke), sends it out as MIDI and plays tracks from incoming MIDI.
- **Kit:** `kit/*.wav` are the web app's synthesized sounds rendered to samples by `tools/render-kit.js`, so the plugin sounds like the browser version. `kit/default-project.json` is the beat a new instance opens with.

## Build

```
cmake -B build -DCMAKE_BUILD_TYPE=Release          # downloads JUCE 8.0.15; or add -DJUCE_DIR=/path/to/JUCE
cmake --build build --config Release --target GrooveRack_VST3 GrooveRack_Standalone
```

Add `--target GrooveRack_AU` on macOS. Windows needs the WebView2 SDK: `nuget install Microsoft.Web.WebView2 -Version 1.0.3485.44 -OutputDirectory C:\webview2`, then configure with `-DJUCE_WEBVIEW2_PACKAGE_LOCATION=C:/webview2`. Linux needs `libwebkit2gtk-4.1-dev` and the usual JUCE packages (see `.github/workflows/groove-rack.yml`).

## Test

```
cmake -B build -DGR_TESTS=ON && cmake --build build --target GrooveRackEngineTest
build/GrooveRackEngineTest_artefacts/Release/GrooveRackEngineTest out.wav
```

It plays the default beat through the engine the way a DAW would (8 bars at 150 BPM). It checks the audio level, that MIDI out carries every hit on the right notes, that at a different DAW tempo (100 BPM, starting mid-song) every kick lands within a sample of its beat, that DAW MIDI plays a track, and that a WAV from disk replaces a kit sound.

## After changing sounds or presets in the web app

```
node groove-rack/plugin/tools/render-kit.js      # needs Playwright with Chromium
```
