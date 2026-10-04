package explain

import (
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/codemap"
)

// Limits keep requests reasonable on huge files and diffs. When material
// is cut, the request says so, so the explanation can mention it.
const (
	maxSource = 200_000
	maxDiff   = 150_000
)

func clip(s string, max int, what string) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + fmt.Sprintf("\n\n[%s truncated: showing the first %d of %d bytes]", what, max, len(s))
}

// Overview summarises the repository's shape: languages, folders, entry
// points and the most-used files. It gives every explanation context.
func Overview(g *codemap.Graph) string {
	var b strings.Builder
	langs := map[codemap.Lang]int{}
	lines := 0
	type dir struct {
		name         string
		files, lines int
	}
	dirs := map[string]*dir{}
	for _, f := range g.Files {
		langs[f.Lang] += f.Lines
		lines += f.Lines
		d := path.Dir(f.Path)
		if dirs[d] == nil {
			dirs[d] = &dir{name: d}
		}
		dirs[d].files++
		dirs[d].lines += f.Lines
	}
	fmt.Fprintf(&b, "Repository %q: %d source files, %d lines.\nLanguages by lines:", g.Root, len(g.Files), lines)
	type kv struct {
		k string
		v int
	}
	var ls []kv
	for l, n := range langs {
		ls = append(ls, kv{string(l), n})
	}
	sort.Slice(ls, func(i, j int) bool { return ls[i].v > ls[j].v })
	for _, l := range ls {
		fmt.Fprintf(&b, " %s %d", l.k, l.v)
	}
	b.WriteString("\n\nFolders (largest first):\n")
	var ds []*dir
	for _, d := range dirs {
		ds = append(ds, d)
	}
	sort.Slice(ds, func(i, j int) bool {
		return ds[i].lines > ds[j].lines || (ds[i].lines == ds[j].lines && ds[i].name < ds[j].name)
	})
	for i, d := range ds {
		if i == 60 {
			fmt.Fprintf(&b, "- ...and %d more folders\n", len(ds)-60)
			break
		}
		fmt.Fprintf(&b, "- %s/ (%d files, %d lines)\n", d.name, d.files, d.lines)
	}
	b.WriteString("\nEntry points:\n")
	n := 0
	for i, f := range g.Files {
		if g.Entries[i] && !f.Test && n < 15 {
			fmt.Fprintf(&b, "- %s\n", f.Path)
			n++
		}
	}
	if n == 0 {
		b.WriteString("- (none found)\n")
	}
	b.WriteString("\nMost depended-on files:\n")
	for _, i := range mostUsed(g, 15) {
		fmt.Fprintf(&b, "- %s (imported by %d files)\n", g.Files[i].Path, len(g.UsedBy(i)))
	}
	ext := map[string]int{}
	for _, xs := range g.External {
		for _, x := range xs {
			ext[x]++
		}
	}
	var es []kv
	for x, c := range ext {
		es = append(es, kv{x, c})
	}
	sort.Slice(es, func(i, j int) bool { return es[i].v > es[j].v || (es[i].v == es[j].v && es[i].k < es[j].k) })
	if len(es) > 0 {
		b.WriteString("\nMain third-party packages:")
		for i, e := range es {
			if i == 20 {
				break
			}
			fmt.Fprintf(&b, " %s", e.k)
		}
		b.WriteString("\n")
	}
	if c := g.Cycles(); len(c) > 0 {
		fmt.Fprintf(&b, "\nDependency cycles: %d\n", len(c))
	}
	return b.String()
}

func mostUsed(g *codemap.Graph, n int) []int {
	var idx []int
	for i, f := range g.Files {
		if !f.Test && len(g.UsedBy(i)) > 0 {
			idx = append(idx, i)
		}
	}
	sort.Slice(idx, func(a, b int) bool {
		if x, y := len(g.UsedBy(idx[a])), len(g.UsedBy(idx[b])); x != y {
			return x > y
		}
		return g.Files[idx[a]].Path < g.Files[idx[b]].Path
	})
	if len(idx) > n {
		idx = idx[:n]
	}
	return idx
}

func paths(g *codemap.Graph, idx []int, max int) string {
	var ps []string
	for _, i := range idx {
		ps = append(ps, g.Files[i].Path)
	}
	sort.Strings(ps)
	if len(ps) > max {
		ps = append(ps[:max], fmt.Sprintf("...and %d more", len(ps)-max))
	}
	if len(ps) == 0 {
		return "(none)"
	}
	return strings.Join(ps, ", ")
}

// FileMaterial describes one file: its place in the graph and its source.
func FileMaterial(g *codemap.Graph, i int, source string) string {
	f := g.Files[i]
	var b strings.Builder
	fmt.Fprintf(&b, "File: %s (%s, %d lines)\n", f.Path, f.Lang, f.Lines)
	fmt.Fprintf(&b, "Imports from this repository: %s\n", paths(g, g.DependsOn(i), 25))
	fmt.Fprintf(&b, "Imported by: %s\n", paths(g, g.UsedBy(i), 25))
	if len(g.External[i]) > 0 {
		fmt.Fprintf(&b, "Third-party imports: %s\n", strings.Join(g.External[i], ", "))
	}
	callers := map[int]int{}
	for _, c := range g.Calls {
		if c.To.File == i && c.From.File != i {
			callers[c.To.Sym]++
		}
	}
	if len(callers) > 0 {
		b.WriteString("Functions called from other files:")
		for s, n := range callers {
			if s >= 0 {
				fmt.Fprintf(&b, " %s (%d)", f.Symbols[s].Name, n)
			}
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "\nSource:\n```%s\n%s\n```\n", f.Lang, clip(source, maxSource, "source"))
	return b.String()
}

// FolderMaterial describes a folder: its files, what they define, and how
// the folder connects to the rest of the repository.
func FolderMaterial(g *codemap.Graph, dir string) (string, bool) {
	var b strings.Builder
	in, out := map[string]int{}, map[string]int{}
	inside := func(p string) bool { return dir == "." || strings.HasPrefix(p, dir+"/") }
	count := 0
	for i, f := range g.Files {
		if !inside(f.Path) {
			continue
		}
		count++
		if count <= 80 {
			var syms []string
			for _, s := range f.Symbols {
				if s.Exported && len(syms) < 12 {
					syms = append(syms, s.Name)
				}
			}
			fmt.Fprintf(&b, "- %s (%d lines)", f.Path, f.Lines)
			if len(syms) > 0 {
				fmt.Fprintf(&b, ": %s", strings.Join(syms, ", "))
			}
			b.WriteString("\n")
		}
		for _, j := range g.DependsOn(i) {
			if p := g.Files[j].Path; !inside(p) {
				out[path.Dir(p)]++
			}
		}
		for _, j := range g.UsedBy(i) {
			if p := g.Files[j].Path; !inside(p) {
				in[path.Dir(p)]++
			}
		}
	}
	if count == 0 {
		return "", false
	}
	if count > 80 {
		fmt.Fprintf(&b, "- ...and %d more files\n", count-80)
	}
	list := func(m map[string]int) string {
		var ks []string
		for k := range m {
			ks = append(ks, k+"/")
		}
		sort.Strings(ks)
		if len(ks) == 0 {
			return "(none)"
		}
		return strings.Join(ks, ", ")
	}
	return fmt.Sprintf("Folder: %s/ (%d source files)\nUses: %s\nUsed by: %s\n\nFiles and what they export:\n%s",
		dir, count, list(out), list(in), b.String()), true
}

// StepMaterial describes an agent step: the prompt, the patch, and how it
// changed the structure of the code.
func StepMaterial(step int, summary, prompt, patch string, d codemap.Diff, impacted int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Step %d: %s\n", step, summary)
	if prompt != "" {
		fmt.Fprintf(&b, "\nThe user's prompt for this step:\n\"\"\"\n%s\n\"\"\"\n", prompt)
	}
	var s []string
	for _, c := range d.NewCycles {
		s = append(s, "new dependency cycle: "+strings.Join(c.Members, " <-> "))
	}
	for _, e := range d.AddedDeps {
		s = append(s, fmt.Sprintf("new dependency: %s -> %s", e.From, e.To))
	}
	for _, x := range d.AddedExternal {
		s = append(s, "new third-party package: "+x)
	}
	if len(d.AddedFiles) > 0 {
		s = append(s, "new files: "+strings.Join(d.AddedFiles, ", "))
	}
	if len(d.RemovedFiles) > 0 {
		s = append(s, "deleted files: "+strings.Join(d.RemovedFiles, ", "))
	}
	if impacted > 0 {
		s = append(s, fmt.Sprintf("%d other files depend on the changed files", impacted))
	}
	if len(s) > 0 {
		b.WriteString("\nStructural changes found by static analysis:\n- " + strings.Join(s, "\n- ") + "\n")
	}
	fmt.Fprintf(&b, "\nThe change:\n```diff\n%s\n```\n", clip(patch, maxDiff, "diff"))
	return b.String()
}

// TourMaterial picks the files a newcomer should see first (entry points
// and the most depended-on files) and includes the top of each.
func TourMaterial(g *codemap.Graph, head func(path string) string) string {
	seen := map[int]bool{}
	var picks []int
	for i, f := range g.Files {
		if g.Entries[i] && !f.Test && len(picks) < 4 {
			picks = append(picks, i)
			seen[i] = true
		}
	}
	for _, i := range mostUsed(g, 12) {
		if !seen[i] && len(picks) < 10 {
			picks = append(picks, i)
			seen[i] = true
		}
	}
	var b strings.Builder
	b.WriteString("The beginning of the most important files:\n")
	for _, i := range picks {
		f := g.Files[i]
		fmt.Fprintf(&b, "\n%s (%d lines, imported by %d files):\n```%s\n%s\n```\n", f.Path, f.Lines, len(g.UsedBy(i)), f.Lang, head(f.Path))
	}
	return b.String()
}

// Head returns the first n lines of a file's contents.
func Head(src string, n int) string {
	lines := strings.SplitN(src, "\n", n+1)
	if len(lines) > n {
		lines = append(lines[:n], "...")
	}
	return strings.Join(lines, "\n")
}
