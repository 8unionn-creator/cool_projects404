// Package hook connects Rewind to coding agents.
//
// Agents run hook commands at fixed points in a session and pass a JSON
// description of the event on stdin. Each agent names things differently,
// so every payload is first normalised into an Event:
//
//	session start → record a baseline snapshot
//	prompt        → remember the prompt, snapshot any manual edits
//	tool          → snapshot what the tool changed, tagged with the prompt
//
// Supported: Claude Code, OpenAI Codex CLI, Gemini CLI and Cursor.
package hook

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
)

// Agents lists the agents Rewind can record.
var Agents = []string{"claude", "codex", "gemini", "cursor"}

// Event is one agent hook call, normalised.
type Event struct {
	Agent     string
	SessionID string
	Kind      string // "start", "prompt", "tool", or "" to ignore
	Cwd       string
	Prompt    string
	Tool      string
	Input     map[string]any
}

// payload is the union of the fields the supported agents send.
type payload struct {
	SessionID      string         `json:"session_id"`
	ConversationID string         `json:"conversation_id"` // Cursor
	Event          string         `json:"hook_event_name"`
	Cwd            string         `json:"cwd"`
	WorkspaceRoots []string       `json:"workspace_roots"` // Cursor
	Prompt         string         `json:"prompt"`
	ToolName       string         `json:"tool_name"`
	ToolInput      map[string]any `json:"tool_input"`
	FilePath       string         `json:"file_path"` // Cursor afterFileEdit
	Command        string         `json:"command"`   // Cursor afterShellExecution
}

// Parse reads one hook payload from an agent.
func Parse(agent string, r io.Reader) (Event, error) {
	var p payload
	if err := json.NewDecoder(r).Decode(&p); err != nil {
		return Event{}, fmt.Errorf("reading %s hook payload: %w", agent, err)
	}
	ev := Event{Agent: agent, SessionID: p.SessionID, Cwd: p.Cwd, Prompt: p.Prompt, Tool: p.ToolName, Input: p.ToolInput}
	switch agent {
	case "claude", "codex": // Codex uses the same event names and fields as Claude Code
		switch p.Event {
		case "SessionStart":
			ev.Kind = "start"
		case "UserPromptSubmit":
			ev.Kind = "prompt"
		case "PostToolUse":
			ev.Kind = "tool"
		}
	case "gemini":
		switch p.Event {
		case "SessionStart":
			ev.Kind = "start"
		case "BeforeAgent":
			ev.Kind = "prompt"
		case "AfterTool":
			ev.Kind = "tool"
		}
	case "cursor":
		ev.SessionID = p.ConversationID
		if ev.Cwd == "" && len(p.WorkspaceRoots) > 0 {
			ev.Cwd = p.WorkspaceRoots[0]
		}
		switch p.Event {
		case "beforeSubmitPrompt":
			ev.Kind = "prompt"
		case "afterFileEdit":
			ev.Kind, ev.Tool, ev.Input = "tool", "Edit", map[string]any{"file_path": p.FilePath}
		case "afterShellExecution":
			ev.Kind, ev.Tool, ev.Input = "tool", "Shell", map[string]any{"command": p.Command}
		case "stop": // catches anything the other hooks missed
			ev.Kind, ev.Tool = "tool", "end of turn"
		}
	default:
		return ev, fmt.Errorf("unknown agent %q (supported: %s)", agent, strings.Join(Agents, ", "))
	}
	return ev, nil
}

// Reply is what the hook must print on stdout for the agent to carry on.
func Reply(agent string, ev Event) string {
	switch agent {
	case "gemini":
		return "{}" // stdout must be JSON
	case "cursor":
		if ev.Kind == "prompt" {
			return `{"continue":true}`
		}
		return "{}"
	}
	return ""
}

// SessionName maps an agent's session id to a Rewind session name.
func SessionName(id string) string { return sessionName("claude", id) }

func sessionName(agent, id string) string {
	id = strings.ToLower(strings.NewReplacer("-", "", "_", "", ".", "").Replace(id))
	if len(id) > 8 {
		id = id[:8]
	}
	if id == "" || !store.ValidName(agent+"-"+id) {
		id = "unknown"
	}
	return agent + "-" + id
}

// Result reports what a hook invocation did.
type Result struct {
	Session string
	Step    *store.Step // nil when nothing changed or the event was ignored
}

// HandleClaude processes one Claude Code hook payload.
func HandleClaude(r io.Reader, fallbackDir string) (Result, error) {
	ev, err := Parse("claude", r)
	if err != nil {
		return Result{}, err
	}
	return Record(ev, fallbackDir)
}

// Record snapshots the repository for one event. Callers should treat
// errors as non-fatal: a recording failure must never block the agent.
func Record(ev Event, fallbackDir string) (Result, error) {
	dir := ev.Cwd
	if dir == "" {
		dir = fallbackDir
	}
	st, err := store.Open(dir)
	if err != nil {
		return Result{}, err // not a git repo: nothing to record
	}
	session := sessionName(ev.Agent, ev.SessionID)
	res := Result{Session: session}

	var meta store.Meta
	switch ev.Kind {
	case "start":
		meta = store.Meta{Kind: store.KindStart, Summary: ev.Agent + " session started"}
	case "prompt":
		if err := savePrompt(st, session, ev.Prompt); err != nil {
			return res, err
		}
		meta = store.Meta{Kind: store.KindPrompt, Summary: "edits before prompt: " + store.OneLine(ev.Prompt, 50), Prompt: ev.Prompt}
	case "tool":
		meta = store.Meta{Kind: store.KindTool, Tool: ev.Tool, Summary: describeTool(ev, st.Repo.Root), Prompt: loadPrompt(st, session)}
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

var patchFile = regexp.MustCompile(`(?m)^\*\*\* (?:Update|Add|Delete) File: (.+)$`)

// describeTool builds a one-line summary such as "Edit internal/store/store.go".
func describeTool(ev Event, root string) string {
	str := func(k string) string { v, _ := ev.Input[k].(string); return v }
	target := ""
	for _, k := range []string{"file_path", "notebook_path", "path", "absolute_path"} {
		if target = str(k); target != "" {
			break
		}
	}
	if target != "" {
		return ev.Tool + " " + relPath(root, target)
	}
	// Codex's apply_patch names its files inside the patch text.
	for _, k := range []string{"input", "patch"} {
		if m := patchFile.FindAllStringSubmatch(str(k), -1); len(m) > 0 {
			var files []string
			for _, x := range m {
				files = append(files, relPath(root, strings.TrimSpace(x[1])))
			}
			if len(files) > 3 {
				files = append(files[:3], fmt.Sprintf("+%d more", len(files)-3))
			}
			return ev.Tool + " " + strings.Join(files, ", ")
		}
	}
	if cmd := str("command"); cmd != "" {
		return ev.Tool + ": " + store.OneLine(cmd, 60)
	}
	if ev.Tool == "" {
		return "tool call"
	}
	return ev.Tool
}

// relPath makes target relative to root. Paths may arrive through a symlink
// (macOS's /var is /private/var), so both sides are resolved before giving up.
func relPath(root, target string) string {
	inside := func(r, t string) (string, bool) {
		rel, err := filepath.Rel(r, t)
		return filepath.ToSlash(rel), err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	if !filepath.IsAbs(target) {
		return filepath.ToSlash(target)
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
