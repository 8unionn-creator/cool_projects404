// Package server serves the code map viewer and its JSON API on localhost.
package server

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/codemap"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/gitx"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
)

//go:embed web
var web embed.FS

// Server holds the state behind the viewer.
type Server struct {
	st *store.Store
	an *codemap.Analyzer

	churnOnce sync.Once
	churn     map[string]int
}

// New returns a server for the repository behind st.
func New(st *store.Store) *Server {
	return &Server{st: st, an: codemap.NewAnalyzer(st.Repo.Root)}
}

// Handler returns the HTTP handler. Only requests addressed to a loopback
// host are served, which blocks DNS-rebinding attacks from web pages.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(web, "web")
	mux.Handle("/", http.FileServer(http.FS(static)))
	mux.HandleFunc("/api/meta", s.meta)
	mux.HandleFunc("/api/graph", s.graph)
	mux.HandleFunc("/api/session", s.session)
	mux.HandleFunc("/api/diff", s.diff)
	mux.HandleFunc("/api/file", s.file)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHost(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'")
		mux.ServeHTTP(w, r)
	})
}

func loopbackHost(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// ---------------------------------------------------------------- handlers

func (s *Server) meta(w http.ResponseWriter, r *http.Request) {
	sessions, err := s.st.Sessions()
	if err != nil {
		fail(w, err, 500)
		return
	}
	_, headErr := s.st.Repo.Git("rev-parse", "--verify", "--quiet", "HEAD^{tree}")
	type sess struct {
		Name    string `json:"name"`
		Steps   int    `json:"steps"`
		Updated int64  `json:"updated"`
		Current bool   `json:"current"`
	}
	list := []sess{}
	for _, x := range sessions {
		list = append(list, sess{x.Name, x.Steps, x.Updated.Unix(), x.Current})
	}
	reply(w, map[string]any{"root": filepath.Base(s.an.Root), "sessions": list, "hasHead": headErr == nil})
}

var hexID = regexp.MustCompile(`^[0-9a-f]{40,64}$`)

// tree turns ?at= into a tree id: "worktree" (default), "HEAD", or a tree id.
func (s *Server) tree(at string) (string, error) {
	switch at {
	case "", "worktree":
		return s.st.WorkTree()
	case "HEAD":
		return "HEAD", nil
	}
	if !hexID.MatchString(at) {
		return "", errBadRequest("at must be worktree, HEAD or a tree id")
	}
	return at, nil
}

func (s *Server) graph(w http.ResponseWriter, r *http.Request) {
	tree, err := s.tree(r.URL.Query().Get("at"))
	if err != nil {
		fail(w, err, 400)
		return
	}
	start := time.Now()
	g, err := s.an.Analyze(tree)
	if err != nil {
		fail(w, err, 400)
		return
	}
	s.churnOnce.Do(func() { s.churn = codemap.Churn(s.st.Repo.Root, "HEAD") })
	churn := map[string]int{}
	for _, f := range g.Files {
		if c := s.churn[f.Path]; c > 0 {
			churn[f.Path] = c
		}
	}
	reply(w, map[string]any{
		"graph":   g,
		"churn":   churn,
		"cycles":  cyclesJSON(g.Cycles()),
		"elapsed": time.Since(start).Milliseconds(),
	})
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if !store.ValidName(name) {
		fail(w, errBadRequest("invalid session name"), 400)
		return
	}
	steps, err := s.st.Steps(name)
	if err != nil {
		fail(w, err, 404)
		return
	}
	type change struct {
		Path    string `json:"path"`
		Added   int    `json:"added"`
		Deleted int    `json:"deleted"`
	}
	type step struct {
		Step    int      `json:"step"`
		Kind    string   `json:"kind"`
		Tool    string   `json:"tool,omitempty"`
		Summary string   `json:"summary"`
		Prompt  string   `json:"prompt,omitempty"`
		Time    int64    `json:"time"`
		Tree    string   `json:"tree"`
		Changes []change `json:"changes"`
	}
	out := make([]step, len(steps))
	for i, st := range steps {
		out[i] = step{st.Step, st.Kind, st.Tool, st.Summary, st.Prompt, st.Time.Unix(), st.Tree, []change{}}
		if i == 0 {
			continue
		}
		files, err := s.st.Changes(steps[i-1].Tree, st.Tree)
		if err != nil {
			fail(w, err, 500)
			return
		}
		for _, f := range files {
			out[i].Changes = append(out[i].Changes, change{f.Path, f.Added, f.Deleted})
		}
	}
	reply(w, map[string]any{"name": name, "steps": out})
}

func (s *Server) diff(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from, err1 := s.tree(q.Get("from"))
	to, err2 := s.tree(q.Get("to"))
	if err1 != nil || err2 != nil {
		fail(w, errBadRequest("from and to must be tree ids"), 400)
		return
	}
	a, err := s.an.Analyze(from)
	if err != nil {
		fail(w, err, 400)
		return
	}
	b, err := s.an.Analyze(to)
	if err != nil {
		fail(w, err, 400)
		return
	}
	d := codemap.Compare(a, b)
	edges := func(es []codemap.DirEdge) [][2]string {
		out := [][2]string{}
		for _, e := range es {
			out = append(out, [2]string{e.From, e.To})
		}
		return out
	}
	reply(w, map[string]any{
		"addedFiles":    nonNil(d.AddedFiles),
		"removedFiles":  nonNil(d.RemovedFiles),
		"addedDeps":     edges(d.AddedDeps),
		"removedDeps":   edges(d.RemovedDeps),
		"addedExternal": nonNil(d.AddedExternal),
		"newCycles":     cyclesJSON(d.NewCycles),
	})
}

// file returns the source of one analysed file, for the code preview.
func (s *Server) file(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	tree, err := s.tree(q.Get("at"))
	if err != nil {
		fail(w, err, 400)
		return
	}
	g, err := s.an.Analyze(tree)
	if err != nil {
		fail(w, err, 400)
		return
	}
	p := q.Get("path")
	if g.Index(p) < 0 { // only files that are part of the map can be read
		fail(w, errBadRequest("unknown file"), 404)
		return
	}
	out, err := s.st.Repo.Run(gitx.Cmd{Args: []string{"cat-file", "blob", g.Tree + ":" + p}})
	if err != nil {
		fail(w, err, 500)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(out))
}

// ---------------------------------------------------------------- helpers

type errBadRequest string

func (e errBadRequest) Error() string { return string(e) }

func reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, err error, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

func cyclesJSON(cs []codemap.Cycle) []map[string]any {
	out := []map[string]any{}
	for _, c := range cs {
		out = append(out, map[string]any{"level": c.Level, "members": c.Members})
	}
	return out
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
