package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/explain"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
	"github.com/anthropics/anthropic-sdk-go/option"
)

func setup(t *testing.T) (*store.Store, http.Handler) {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"config", "user.email", "t@e"}, {"config", "user.name", "t"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	write := func(p, c string) {
		os.MkdirAll(filepath.Dir(filepath.Join(dir, p)), 0o755)
		os.WriteFile(filepath.Join(dir, p), []byte(c), 0o644)
	}
	write("app/main.py", "from app import util\n")
	write("app/util.py", "def f(): pass\n")
	write("app/__init__.py", "")
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.Snapshot("demo", store.Meta{}); err != nil {
		t.Fatal(err)
	}
	write("app/new.py", "from app import main\n")
	if _, _, err := st.Snapshot("demo", store.Meta{Kind: store.KindTool, Summary: "add new.py"}); err != nil {
		t.Fatal(err)
	}
	return st, New(st).Handler()
}

func get(t *testing.T, h http.Handler, url string, v any) int {
	t.Helper()
	req := httptest.NewRequest("GET", url, nil)
	req.Host = "127.0.0.1:7777"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if v != nil && rec.Code == 200 {
		if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
			t.Fatalf("%s: %v\n%s", url, err, rec.Body.String())
		}
	}
	return rec.Code
}

func TestAPI(t *testing.T) {
	_, h := setup(t)

	var meta struct {
		Sessions []struct {
			Name  string
			Steps int
		}
	}
	if get(t, h, "/api/meta", &meta) != 200 || len(meta.Sessions) != 1 || meta.Sessions[0].Steps != 2 {
		t.Fatalf("meta = %+v", meta)
	}

	var sess struct {
		Steps []struct {
			Tree    string
			Changes []struct{ Path string }
		}
	}
	if get(t, h, "/api/session?name=demo", &sess) != 200 || len(sess.Steps) != 2 || sess.Steps[1].Changes[0].Path != "app/new.py" {
		t.Fatalf("session = %+v", sess)
	}

	var graph struct {
		Graph struct {
			Files []struct{ P string }
			Edges [][4]int
		}
	}
	if code := get(t, h, "/api/graph?at="+sess.Steps[1].Tree, &graph); code != 200 || len(graph.Graph.Files) != 4 || len(graph.Graph.Edges) != 2 {
		t.Fatalf("graph (%d) = %+v", code, graph)
	}
	if get(t, h, "/api/graph", nil) != 200 {
		t.Fatal("the working tree should be mappable")
	}

	var diff struct {
		AddedFiles []string
		AddedDeps  [][2]string
	}
	get(t, h, "/api/diff?from="+sess.Steps[0].Tree+"&to="+sess.Steps[1].Tree, &diff)
	if len(diff.AddedFiles) != 1 || diff.AddedFiles[0] != "app/new.py" {
		t.Fatalf("diff = %+v", diff)
	}

	req := httptest.NewRequest("GET", "/api/file?at="+sess.Steps[1].Tree+"&path=app/util.py", nil)
	req.Host = "localhost:7777"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "def f()") {
		t.Fatalf("file: %d %s", rec.Code, rec.Body.String())
	}

	if get(t, h, "/", nil) != 200 || get(t, h, "/app.js", nil) != 200 {
		t.Fatal("the viewer should be served")
	}
}

func TestAPIRejectsBadInput(t *testing.T) {
	st, h := setup(t)
	if code := get(t, h, "/api/file?at=HEAD&path=../../etc/passwd", nil); code == 200 {
		t.Fatal("only mapped files may be read")
	}
	os.WriteFile(filepath.Join(st.Repo.Root, "secret.txt"), []byte("x"), 0o644)
	if code := get(t, h, "/api/file?path=secret.txt", nil); code == 200 {
		t.Fatal("files outside the map must not be served")
	}
	if code := get(t, h, "/api/graph?at=--output=x", nil); code != 400 {
		t.Fatalf("option-like revisions must be rejected, got %d", code)
	}
	if code := get(t, h, "/api/session?name=../x", nil); code != 400 {
		t.Fatalf("bad session names must be rejected, got %d", code)
	}
}

func TestOnlyLoopbackHosts(t *testing.T) {
	_, h := setup(t)
	for host, want := range map[string]int{
		"127.0.0.1:1234": 200, "localhost:1234": 200, "[::1]:1234": 200,
		"evil.example:1234": 403, "192.168.1.5:1234": 403,
	} {
		req := httptest.NewRequest("GET", "/api/meta", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("host %s: got %d, want %d", host, rec.Code, want)
		}
	}
	req := httptest.NewRequest("POST", "/api/meta", nil)
	req.Host = "127.0.0.1:1"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden && rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST without the token should be refused, got %d", rec.Code)
	}
}

func post(h http.Handler, url, token, origin, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", url, strings.NewReader(body))
	req.Host = "127.0.0.1:7777"
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("X-Rewind-Token", token)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestPatchAndRestore(t *testing.T) {
	st, h := setup(t)
	var meta struct{ Token string }
	get(t, h, "/api/meta", &meta)
	if len(meta.Token) != 32 {
		t.Fatalf("token = %q", meta.Token)
	}
	var sess struct{ Steps []struct{ Tree string } }
	get(t, h, "/api/session?name=demo", &sess)

	var p struct{ Patch string }
	get(t, h, "/api/patch?from="+sess.Steps[0].Tree+"&to="+sess.Steps[1].Tree, &p)
	if !strings.Contains(p.Patch, "+++ b/app/new.py") || !strings.Contains(p.Patch, "+from app import main") {
		t.Fatalf("patch:\n%s", p.Patch)
	}

	// Writes need the token, and must not come from another origin.
	body := `{"session":"demo","step":0,"dry":true}`
	if rec := post(h, "/api/restore", "", "", body); rec.Code != 403 {
		t.Fatalf("restore without token: %d", rec.Code)
	}
	if rec := post(h, "/api/restore", meta.Token, "http://evil.example", body); rec.Code != 403 {
		t.Fatalf("restore from another origin: %d", rec.Code)
	}

	newFile := filepath.Join(st.Repo.Root, "app", "new.py")
	rec := post(h, "/api/restore", meta.Token, "http://127.0.0.1:7777", body)
	var plan struct{ Write, Delete []string }
	json.Unmarshal(rec.Body.Bytes(), &plan)
	if rec.Code != 200 || len(plan.Delete) != 1 || plan.Delete[0] != "app/new.py" {
		t.Fatalf("dry run (%d): %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(newFile); err != nil {
		t.Fatal("a dry run must not touch files")
	}

	rec = post(h, "/api/restore", meta.Token, "", `{"session":"demo","step":0}`)
	if rec.Code != 200 {
		t.Fatalf("restore: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(newFile); !os.IsNotExist(err) {
		t.Fatal("restoring step 0 should delete the file added in step 1")
	}
	steps, _ := st.Steps("demo")
	if len(steps) != 3 || steps[2].Kind != store.KindRestore {
		t.Fatalf("a restore should be recorded as a step, got %d steps", len(steps))
	}
}

func TestExplainEndpoint(t *testing.T) {
	st, _ := setup(t)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, ev := range []string{
			`{"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"It adds "}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"app/new.py."}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}`,
			`{"type":"message_stop"}`,
		} {
			var m map[string]any
			json.Unmarshal([]byte(ev), &m)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", m["type"], ev)
		}
	}))
	defer api.Close()
	srv := New(st)
	srv.Explainer = explain.New(st.Repo.GitDir, option.WithBaseURL(api.URL), option.WithAPIKey("k"), option.WithMaxRetries(0))
	srv.AIReady = func() bool { return true }
	h := srv.Handler()
	var meta struct{ Token string }
	get(t, h, "/api/meta", &meta)

	body := `{"kind":"step","session":"demo","step":1}`
	if rec := post(h, "/api/explain", "", "", body); rec.Code != 403 {
		t.Fatalf("explain without the token must be refused (it spends money), got %d", rec.Code)
	}
	rec := post(h, "/api/explain", meta.Token, "", body)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"t":"It adds "`) || !strings.Contains(rec.Body.String(), `"done":true`) {
		t.Fatalf("explain stream (%d):\n%s", rec.Code, rec.Body.String())
	}
	if rec := post(h, "/api/explain", meta.Token, "", `{"kind":"file","path":"nope.py"}`); rec.Code != 400 {
		t.Fatalf("unknown file: %d", rec.Code)
	}
	srv.AIReady = func() bool { return false }
	rec = post(h, "/api/explain", meta.Token, "", `{"kind":"tour"}`)
	if !strings.Contains(rec.Body.String(), "ANTHROPIC_API_KEY") {
		t.Fatalf("without credentials the reply should explain how to set them up:\n%s", rec.Body.String())
	}
}

func TestSessionCarriesBisectResult(t *testing.T) {
	st, h := setup(t)
	os.WriteFile(filepath.Join(st.Repo.GitDir, "rewind", "bisect.json"), []byte(`{"session":"demo","culprit":1,"lastGood":0,"command":"make test"}`), 0o644)
	var sess struct {
		Bisect *struct {
			Culprit int
			Command string
		}
	}
	if get(t, h, "/api/session?name=demo", &sess) != 200 || sess.Bisect == nil || sess.Bisect.Culprit != 1 || sess.Bisect.Command != "make test" {
		t.Fatalf("session should carry the last bisect result: %+v", sess.Bisect)
	}
}
