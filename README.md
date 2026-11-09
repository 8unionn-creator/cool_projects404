# cool_projects404

Things I build to sharpen my skills and make my own work easier.

| Project | What it is | Stack |
|---|---|---|
| [⏪ Rewind](rewind/) | Undo history and a code map for AI coding agents: every agent step saved as a Git snapshot you can restore, `rewind bisect` to find the step that broke the tests, an interactive map that replays what the agent changed, and an MCP server so agents can use it themselves | Go, Git internals, static analysis, MCP |
| [🍅 Tomato Dial](tomato-dial/) | A focus timer you set by dragging a kitchen-timer dial, with tasks, ambient sounds and stats | HTML, CSS, JS, Web Audio |
| [💿 Spin Room](spin-room/) | A record player and CD player that spin to your beats, made to screen-record for TikTok | HTML, CSS, JS, Web Audio |

## ⏪ Rewind — [`rewind/`](rewind/)

![rewind CI](https://github.com/8unionn-creator/cool_projects404/actions/workflows/rewind.yml/badge.svg)

When an AI agent breaks something at step 14 of 30, `rewind restore 13` gets you back, without losing steps 1–12 or touching your branch. Each step is stored as a real Git commit under `refs/rewind/`, tagged with the prompt that caused it. Install the hooks with `rewind init claude` (or `codex`, `gemini`, `cursor`).

When the tests fail, `rewind bisect -- npm test` binary-searches the agent's steps and names the one that broke them, with its prompt and diff. `rewind undo <step>` then takes back just that step and keeps everything after it. Agents get the same powers through `rewind mcp`: they can query the code map, check what an edit can break, checkpoint, undo and bisect.

`rewind map` opens an interactive map of the codebase (12 languages: Go, Python, TypeScript/JavaScript, Java, Kotlin, C#, C/C++, Rust, PHP, Ruby, Dart) and replays the session on it: which code each step touched, what depends on it, and which step added a dependency or an import cycle. [Read more →](rewind/README.md)

![Rewind map](rewind/docs/map-step.png)

## 🍅 Tomato Dial — [`tomato-dial/`](tomato-dial/index.html)

A focus timer that works like a real kitchen timer. Drag the dial to set the minutes, pick a task, and press Start.

**What it does**
- **Draggable dial timer** for Focus, Short break and Long break sessions, with a long break after every 4 tomatoes (you can change that)
- **Task list**: estimate each task in tomatoes. Each finished session adds one to the task you're working on, and the list shows how many hours of work are left
- **Background sound made in the browser** (no audio files): brown noise, rain, a fan, and an optional ticking clock
- **Bell and a shaking dial** when time is up, plus optional desktop notifications
- **Stats**: minutes and tomatoes today, your day streak, and a 14-day chart
- Keeps counting in a background tab and survives a page reload. Keeps the screen awake while running.
- Shortcuts: `Space` start/pause · `R` reset · `S` skip · `N` new task
- Light and dark themes, works on phones

**How to run it:** open `tomato-dial/index.html` in any browser. Nothing to install, no build step. Your data stays in your browser's localStorage and is never sent anywhere.

## 💿 Spin Room — [`spin-room/`](spin-room/index.html)

A 9:16 music showcase for TikTok. Load your beats, and a turntable or a portable CD player spins them: the tonearm drops and tracks across the record as the beat plays, the platter spins up and slows down like a real one, and the sound bars and background glow move with the bass.

**What it does**
- **Eleven players:** turntable, portable CD player, both together, a record on its own, a CD on its own, a cassette tape (the reels turn and the tape winds across as the beat plays), a pocket MP3 player (cover, title and live sound bars on its screen), a boombox (the speakers pump with the bass), a jukebox (neon arch, a record spinning behind the glass, your title on the selection card), a reel-to-reel tape machine (winding reels and moving VU needles) and a car stereo (your title scrolling on the display and a light ring that follows the bass)
- **Finds BPM and key by itself** when you add a beat (½ and ×2 buttons fix a tempo read at half or double speed)
- **Your tag on everything:** producer name, beat title, BPM, key, handle and tagline. Cover art prints on the record label and the CD, and can blur into the background. BPM and key in file names like `night_drive_140bpm_F#min.mp3` are used before detection
- **Two formats:** vertical 9:16 for TikTok, Reels and Shorts, or widescreen 16:9 for YouTube (deck on the left, your title and sound bars on the right)
- **Looks:** 6 vinyl colors, 5 rooms, any accent color, 3 title styles, 33⅓ or 45 RPM
- **Record video:** makes a 1080 × 1920 (or 1920 × 1080) MP4 (H.264 + AAC, a steady 30 fps) with the beat's sound: 15, 30 or 60 seconds, or the whole beat, from any start time. It fades out at the end and the tonearm lifts. Frames are drawn and encoded one by one with WebCodecs, so nothing is dropped even on a busy phone; browsers without it record live instead. Save it straight to your phone and upload it to TikTok, Reels or YouTube Shorts
- **Full-screen mode** for screen recorders instead: hides the controls, counts down and plays. A guide shows where TikTok's buttons and caption will cover the video
- Comes with a built-in demo beat made in the browser, so it works before you add anything

**How to use it:** open `spin-room/index.html` in a browser. Add beats, style it, pick a start time and length, then tap **Record** and keep the screen open while it records. Tap **Save video** when it's done. Beats stay on your device and are never uploaded.

**Install it as an app:** with GitHub Pages turned on for this repo (Settings → Pages → Deploy from a branch → the default branch, `/ (root)`), it lives at `https://8unionn-creator.github.io/cool_projects404/spin-room/`. Open that in Safari and choose Share → Add to Home Screen (on Android, Chrome → Install app). It then opens full screen with no browser bars, which keeps them out of your recordings, and works offline.

**Where the video goes:** **Save video** opens the share menu on iPhone (choose Save Video to put it in Photos) and downloads it elsewhere. Then in TikTok tap **+** → **Upload**.

