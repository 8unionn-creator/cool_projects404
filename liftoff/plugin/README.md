# Liftoff plugin

The Liftoff plugin (VST3, AU on macOS, standalone) built with [JUCE 8](https://juce.com).

- **UI:** the web page from `liftoff/` (`index.html`, `params.js`, `dsp.js`, `transition.js`, `app.js`), bundled into the plugin and shown in JUCE's `WebBrowserComponent`. The page talks to C++ through native functions and gets `state` (preview position, recording, build progress, meters, tempo, latency) and `params` (host automation) events.
- **SAMPLE mode** (where a new instance opens): the track passes through dry with no latency. `recStart` / `recStop` capture up to 60 s of the track and save the take under `Liftoff/Recordings`; `pickSample`, `storeSample` and `getSample` load files and remember the sample's path in the session. The page renders the transition itself (`transition.js`, the same code as the browser) at the session's sample rate and hands it over with `setRender`. `preview` plays it on top of the track through the plugin's output, `audition` plays the part of the sample you cut (or a VARY take), `saveRender` writes a 24-bit WAV, and the clip strip under the page (a waveform thumbnail of the render) drags it into the DAW.
- **IN SONG:** `setCue` turns it on with the bar the drop is on. While the DAW plays, `processBlock` adds the render where the song is (`lf::cueStart` / `lf::cueMix` in `Core.h`), so the render's drop point (`endAt`, sent with `setRender`) lands on that bar's downbeat. Once the render stops changing it is written to `Liftoff/In Song` and its path saved with the session, so a reopened session plays it before its window has been opened.
- **Your presets:** `getUserPresets` / `setUserPresets` read and write `Liftoff/User Presets.json`, shared by every session. The selected preset is saved with the session as a key (`f:3` factory, `u:0` yours).
- **LIVE mode:** the C++ engine below builds into every drop as an insert effect. `setView` switches modes; LIVE reports the backverb length as latency. The page shows what you *hear*: in LIVE mode the state is delayed by the plugin's latency.
- **Parameters:** built at load time from the list in `params.js`, so the page and the DAW always agree. 28 automatable parameters, including **Build** for riding the build by hand.
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

- **Engine test:** IN SONG lands the riser's drop on the chosen bar's downbeat at any block size, and plays nothing outside the riser. Everything off is a wire with no latency. The latency equals the backverb length and follows the tempo. A hit on the drop comes out exactly one latency later, with a swell rising from silence into it and nothing after it. Any block size gives the same output. AUTO drops on the phrase's downbeat, and a MIDI note drops a bar later.
- **Parity:** the C++ core and `dsp.js` render four scenarios (every tremolo shape, chorus, every backverb mode, pitch, stutter, width, noise, mix, output, and the drop code LIVE mode keeps) and must agree to 1e-4. They agree to about 1e-8, including the pitch shifter's splice search (a wrong pick there would show up as a large difference).
- **Host test:** loads the built VST3 the way a DAW does. It checks for exactly 28 parameters (tremolo and chorus, no DROP ones), that a new instance opens in SAMPLE mode with no latency and passes audio through untouched, and that its state saves and loads.

## Release

GitHub Actions builds and tests every change. To publish a release with the installers, push a tag such as `liftoff-v0.1.0`, or open **Actions → liftoff plugin → Run workflow** and fill in **release_tag**.

## Signed releases

Without anything set up, the macOS bundles are signed ad hoc and nothing is signed on Windows, so macOS and SmartScreen warn people the first time (INSTALL.md says what to click). To ship signed, notarized installers, add these repository secrets (**Settings → Secrets and variables → Actions**); the workflow uses them when they are there:

| Secret | What |
|---|---|
| `MACOS_CERT_P12` | Your **Developer ID Application** certificate and key, exported from Keychain Access as .p12, then `base64 -i cert.p12` |
| `MACOS_CERT_PASSWORD` | The .p12's password |
| `MACOS_INSTALLER_CERT_P12`, `MACOS_INSTALLER_CERT_PASSWORD` | Your **Developer ID Installer** certificate (signs the .pkg). Optional: without it the bundles are signed but the .pkg is not |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | For notarization: your Apple ID, your team ID, and an app-specific password from appleid.apple.com |
| `WINDOWS_CERT_PFX`, `WINDOWS_CERT_PASSWORD` | A code-signing certificate as .pfx (`base64 -w0 cert.pfx`) and its password: signs the VST3, the app and Setup.exe |

Developer ID certificates come with the Apple Developer Program. With them, the bundles are signed with the hardened runtime (`installer/macos/entitlements.plist` lets the app use the microphone) and the .pkg is notarized and stapled, and the release notes leave out the "Open Anyway" steps.

