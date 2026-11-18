# Installing Groove Rack

Groove Rack is a drum and bass groove maker. It comes as a **VST3** (most DAWs), an **Audio Unit** on macOS (Logic, GarageBand), and a **standalone app**.

## Windows

1. Copy the `Groove Rack.vst3` folder to `C:\Program Files\Common Files\VST3\`.
2. Rescan plugins in your DAW (FL Studio: *Options → Manage plugins → Find plugins*; Ableton: *Preferences → Plug-ins → Rescan*).
3. Load **Groove Rack** as an instrument.

The interface uses Microsoft Edge WebView2, which Windows 10 and 11 already include.

## macOS

1. Copy `Groove Rack.vst3` to `~/Library/Audio/Plug-Ins/VST3/` and `Groove Rack.component` to `~/Library/Audio/Plug-Ins/Components/`.
2. These builds are not notarized by Apple, so macOS blocks them at first. Open **Terminal** and run:

   ```
   xattr -dr com.apple.quarantine ~/Library/Audio/Plug-Ins/VST3/"Groove Rack.vst3" ~/Library/Audio/Plug-Ins/Components/"Groove Rack.component"
   ```

3. Restart your DAW. In Logic, load it as *Software Instrument → AU Instruments → cool_projects404 → Groove Rack*.

## Linux

Copy `Groove Rack.vst3` to `~/.vst3/`. It needs `libwebkit2gtk-4.1` (installed on most desktops).

## Using it in a DAW

- **Tempo and position** follow your DAW: change the tempo there and the groove, its echo and your exports follow. The loop lines up with your DAW's bars (in 4/4). When the DAW is stopped, the play button in the plugin plays the loop on its own at the DAW's tempo.
- **New patterns:** press GENERATE for a whole new groove in the genre on the screen (tap the genre to change it), or the dice on a channel for that channel alone. Simple, Med and Busy set how much happens; hold a dice for more options.
- **Your own sounds:** tap a channel's sample name (for example *bounce kick*) and choose a file, or drop a WAV, AIFF, MP3 or FLAC file onto the channel.
- **MIDI out:** the plugin sends the pattern as MIDI, so you can record it onto a MIDI track. Or drag the **Drag MIDI into your DAW** strip at the bottom onto a track to drop the whole loop as a MIDI clip, then edit it in your DAW's piano roll.
- **MIDI in:** notes from your DAW play the tracks, so you can program grooves in your DAW instead:
  - Drum, percussion and FX tracks listen for their own note on any channel: kick C1 (36), clap D#1 (39), closed hat F#1 (42), open hat A#1 (46), and so on. Each track's settings show its note.
  - Bass, 808 and log drum tracks listen on their own channel (the first one on channel 2), at the pitch you play.
- **MIDI files:** import a `.mid` from the menu (⋮ → Import MIDI file), or onto one track from its settings. Drum notes go to the matching tracks, other channels go to the bass.
- The project, including the samples you chose, is saved inside your DAW session.
