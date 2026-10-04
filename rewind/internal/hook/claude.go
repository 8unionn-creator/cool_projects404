// Package hook connects Rewind to coding agents.
//
// Claude Code runs hook commands at fixed points in a session and passes a
// JSON description of the event on stdin. Rewind listens to three of them:
//
//	SessionStart     → record a baseline snapshot
//	UserPromptSubmit → remember the prompt, snapshot any manual edits
//	PostToolUse      → snapshot what the tool changed, tagged with the prompt
package hook

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
)

// ClaudeEvent is the subset of Claude Code's hook payload Rewind reads.
type ClaudeEvent struct {
	SessionID string         `json:"session_id"`
	Event     string         `json:"hook_event_name"`
	Cwd       string         `json:"cwd"`
	Prompt    string         `json:"prompt"`
	ToolName  string         `json:"tool_name"`
	ToolInput map[string]any `json:"tool_input"`
}

// SessionName maps a Claude Code session id to a Rewind session name.
func SessionName(id string) string {
	id = strings.ToLower(strings.ReplaceAll(id, "-", ""))
	if len(id) > 8 {
		id = id[:8]
	}
	if id == "" {
		id = "unknown"
	}
	return "claude-" + id
}

// Result reports what a hook invocation did.
type Result struct {
	Session string
	Step    *store.Step // nil when nothing changed or the event was ignored
}

// HandleClaude processes one hook payload. Callers should treat errors as
// non-fatal: a recording failure must never block the agent.
func HandleClaude(r io.Reader, fallbackDir string) (Result, error) {
	var ev ClaudeEvent
	if err := json.NewDecoder(r).Decode(&ev); err != nil {
		return Result{}, fmt.Errorf("reading hook payload: %w", err)
	}
	dir := ev.Cwd
	if dir == "" {
		dir = fallbackDir
	}
	st, err := store.Open(dir)
	if err != nil {
		return Result{}, err // not a git repo: nothing to record
	}
	session := SessionName(ev.SessionID)
	res := Result{Session: session}

	var meta store.Meta
	switch ev.Event {
	case "SessionStart":
		meta = store.Meta{Kind: store.KindStart, Summary: "session started"}
	case "UserPromptSubmit":
		if err := savePrompt(st, session, ev.Prompt); err != nil {
			return res, err
		}
		meta = store.Meta{Kind: store.KindPrompt, Summary: "edits before prompt: " + store.OneLine(ev.Prompt, 50), Prompt: ev.Prompt}
	case "PostToolUse":
		meta = store.Meta{Kind: store.KindTool, Tool: ev.ToolName, Summary: describeTool(ev, st.Repo.Root), Prompt: loadPrompt(st, session)}
	default:
		return res, nil
	}
	if err := st.SetCurrent(session); err != nil {
		return res, err
	}
	step, created, err := st.Snapshot(session, meta)
	if err != nil {
		return res, err
	}
	if created {
		res.Step = &step
	}
	return res, nil
}

// describeTool builds a one-line summary such as "Edit internal/store/store.go".
func describeTool(ev ClaudeEvent, root string) string {
	str := func(k string) string { v, _ := ev.ToolInput[k].(string); return v }
	target := str("file_path")
	if target == "" {
		target = str("notebook_path")
	}
	if target != "" {
		return ev.ToolName + " " + relPath(root, target)
	}
	if cmd := str("command"); cmd != "" {
		return ev.ToolName + ": " + store.OneLine(cmd, 60)
	}
	if ev.ToolName == "" {
		return "tool call"
	}
	return ev.ToolName
}

// relPath makes target relative to root. Paths may arrive through a symlink
// (macOS's /var is /private/var), so both sides are resolved before giving up.
func relPath(root, target string) string {
	inside := func(r, t string) (string, bool) {
		rel, err := filepath.Rel(r, t)
		return filepath.ToSlash(rel), err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	if rel, ok := inside(root, target); ok {
		return rel
	}
	realRoot, err1 := filepath.EvalSymlinks(root)
	// The file may have been deleted, so resolve its directory instead.
	realDir, err2 := filepath.EvalSymlinks(filepath.Dir(target))
	if err1 == nil && err2 == nil {
		if rel, ok := inside(realRoot, filepath.Join(realDir, filepath.Base(target))); ok {
			return rel
		}
	}
	return target
}

func promptPath(st *store.Store, session string) string {
	return filepath.Join(st.Repo.GitDir, "rewind", "prompts", session)
}

func savePrompt(st *store.Store, session, prompt string) error {
	p := promptPath(st, session)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, []byte(prompt), 0o644)
}

func loadPrompt(st *store.Store, session string) string {
	b, _ := os.ReadFile(promptPath(st, session))
	return string(b)
}

// LogError appends a hook failure to .git/rewind/hook.log, if a repo exists.
func LogError(dir string, err error) {
	st, openErr := store.Open(dir)
	if openErr != nil {
		return
	}
	p := filepath.Join(st.Repo.GitDir, "rewind", "hook.log")
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	f, ferr := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if ferr != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %v\n", time.Now().Format(time.RFC3339), err)
}
