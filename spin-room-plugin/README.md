# Spin Room plugin

Spin Room as an Audio Unit, VST3 and standalone app, built with [JUCE 8](https://juce.com). Put it on the Master channel and play your beat: it catches the beat as it plays and shows Spin Room in its window, so the video, title and tags are made without exporting anything. See [INSTALL.md](INSTALL.md) to install and use it.

- **Catching the beat** (`Source/TakeRecorder.*`): the audio thread copies the master into a lock-free FIFO and posts start and stop events stamped with a sample position. A take starts when the DAW starts playing, or on `record()`, and ends when it stops, on `stop()`, or after 20 minutes. A writer thread drains the FIFO to a 24-bit WAV. It skips the silence before the music, trims the silence after it (keeping a 0.4 s tail), and drops runs under 1.5 s or silent ones. Takes go to `Music/Spin Room/Takes` with the DAW's BPM in the name, and are listed in `takes.json`. The sound passes through untouched, with no latency. The standalone app listens to the chosen input and outputs silence, so it can't feed back.
- **UI** (`Source/PluginEditor.*`): `spin-room/index.html` and the MP4 muxer, bundled into the plugin and served to JUCE's `WebBrowserComponent` as plain ASCII (non-ASCII as entities and `\u` escapes, so no web view can mis-read the encoding).
  - **Native functions:** `spinroom_status`, `spinroom_takes`, `spinroom_setAuto`, `spinroom_record`, `spinroom_stop`, `spinroom_getState` / `spinroom_setState` (the page's settings, saved with the session), `spinroom_copy`, `spinroom_saveBegin` / `spinroom_saveChunk` / `spinroom_saveEnd` (videos arrive in base64 pieces and go to `Movies/Spin Room`), `spinroom_reveal` and `spinroom_openFolder`.
  - **Takes:** served at `takes/<id>.wav`.
  - **Events:** `spinroom_status` while the window is open, and `spinroom_take` when a take is saved. The page then adds the take to its beats with the DAW's BPM.

## Build

```
cmake -B build -DCMAKE_BUILD_TYPE=Release          # downloads JUCE 8.0.15; or add -DJUCE_DIR=/path/to/JUCE
cmake --build build --config Release --target SpinRoom_AU SpinRoom_VST3 SpinRoom_Standalone
```

`SpinRoom_AU` is macOS only. On Linux, the VST3 and app build with `libwebkit2gtk-4.1-dev` and the usual JUCE packages. JUCE's Linux web view runs in a helper process and loses messages larger than a pipe's buffer, so Spin Room's page won't open there without patching JUCE. macOS and Windows show the page in-process.

## Test

```
cmake -B build -DSR_TESTS=ON && cmake --build build --target SpinRoomCaptureTest SpinRoomHostTest SpinRoom_VST3
build/SpinRoomCaptureTest_artefacts/Release/SpinRoomCaptureTest
build/SpinRoomHostTest_artefacts/Release/SpinRoomHostTest "build/SpinRoom_artefacts/Release/VST3/Spin Room.vst3"
```

- **Capture test:** a fake transport through the capture engine.
  - Play, then stop: one take, starting right on the sound, with trailing silence trimmed and the DAW's BPM.
  - Short and silent runs are not kept.
  - Manual record works with auto off.
  - Back-to-back runs become separate takes.
  - The list survives a restart, and no temp files are left.
- **Host test:** loads the built VST3 the way a DAW does.
  - Audio passes through untouched with no latency.
  - Stopping the transport saves the 4 seconds that played, named with the tempo.
  - The session state keeps the settings.
  - With catching off, playing saves nothing.

GitHub Actions (`.github/workflows/spin-room-plugin.yml`) builds a universal macOS build and runs both tests. It then makes the installer, installs it, and validates the AU with `auval` and both plugins with pluginval.

## Release

Push a tag such as `spin-room-v0.1.0`, or open **Actions → spin-room plugin → Run workflow** and fill in **release_tag**. Signing and notarization use the same repository secrets as Liftoff (see `liftoff/plugin/README.md`, "Signed releases"). Without them, the bundles are signed ad hoc.
