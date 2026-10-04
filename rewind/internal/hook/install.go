package hook

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// claudeHooks lists the events Rewind registers for, with their matchers.
var claudeHooks = []struct{ Event, Matcher string }{
	{"SessionStart", ""},
	{"UserPromptSubmit", ""},
	{"PostToolUse", "Edit|MultiEdit|Write|NotebookEdit|Bash"},
}

// InstallClaude adds Rewind's hooks to a Claude Code settings file, keeping
// everything already in it. It is safe to run more than once.
func InstallClaude(settingsPath, command string) (added int, err error) {
	settings := map[string]any{}
	b, err := os.ReadFile(settingsPath)
	switch {
	case err == nil:
		if len(strings.TrimSpace(string(b))) > 0 {
			if err := json.Unmarshal(b, &settings); err != nil {
				return 0, fmt.Errorf("%s is not valid JSON: %w", settingsPath, err)
			}
		}
	case !errors.Is(err, os.ErrNotExist):
		return 0, err
	}

	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	for _, h := range claudeHooks {
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
	settings["hooks"] = hooks

	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		return 0, err
	}
	return added, os.WriteFile(settingsPath, append(out, '\n'), 0o644)
}

func hasCommand(groups []any, command string) bool {
	for _, g := range groups {
		gm, _ := g.(map[string]any)
		list, _ := gm["hooks"].([]any)
		for _, h := range list {
			hm, _ := h.(map[string]any)
			if c, _ := hm["command"].(string); c == command {
				return true
			}
		}
	}
	return false
}
