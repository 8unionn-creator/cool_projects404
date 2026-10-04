// Command rewind records every step of an AI coding session as a git
// snapshot, so you can see what changed, why, and roll back to any step.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/codemap"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/gitx"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/hook"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
	"github.com/8unionn-creator/cool_projects404/rewind/internal/watch"
)

var version = "0.5.0"

const usage = `rewind: undo history and a code map for AI coding agents

Usage:
  rewind init <agent>             record an agent's sessions: claude, codex, gemini, cursor or all
  rewind watch                    record steps for any tool by watching files (Aider, Copilot, ...)
  rewind start [name]             begin a new session (takes a baseline)
  rewind snap [-m message]        record a step by hand
  rewind log [-s session]         list the steps of a session
  rewind sessions                 list recorded sessions
  rewind show [-p] <step>         show what one step changed (-p: full patch)
  rewind diff [--stat] <a> [<b>]  diff step a against b (default: the step before a)
  rewind diff -w <step>           diff a step against the current files
  rewind restore [-n] <step>      put the files back as they were at a step
  rewind undo [-n] <step>         undo just one step, keeping every change after it

Find what broke:
  rewind bisect -- <test command> find the agent step that broke a test (e.g. -- npm test)

Let agents use Rewind:
  rewind mcp                      run the MCP server (rewind init adds it for each agent)

Understand the code:
  rewind map                      open the interactive code map in your browser
  rewind map --json | --dot       print the dependency graph instead
  rewind deps <file>              what a file imports, what imports it, what it defines
  rewind impact <file>...         every file that depends on these files
  rewind impact --step <step>     every file that depends on what a step changed
  rewind callers <file> <func>    who calls a function, and what it calls
  rewind find <name>              where a function, class or type is defined
  rewind overview                 a summary of the repository's shape
  rewind cycles [--fail]          list import cycles (--fail: exit 1 for CI)
  rewind explain <file|folder>    ask Claude to explain code (needs ANTHROPIC_API_KEY)
  rewind explain step <n> | tour  explain what an agent step did, or tour the repository
  (map, deps and cycles take --at <step|revision> to look at a snapshot)

  rewind hook <agent>             (used by the agents themselves; reads a hook event on stdin)

Steps are numbers within the current session ("7"), "last", or
"<session>:<n>" for another session. Snapshots live under refs/rewind/ as
ordinary git commits; your branches, index and HEAD are never touched.
`

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "rewind:", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, out io.Writer) error {
	if len(args) == 0 {
		fmt.Fprint(out, usage)
		return nil
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "help", "-h", "--help":
		fmt.Fprint(out, usage)
		return nil
	case "version", "--version":
		fmt.Fprintln(out, "rewind", version)
		return nil
	case "hook":
		return cmdHook(rest, stdin, out)
	case "mcp":
		return cmdMCP(rest, stdin, out)
	case "update":
		return cmdUpdate(rest, out)
	}

	st, err := store.Open(".")
	if errors.Is(err, gitx.ErrNotRepo) {
		return errors.New("not inside a git repository (run `git init` first)")
	} else if err != nil {
		return err
	}
	c := &cli{st: st, out: out, color: colorEnabled(out)}
	switch cmd {
	case "init":
		return c.init(rest)
	case "start":
		return c.start(rest)
	case "snap":
		return c.snap(rest)
	case "log":
		return c.log(rest)
	case "sessions":
		return c.sessions()
	case "show":
		return c.show(rest)
	case "diff":
		return c.diff(rest)
	case "restore":
		return c.restore(rest)
	case "watch":
		return c.watch(rest)
	case "map":
		return c.mapCmd(rest)
	case "deps":
		return c.depsCmd(rest)
	case "impact":
		return c.impactCmd(rest)
	case "cycles":
		return c.cyclesCmd(rest)
	case "callers":
		return c.callersCmd(rest)
	case "explain":
		return c.explainCmd(rest)
	case "bisect":
		return c.bisectCmd(rest)
	case "undo":
		return c.undo(rest)
	case "find":
		return c.findCmd(rest)
	case "overview":
		return c.overviewCmd(rest)
	}
	return fmt.Errorf("unknown command %q (run `rewind help`)", cmd)
}

type cli struct {
	st    *store.Store
	out   io.Writer
	color bool
	an    *codemap.Analyzer // shared, so repeated queries reuse parsed files

	// Set by the MCP server, which serves one repository from anywhere.
	ctx      context.Context // cancels long commands (bisect)
	progress func(string)    // reports progress of long commands
	base     string          // relative paths are relative to this, not the process directory
}

// ---------------------------------------------------------------- commands

func (c *cli) init(args []string) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	shared := fs.Bool("shared", false, "Claude Code: write .claude/settings.json (committed) instead of settings.local.json")
	command := fs.String("command", "", "hook command to register (default: rewind hook <agent>)")
	absolute := fs.Bool("absolute", false, "register this rewind binary by its full path, for agents that do not see your PATH")
	noMCP := fs.Bool("no-mcp", false, "do not add the Rewind MCP server (the tools agents use to query the map, rewind and bisect)")
	if err := parse(fs, args); err != nil {
		return err
	}
	usage := "usage: rewind init <" + strings.Join(hook.Agents, "|") + "|all> [--absolute]"
	if fs.NArg() != 1 {
		return errors.New(usage)
	}
	agents := []string{fs.Arg(0)}
	if fs.Arg(0) == "all" {
		agents = hook.Agents
	}
	for _, agent := range agents {
		inst, ok := hook.Installs[agent]
		if !ok {
			return errors.New(usage)
		}
		rel := inst.Path
		if agent == "claude" && *shared {
			rel = ".claude/settings.json"
		}
		bin := "rewind"
		if *absolute {
			if exe, err := os.Executable(); err == nil {
				bin = filepath.ToSlash(exe)
			}
		}
		cmd := *command
		if cmd == "" {
			cmd = bin + " hook " + agent
			if *absolute {
				cmd = strconv.Quote(bin) + " hook " + agent
			}
		}
		added, err := hook.InstallAgent(agent, filepath.Join(c.st.Repo.Root, filepath.FromSlash(rel)), cmd)
		if err != nil {
			return err
		}
		if added == 0 {
			fmt.Fprintf(c.out, "%-7s hooks already in %s\n", agent, rel)
		} else {
			fmt.Fprintf(c.out, "%-7s added %d hooks to %s\n", agent, added, rel)
		}
		if inst.Note != "" && added > 0 {
			fmt.Fprintf(c.out, "        %s\n", c.dim(inst.Note))
		}
		if *noMCP {
			continue
		}
		mcpAdded, err := hook.InstallMCP(agent, c.st.Repo.Root, bin)
		if err != nil {
			return err
		}
		if mcpAdded {
			fmt.Fprintf(c.out, "%-7s added the rewind MCP server to %s\n", "", hook.MCPFiles[agent])
			if note := hook.MCPNotes[agent]; note != "" {
				fmt.Fprintf(c.out, "        %s\n", c.dim(note))
			}
		}
	}
	fmt.Fprintln(c.out, "Sessions in this repo are now recorded. Run `rewind log` during or after one, or `rewind map` to replay it.")
	if !*noMCP {
		fmt.Fprintln(c.out, c.dim("Agents can now ask Rewind about the code, checkpoint, undo and bisect through its MCP tools."))
	}
	return nil
}

func (c *cli) watch(args []string) error {
	fs := flag.NewFlagSet("watch", flag.ContinueOnError)
	session := fs.String("s", "", "session to record into (default: a new one)")
	quiet := fs.Duration("quiet", 2*time.Second, "how long files must stay unchanged before a step is recorded")
	if err := parse(fs, args); err != nil {
		return err
	}
	name := *session
	if name == "" {
		name = "watch-" + c.st.NewSessionName()
	}
	if err := c.st.SetCurrent(name); err != nil {
		return err
	}
	fmt.Fprintf(c.out, "Watching %s for changes, recording into session %s. Press Ctrl+C to stop.\n", c.bold(filepath.Base(c.st.Repo.Root)), c.bold(name))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return watch.Run(c.st, watch.Options{Session: name, Quiet: *quiet, Out: c.out, Stop: ctx.Done()})
}

func (c *cli) start(args []string) error {
	name := c.st.NewSessionName()
	if len(args) > 0 {
		name = args[0]
	}
	if err := c.st.SetCurrent(name); err != nil {
		return err
	}
	step, created, err := c.st.Snapshot(name, store.Meta{Kind: store.KindStart, Summary: "session started"})
	if err != nil {
		return err
	}
	if created {
		fmt.Fprintf(c.out, "Started session %s (baseline is step %d).\n", c.bold(name), step.Step)
	} else {
		fmt.Fprintf(c.out, "Switched to session %s (%d steps).\n", c.bold(name), step.Step+1)
	}
	return nil
}

func (c *cli) snap(args []string) error {
	fs := flag.NewFlagSet("snap", flag.ContinueOnError)
	msg := fs.String("m", "", "describe this step")
	if err := parse(fs, args); err != nil {
		return err
	}
	session := c.st.Current()
	if session == "" {
		session = c.st.NewSessionName()
		if err := c.st.SetCurrent(session); err != nil {
			return err
		}
	}
	summary := *msg
	if summary == "" {
		summary = "manual snapshot"
	}
	step, created, err := c.st.Snapshot(session, store.Meta{Kind: store.KindManual, Summary: summary})
	if err != nil {
		return err
	}
	if !created {
		fmt.Fprintf(c.out, "Nothing changed since step %d.\n", step.Step)
		return nil
	}
	fmt.Fprintf(c.out, "Recorded step %d in %s.\n", step.Step, session)
	return nil
}

func (c *cli) log(args []string) error {
	fs := flag.NewFlagSet("log", flag.ContinueOnError)
	session := fs.String("s", "", "session to show (default: current)")
	asJSON := fs.Bool("json", false, "print steps as JSON (for editor integrations)")
	if err := parse(fs, args); err != nil {
		return err
	}
	name, err := c.session(*session)
	if err != nil {
		return err
	}
	steps, err := c.st.Steps(name)
	if err != nil {
		return err
	}
	if *asJSON {
		type js struct {
			Step    int    `json:"step"`
			Kind    string `json:"kind"`
			Summary string `json:"summary"`
			Prompt  string `json:"prompt,omitempty"`
			Time    int64  `json:"time"`
		}
		out := make([]js, len(steps))
		for i, s := range steps {
			out[i] = js{s.Step, s.Kind, s.Summary, s.Prompt, s.Time.Unix()}
		}
		return json.NewEncoder(c.out).Encode(map[string]any{"session": name, "steps": out})
	}
	fmt.Fprintf(c.out, "%s  %s\n\n", c.bold("Session "+name), c.dim(fmt.Sprintf("%d steps · started %s", len(steps), steps[0].Time.Format("Jan 2 15:04"))))
	lastPrompt := ""
	for i, s := range steps {
		if s.Prompt != "" && s.Prompt != lastPrompt {
			fmt.Fprintf(c.out, "  %s %s\n", c.paint("36", "▸"), c.paint("36", store.OneLine(s.Prompt, 90)))
			lastPrompt = s.Prompt
		}
		change := c.dim("baseline")
		if i > 0 {
			files, err := c.st.Changes(steps[i-1].Tree, s.Tree)
			if err != nil {
				return err
			}
			change = c.changeSummary(files)
		}
		fmt.Fprintf(c.out, "  %4d  %s  %-7s  %s  %s\n", s.Step, c.dim(s.Time.Format("15:04:05")), s.Kind, pad(change, 22, c.color), s.Summary)
	}
	return nil
}

func (c *cli) sessions() error {
	list, err := c.st.Sessions()
	if err != nil {
		return err
	}
	if len(list) == 0 {
		fmt.Fprintln(c.out, "No sessions yet. Run `rewind init claude` to record Claude Code sessions, or `rewind start` to begin one by hand.")
		return nil
	}
	for _, s := range list {
		mark := "  "
		if s.Current {
			mark = c.paint("32", "* ")
		}
		fmt.Fprintf(c.out, "%s%-28s %4d steps   %s\n", mark, s.Name, s.Steps, c.dim("updated "+s.Updated.Format("Jan 2 15:04")))
	}
	return nil
}

func (c *cli) show(args []string) error {
	fs := flag.NewFlagSet("show", flag.ContinueOnError)
	patch := fs.Bool("p", false, "print the full patch")
	if err := parse(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: rewind show [-p] <step>")
	}
	steps, i, err := c.resolve(fs.Arg(0))
	if err != nil {
		return err
	}
	s := steps[i]
	fmt.Fprintf(c.out, "%s  %s\n", c.bold(fmt.Sprintf("Step %d", s.Step)), c.dim(s.Time.Format("Mon Jan 2 15:04:05")+" · "+s.Kind+" · "+short(s.Commit)))
	fmt.Fprintf(c.out, "%s\n", s.Summary)
	if s.Prompt != "" {
		fmt.Fprintf(c.out, "\n%s\n%s\n", c.dim("Prompt:"), indent(s.Prompt, "  "))
	}
	from, err := c.parentTree(steps, i)
	if err != nil {
		return err
	}
	files, err := c.st.Changes(from, s.Tree)
	if err != nil {
		return err
	}
	if i == 0 {
		fmt.Fprintf(c.out, "\n%s\n", c.dim(fmt.Sprintf("Baseline snapshot of %d files.", len(files))))
		return nil
	}
	fmt.Fprintln(c.out)
	if len(files) == 0 {
		fmt.Fprintln(c.out, c.dim("No file changes."))
	}
	for _, f := range files {
		fmt.Fprintf(c.out, "  %s  %s\n", pad(c.numstat(f), 14, c.color), f.Path)
	}
	c.structure(from, s.Tree, files)
	if *patch && len(files) > 0 {
		fmt.Fprintln(c.out)
		return c.st.Diff(c.out, from, s.Tree, c.diffColor()...)
	}
	return nil
}

// relToRoot turns a path given on the command line into a path relative to
// the repository root.
func (c *cli) relToRoot(p string) (string, error) {
	if c.base != "" && !filepath.IsAbs(p) {
		p = filepath.Join(c.base, p)
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	root := c.st.Repo.Root
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	if realDir, err := filepath.EvalSymlinks(filepath.Dir(abs)); err == nil {
		abs = filepath.Join(realDir, filepath.Base(abs))
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("%s is outside the repository", p)
	}
	return filepath.ToSlash(rel), nil
}

func (c *cli) diff(args []string) error {
	fs := flag.NewFlagSet("diff", flag.ContinueOnError)
	stat := fs.Bool("stat", false, "show a diffstat instead of the patch")
	work := fs.Bool("w", false, "compare against the current files")
	if err := parse(fs, args); err != nil {
		return err
	}
	if fs.NArg() < 1 || fs.NArg() > 2 || (*work && fs.NArg() != 1) {
		return errors.New("usage: rewind diff [--stat] <a> [<b>]  or  rewind diff -w <step>")
	}
	steps, i, err := c.resolve(fs.Arg(0))
	if err != nil {
		return err
	}
	var from, to string
	switch {
	case *work:
		from = steps[i].Tree
		if to, err = c.st.WorkTree(); err != nil {
			return err
		}
	case fs.NArg() == 2:
		steps2, j, err := c.resolve(fs.Arg(1))
		if err != nil {
			return err
		}
		from, to = steps[i].Tree, steps2[j].Tree
	default:
		if from, err = c.parentTree(steps, i); err != nil {
			return err
		}
		to = steps[i].Tree
	}
	extra := c.diffColor()
	if *stat {
		extra = append(extra, "--stat")
	}
	return c.st.Diff(c.out, from, to, extra...)
}

func (c *cli) restore(args []string) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	dry := fs.Bool("n", false, "show what would change without touching any file")
	if err := parse(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: rewind restore [-n] <step>")
	}
	steps, i, err := c.resolve(fs.Arg(0))
	if err != nil {
		return err
	}
	target := steps[i]
	if *dry {
		plan, _, err := c.st.PlanRestore(target)
		if err != nil {
			return err
		}
		c.printPlan(plan, "would")
		return nil
	}
	session := c.sessionOf(fs.Arg(0))
	plan, err := c.st.Restore(session, target)
	if err != nil {
		return err
	}
	if len(plan.Write)+len(plan.Delete) == 0 {
		fmt.Fprintf(c.out, "Files already match step %d.\n", target.Step)
		return nil
	}
	c.printPlan(plan, "")
	fmt.Fprintf(c.out, "\nRestored step %d. The state before the restore is saved too, so `rewind log` shows how to undo this.\n", target.Step)
	return nil
}

func cmdHook(args []string, stdin io.Reader, out io.Writer) error {
	if len(args) != 1 {
		return errors.New("usage: rewind hook <" + strings.Join(hook.Agents, "|") + ">")
	}
	// A recording failure must never interrupt the agent, so errors are
	// logged to .git/rewind/hook.log and the hook always succeeds.
	ev, err := hook.Parse(args[0], stdin)
	if err == nil {
		_, err = hook.Record(ev, ".")
	}
	if err != nil && !errors.Is(err, gitx.ErrNotRepo) {
		hook.LogError(".", err)
	}
	if reply := hook.Reply(args[0], ev); reply != "" {
		fmt.Fprintln(out, reply)
	}
	return nil
}

// ---------------------------------------------------------------- helpers

func parse(fs *flag.FlagSet, args []string) error {
	fs.SetOutput(io.Discard)
	// Allow flags after positional arguments (`rewind show 3 -p`).
	var flags, pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") && len(a) > 1 && !isNumber(a) {
			flags = append(flags, a)
			if f := fs.Lookup(strings.TrimLeft(strings.SplitN(a, "=", 2)[0], "-")); f != nil && !strings.Contains(a, "=") {
				if _, isBool := f.Value.(interface{ IsBoolFlag() bool }); !isBool && i+1 < len(args) {
					flags = append(flags, args[i+1])
					i++
				}
			}
			continue
		}
		pos = append(pos, a)
	}
	if err := fs.Parse(append(flags, pos...)); err != nil {
		return fmt.Errorf("%s: %v", fs.Name(), err)
	}
	return nil
}

func isNumber(s string) bool { _, err := strconv.Atoi(s); return err == nil }

func (c *cli) session(name string) (string, error) {
	if name != "" {
		return name, nil
	}
	if cur := c.st.Current(); cur != "" {
		return cur, nil
	}
	return "", errors.New("no session yet: run `rewind start`, or `rewind init claude` to record agent sessions")
}

func (c *cli) sessionOf(ref string) string {
	if i := strings.LastIndex(ref, ":"); i >= 0 {
		return ref[:i]
	}
	s, _ := c.session("")
	return s
}

// resolve turns "7", "last", "<session>:7" or "<session>:last" into a step.
func (c *cli) resolve(ref string) ([]store.Step, int, error) {
	session, num := "", ref
	if i := strings.LastIndex(ref, ":"); i >= 0 {
		session, num = ref[:i], ref[i+1:]
	}
	name, err := c.session(session)
	if err != nil {
		return nil, 0, err
	}
	steps, err := c.st.Steps(name)
	if err != nil {
		return nil, 0, err
	}
	if num == "last" || num == "" {
		return steps, len(steps) - 1, nil
	}
	n, err := strconv.Atoi(num)
	if err != nil {
		return nil, 0, fmt.Errorf("%q is not a step (use a number, \"last\", or session:number)", ref)
	}
	for i, s := range steps {
		if s.Step == n {
			return steps, i, nil
		}
	}
	return nil, 0, fmt.Errorf("session %s has no step %d (steps 0–%d)", name, n, steps[len(steps)-1].Step)
}

func (c *cli) parentTree(steps []store.Step, i int) (string, error) {
	if i == 0 {
		return c.st.EmptyTree()
	}
	return steps[i-1].Tree, nil
}

func (c *cli) printPlan(p store.RestorePlan, verb string) {
	w, d := "write", "delete"
	if verb != "" {
		w, d = verb+" write", verb+" delete"
	}
	for _, f := range p.Write {
		fmt.Fprintf(c.out, "  %s  %s\n", c.paint("32", pad(w, 12, false)), f)
	}
	for _, f := range p.Delete {
		fmt.Fprintf(c.out, "  %s  %s\n", c.paint("31", pad(d, 12, false)), f)
	}
	if verb != "" && len(p.Write)+len(p.Delete) == 0 {
		fmt.Fprintln(c.out, "Files already match that step.")
	}
}

func (c *cli) changeSummary(files []store.FileChange) string {
	if len(files) == 0 {
		return c.dim("no changes")
	}
	add, del := 0, 0
	for _, f := range files {
		if f.Added > 0 {
			add += f.Added
		}
		if f.Deleted > 0 {
			del += f.Deleted
		}
	}
	noun := "files"
	if len(files) == 1 {
		noun = "file"
	}
	return fmt.Sprintf("%s %s %s", c.paint("32", fmt.Sprintf("+%d", add)), c.paint("31", fmt.Sprintf("-%d", del)), c.dim(fmt.Sprintf("%d %s", len(files), noun)))
}

func (c *cli) numstat(f store.FileChange) string {
	if f.Added < 0 {
		return c.dim("binary")
	}
	return c.paint("32", fmt.Sprintf("+%d", f.Added)) + " " + c.paint("31", fmt.Sprintf("-%d", f.Deleted))
}

func (c *cli) diffColor() []string {
	if c.color {
		return []string{"--color=always"}
	}
	return []string{"--no-color"}
}

func colorEnabled(w io.Writer) bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

func (c *cli) paint(code, s string) string {
	if !c.color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}
func (c *cli) bold(s string) string { return c.paint("1", s) }
func (c *cli) dim(s string) string  { return c.paint("2", s) }

// pad right-pads s to width visible characters, ignoring ANSI escapes.
func pad(s string, width int, hasColor bool) string {
	visible := s
	if hasColor {
		var b strings.Builder
		esc := false
		for _, r := range s {
			switch {
			case r == '\x1b':
				esc = true
			case esc && r == 'm':
				esc = false
			case !esc:
				b.WriteRune(r)
			}
		}
		visible = b.String()
	}
	if n := len([]rune(visible)); n < width {
		return s + strings.Repeat(" ", width-n)
	}
	return s
}

func short(id string) string {
	if len(id) > 10 {
		return id[:10]
	}
	return id
}

func indent(s, prefix string) string {
	return prefix + strings.ReplaceAll(strings.TrimRight(s, "\n"), "\n", "\n"+prefix)
}
