// Package bisect finds the agent step that broke a test.
//
// It works like git bisect, but over the steps of a Rewind session, which
// are snapshots an agent never committed. Each probe puts the work tree back
// to one step, runs the test command, and reads its exit status: 0 is good,
// 125 means "cannot test this step" (as in git bisect), anything else is bad.
// When it finishes, the work tree is put back exactly as it was.
package bisect

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
)

// Verdicts for one probe.
const (
	Good = "good"
	Bad  = "bad"
	Skip = "skip"
)

// SkipCode is the exit status a test uses to say a step cannot be tested.
const SkipCode = 125

// Options configures a bisect run.
type Options struct {
	Session string
	Good    int // index into the session's steps known (or assumed) to pass; -1 for the first step
	Bad     int // index known (or assumed) to fail; -1 for the last step
	Command []string
	Timeout time.Duration // per probe; 0 means none. A probe that times out is bad.
	// Isolated runs each probe in a temporary copy of the step instead of
	// the work tree. It leaves your files alone, but the copy has no ignored
	// files (node_modules, virtualenvs, build output).
	Isolated bool
	Progress func(Probe) // called after each probe
}

// Probe is the result of running the command at one step.
type Probe struct {
	Step     int
	Verdict  string
	ExitCode int
	TimedOut bool
	Duration time.Duration
	Output   string // the end of the command's combined output
}

// Result is what a bisect found.
type Result struct {
	Session string
	// Culprit is the first bad step and LastGood the step before it. When
	// skipped steps hide the answer, Candidates lists the steps that may be
	// the culprit and Culprit is the first bad step after them.
	Culprit    store.Step
	LastGood   store.Step
	Candidates []int
	Probes     []Probe
	// BadOutput is the end of the command's output at the culprit step.
	BadOutput string
}

// ErrNotBroken means the command passes at the "bad" end too.
var ErrNotBroken = errors.New("the command passes at the last step; nothing to bisect")

// ErrAlwaysBroken means the command fails at the "good" end too.
type ErrAlwaysBroken struct{ Step int }

func (e ErrAlwaysBroken) Error() string {
	return fmt.Sprintf("the command already fails at step %d, the start of the range; pass an earlier good step or fix the test command", e.Step)
}

// Run bisects a session. ctx cancels the run; the work tree is restored
// either way.
func Run(ctx context.Context, st *store.Store, opts Options) (res Result, err error) {
	if len(opts.Command) == 0 {
		return res, errors.New("no test command")
	}
	steps, err := st.Steps(opts.Session)
	if err != nil {
		return res, err
	}
	good, bad := opts.Good, opts.Bad
	if good < 0 {
		good = 0
	}
	if bad < 0 {
		bad = len(steps) - 1
	}
	if good >= bad || bad >= len(steps) {
		return res, fmt.Errorf("need a good step before the bad one (got steps %d and %d)", steps[clamp(good, len(steps))].Step, steps[clamp(bad, len(steps))].Step)
	}
	res.Session = opts.Session

	run := &runner{st: st, opts: opts, ctx: ctx, seen: map[string]Probe{}}
	if !opts.Isolated {
		// Save the current files first: they are put back at the end, and
		// stay recoverable from the session even if this process dies.
		orig, err := st.WorkTree()
		if err != nil {
			return res, err
		}
		if _, _, err := st.Snapshot(opts.Session, store.Meta{Kind: store.KindManual, Summary: "before bisect"}); err != nil {
			return res, err
		}
		defer func() {
			if _, cerr := st.Checkout(orig); cerr != nil && err == nil {
				err = fmt.Errorf("putting your files back: %w (they are saved as the step before the bisect)", cerr)
			}
		}()
	}

	probe := func(i int) (Probe, error) {
		p, err := run.probe(steps[i])
		if err == nil {
			res.Probes = append(res.Probes, p)
			if opts.Progress != nil {
				opts.Progress(p)
			}
		}
		return p, err
	}

	// Check both ends, so a broken test command is caught early.
	p, err := probe(bad)
	if err != nil {
		return res, err
	}
	switch p.Verdict {
	case Good:
		return res, ErrNotBroken
	case Skip:
		return res, fmt.Errorf("the command cannot test step %d (exit %d); pick another bad step", p.Step, SkipCode)
	}
	badOut := p.Output
	if p, err = probe(good); err != nil {
		return res, err
	}
	switch p.Verdict {
	case Bad:
		return res, ErrAlwaysBroken{p.Step}
	case Skip:
		return res, fmt.Errorf("the command cannot test step %d (exit %d); pick another good step", p.Step, SkipCode)
	}

	skipped := map[int]bool{}
	for bad-good > 1 {
		mid := pick(good, bad, skipped)
		if mid < 0 {
			break // only skipped steps are left between good and bad
		}
		p, err := probe(mid)
		if err != nil {
			return res, err
		}
		switch p.Verdict {
		case Good:
			good = mid
		case Bad:
			bad, badOut = mid, p.Output
		default:
			skipped[mid] = true
		}
	}
	res.Culprit, res.LastGood, res.BadOutput = steps[bad], steps[good], badOut
	if bad-good > 1 {
		for i := good + 1; i <= bad; i++ {
			res.Candidates = append(res.Candidates, steps[i].Step)
		}
	}
	return res, nil
}

// pick returns the untested index closest to the middle of (lo, hi).
func pick(lo, hi int, skipped map[int]bool) int {
	mid := (lo + hi) / 2
	for d := 0; d < hi-lo; d++ {
		for _, i := range []int{mid - d, mid + d} {
			if i > lo && i < hi && !skipped[i] {
				return i
			}
		}
	}
	return -1
}

func clamp(i, n int) int {
	if i < 0 {
		return 0
	}
	if i >= n {
		return n - 1
	}
	return i
}

type runner struct {
	st   *store.Store
	opts Options
	ctx  context.Context
	seen map[string]Probe // results by tree: a restore can bring back an earlier tree
}

func (r *runner) probe(s store.Step) (Probe, error) {
	if p, ok := r.seen[s.Tree]; ok {
		p.Step = s.Step
		return p, nil
	}
	if err := r.ctx.Err(); err != nil {
		return Probe{}, err
	}
	dir := r.st.Repo.Root
	if r.opts.Isolated {
		tmp, err := os.MkdirTemp("", "rewind-bisect-*")
		if err != nil {
			return Probe{}, err
		}
		defer os.RemoveAll(tmp)
		if err := r.st.Export(s.Tree, tmp); err != nil {
			return Probe{}, err
		}
		dir = tmp
	} else if _, err := r.st.Checkout(s.Tree); err != nil {
		return Probe{}, err
	}
	p := r.exec(dir, s.Step)
	if err := r.ctx.Err(); err != nil {
		return Probe{}, err // the command was interrupted, not failing
	}
	r.seen[s.Tree] = p
	return p, nil
}

func (r *runner) exec(dir string, step int) Probe {
	ctx := r.ctx
	if r.opts.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, r.opts.Timeout)
		defer cancel()
	}
	cmd := Command(ctx, r.opts.Command)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "REWIND_BISECT_STEP="+strconv.Itoa(step))
	cmd.WaitDelay = 2 * time.Second
	out := &tail{max: 8 << 10}
	cmd.Stdout, cmd.Stderr = out, out
	start := time.Now()
	err := cmd.Run()
	p := Probe{Step: step, Duration: time.Since(start), Output: out.String()}
	var exit *exec.ExitError
	switch {
	case err == nil:
		p.Verdict = Good
	case ctx.Err() == context.DeadlineExceeded:
		p.Verdict, p.TimedOut, p.ExitCode = Bad, true, -1
	case errors.As(err, &exit):
		p.ExitCode = exit.ExitCode()
		p.Verdict = Bad
		if p.ExitCode == SkipCode {
			p.Verdict = Skip
		}
	default: // the command could not start at all
		p.Verdict, p.ExitCode = Bad, -1
		p.Output += err.Error()
	}
	return p
}

// Command builds the test command. A single argument is a shell command
// line ("npm test && npm run lint"); several are run directly.
func Command(ctx context.Context, args []string) *exec.Cmd {
	if len(args) == 1 {
		if runtime.GOOS == "windows" {
			return exec.CommandContext(ctx, "cmd", "/C", args[0])
		}
		return exec.CommandContext(ctx, "sh", "-c", args[0])
	}
	return exec.CommandContext(ctx, args[0], args[1:]...)
}

// tail keeps the last max bytes written to it.
type tail struct {
	mu  sync.Mutex
	max int
	buf bytes.Buffer
	cut bool
}

var _ io.Writer = (*tail)(nil)

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf.Write(p)
	if over := t.buf.Len() - t.max; over > 0 {
		t.buf.Next(over)
		t.cut = true
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.buf.String()
	if t.cut {
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = s[i+1:]
		}
		s = "...\n" + s
	}
	return s
}
