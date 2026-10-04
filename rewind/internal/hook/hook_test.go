package hook

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
)

func repo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"config", "user.email", "t@e"}, {"config", "user.name", "t"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	return dir
}

func send(t *testing.T, dir string, ev map[string]any) Result {
	t.Helper()
	ev["cwd"] = dir
	ev["session_id"] = "ABCDEF12-3456-7890-abcd-ef1234567890"
	b, _ := json.Marshal(ev)
	res, err := HandleClaude(strings.NewReader(string(b)), dir)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestClaudeSessionIsRecordedWithPrompts(t *testing.T) {
	dir := repo(t)
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0o644)

	if r := send(t, dir, map[string]any{"hook_event_name": "SessionStart"}); r.Step == nil || r.Session != "claude-abcdef12" {
		t.Fatalf("SessionStart should record a baseline: %+v", r)
	}
	send(t, dir, map[string]any{"hook_event_name": "UserPromptSubmit", "prompt": "add a func"})
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc f() {}\n"), 0o644)
	r := send(t, dir, map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Edit",
		"tool_input": map[string]any{"file_path": filepath.Join(dir, "main.go")}})
	if r.Step == nil {
		t.Fatal("an edit should create a step")
	}
	if r.Step.Summary != "Edit main.go" || r.Step.Prompt != "add a func" || r.Step.Tool != "Edit" {
		t.Fatalf("unexpected step: %+v", r.Step.Meta)
	}
	// A read-only tool call changes nothing, so it adds no step.
	if r := send(t, dir, map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Bash",
		"tool_input": map[string]any{"command": "ls"}}); r.Step != nil {
		t.Fatal("no-op tool call should not create a step")
	}
	// Unknown events are ignored.
	if r := send(t, dir, map[string]any{"hook_event_name": "Notification"}); r.Step != nil {
		t.Fatal("unhandled events should be ignored")
	}

	st, _ := store.Open(dir)
	if st.Current() != "claude-abcdef12" {
		t.Fatalf("hook should make its session current, got %q", st.Current())
	}
	steps, _ := st.Steps("claude-abcdef12")
	if len(steps) != 2 {
		t.Fatalf("want 2 steps, got %d", len(steps))
	}
}

func TestNotARepoIsAnError(t *testing.T) {
	dir := t.TempDir()
	_, err := HandleClaude(strings.NewReader(`{"hook_event_name":"SessionStart","cwd":"`+dir+`"}`), dir)
	if err == nil {
		t.Fatal("expected an error outside a repository")
	}
}

func TestInstallClaudeMergesAndIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".claude", "settings.local.json")
	os.MkdirAll(filepath.Dir(path), 0o755)
	existing := `{"model":"x","hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"lint"}]}]}}`
	os.WriteFile(path, []byte(existing), 0o644)

	added, err := InstallClaude(path, "rewind hook claude")
	if err != nil || added != 3 {
		t.Fatalf("added=%d err=%v", added, err)
	}
	if added, _ := InstallClaude(path, "rewind hook claude"); added != 0 {
		t.Fatalf("second install should add nothing, added %d", added)
	}
	var s map[string]any
	b, _ := os.ReadFile(path)
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	if s["model"] != "x" {
		t.Fatal("existing settings were lost")
	}
	post := s["hooks"].(map[string]any)["PostToolUse"].([]any)
	if len(post) != 2 || !strings.Contains(string(b), `"lint"`) {
		t.Fatalf("existing hook was not kept: %s", b)
	}
}

func TestSessionName(t *testing.T) {
	if got := SessionName(""); got != "claude-unknown" {
		t.Fatal(got)
	}
	if !store.ValidName(SessionName("9f1c2b7e-aaaa-bbbb-cccc-dddddddddddd")) {
		t.Fatal("session names must be valid ref names")
	}
}

func TestRelPathThroughSymlink(t *testing.T) {
	target := t.TempDir()
	os.MkdirAll(filepath.Join(target, "src"), 0o755)
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("symlinks not supported:", err)
	}
	if got := relPath(target, filepath.Join(link, "src", "a.go")); got != "src/a.go" {
		t.Fatalf("got %q", got)
	}
	if got := relPath(target, filepath.Join(target, "src", "gone.go")); got != "src/gone.go" {
		t.Fatalf("got %q", got)
	}
	if got := relPath(target, "/elsewhere/x.go"); got != "/elsewhere/x.go" {
		t.Fatalf("paths outside the repo should stay absolute, got %q", got)
	}
}
