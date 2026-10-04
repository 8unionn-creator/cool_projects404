package codemap

import (
	"os/exec"
	"path"
	"sort"
	"strings"
)

// ---------------------------------------------------------------- cycles

// Cycle is a set of files or directories that depend on each other.
type Cycle struct {
	Level   string   // "file" or "dir"
	Members []string // sorted
}

// Cycles finds dependency cycles that are worth fixing:
//   - file-level import cycles where load order matters: Python and JS/TS
//     (initialisation-order bugs) and C/C++ (include order). Type-only and
//     lazy imports are ignored because they never run at load time. In Go,
//     Rust, Java, Kotlin, C#, PHP, Ruby and Dart, files and classes of one
//     package referring to each other is normal, so only folders count.
//   - directory-level cycles in any language but Rust (layering violations).
func (g *Graph) Cycles() []Cycle {
	var out []Cycle
	n := len(g.Files)
	adj := make([][]int, n)
	for _, e := range g.Edges {
		if e.TypeOnly || !OrderSensitive(g.Files[e.From].Lang) || !OrderSensitive(g.Files[e.To].Lang) {
			continue
		}
		adj[e.From] = append(adj[e.From], e.To)
	}
	for _, scc := range tarjan(n, adj) {
		m := make([]string, len(scc))
		for k, i := range scc {
			m[k] = g.Files[i].Path
		}
		sort.Strings(m)
		out = append(out, Cycle{Level: "file", Members: m})
	}

	dirs, dirIdx := g.dirIndex()
	dadj := make([][]int, len(dirs))
	seen := map[[2]int]bool{}
	for _, e := range g.Edges {
		// Rust allows any cycle inside a crate and Cargo forbids them
		// between crates, so Rust module cycles are never a problem.
		if e.TypeOnly || g.Files[e.From].Lang == Rust || g.Files[e.To].Lang == Rust {
			continue
		}
		a, b := dirIdx[e.From], dirIdx[e.To]
		if a != b && !seen[[2]int{a, b}] {
			seen[[2]int{a, b}] = true
			dadj[a] = append(dadj[a], b)
		}
	}
	for _, scc := range tarjan(len(dirs), dadj) {
		m := make([]string, len(scc))
		for k, i := range scc {
			m[k] = dirs[i]
		}
		sort.Strings(m)
		out = append(out, Cycle{Level: "dir", Members: m})
	}
	return out
}

// OrderSensitive reports whether import cycles between files of a language
// can break a program at load time.
func OrderSensitive(l Lang) bool {
	switch l {
	case Python, JavaScript, TypeScript, C, Cpp:
		return true
	}
	return false
}

func (g *Graph) dirIndex() ([]string, []int) {
	idx := map[string]int{}
	var dirs []string
	of := make([]int, len(g.Files))
	for i, f := range g.Files {
		d := path.Dir(f.Path)
		k, ok := idx[d]
		if !ok {
			k = len(dirs)
			idx[d] = k
			dirs = append(dirs, d)
		}
		of[i] = k
	}
	return dirs, of
}

// tarjan returns the strongly connected components with more than one node.
func tarjan(n int, adj [][]int) [][]int {
	index := make([]int, n)
	low := make([]int, n)
	onStack := make([]bool, n)
	for i := range index {
		index[i] = -1
	}
	var stack []int
	var out [][]int
	next := 0

	// Iterative to survive very deep graphs.
	type frame struct{ v, edge int }
	for root := 0; root < n; root++ {
		if index[root] >= 0 {
			continue
		}
		call := []frame{{root, 0}}
		index[root], low[root] = next, next
		next++
		stack = append(stack, root)
		onStack[root] = true
		for len(call) > 0 {
			top := &call[len(call)-1]
			v := top.v
			if top.edge < len(adj[v]) {
				w := adj[v][top.edge]
				top.edge++
				if index[w] < 0 {
					index[w], low[w] = next, next
					next++
					stack = append(stack, w)
					onStack[w] = true
					call = append(call, frame{w, 0})
				} else if onStack[w] && index[w] < low[v] {
					low[v] = index[w]
				}
				continue
			}
			if low[v] == index[v] {
				var comp []int
				for {
					w := stack[len(stack)-1]
					stack = stack[:len(stack)-1]
					onStack[w] = false
					comp = append(comp, w)
					if w == v {
						break
					}
				}
				if len(comp) > 1 {
					out = append(out, comp)
				}
			}
			call = call[:len(call)-1]
			if len(call) > 0 {
				p := call[len(call)-1].v
				if low[v] < low[p] {
					low[p] = low[v]
				}
			}
		}
	}
	return out
}

// ---------------------------------------------------------------- impact

// Impact returns every file that depends, directly or transitively, on any
// of the given files, mapped to its distance (1 = imports it directly).
func (g *Graph) Impact(paths []string) map[string]int {
	dist := map[int]int{}
	var queue []int
	for _, p := range paths {
		if i := g.Index(p); i >= 0 {
			dist[i] = 0
			queue = append(queue, i)
		}
	}
	for len(queue) > 0 {
		v := queue[0]
		queue = queue[1:]
		for _, u := range g.in[v] {
			if _, ok := dist[u]; !ok {
				dist[u] = dist[v] + 1
				queue = append(queue, u)
			}
		}
	}
	out := map[string]int{}
	for i, d := range dist {
		if d > 0 {
			out[g.Files[i].Path] = d
		}
	}
	return out
}

// ---------------------------------------------------------------- hotspots

// Churn counts the commits that touched each file in the last year of the
// given revision's history. It returns an empty map when there is no history.
func Churn(root, rev string) map[string]int {
	cmd := exec.Command("git", "log", "--since=1.year", "--no-renames", "--format=", "--name-only", rev, "--")
	cmd.Dir = root
	out, err := cmd.Output()
	counts := map[string]int{}
	if err != nil {
		return counts
	}
	for _, l := range strings.Split(string(out), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			counts[l]++
		}
	}
	return counts
}

// Hotspot is a file that is both complex and frequently changed, which is
// where bugs tend to cluster.
type Hotspot struct {
	Path       string
	Commits    int
	Complexity int
	Score      int
}

// Hotspots ranks non-test files by commits × complexity.
func (g *Graph) Hotspots(churn map[string]int, limit int) []Hotspot {
	var hs []Hotspot
	for _, f := range g.Files {
		c := churn[f.Path]
		if c == 0 || f.Test {
			continue
		}
		hs = append(hs, Hotspot{f.Path, c, f.Complexity, c * (f.Complexity + 1)})
	}
	sort.Slice(hs, func(i, j int) bool {
		if hs[i].Score != hs[j].Score {
			return hs[i].Score > hs[j].Score
		}
		return hs[i].Path < hs[j].Path
	})
	if limit > 0 && len(hs) > limit {
		hs = hs[:limit]
	}
	return hs
}

// ---------------------------------------------------------------- diff

// DirEdge is a dependency between two directories.
type DirEdge struct{ From, To string }

// Diff is the structural difference between two graphs.
type Diff struct {
	AddedFiles, RemovedFiles []string
	AddedDeps, RemovedDeps   []DirEdge // between directories
	AddedExternal            []string  // third-party packages newly imported
	NewCycles                []Cycle
}

// Empty reports whether nothing structural changed.
func (d Diff) Empty() bool {
	return len(d.AddedFiles)+len(d.RemovedFiles)+len(d.AddedDeps)+len(d.RemovedDeps)+len(d.AddedExternal)+len(d.NewCycles) == 0
}

// Compare reports how the structure changed from a to b.
func Compare(a, b *Graph) Diff {
	var d Diff
	for _, f := range b.Files {
		if a.Index(f.Path) < 0 {
			d.AddedFiles = append(d.AddedFiles, f.Path)
		}
	}
	for _, f := range a.Files {
		if b.Index(f.Path) < 0 {
			d.RemovedFiles = append(d.RemovedFiles, f.Path)
		}
	}
	ea, eb := a.dirEdges(), b.dirEdges()
	for e := range eb {
		if !ea[e] {
			d.AddedDeps = append(d.AddedDeps, e)
		}
	}
	for e := range ea {
		if !eb[e] {
			d.RemovedDeps = append(d.RemovedDeps, e)
		}
	}
	xa, xb := a.externals(), b.externals()
	for x := range xb {
		if !xa[x] {
			d.AddedExternal = append(d.AddedExternal, x)
		}
	}
	old := map[string]bool{}
	for _, c := range a.Cycles() {
		old[c.Level+strings.Join(c.Members, "\x00")] = true
	}
	for _, c := range b.Cycles() {
		if !old[c.Level+strings.Join(c.Members, "\x00")] {
			d.NewCycles = append(d.NewCycles, c)
		}
	}
	sort.Strings(d.AddedFiles)
	sort.Strings(d.RemovedFiles)
	sort.Strings(d.AddedExternal)
	byName := func(s []DirEdge) {
		sort.Slice(s, func(i, j int) bool {
			if s[i].From != s[j].From {
				return s[i].From < s[j].From
			}
			return s[i].To < s[j].To
		})
	}
	byName(d.AddedDeps)
	byName(d.RemovedDeps)
	return d
}

func (g *Graph) dirEdges() map[DirEdge]bool {
	m := map[DirEdge]bool{}
	for _, e := range g.Edges {
		a, b := path.Dir(g.Files[e.From].Path), path.Dir(g.Files[e.To].Path)
		if a != b {
			m[DirEdge{a, b}] = true
		}
	}
	return m
}

func (g *Graph) externals() map[string]bool {
	m := map[string]bool{}
	for _, xs := range g.External {
		for _, x := range xs {
			m[x] = true
		}
	}
	return m
}
