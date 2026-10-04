# Rewind for VS Code

Undo history and a code map for AI coding agents, inside your editor.

- **Rewind: Open Code Map** opens the interactive map in an editor tab: architecture, who calls what, cycles, hotspots, and a replay of each agent session.
- **Rewind: Show Session Steps…** lists every step of the current session. Pick one to see its diff, open the map, or restore your files to it.
- **Rewind: Record Agent Sessions…** sets up recording for Claude Code, Codex, Gemini CLI or Cursor in this repository.
- **Rewind: Start or Stop Watching Files** records steps for any tool (Aider, Copilot, or your own edits) by watching for changes.

The status bar shows the current session and step; click it to open the map.

## Requirements

The `rewind` command must be installed. If it isn't on your PATH, set **Rewind: Path** (`rewind.path`) in your settings to its full location.

## Install

```sh
code --install-extension rewind-0.3.0.vsix
```
