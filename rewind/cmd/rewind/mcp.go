package main

// rewind mcp: a Model Context Protocol server over stdio, so coding agents
// can query the code map, read their own history, checkpoint, rewind and
// bisect. Each tool runs the matching CLI command and returns its text,
// so agents see exactly what a person would.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/codemap"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/gitx"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
)

var mcpVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

const mcpInstructions = `Rewind knows the structure of this repository and records every step of your session as a snapshot.
- Before changing unfamiliar code, call overview, find_symbol, file_deps and callers instead of searching file by file.
- Before editing a file other code depends on, call impact to see what can break and which tests to run.
- Call snapshot before a risky change. If a change goes wrong, call steps and show_step, then undo_step (one step) or restore (go back to a step).
- When tests fail and you do not know which of your changes caused it, call bisect with the test command.`

type mcpTool struct {
	Name        string         `json:"name"`
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
	run         func(c *cli, a mcpArgs) error
}

type mcpArgs map[string]any

func (a mcpArgs) str(k string) string {
	switch v := a[k].(type) {
	case string:
		return v
	case float64:
		return fmt.Sprint(int64(v))
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

func (a mcpArgs) flag(k string) bool { b, _ := a[k].(bool); return b }

func (a mcpArgs) list(k string) []string {
	var out []string
	switch v := a[k].(type) {
	case []any:
		for _, x := range v {
			if s, ok := x.(string); ok && s != "" {
				out = append(out, s)
			}
		}
	case string:
		out = strings.Fields(v)
	}
	return out
}

// at adds --at when the caller asked for a snapshot.
func (a mcpArgs) at(args ...string) []string {
	if at := a.str("at"); at != "" {
		args = append(args, "--at", at)
	}
	return args
}

func (a mcpArgs) need(keys ...string) error {
	for _, k := range keys {
		if a.str(k) == "" && len(a.list(k)) == 0 {
			return fmt.Errorf("missing argument %q", k)
		}
	}
	return nil
}

func schema(required []string, props map[string]any) map[string]any {
	s := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func prop(typ, desc string) map[string]any { return map[string]any{"type": typ, "description": desc} }

var (
	readOnly    = map[string]any{"readOnlyHint": true, "openWorldHint": false}
	writes      = map[string]any{"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}
	destructive = map[string]any{"readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}
	atProp      = prop("string", "optional: a step (\"7\", \"last\", \"session:3\") or git revision to look at instead of the current files")
	stepProp    = prop("string", "a step number in the current session, \"last\", or \"session:number\"")
)

var mcpTools = []mcpTool{
	{
		Name: "overview", Title: "Repository overview",
		Description: "Summarise the repository: languages, folders by size, entry points, the most depended-on files, third-party packages, dependency cycles and hotspots. A good first call in an unfamiliar codebase.",
		InputSchema: schema(nil, map[string]any{"at": atProp}), Annotations: readOnly,
		run: func(c *cli, a mcpArgs) error { return c.overviewCmd(a.at()) },
	},
	{
		Name: "find_symbol", Title: "Find a definition",
		Description: "Find where a function, method, class or type is defined across the repository, with how many places call it. Falls back to similar names when there is no exact match.",
		InputSchema: schema([]string{"name"}, map[string]any{"name": prop("string", "the name, e.g. parseConfig or Server.Start"), "at": atProp}), Annotations: readOnly,
		run: func(c *cli, a mcpArgs) error {
			if err := a.need("name"); err != nil {
				return err
			}
			return c.findCmd(a.at(a.str("name")))
		},
	},
	{
		Name: "file_deps", Title: "File dependencies",
		Description: "For one source file: the repository files it imports, the files that import it, its third-party imports, and every function, class and type it defines with line numbers.",
		InputSchema: schema([]string{"file"}, map[string]any{"file": prop("string", "path relative to the repository root"), "at": atProp}), Annotations: readOnly,
		run: func(c *cli, a mcpArgs) error {
			if err := a.need("file"); err != nil {
				return err
			}
			return c.depsCmd(a.at(a.str("file")))
		},
	},
	{
		Name: "callers", Title: "Who calls this",
		Description: "List every place that calls a function (file and line), and every function it calls. Matches made only by method name are marked likely.",
		InputSchema: schema([]string{"file", "function"}, map[string]any{
			"file": prop("string", "the file that defines the function"), "function": prop("string", "the function or method name"), "at": atProp,
		}), Annotations: readOnly,
		run: func(c *cli, a mcpArgs) error {
			if err := a.need("file", "function"); err != nil {
				return err
			}
			return c.callersCmd(a.at(a.str("file"), a.str("function")))
		},
	},
	{
		Name: "impact", Title: "What can break",
		Description: "List every file that depends, directly or through other files, on the given files (or on what a recorded step changed), grouped by distance, with test files marked. Use it before editing widely used code, and to choose which tests to run.",
		InputSchema: schema(nil, map[string]any{
			"files": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "files relative to the repository root"},
			"step":  prop("string", "instead of files: a recorded step, to see what its changes can affect"),
		}), Annotations: readOnly,
		run: func(c *cli, a mcpArgs) error {
			if s := a.str("step"); s != "" {
				return c.impactCmd([]string{"--step", s})
			}
			if err := a.need("files"); err != nil {
				return err
			}
			return c.impactCmd(a.list("files"))
		},
	},
	{
		Name: "cycles", Title: "Dependency cycles",
		Description: "List import cycles between files and between folders.",
		InputSchema: schema(nil, map[string]any{"at": atProp}), Annotations: readOnly,
		run: func(c *cli, a mcpArgs) error { return c.cyclesCmd(a.at()) },
	},
	{
		Name: "steps", Title: "Session history",
		Description: "List the recorded steps of a session (by default the current one): what each step changed, the tool that made it, and the user prompts.",
		InputSchema: schema(nil, map[string]any{"session": prop("string", "optional: another session's name")}), Annotations: readOnly,
		run: func(c *cli, a mcpArgs) error {
			if s := a.str("session"); s != "" {
				return c.log([]string{"-s", s})
			}
			return c.log(nil)
		},
	},
	{
		Name: "show_step", Title: "Show a step",
		Description: "Show what one recorded step changed: its prompt, files, how it changed the structure of the code (new dependencies, new cycles), and optionally the full patch.",
		InputSchema: schema([]string{"step"}, map[string]any{"step": stepProp, "patch": prop("boolean", "include the full patch")}), Annotations: readOnly,
		run: func(c *cli, a mcpArgs) error {
			if err := a.need("step"); err != nil {
				return err
			}
			args := []string{a.str("step")}
			if a.flag("patch") {
				args = append(args, "-p")
			}
			return c.show(args)
		},
	},
	{
		Name: "snapshot", Title: "Checkpoint",
		Description: "Record the current files as a step, so you can come back to this point later. Call it before a risky change.",
		InputSchema: schema(nil, map[string]any{"message": prop("string", "what this checkpoint is")}), Annotations: writes,
		run: func(c *cli, a mcpArgs) error {
			if m := a.str("message"); m != "" {
				return c.snap([]string{"-m", m})
			}
			return c.snap(nil)
		},
	},
	{
		Name: "undo_step", Title: "Undo one step",
		Description: "Reverse the changes of one recorded step while keeping every change made after it. Fails without touching anything if later changes overlap. The state before the undo is recorded, so it can be reversed.",
		InputSchema: schema([]string{"step"}, map[string]any{"step": stepProp, "dry_run": prop("boolean", "only check that the undo applies")}), Annotations: destructive,
		run: func(c *cli, a mcpArgs) error {
			if err := a.need("step"); err != nil {
				return err
			}
			args := []string{a.str("step")}
			if a.flag("dry_run") {
				args = append(args, "-n")
			}
			return c.undo(args)
		},
	},
	{
		Name: "restore", Title: "Go back to a step",
		Description: "Put every file back exactly as it was at a recorded step. The current state is recorded first, so a restore can be undone. Ignored files are never touched.",
		InputSchema: schema([]string{"step"}, map[string]any{"step": stepProp, "dry_run": prop("boolean", "only list the files that would change")}), Annotations: destructive,
		run: func(c *cli, a mcpArgs) error {
			if err := a.need("step"); err != nil {
				return err
			}
			args := []string{a.str("step")}
			if a.flag("dry_run") {
				args = append(args, "-n")
			}
			return c.restore(args)
		},
	},
	{
		Name: "bisect", Title: "Find the step that broke it",
		Description: "Binary-search the recorded steps of a session with a test command to find the first step where it fails: exit 0 is pass, 125 is cannot-test, anything else is fail. Reports the step, its prompt and change, and the failing output. The files are put back exactly as they were afterwards.",
		InputSchema: schema([]string{"command"}, map[string]any{
			"command":         prop("string", "shell command that passes when things work, e.g. \"go test ./...\" or \"npm test -- auth\""),
			"good":            prop("string", "optional: a step known to pass (default: the first step)"),
			"bad":             prop("string", "optional: a step known to fail (default: the last step)"),
			"session":         prop("string", "optional: the session to search (default: the current one)"),
			"timeout_seconds": prop("integer", "optional: per-run limit; a run that takes longer counts as failing (default 600)"),
			"isolated":        prop("boolean", "optional: test temporary copies instead of the work tree (copies have no ignored files such as node_modules)"),
		}), Annotations: writes,
		run: func(c *cli, a mcpArgs) error {
			if err := a.need("command"); err != nil {
				return err
			}
			var args []string
			for _, k := range []string{"good", "bad"} {
				if v := a.str(k); v != "" {
					args = append(args, "--"+k, v)
				}
			}
			if s := a.str("session"); s != "" {
				args = append(args, "-s", s)
			}
			if t := a.str("timeout_seconds"); t != "" {
				args = append(args, "--timeout", t+"s")
			}
			if a.flag("isolated") {
				args = append(args, "--isolated")
			}
			return c.bisectCmd(append(args, "--", a.str("command")))
		},
	},
}

// ---------------------------------------------------------------- protocol

type rpcMsg struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type mcpServer struct {
	out  io.Writer
	wmu  sync.Mutex // one message per line, never interleaved
	work sync.Mutex // tools run one at a time: they share the work tree

	mu        sync.Mutex
	dir       string // repository to serve; "" until known
	an        *codemap.Analyzer
	roots     bool // the client can tell us its workspace folders
	cancels   map[string]context.CancelFunc
	nextReqID int
}

func cmdMCP(args []string, stdin io.Reader, out io.Writer) error {
	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	repo := fs.String("repo", "", "repository to serve (default: the current directory, or the client's workspace)")
	if err := parse(fs, args); err != nil {
		return err
	}
	s := &mcpServer{out: out, cancels: map[string]context.CancelFunc{}}
	dir := *repo
	if dir == "" {
		dir = os.Getenv("REWIND_REPO")
	}
	if dir == "" || strings.Contains(dir, "${") { // an editor that did not expand ${workspaceFolder}
		dir = "."
	}
	s.useRepo(dir)
	return s.serve(stdin)
}

// useRepo serves the repository containing dir, if it is one.
func (s *mcpServer) useRepo(dir string) bool {
	r, err := gitx.Open(dir)
	if err != nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dir != r.Root {
		s.dir, s.an = r.Root, codemap.NewAnalyzer(r.Root)
	}
	return true
}

func (s *mcpServer) serve(in io.Reader) error {
	r := bufio.NewReaderSize(in, 1<<16)
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		line, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var m rpcMsg
			if jerr := json.Unmarshal(line, &m); jerr != nil {
				s.send(rpcMsg{ID: json.RawMessage("null"), Error: &rpcError{-32700, "parse error"}})
			} else if m.Method == "tools/call" && m.ID != nil {
				wg.Add(1)
				go func() { defer wg.Done(); s.call(m) }()
			} else {
				s.handle(m)
			}
		}
		if err == io.EOF {
			return nil
		} else if err != nil {
			return err
		}
	}
}

func (s *mcpServer) send(m rpcMsg) {
	m.JSONRPC = "2.0"
	b, _ := json.Marshal(m)
	s.wmu.Lock()
	defer s.wmu.Unlock()
	s.out.Write(append(b, '\n'))
}

func (s *mcpServer) reply(id json.RawMessage, result any) {
	b, _ := json.Marshal(result)
	s.send(rpcMsg{ID: id, Result: b})
}

func (s *mcpServer) fail(id json.RawMessage, code int, msg string) {
	s.send(rpcMsg{ID: id, Error: &rpcError{code, msg}})
}

func (s *mcpServer) notify(method string, params any) {
	b, _ := json.Marshal(params)
	s.send(rpcMsg{Method: method, Params: b})
}

func (s *mcpServer) handle(m rpcMsg) {
	if m.Method == "" { // a response to one of our requests
		s.rootsReply(m)
		return
	}
	switch m.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
			Capabilities    struct {
				Roots *struct{} `json:"roots"`
			} `json:"capabilities"`
		}
		json.Unmarshal(m.Params, &p)
		v := mcpVersions[0]
		for _, known := range mcpVersions {
			if p.ProtocolVersion == known {
				v = known
			}
		}
		s.mu.Lock()
		s.roots = p.Capabilities.Roots != nil
		s.mu.Unlock()
		s.reply(m.ID, map[string]any{
			"protocolVersion": v,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "rewind", "title": "Rewind", "version": version},
			"instructions":    mcpInstructions,
		})
	case "notifications/initialized", "notifications/roots/list_changed":
		s.askRoots()
	case "notifications/cancelled":
		var p struct {
			RequestID json.RawMessage `json:"requestId"`
		}
		json.Unmarshal(m.Params, &p)
		s.mu.Lock()
		if cancel := s.cancels[string(p.RequestID)]; cancel != nil {
			cancel()
		}
		s.mu.Unlock()
	case "ping":
		s.reply(m.ID, map[string]any{})
	case "tools/list":
		s.reply(m.ID, map[string]any{"tools": mcpTools})
	default:
		if m.ID != nil && !strings.HasPrefix(m.Method, "notifications/") {
			s.fail(m.ID, -32601, "method not found: "+m.Method)
		}
	}
}

// askRoots asks the client for its workspace folders when the server was
// not started inside a repository.
func (s *mcpServer) askRoots() {
	s.mu.Lock()
	ask := s.roots && s.dir == ""
	s.nextReqID++
	id := fmt.Sprintf(`"roots-%d"`, s.nextReqID)
	s.mu.Unlock()
	if ask {
		s.send(rpcMsg{ID: json.RawMessage(id), Method: "roots/list"})
	}
}

func (s *mcpServer) rootsReply(m rpcMsg) {
	var res struct {
		Roots []struct {
			URI string `json:"uri"`
		} `json:"roots"`
	}
	if m.Error != nil || json.Unmarshal(m.Result, &res) != nil {
		return
	}
	for _, r := range res.Roots {
		u, err := url.Parse(r.URI)
		if err != nil || u.Scheme != "file" {
			continue
		}
		p := u.Path
		if len(p) > 2 && p[0] == '/' && p[2] == ':' { // file:///C:/Users/... on Windows
			p = p[1:]
		}
		if s.useRepo(filepath.FromSlash(p)) {
			return
		}
	}
}

func (s *mcpServer) call(m rpcMsg) {
	var p struct {
		Name      string  `json:"name"`
		Arguments mcpArgs `json:"arguments"`
		Meta      struct {
			ProgressToken json.RawMessage `json:"progressToken"`
		} `json:"_meta"`
	}
	if err := json.Unmarshal(m.Params, &p); err != nil {
		s.fail(m.ID, -32602, "invalid params")
		return
	}
	var tool *mcpTool
	for i := range mcpTools {
		if mcpTools[i].Name == p.Name {
			tool = &mcpTools[i]
		}
	}
	if tool == nil {
		s.fail(m.ID, -32602, "unknown tool: "+p.Name)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.mu.Lock()
	s.cancels[string(m.ID)] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.cancels, string(m.ID))
		s.mu.Unlock()
	}()

	s.work.Lock()
	text, err := s.runTool(ctx, tool, p.Arguments, p.Meta.ProgressToken)
	s.work.Unlock()
	if ctx.Err() != nil {
		return // cancelled: the client expects no reply
	}
	if err != nil {
		if text != "" {
			text += "\n"
		}
		text += "Error: " + err.Error()
	}
	s.reply(m.ID, map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}, "isError": err != nil})
}

func (s *mcpServer) runTool(ctx context.Context, tool *mcpTool, args mcpArgs, progressToken json.RawMessage) (string, error) {
	s.mu.Lock()
	dir, an := s.dir, s.an
	s.mu.Unlock()
	if dir == "" {
		return "", errors.New("rewind is not running inside a git repository; start it with `rewind mcp --repo <path>`, or run `rewind init <agent>` inside the repository")
	}
	st, err := store.Open(dir)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	c := &cli{st: st, out: &buf, an: an, ctx: ctx, base: dir}
	if len(progressToken) > 0 && string(progressToken) != "null" {
		n := 0
		c.progress = func(msg string) {
			n++
			s.notify("notifications/progress", map[string]any{"progressToken": progressToken, "progress": n, "message": msg})
		}
	}
	err = tool.run(c, args)
	return strings.TrimRight(buf.String(), "\n"), err
}
