// Package codemap builds a dependency map of a codebase straight from a git
// tree: which files exist, what they define, and which files they depend on.
//
// It understands Go (with the standard library's own parser), Python and
// JavaScript/TypeScript (with small tokenizers that skip strings and
// comments correctly). Imports are resolved to files inside the repository;
// anything that does not resolve is recorded as an external dependency.
//
// Parsed files are cached by blob id. Git stores identical content once, so
// analysing a second snapshot of the same repository only parses the files
// that changed, which is what makes per-step structural diffs cheap.
package codemap

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"path"
	"runtime"
	"sort"
	"strings"
	"sync"
)

// Lang identifies a source language.
type Lang string

// Supported languages.
const (
	Go         Lang = "go"
	Python     Lang = "py"
	JavaScript Lang = "js"
	TypeScript Lang = "ts"
)

// Symbol is a top-level definition (function, type, class, constant...).
type Symbol struct {
	Name     string `json:"n"`
	Kind     string `json:"k"`
	Line     int    `json:"l"`
	End      int    `json:"z,omitempty"` // last line of a function or type body
	Exported bool   `json:"e,omitempty"`
}

// Import is one import statement as written in the source.
type Import struct {
	Spec     string   // module path, package name or relative file path
	Line     int      // 1-based
	TypeOnly bool     // not a load-time dependency: TS `import type`, Python TYPE_CHECKING or function-local imports, Rust `mod`, Dart `part`
	Names    []string // Python: names in `from x import a, b`
	Alias    string   // Go: explicit package alias
}

// File is everything the parser learned about one file. Files are shared
// between graphs through the cache and must not be modified after parsing.
type File struct {
	Path       string
	Lang       Lang
	Lines      int
	Complexity int // decision points: if, for, case, &&, ||, catch...
	Test       bool
	Entry      bool // a program entry point (Go main, Python __main__ ...)
	Symbols    []Symbol
	Imports    []Import

	pkg       string              // package or namespace
	refs      map[string]bool     // identifiers used, for same-package links
	selectors map[string][]string // Go: X -> selectors used as X.Sel
	calls     []call              // call sites, resolved into Graph.Calls
}

// Edge says that file From depends on file To.
type Edge struct {
	From, To int
	Weight   int  // how many imported names/references back the edge
	TypeOnly bool // only imports that never run at load time (see Import.TypeOnly)
}

// Graph is the dependency map of one tree.
type Graph struct {
	Root     string // repository directory name
	Tree     string
	Files    []*File
	Edges    []Edge
	External [][]string // per file: unresolved, non-standard-library imports
	Entries  []bool     // per file: entry point (parser or package manifest)
	Calls    []Call     // function-level call graph

	index map[string]int
	out   [][]int // adjacency, by file index
	in    [][]int
}

// Index returns the position of path in Files, or -1.
func (g *Graph) Index(path string) int {
	if i, ok := g.index[path]; ok {
		return i
	}
	return -1
}

// DependsOn lists the files that file i imports.
func (g *Graph) DependsOn(i int) []int { return g.out[i] }

// UsedBy lists the files that import file i.
func (g *Graph) UsedBy(i int) []int { return g.in[i] }

// ---------------------------------------------------------------- analyzer

// Analyzer analyses trees of one repository, caching parsed files by blob.
type Analyzer struct {
	Root string

	mu     sync.Mutex
	parsed map[string]*File  // blob + path -> parsed file
	graphs map[string]*Graph // tree -> graph
	order  []string          // graph cache order, oldest first
}

// NewAnalyzer returns an analyzer for the repository at root.
func NewAnalyzer(root string) *Analyzer {
	return &Analyzer{Root: root, parsed: map[string]*File{}, graphs: map[string]*Graph{}}
}

const maxFileSize = 1 << 20 // larger files are almost always generated or bundled

// skipDir reports whether files under a directory are third-party or build
// output that would drown the map.
func skipDir(name string) bool {
	switch name {
	case "node_modules", "vendor", "third_party", "dist", "build", "out", "target",
		"testdata", "__pycache__", ".venv", "venv", "site-packages", ".next", ".git", "coverage",
		"obj", ".gradle", ".idea", "Pods", "DerivedData", ".dart_tool", ".pub-cache", "cmake-build-debug",
		"cmake-build-release", ".cargo", "bower_components", "jspm_packages":
		return true
	}
	return false
}

// IsSource reports whether the map understands a file, by its name.
func IsSource(p string) bool { return langOf(p) != "" }

func langOf(p string) Lang {
	if strings.HasSuffix(p, ".min.js") || strings.HasSuffix(p, ".d.ts") {
		return ""
	}
	switch path.Ext(p) {
	case ".go":
		return Go
	case ".py":
		return Python
	case ".js", ".jsx", ".mjs", ".cjs":
		return JavaScript
	case ".ts", ".tsx", ".mts", ".cts":
		return TypeScript
	case ".java":
		return Java
	case ".kt", ".kts":
		return Kotlin
	case ".cs":
		return CSharp
	case ".c", ".h":
		return C
	case ".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".h++", ".ipp", ".tpp":
		return Cpp
	case ".rs":
		return Rust
	case ".php":
		return PHP
	case ".rb", ".rake":
		return Ruby
	case ".dart":
		return Dart
	}
	return ""
}

func wanted(e Entry) bool {
	if e.Size > maxFileSize || langOf(e.Path) == "" {
		return false
	}
	for _, part := range strings.Split(path.Dir(e.Path), "/") {
		if skipDir(part) {
			return false
		}
	}
	return true
}

// Analyze builds the graph of a tree (any tree-ish git accepts).
func (a *Analyzer) Analyze(treeish string) (*Graph, error) {
	// Cache by tree id, never by name: "HEAD" means something new after a commit.
	tree, err := resolveTree(a.Root, treeish)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	if g, ok := a.graphs[tree]; ok {
		a.mu.Unlock()
		return g, nil
	}
	a.mu.Unlock()

	src, err := openTree(a.Root, tree)
	if err != nil {
		return nil, err
	}
	defer src.close()

	type job struct {
		e    Entry
		data []byte
	}
	var files []*File
	var todo []job
	slot := map[string]int{}
	for _, e := range src.entries {
		if !wanted(e) {
			continue
		}
		key := e.Blob + "\x00" + e.Path
		a.mu.Lock()
		f, ok := a.parsed[key]
		a.mu.Unlock()
		slot[e.Path] = len(files)
		files = append(files, f)
		if !ok {
			data, err := src.read(e.Blob)
			if err != nil {
				return nil, err
			}
			todo = append(todo, job{e, data})
		}
	}

	// Parse uncached files in parallel.
	var wg sync.WaitGroup
	jobs := make(chan job)
	for w := 0; w < runtime.NumCPU(); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				f := parse(j.e.Path, j.data)
				a.mu.Lock()
				a.parsed[j.e.Blob+"\x00"+j.e.Path] = f
				a.mu.Unlock()
				files[slot[j.e.Path]] = f
			}
		}()
	}
	for _, j := range todo {
		jobs <- j
	}
	close(jobs)
	wg.Wait()

	g := build(src, files)
	g.Root = path.Base(strings.ReplaceAll(a.Root, "\\", "/"))
	g.Tree = tree

	a.mu.Lock()
	a.graphs[tree] = g
	a.order = append(a.order, tree)
	if len(a.order) > 64 {
		delete(a.graphs, a.order[0])
		a.order = a.order[1:]
	}
	a.mu.Unlock()
	return g, nil
}

func resolveTree(root, treeish string) (string, error) {
	cmd := exec.Command("git", "rev-parse", "--verify", "--quiet", treeish+"^{tree}")
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("%q is not a commit or tree in this repository", treeish)
	}
	return strings.TrimSpace(string(out)), nil
}

func parse(p string, src []byte) *File {
	src = bytes.TrimPrefix(src, []byte("\xef\xbb\xbf")) // UTF-8 byte order mark, common on Windows
	f := &File{Path: p, Lang: langOf(p), Lines: countLines(src)}
	switch f.Lang {
	case Go:
		parseGo(f, src)
	case Python:
		parsePython(f, src)
	case JavaScript, TypeScript:
		parseJS(f, src)
	case Java, Kotlin, CSharp, C, Cpp, Rust, PHP, Dart:
		parseCLike(f, src)
	case Ruby:
		parseRuby(f, src)
	}
	return f
}

func countLines(b []byte) int {
	if len(b) == 0 {
		return 0
	}
	n := strings.Count(string(b), "\n")
	if b[len(b)-1] != '\n' {
		n++
	}
	return n
}

// ---------------------------------------------------------------- building

type builder struct {
	src   *treeSource
	g     *Graph
	dirs  map[string][]int // directory -> files in it
	edges map[[2]int]*Edge

	cur       int                   // line of the import being resolved, if any
	importsOf map[int]map[int][]int // file -> import line -> files it resolved to
}

func build(src *treeSource, files []*File) *Graph {
	g := &Graph{Files: files, index: map[string]int{}, External: make([][]string, len(files)), Entries: make([]bool, len(files))}
	b := &builder{src: src, g: g, dirs: map[string][]int{}, edges: map[[2]int]*Edge{}, importsOf: map[int]map[int][]int{}}
	for i, f := range files {
		g.index[f.Path] = i
		g.Entries[i] = f.Entry
		d := path.Dir(f.Path)
		b.dirs[d] = append(b.dirs[d], i)
	}
	resolveGo(b)
	resolvePython(b)
	resolveJS(b)
	resolveJVM(b)
	resolveCSharp(b)
	resolveC(b)
	resolveRust(b)
	resolvePHP(b)
	resolveRuby(b)
	resolveDart(b)
	resolveCalls(b)

	for _, e := range b.edges {
		g.Edges = append(g.Edges, *e)
	}
	sort.Slice(g.Edges, func(i, j int) bool {
		if g.Edges[i].From != g.Edges[j].From {
			return g.Edges[i].From < g.Edges[j].From
		}
		return g.Edges[i].To < g.Edges[j].To
	})
	g.out = make([][]int, len(files))
	g.in = make([][]int, len(files))
	for _, e := range g.Edges {
		g.out[e.From] = append(g.out[e.From], e.To)
		g.in[e.To] = append(g.in[e.To], e.From)
	}
	for i := range g.External {
		g.External[i] = dedupe(g.External[i])
	}
	return g
}

func (b *builder) link(from, to, weight int, typeOnly bool) {
	if from == to || from < 0 || to < 0 {
		return
	}
	if b.cur > 0 {
		if b.importsOf[from] == nil {
			b.importsOf[from] = map[int][]int{}
		}
		b.importsOf[from][b.cur] = append(b.importsOf[from][b.cur], to)
	}
	k := [2]int{from, to}
	if e, ok := b.edges[k]; ok {
		e.Weight += weight
		e.TypeOnly = e.TypeOnly && typeOnly
		return
	}
	b.edges[k] = &Edge{From: from, To: to, Weight: weight, TypeOnly: typeOnly}
}

func (b *builder) external(i int, name string) {
	b.g.External[i] = append(b.g.External[i], name)
}

func dedupe(s []string) []string {
	if len(s) < 2 {
		return s
	}
	sort.Strings(s)
	out := s[:1]
	for _, v := range s[1:] {
		if v != out[len(out)-1] {
			out = append(out, v)
		}
	}
	return out
}

// ---------------------------------------------------------------- JSON

type jsonFile struct {
	Path       string   `json:"p"`
	Lang       Lang     `json:"g"`
	Lines      int      `json:"n"`
	Complexity int      `json:"c"`
	Test       bool     `json:"t,omitempty"`
	Entry      bool     `json:"e,omitempty"`
	Symbols    []Symbol `json:"s,omitempty"`
	External   []string `json:"x,omitempty"`
	Callers    []int    `json:"k,omitempty"` // per symbol: how many places call it
}

// MarshalJSON writes a compact form for the map viewer: edges are
// [from, to, weight, typeOnly] index tuples.
func (g *Graph) MarshalJSON() ([]byte, error) {
	callers := make([][]int, len(g.Files))
	for _, c := range g.Calls {
		if callers[c.To.File] == nil {
			callers[c.To.File] = make([]int, len(g.Files[c.To.File].Symbols))
		}
		callers[c.To.File][c.To.Sym]++
	}
	files := make([]jsonFile, len(g.Files))
	for i, f := range g.Files {
		files[i] = jsonFile{f.Path, f.Lang, f.Lines, f.Complexity, f.Test, g.Entries[i], f.Symbols, g.External[i], callers[i]}
	}
	edges := make([][4]int, len(g.Edges))
	for i, e := range g.Edges {
		t := 0
		if e.TypeOnly {
			t = 1
		}
		edges[i] = [4]int{e.From, e.To, e.Weight, t}
	}
	return json.Marshal(struct {
		Root  string     `json:"root"`
		Tree  string     `json:"tree"`
		Files []jsonFile `json:"files"`
		Edges [][4]int   `json:"edges"`
	}{g.Root, g.Tree, files, edges})
}
