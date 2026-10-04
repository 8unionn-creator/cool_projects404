package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/bisect"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/codemap"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/explain"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
)

const bisectUsage = "usage: rewind bisect [-s session] [--good <step>] [--bad <step>] [--timeout 10m] [--isolated] -- <test command>"

func (c *cli) bisectCmd(args []string) error {
	// Everything after "--" is the test command, flags included.
	var command []string
	for i, a := range args {
		if a == "--" {
			args, command = args[:i], args[i+1:]
			break
		}
	}
	fs := flag.NewFlagSet("bisect", flag.ContinueOnError)
	session := fs.String("s", "", "session to bisect (default: current)")
	good := fs.String("good", "", "a step where the test passes (default: the first step)")
	bad := fs.String("bad", "", "a step where the test fails (default: the last step)")
	timeout := fs.Duration("timeout", 10*time.Minute, "give up on one run after this long and count it as a failure (0: no limit)")
	isolated := fs.Bool("isolated", false, "test copies of each step in a temporary folder instead of your work tree (no ignored files there, like node_modules)")
	verbose := fs.Bool("v", false, "print the test output of every run")
	asJSON := fs.Bool("json", false, "print the result as JSON")
	if err := parse(fs, args); err != nil {
		return err
	}
	if len(command) == 0 {
		command = fs.Args() // `rewind bisect "npm test"`
	} else if fs.NArg() > 0 {
		return errors.New(bisectUsage)
	}
	if len(command) == 0 {
		return errors.New(bisectUsage)
	}
	name, err := c.session(*session)
	if err != nil {
		return err
	}
	steps, err := c.st.Steps(name)
	if err != nil {
		return err
	}
	opts := bisect.Options{Session: name, Good: -1, Bad: -1, Command: command, Timeout: *timeout, Isolated: *isolated}
	index := func(ref string) (int, error) {
		if ref == "" {
			return -1, nil
		}
		if !strings.Contains(ref, ":") {
			ref = name + ":" + ref
		}
		s, i, err := c.resolve(ref)
		if err == nil && s[0].Commit != steps[0].Commit {
			err = errors.New("--good and --bad must be steps of the session being bisected")
		}
		return i, err
	}
	if opts.Good, err = index(*good); err != nil {
		return err
	}
	if opts.Bad, err = index(*bad); err != nil {
		return err
	}

	shown := strings.Join(command, " ")
	if !*asJSON {
		where := "your work tree (it is put back when done)"
		if *isolated {
			where = "temporary copies"
		}
		fmt.Fprintf(c.out, "Bisecting session %s (%d steps) with %s, in %s\n\n", c.bold(name), len(steps), c.paint("36", shown), where)
		opts.Progress = func(p bisect.Probe) {
			verdict := map[string]string{bisect.Good: c.paint("32", "pass"), bisect.Bad: c.paint("31", "fail"), bisect.Skip: c.paint("33", "skip")}[p.Verdict]
			detail := fmt.Sprintf("%.1fs", p.Duration.Seconds())
			switch {
			case p.TimedOut:
				detail = "timed out after " + detail
			case p.Verdict == bisect.Bad:
				detail = fmt.Sprintf("exit %d · %s", p.ExitCode, detail)
			}
			fmt.Fprintf(c.out, "  step %-4d %s  %s\n", p.Step, verdict, c.dim(detail))
			if c.progress != nil {
				c.progress(fmt.Sprintf("step %d: %s (%s)", p.Step, p.Verdict, detail))
			}
			if *verbose && strings.TrimSpace(p.Output) != "" {
				fmt.Fprintln(c.out, indent(c.dim(strings.TrimRight(p.Output, "\n")), "      "))
			}
		}
	}
	parent := c.ctx
	if parent == nil {
		parent = context.Background()
	}
	ctx, stop := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer stop()
	res, err := bisect.Run(ctx, c.st, opts)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return errors.New("bisect interrupted; your files are back as they were")
		}
		return err
	}
	c.saveBisect(res, shown)
	if *asJSON {
		return json.NewEncoder(c.out).Encode(map[string]any{
			"session": res.Session, "culprit": res.Culprit.Step, "lastGood": res.LastGood.Step,
			"summary": res.Culprit.Summary, "prompt": res.Culprit.Prompt, "candidates": res.Candidates,
			"probes": res.Probes, "output": res.BadOutput,
		})
	}
	return c.printBisect(res, len(res.Probes))
}

func (c *cli) printBisect(res bisect.Result, probes int) error {
	s := res.Culprit
	fmt.Fprintln(c.out)
	if len(res.Candidates) > 0 {
		fmt.Fprintf(c.out, "%s The test could not run on some steps, so the culprit is one of steps %s.\n",
			c.paint("33", "Almost:"), joinInts(res.Candidates))
		fmt.Fprintf(c.out, "The first step known to fail is %d.\n", s.Step)
	} else {
		fmt.Fprintf(c.out, "%s %s\n", c.paint("31;1", fmt.Sprintf("Step %d broke it", s.Step)), c.dim(fmt.Sprintf("(found in %d runs)", probes)))
	}
	fmt.Fprintf(c.out, "  %s %s\n", c.dim(s.Kind+" ·"), s.Summary)
	if s.Prompt != "" {
		fmt.Fprintf(c.out, "  %s %s\n", c.dim("prompt:"), c.paint("36", store.OneLine(s.Prompt, 100)))
	}
	files, err := c.st.Changes(res.LastGood.Tree, s.Tree)
	if err != nil {
		return err
	}
	for _, f := range files {
		fmt.Fprintf(c.out, "  %s  %s\n", pad(c.numstat(f), 14, c.color), f.Path)
	}
	c.structure(res.LastGood.Tree, s.Tree, files)
	if out := strings.TrimSpace(res.BadOutput); out != "" {
		lines := strings.Split(out, "\n")
		if len(lines) > 15 {
			lines = append([]string{"..."}, lines[len(lines)-15:]...)
		}
		fmt.Fprintf(c.out, "\n%s\n%s\n", c.bold(fmt.Sprintf("Test output at step %d", s.Step)), indent(c.dim(strings.Join(lines, "\n")), "  "))
	}
	ref := func(n int) string {
		if res.Session == c.st.Current() {
			return fmt.Sprint(n)
		}
		return fmt.Sprintf("%s:%d", res.Session, n)
	}
	fmt.Fprintf(c.out, "\n%s\n", c.bold("Next"))
	fmt.Fprintf(c.out, "  rewind show %-10s %s\n", ref(s.Step)+" -p", c.dim("the full change"))
	fmt.Fprintf(c.out, "  rewind undo %-10s %s\n", ref(s.Step), c.dim("undo just that step, keeping everything after it"))
	fmt.Fprintf(c.out, "  rewind restore %-7s %s\n", ref(res.LastGood.Step), c.dim("go back to the last good step"))
	return nil
}

// saveBisect remembers the last result, so the map can mark the step.
func (c *cli) saveBisect(res bisect.Result, command string) {
	b, _ := json.Marshal(map[string]any{
		"session": res.Session, "culprit": res.Culprit.Step, "lastGood": res.LastGood.Step,
		"candidates": res.Candidates, "command": command, "time": time.Now().Unix(),
	})
	_ = os.WriteFile(filepath.Join(c.st.Repo.GitDir, "rewind", "bisect.json"), b, 0o644)
}

func joinInts(xs []int) string {
	s := make([]string, len(xs))
	for i, x := range xs {
		s[i] = fmt.Sprint(x)
	}
	return strings.Join(s, ", ")
}

func (c *cli) undo(args []string) error {
	fs := flag.NewFlagSet("undo", flag.ContinueOnError)
	dry := fs.Bool("n", false, "check that the undo applies without changing any file")
	if err := parse(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: rewind undo [-n] <step>")
	}
	steps, i, err := c.resolve(fs.Arg(0))
	if err != nil {
		return err
	}
	if i == 0 {
		return errors.New("step 0 is the baseline; there is nothing before it to go back to")
	}
	files, err := c.st.Undo(c.sessionOf(fs.Arg(0)), steps[i-1], steps[i], *dry)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		fmt.Fprintf(c.out, "Step %d changed no files.\n", steps[i].Step)
		return nil
	}
	verb := "Undid"
	if *dry {
		verb = "Can undo"
	}
	fmt.Fprintf(c.out, "%s step %d (%s), keeping later changes:\n", verb, steps[i].Step, steps[i].Summary)
	for _, f := range files {
		fmt.Fprintf(c.out, "  %s  %s\n", pad(c.numstat(f), 14, c.color), f.Path)
	}
	if !*dry {
		fmt.Fprintln(c.out, c.dim("\nThe state before the undo is saved as a step, so this can be reversed with rewind restore."))
	}
	return nil
}

func (c *cli) findCmd(args []string) error {
	fs := flag.NewFlagSet("find", flag.ContinueOnError)
	at := fs.String("at", "", "use a step or git revision")
	if err := parse(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: rewind find <name>   (a function, class, type or method)")
	}
	g, err := c.graphAt(*at)
	if err != nil {
		return err
	}
	hits, fuzzy := findSymbols(g, fs.Arg(0), 40)
	if len(hits) == 0 {
		fmt.Fprintf(c.out, "Nothing named %q is defined in the mapped source files.\n", fs.Arg(0))
		return nil
	}
	if fuzzy {
		fmt.Fprintf(c.out, "No exact match for %q; similar names:\n", fs.Arg(0))
	}
	callers := map[codemap.SymRef]int{}
	for _, call := range g.Calls {
		callers[call.To]++
	}
	for _, h := range hits {
		f := g.Files[h.File]
		s := f.Symbols[h.Sym]
		fmt.Fprintf(c.out, "  %s %s  %s %s\n", c.dim(pad(s.Kind, 9, false)), c.bold(s.Name),
			fmt.Sprintf("%s:%d", f.Path, s.Line), c.dim(fmt.Sprintf("· %d callers", callers[h])))
	}
	return nil
}

// findSymbols finds definitions by exact name (or Type.name suffix), falling
// back to case-insensitive substring matches.
func findSymbols(g *codemap.Graph, name string, limit int) (hits []codemap.SymRef, fuzzy bool) {
	lower := strings.ToLower(name)
	var near []codemap.SymRef
	for fi, f := range g.Files {
		for si, s := range f.Symbols {
			switch {
			case s.Name == name || strings.HasSuffix(s.Name, "."+name):
				hits = append(hits, codemap.SymRef{File: fi, Sym: si})
			case strings.Contains(strings.ToLower(s.Name), lower):
				near = append(near, codemap.SymRef{File: fi, Sym: si})
			}
		}
	}
	if len(hits) == 0 {
		hits, fuzzy = near, true
	}
	sort.SliceStable(hits, func(a, b int) bool {
		// Code before tests, then shorter names (closer matches) first.
		ta, tb := g.Files[hits[a].File].Test, g.Files[hits[b].File].Test
		if ta != tb {
			return !ta
		}
		return len(g.Files[hits[a].File].Symbols[hits[a].Sym].Name) < len(g.Files[hits[b].File].Symbols[hits[b].Sym].Name)
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, fuzzy
}

func (c *cli) overviewCmd(args []string) error {
	fs := flag.NewFlagSet("overview", flag.ContinueOnError)
	at := fs.String("at", "", "use a step or git revision")
	if err := parse(fs, args); err != nil {
		return err
	}
	g, err := c.graphAt(*at)
	if err != nil {
		return err
	}
	fmt.Fprint(c.out, explain.Overview(g))
	if hs := g.Hotspots(codemap.Churn(c.st.Repo.Root, "HEAD"), 8); len(hs) > 0 {
		fmt.Fprintln(c.out, "\nHotspots (often changed and complex; edit with care):")
		for _, h := range hs {
			fmt.Fprintf(c.out, "- %s (%d commits, complexity %d)\n", h.Path, h.Commits, h.Complexity)
		}
	}
	return nil
}
