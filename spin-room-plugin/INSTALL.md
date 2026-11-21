# Installing Spin Room on a Mac

Spin Room comes as an **Audio Unit** (Logic Pro, GarageBand, FL Studio), a **VST3** (FL Studio, Ableton Live, Studio One, Reaper, Cubase, Bitwig) and a **standalone app**.

## The easy way: the installer

Download `SpinRoom-macOS-Installer.pkg` from the [releases page](https://github.com/8unionn-creator/cool_projects404/releases), open it and click through. It puts the Audio Unit and the VST3 in `/Library/Audio/Plug-Ins` and the app in Applications.

This build is not signed with a paid Apple certificate, so the first time, macOS may say it can't check the installer. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. On macOS 14 and older you can also right-click the installer and choose **Open**.

## By hand, from the zip

1. Copy `Spin Room.vst3` to `~/Library/Audio/Plug-Ins/VST3/`, `Spin Room.component` to `~/Library/Audio/Plug-Ins/Components/`, and `Spin Room.app` to Applications.
2. macOS blocks builds that aren't notarized at first. Open **Terminal** and run:

   ```
   xattr -dr com.apple.quarantine ~/Library/Audio/Plug-Ins/VST3/"Spin Room.vst3" ~/Library/Audio/Plug-Ins/Components/"Spin Room.component" "/Applications/Spin Room.app"
   killall -9 AudioComponentRegistrar
   ```

3. Restart your DAW.

## Using it

1. **Put it on the master.**
   - **FL Studio:** *Options → Manage plugins → Find plugins*, then put **Spin Room** in the last slot of the Master mixer track.
   - **Logic Pro:** on the Stereo Out channel, click an Audio FX slot and pick **Audio Units → cool_projects404 → Spin Room**.
   - **Other DAWs:** put Spin Room last on the master.
2. **Open Spin Room and play your beat from the top.** It catches the beat as it plays, with no export. When you stop, the take is trimmed and added to your beats with the DAW's exact BPM. Its key and hook are found for you.
   - Turn off **Catch the beat when I press play** to catch only when you press **Record**.
   - Takes are kept in **Music → Spin Room → Takes**.
3. **Make the video.** Pick a player and a look, then press **Record video** and **Save video**. Videos are saved to **Movies → Spin Room**.
4. **Post it.** At the bottom of the panel, copy the YouTube title, description and tags, or the TikTok caption.

Spin Room passes your sound through untouched and adds no latency. Its settings are saved with your DAW project.

## On its own: the Spin Room app

Open **Spin Room** from Applications, click **Options** (top left) and choose your audio input, then press **Record** and play your beat. To catch your DAW without the plugin, choose a loopback device such as BlackHole as the input. The app only listens; it doesn't play the input back out.
