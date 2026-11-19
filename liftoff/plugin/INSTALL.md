# Installing Liftoff

Liftoff is an effect: riser, reverse reverb and pre-drop cut in one, locked to your bars. It comes as a **VST3** (most DAWs), an **Audio Unit** on macOS (Logic, GarageBand), and a **standalone app**.

## The easy way: the installers

Download from the [releases page](https://github.com/8unionn-creator/cool_projects404/releases):

- **Mac:** `Liftoff-macOS-Installer.pkg`. Open it and click through. It puts the Audio Unit and the VST3 in `/Library/Audio/Plug-Ins` and the app in Applications. Then in Logic, click an **Audio FX** slot and pick **Audio Units → cool_projects404 → Liftoff**.
- **Windows:** `Liftoff-Windows-Setup.exe`. Run it and click through. It puts the VST3 in `C:\Program Files\Common Files\VST3`. Rescan plugins in your DAW (FL Studio: *Options → Manage plugins → Find plugins*) and put **Liftoff** on a mixer track.

These builds are not signed with a paid Apple or Microsoft certificate, so the first time:

- **Mac:** if macOS says it cannot check the installer, open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. On macOS 14 and older you can also right-click the installer and choose **Open**.
- **Windows:** if SmartScreen says it protected your PC, click **More info → Run anyway**.

## By hand, from the zip

### Windows

1. Copy the `Liftoff.vst3` folder to `C:\Program Files\Common Files\VST3\`.
2. Rescan plugins in your DAW and put **Liftoff** on a track, a bus or the master.

The interface uses Microsoft Edge WebView2, which Windows 10 and 11 already include.

### macOS

1. Copy `Liftoff.vst3` to `~/Library/Audio/Plug-Ins/VST3/` and `Liftoff.component` to `~/Library/Audio/Plug-Ins/Components/`.
2. These builds are not notarized by Apple, so macOS blocks them at first. Open **Terminal** and run:

   ```
   xattr -dr com.apple.quarantine ~/Library/Audio/Plug-Ins/VST3/Liftoff.vst3 ~/Library/Audio/Plug-Ins/Components/Liftoff.component
   killall -9 AudioComponentRegistrar
   ```

3. Restart your DAW.

### Linux

Copy `Liftoff.vst3` to `~/.vst3/`.

## Using it

- **AUTO** (default): press play. The build fills the end of every phrase (16 bars by default, the last 4 of them) and drops on the next phrase's first bar: bars 17, 33, 49… Set **PHRASE** and **BUILD LENGTH** to match your song. The countdown shows how far away the drop is.
- **MANUAL**: automate **Build** from 0 up to 100% over your build, hold it at 100% for the gap, and drop it to 0 on the drop.
- **TRIGGER**: send Liftoff a MIDI note where a build should start (or press **LAUNCH**): it drops *BUILD LENGTH* later.
  - **FL Studio:** in Liftoff's wrapper settings, give it a MIDI input port, and point a MIDI Out channel at the same port. Notes in that channel's pattern then launch builds.
  - **Logic:** Liftoff is a MIDI-controlled effect: in the side-chain menu in the Liftoff window's header, pick the Software Instrument track whose notes should launch builds.
  - **Ableton Live** does not send MIDI to audio effects: use AUTO or automate Build.

Liftoff reports its backverb length as latency, from 1/8 note up to a bar. Your DAW compensates, so everything stays in time. Turn **BACKVERB** off for zero latency, for example while recording.
