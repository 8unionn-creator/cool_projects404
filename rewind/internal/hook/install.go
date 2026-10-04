package hook

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Install describes where an agent keeps its hook configuration.
type Install struct {
	Agent string
	Path  string // relative to the repository root
	Note  string // what the user still has to do, if anything
}

// Installs lists the project-level hook files for each agent.
var Installs = map[string]Install{
	"claude": {"claude", ".claude/settings.local.json", ""},
	"codex":  {"codex", ".codex/hooks.json", "Codex asks you to trust new project hooks: run /hooks in Codex and approve them."},
	"gemini": {"gemini", ".gemini/settings.json", ""},
	"cursor": {"cursor", ".cursor/hooks.json", "Restart Cursor so it picks up the new hooks."},
}

type hookEvent struct{ Event, Matcher string }

var groupEvents = map[string][]hookEvent{
	"claude": {{"SessionStart", ""}, {"UserPromptSubmit", ""}, {"PostToolUse", "Edit|MultiEdit|Write|NotebookEdit|Bash"}},
	"codex":  {{"SessionStart", ""}, {"UserPromptSubmit", ""}, {"PostToolUse", ""}},
	"gemini": {{"SessionStart", ""}, {"BeforeAgent", ""}, {"AfterTool", ""}},
}

var cursorEvents = []string{"beforeSubmitPrompt", "afterFileEdit", "afterShellExecution", "stop"}

// InstallClaude adds Rewind's hooks to a Claude Code settings file.
func InstallClaude(settingsPath, command string) (int, error) {
	return InstallAgent("claude", settingsPath, command)
}

// InstallAgent adds Rewind's hooks to an agent's configuration file,
// keeping everything already in it. It is safe to run more than once.
func InstallAgent(agent, file, command string) (added int, err error) {
	settings := map[string]any{}
	b, err := os.ReadFile(file)
	switch {
	case err == nil:
		if len(strings.TrimSpace(string(b))) > 0 {
			if err := json.Unmarshal(b, &settings); err != nil {
				return 0, fmt.Errorf("%s is not valid JSON: %w", file, err)
			}
		}
	case !errors.Is(err, os.ErrNotExist):
		return 0, err
	}
	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}

	if agent == "cursor" { // {"version": 1, "hooks": {"event": [{"command": "..."}]}}
		if _, ok := settings["version"]; !ok {
			settings["version"] = 1
		}
		for _, ev := range cursorEvents {
			list, _ := hooks[ev].([]any)
			if hasFlatCommand(list, command) {
				continue
			}
			hooks[ev] = append(list, map[string]any{"command": command})
			added++
		}
	} else {
		events, ok := groupEvents[agent]
		if !ok {
			return 0, fmt.Errorf("unknown agent %q", agent)
		}
		for _, h := range events {
			groups, _ := hooks[h.Event].([]any)
			if hasCommand(groups, command) {
				continue
			}
			group := map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command}}}
			if h.Matcher != "" {
				group["matcher"] = h.Matcher
			}
			hooks[h.Event] = append(groups, group)
			added++
		}
	}
	settings["hooks"] = hooks

	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return 0, err
	}
	return added, os.WriteFile(file, append(out, '\n'), 0o644)
}

func hasCommand(groups []any, command string) bool {
	for _, g := range groups {
		gm, _ := g.(map[string]any)
		list, _ := gm["hooks"].([]any)
		if hasFlatCommand(list, command) {
			return true
		}
	}
	return false
}

func hasFlatCommand(list []any, command string) bool {
	for _, h := range list {
		hm, _ := h.(map[string]any)
		if c, _ := hm["command"].(string); c == command {
			return true
		}
	}
	return false
}
