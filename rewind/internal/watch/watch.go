// Package watch records steps without any agent integration: it polls the
// work tree and takes a snapshot whenever files change and then stay quiet
// for a moment. It works with any editor or agent (Aider, Copilot,
// Windsurf, or edits by hand).
package watch

import (
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
)

// Options configures a watch.
type Options struct {
	Session  string        // session to record into
	Interval time.Duration // how often to look for changes
	Quiet    time.Duration // how long files must stay unchanged before a snapshot
	Out      io.Writer     // progress messages; may be nil
	Stop     <-chan struct{}
}

// Run watches until opt.Stop is closed.
func Run(st *store.Store, opt Options) error {
	if opt.Interval <= 0 {
		opt.Interval = time.Second
	}
	if opt.Quiet <= 0 {
		opt.Quiet = 2 * time.Second
	}
	say := func(format string, a ...any) {
		if opt.Out != nil {
			fmt.Fprintf(opt.Out, format, a...)
		}
	}
	if _, created, err := st.Snapshot(opt.Session, store.Meta{Kind: store.KindStart, Summary: "watch started"}); err != nil {
		return err
	} else if created {
		say("Baseline recorded in %s.\n", opt.Session)
	}
	last, err := fingerprint(st)
	if err != nil {
		return err
	}
	var changedAt time.Time
	dirty := false
	tick := time.NewTicker(opt.Interval)
	defer tick.Stop()
	for {
		select {
		case <-opt.Stop:
			return nil
		case now := <-tick.C:
			fp, err := fingerprint(st)
			if err != nil {
				return err
			}
			if fp != last {
				last, changedAt, dirty = fp, now, true
				continue
			}
			if !dirty || now.Sub(changedAt) < opt.Quiet {
				continue
			}
			dirty = false
			step, created, err := snap(st, opt.Session)
			if err != nil {
				return err
			}
			if created {
				say("step %d  %s  %s\n", step.Step, step.Time.Format("15:04:05"), step.Summary)
			}
		}
	}
}

// snap records the work tree with a summary of what changed.
func snap(st *store.Store, session string) (store.Step, bool, error) {
	tree, err := st.WorkTree()
	if err != nil {
		return store.Step{}, false, err
	}
	summary := "files changed"
	if steps, err := st.Steps(session); err == nil && len(steps) > 0 {
		if files, err := st.Changes(steps[len(steps)-1].Tree, tree); err == nil {
			summary = describe(files)
		}
	}
	return st.Snapshot(session, store.Meta{Kind: store.KindWatch, Summary: summary})
}

func describe(files []store.FileChange) string {
	if len(files) == 0 {
		return "files changed"
	}
	var names []string
	for i, f := range files {
		if i == 3 {
			names = append(names, fmt.Sprintf("+%d more", len(files)-3))
			break
		}
		names = append(names, f.Path)
	}
	return "edit " + strings.Join(names, ", ")
}

// fingerprint summarises the state of every changed or untracked file:
// git status names them, and size and modification time catch further
// edits to a file that was already modified.
func fingerprint(st *store.Store) (string, error) {
	out, err := st.Repo.Git("status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return "", err
	}
	h := sha256.New()
	h.Write([]byte(out))
	for _, rec := range strings.Split(out, "\x00") {
		if len(rec) < 4 {
			continue
		}
		p := filepath.Join(st.Repo.Root, filepath.FromSlash(rec[3:]))
		if fi, err := os.Stat(p); err == nil {
			fmt.Fprintf(h, "%s %d %d\n", rec[3:], fi.Size(), fi.ModTime().UnixNano())
		}
	}
	return fmt.Sprintf("%x", h.Sum(nil)), nil
}
