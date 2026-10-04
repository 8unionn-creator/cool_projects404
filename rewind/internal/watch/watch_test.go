package watch

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
)

func TestWatchRecordsSettledChanges(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"config", "user.email", "t@e"}, {"config", "user.name", "t"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("1"), 0o644)
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- Run(st, Options{Session: "w", Interval: 20 * time.Millisecond, Quiet: 80 * time.Millisecond, Stop: stop})
	}()
	waitFor := func(n int) []store.Step {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if steps, err := st.Steps("w"); err == nil && len(steps) >= n {
				return steps
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for %d steps", n)
		return nil
	}
	waitFor(1) // baseline
	// A burst of edits settles into one step.
	for i := 0; i < 3; i++ {
		os.WriteFile(filepath.Join(dir, "a.txt"), []byte(strings.Repeat("x", i+2)), 0o644)
		os.WriteFile(filepath.Join(dir, "b.txt"), []byte("new"), 0o644)
		time.Sleep(10 * time.Millisecond)
	}
	steps := waitFor(2)
	close(stop)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	last := steps[len(steps)-1]
	if last.Kind != store.KindWatch || last.Summary != "edit a.txt, b.txt" {
		t.Fatalf("unexpected step: %+v", last.Meta)
	}
	if len(steps) != 2 {
		t.Fatalf("a burst of edits should become one step, got %d steps", len(steps))
	}
}
