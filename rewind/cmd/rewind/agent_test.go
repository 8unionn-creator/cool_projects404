package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// pyRepo records a session where step 2 breaks test_calc.py.
func pyRepo(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	dir := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"config", "user.email", "t@e"}, {"config", "user.name", "t"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	wd, _ := os.Getwd()
	t.Cleanup(func() { os.Chdir(wd) })
	os.Chdir(dir)
	w := func(name, body string) { os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644) }
	sh := func(args ...string) {
		t.Helper()
		if err := run(args, nil, io.Discard); err != nil {
			t.Fatalf("rewind %v: %v", args, err)
		}
	}
	w("calc.py", "from util import mul\n\ndef add(a, b):\n    return a + b\n")
	w("util.py", "def mul(a, b):\n    return a * b\n")
	w("check.sh", "grep -q 'a + b' calc.py || { echo 'add is broken'; exit 1; }\n")
	sh("start", "demo")
	w("util.py", "def mul(a, b):\n    return a * b\n\ndef sq(x):\n    return mul(x, x)\n")
	sh("snap", "-m", "add sq")
	w("calc.py", "from util import mul\n\ndef add(a, b):\n    return a - b\n")
	sh("snap", "-m", "refactor add")
	w("README.md", "docs\n")
	sh("snap", "-m", "docs")
	return dir
}

func TestBisectAndUndoCLI(t *testing.T) {
	dir := pyRepo(t)
	var out bytes.Buffer
	if err := run([]string{"bisect", "--", "sh", "check.sh"}, nil, &out); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Step 2 broke it", "refactor add", "calc.py", "add is broken", "rewind undo 2", "rewind restore 1"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("bisect output missing %q:\n%s", want, out.String())
		}
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "README.md")); string(b) != "docs\n" {
		t.Fatal("files must be put back after bisect")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, ".git", "rewind", "bisect.json")); !strings.Contains(string(b), `"culprit":2`) {
		t.Fatalf("bisect result not saved: %s", b)
	}
	out.Reset()
	if err := run([]string{"undo", "2"}, nil, &out); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "calc.py")); !strings.Contains(string(b), "a + b") {
		t.Fatalf("undo did not revert calc.py:\n%s", b)
	}
	if _, err := os.Stat(filepath.Join(dir, "README.md")); err != nil {
		t.Fatal("undo must keep later steps' changes")
	}
	out.Reset()
	run([]string{"find", "sq"}, nil, &out)
	if !strings.Contains(out.String(), "util.py:4") {
		t.Fatalf("find:\n%s", out.String())
	}
}

// mcpSession drives `rewind mcp` with one request per line and returns the
// responses by id.
func mcpSession(t *testing.T, dir string, reqs ...string) map[string]map[string]any {
	t.Helper()
	in := strings.Join(reqs, "\n") + "\n"
	var out bytes.Buffer
	if err := cmdMCP([]string{"--repo", dir}, strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	res := map[string]map[string]any{}
	sc := bufio.NewScanner(&out)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("stdout must only carry JSON-RPC: %q", sc.Text())
		}
		if id, ok := m["id"]; ok {
			res[fmt.Sprint(id)] = m
		} else {
			res["note:"+fmt.Sprint(m["method"])] = m
		}
	}
	return res
}

func toolText(t *testing.T, m map[string]any) (string, bool) {
	t.Helper()
	r, _ := m["result"].(map[string]any)
	if r == nil {
		t.Fatalf("no result: %v", m)
	}
	c := r["content"].([]any)[0].(map[string]any)
	return c["text"].(string), r["isError"].(bool)
}

func TestMCP(t *testing.T) {
	dir := pyRepo(t)
	os.Chdir(t.TempDir()) // the server must not depend on its working directory
	res := mcpSession(t, dir,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"callers","arguments":{"file":"util.py","function":"mul"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"steps","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"file_deps","arguments":{"file":"nope.py"}}}`,
		`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"bisect","arguments":{"command":"sh check.sh"},"_meta":{"progressToken":7}}}`,
		`{"jsonrpc":"2.0","id":7,"method":"bogus"}`,
		`not json`,
	)
	init := res["1"]["result"].(map[string]any)
	if init["protocolVersion"] != "2025-06-18" || init["serverInfo"].(map[string]any)["name"] != "rewind" {
		t.Fatalf("initialize: %v", init)
	}
	tools := res["2"]["result"].(map[string]any)["tools"].([]any)
	if len(tools) != len(mcpTools) {
		t.Fatalf("tools/list returned %d tools", len(tools))
	}
	for _, x := range tools {
		tool := x.(map[string]any)
		if tool["inputSchema"].(map[string]any)["type"] != "object" || tool["description"] == "" {
			t.Fatalf("bad tool: %v", tool)
		}
	}
	if text, isErr := toolText(t, res["3"]); isErr || !strings.Contains(text, "calc.py") && !strings.Contains(text, "util.py") {
		t.Fatalf("callers: %s", text)
	}
	if text, _ := toolText(t, res["4"]); !strings.Contains(text, "refactor add") {
		t.Fatalf("steps: %s", text)
	}
	if text, isErr := toolText(t, res["5"]); !isErr || !strings.Contains(text, "nope.py") {
		t.Fatalf("errors must come back as tool errors: %s", text)
	}
	if text, isErr := toolText(t, res["6"]); isErr || !strings.Contains(text, "Step 2 broke it") {
		t.Fatalf("bisect: %s", text)
	}
	if res["note:notifications/progress"] == nil {
		t.Fatal("bisect should report progress when the client asks for it")
	}
	if res["7"]["error"].(map[string]any)["code"].(float64) != -32601 {
		t.Fatalf("unknown methods: %v", res["7"])
	}
	if res["<nil>"]["error"] == nil {
		t.Fatal("bad JSON should get a parse error")
	}
}

func TestUpdate(t *testing.T) {
	binary := []byte("new rewind binary")
	sum := sha256.Sum256(binary)
	name := assetName()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/releases":
			fmt.Fprintf(w, `[{"tag_name":"other-v9.0.0","assets":[]},
				{"tag_name":"rewind-v99.1.0","prerelease":true,"assets":[]},
				{"tag_name":"rewind-v0.4.0","assets":[]},
				{"tag_name":"rewind-v1.2.0","html_url":"x","assets":[{"name":%q,"browser_download_url":"%s/bin"},{"name":"checksums.txt","browser_download_url":"%s/sums"}]}]`, name, srv.URL, srv.URL)
		case "/bin":
			w.Write(binary)
		case "/sums":
			fmt.Fprintf(w, "%s  %s\n", hex.EncodeToString(sum[:]), name)
		}
	}))
	defer srv.Close()
	old := releasesAPI
	releasesAPI = srv.URL + "/releases"
	defer func() { releasesAPI = old }()

	client := &http.Client{Timeout: 5 * time.Second}
	rel, err := latestRelease(client)
	if err != nil || rel.Tag != "rewind-v1.2.0" {
		t.Fatalf("latest = %q, %v (drafts, prereleases and other tags must be ignored)", rel.Tag, err)
	}
	var out bytes.Buffer
	if err := cmdUpdate([]string{"--check"}, &out); err != nil || !strings.Contains(out.String(), "1.2.0 is available") {
		t.Fatalf("check: %v %s", err, out.String())
	}
	want, err := checksum(client, rel.asset("checksums.txt"), name)
	if err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), "rewind")
	if err := download(client, rel.asset(name), dst, want); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != string(binary) {
		t.Fatal("download content")
	}
	if err := download(client, rel.asset(name), dst, strings.Repeat("0", 64)); err == nil || !strings.Contains(err.Error(), "corrupt") {
		t.Fatalf("a checksum mismatch must fail, got %v", err)
	}
	for _, c := range [][2]string{{"0.10.0", "0.9.9"}, {"1.0", "0.99.1"}, {"0.5.1", "0.5.0"}} {
		if !newer(c[0], c[1]) || newer(c[1], c[0]) {
			t.Errorf("newer(%s, %s)", c[0], c[1])
		}
	}
	if newer("0.5.0", "0.5.0") {
		t.Error("equal versions are not newer")
	}
}
