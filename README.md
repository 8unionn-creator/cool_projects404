# cool_projects404

Things I build to sharpen my skills and make my own work easier.

| Project | What it is | Stack |
|---|---|---|
| [⏪ Rewind](rewind/) | Undo history and a code map for AI coding agents: every agent step saved as a Git snapshot you can restore, `rewind bisect` to find the step that broke the tests, an interactive map that replays what the agent changed, and an MCP server so agents can use it themselves | Go, Git internals, static analysis, MCP |
| [🍅 Tomato Dial](tomato-dial/) | A focus timer you set by dragging a kitchen-timer dial, with tasks, ambient sounds and stats | HTML, CSS, JS, Web Audio |

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
