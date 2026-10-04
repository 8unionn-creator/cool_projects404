package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"path"
	"runtime"
	"sort"
	"strings"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/codemap"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/server"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
)

// snapshot resolves --at: "" means the current files, a step reference
// ("7", "last", "session:3") means that step, anything else is a git revision.
func (c *cli) snapshot(at string) (tree, label string, err error) {
	if at == "" || at == "worktree" {
		tree, err = c.st.WorkTree()
		return tree, "working tree", err
	}
	if steps, i, rerr := c.resolve(at); rerr == nil {
		return steps[i].Tree, fmt.Sprintf("step %d", steps[i].Step), nil
	}
	if _, err := c.st.Repo.Git("rev-parse", "--verify", "--quiet", at+"^{tree}"); err == nil {
		return at, at, nil
	}
	return "", "", fmt.Errorf("%q is not a step or a git revision", at)
}

func (c *cli) analyzer() *codemap.Analyzer { return codemap.NewAnalyzer(c.st.Repo.Root) }

func (c *cli) mapCmd(args []string) error {
	fs := flag.NewFlagSet("map", flag.ContinueOnError)
	at := fs.String("at", "", "map a step or git revision instead of the current files")
	asJSON := fs.Bool("json", false, "print the dependency graph as JSON")
	dot := fs.Bool("dot", false, "print folder dependencies in Graphviz DOT format")
	addr := fs.String("addr", "127.0.0.1:0", "address for the viewer (loopback only)")
	noOpen := fs.Bool("no-open", false, "do not open a browser")
	if err := parse(fs, args); err != nil {
		return err
	}
	if *asJSON || *dot {
		tree, _, err := c.snapshot(*at)
		if err != nil {
			return err
		}
		g, err := c.analyzer().Analyze(tree)
		if err != nil {
			return err
		}
		if *asJSON {
			enc := json.NewEncoder(c.out)
			return enc.Encode(g)
		}
		return writeDOT(c, g)
	}

	host, _, err := net.SplitHostPort(*addr)
	if err != nil {
		return fmt.Errorf("--addr: %v", err)
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return errors.New("--addr must be a loopback address such as 127.0.0.1:7777; the map shows your source code")
	}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	url := "http://" + ln.Addr().String() + "/"
	fmt.Fprintf(c.out, "Rewind map of %s: %s\n", c.bold(path.Base(c.st.Repo.Root)), c.paint("36", url))
	fmt.Fprintln(c.out, c.dim("Press Ctrl+C to stop."))
	if !*noOpen {
		openBrowser(url)
	}
	return http.Serve(ln, server.New(c.st).Handler())
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start() // best effort; the URL is printed either way
}

func writeDOT(c *cli, g *codemap.Graph) error {
	weights := map[[2]string]int{}
	dirs := map[string]int{}
	for _, f := range g.Files {
		dirs[path.Dir(f.Path)] += f.Lines
	}
	for _, e := range g.Edges {
		a, b := path.Dir(g.Files[e.From].Path), path.Dir(g.Files[e.To].Path)
		if a != b {
			weights[[2]string{a, b}] += e.Weight
		}
	}
	names := make([]string, 0, len(dirs))
	for d := range dirs {
		names = append(names, d)
	}
	sort.Strings(names)
	fmt.Fprintln(c.out, "digraph rewind {")
	fmt.Fprintln(c.out, `  rankdir=TB; node [shape=box, style=rounded, fontname="Helvetica"];`)
	for _, d := range names {
		fmt.Fprintf(c.out, "  %q [label=%q];\n", d, fmt.Sprintf("%s\n%d lines", d, dirs[d]))
	}
	keys := make([][2]string, 0, len(weights))
	for k := range weights {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i][0]+keys[i][1] < keys[j][0]+keys[j][1] })
	for _, k := range keys {
		fmt.Fprintf(c.out, "  %q -> %q [weight=%d];\n", k[0], k[1], weights[k])
	}
	fmt.Fprintln(c.out, "}")
	return nil
}

func (c *cli) depsCmd(args []string) error {
	fs := flag.NewFlagSet("deps", flag.ContinueOnError)
	at := fs.String("at", "", "use a step or git revision")
	if err := parse(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: rewind deps <file>")
	}
	g, err := c.graphAt(*at)
	if err != nil {
		return err
	}
	p, i, err := c.fileIn(g, fs.Arg(0))
	if err != nil {
		return err
	}
	f := g.Files[i]
	tags := string(f.Lang)
	if g.Entries[i] {
		tags += ", entry point"
	}
	if f.Test {
		tags += ", test"
	}
	fmt.Fprintf(c.out, "%s  %s\n", c.bold(p), c.dim(fmt.Sprintf("%s · %d lines · complexity %d", tags, f.Lines, f.Complexity)))
	list := func(title string, idx []int) {
		fmt.Fprintf(c.out, "\n%s %s\n", title, c.dim(fmt.Sprintf("(%d)", len(idx))))
		names := make([]string, len(idx))
		for k, j := range idx {
			names[k] = g.Files[j].Path
		}
		sort.Strings(names)
		for _, n := range names {
			fmt.Fprintf(c.out, "  %s\n", n)
		}
	}
	list("Imports", g.DependsOn(i))
	list("Imported by", g.UsedBy(i))
	if len(g.External[i]) > 0 {
		fmt.Fprintf(c.out, "\nExternal %s\n  %s\n", c.dim(fmt.Sprintf("(%d)", len(g.External[i]))), strings.Join(g.External[i], ", "))
	}
	if len(f.Symbols) > 0 {
		fmt.Fprintf(c.out, "\nDefines %s\n", c.dim(fmt.Sprintf("(%d)", len(f.Symbols))))
		for _, s := range f.Symbols {
			fmt.Fprintf(c.out, "  %s %s %s\n", c.dim(pad(s.Kind, 9, false)), s.Name, c.dim(fmt.Sprintf(":%d", s.Line)))
		}
	}
	return nil
}

func (c *cli) impactCmd(args []string) error {
	fs := flag.NewFlagSet("impact", flag.ContinueOnError)
	step := fs.String("step", "", "use the files changed in a step")
	if err := parse(fs, args); err != nil {
		return err
	}
	var g *codemap.Graph
	var sources []string
	switch {
	case *step != "" && fs.NArg() == 0:
		steps, i, err := c.resolve(*step)
		if err != nil {
			return err
		}
		if i == 0 {
			return errors.New("step 0 is the baseline; pick a later step")
		}
		files, err := c.st.Changes(steps[i-1].Tree, steps[i].Tree)
		if err != nil {
			return err
		}
		if g, err = c.analyzer().Analyze(steps[i].Tree); err != nil {
			return err
		}
		for _, f := range files {
			if g.Index(f.Path) >= 0 {
				sources = append(sources, f.Path)
			}
		}
		if len(sources) == 0 {
			fmt.Fprintf(c.out, "Step %d changed no source files that the map understands.\n", steps[i].Step)
			return nil
		}
	case *step == "" && fs.NArg() > 0:
		var err error
		if g, err = c.graphAt(""); err != nil {
			return err
		}
		for _, a := range fs.Args() {
			p, _, err := c.fileIn(g, a)
			if err != nil {
				return err
			}
			sources = append(sources, p)
		}
	default:
		return errors.New("usage: rewind impact <file>...  or  rewind impact --step <step>")
	}

	imp := g.Impact(sources)
	what := strings.Join(sources, ", ")
	if len(sources) > 3 {
		what = fmt.Sprintf("%d files", len(sources))
	}
	if len(imp) == 0 {
		fmt.Fprintf(c.out, "Nothing in the repository depends on %s.\n", what)
		return nil
	}
	fmt.Fprintf(c.out, "Changing %s can affect %s:\n", c.bold(what), c.bold(fmt.Sprintf("%d files", len(imp))))
	byDist := map[int][]string{}
	maxD := 0
	for p, d := range imp {
		byDist[d] = append(byDist[d], p)
		if d > maxD {
			maxD = d
		}
	}
	for d := 1; d <= maxD; d++ {
		ps := byDist[d]
		if len(ps) == 0 {
			continue
		}
		sort.Strings(ps)
		label := "direct"
		if d > 1 {
			label = fmt.Sprintf("%d hops", d)
		}
		fmt.Fprintf(c.out, "\n  %s\n", c.paint("33", label))
		for _, p := range ps {
			test := ""
			if f := g.Files[g.Index(p)]; f.Test {
				test = c.dim(" (test)")
			}
			fmt.Fprintf(c.out, "    %s%s\n", p, test)
		}
	}
	return nil
}

func (c *cli) cyclesCmd(args []string) error {
	fs := flag.NewFlagSet("cycles", flag.ContinueOnError)
	at := fs.String("at", "", "use a step or git revision")
	failOn := fs.Bool("fail", false, "exit with status 1 when cycles exist (for CI)")
	if err := parse(fs, args); err != nil {
		return err
	}
	g, err := c.graphAt(*at)
	if err != nil {
		return err
	}
	cycles := g.Cycles()
	if len(cycles) == 0 {
		fmt.Fprintln(c.out, "No dependency cycles between files or folders.")
		return nil
	}
	for _, cy := range cycles {
		kind := "import cycle"
		if cy.Level == "dir" {
			kind = "folder cycle"
		}
		fmt.Fprintf(c.out, "%s %s\n", c.paint("31", kind), c.dim(fmt.Sprintf("(%d members)", len(cy.Members))))
		for _, m := range cy.Members {
			fmt.Fprintf(c.out, "  %s\n", m)
		}
	}
	if *failOn {
		return fmt.Errorf("found %d dependency cycles", len(cycles))
	}
	return nil
}

func (c *cli) graphAt(at string) (*codemap.Graph, error) {
	tree, _, err := c.snapshot(at)
	if err != nil {
		return nil, err
	}
	return c.analyzer().Analyze(tree)
}

// fileIn finds a file given as a path relative to the current directory or
// to the repository root.
func (c *cli) fileIn(g *codemap.Graph, arg string) (string, int, error) {
	candidates := []string{strings.TrimPrefix(path.Clean(strings.ReplaceAll(arg, "\\", "/")), "./")}
	if rel, err := c.relToRoot(arg); err == nil {
		candidates = append([]string{rel}, candidates...)
	}
	for _, p := range candidates {
		if i := g.Index(p); i >= 0 {
			return p, i, nil
		}
	}
	return "", -1, fmt.Errorf("%s is not a source file the map understands (Go, Python, JavaScript or TypeScript)", arg)
}

// structure prints how a step changed the shape of the code, for `show`.
func (c *cli) structure(fromTree, toTree string, files []store.FileChange) {
	code := false
	for _, f := range files {
		if codemapLang(f.Path) {
			code = true
			break
		}
	}
	if !code {
		return
	}
	an := c.analyzer()
	a, err1 := an.Analyze(fromTree)
	b, err2 := an.Analyze(toTree)
	if err1 != nil || err2 != nil {
		return
	}
	d := codemap.Compare(a, b)
	var changed []string
	for _, f := range files {
		if b.Index(f.Path) >= 0 {
			changed = append(changed, f.Path)
		}
	}
	impact := b.Impact(changed)
	fmt.Fprintf(c.out, "\n%s\n", c.bold("Structure"))
	if d.Empty() {
		fmt.Fprintln(c.out, c.dim("  No change to how the code fits together."))
	}
	for _, cy := range d.NewCycles {
		fmt.Fprintf(c.out, "  %s %s\n", c.paint("31", "new cycle"), strings.Join(cy.Members, " ↔ "))
	}
	for _, e := range d.AddedDeps {
		fmt.Fprintf(c.out, "  %s %s → %s\n", c.paint("33", "+ dep    "), e.From, e.To)
	}
	for _, e := range d.RemovedDeps {
		fmt.Fprintf(c.out, "  %s %s → %s\n", c.dim("- dep    "), e.From, e.To)
	}
	for _, x := range d.AddedExternal {
		fmt.Fprintf(c.out, "  %s %s\n", c.paint("33", "+ package"), x)
	}
	if len(impact) > 0 {
		fmt.Fprintf(c.out, "  %s %d files depend on what changed (rewind impact --step to list them)\n", c.dim("impact   "), len(impact))
	}
}

func codemapLang(p string) bool {
	switch path.Ext(p) {
	case ".go", ".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts":
		return true
	}
	return false
}
