package bisect

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/store"
)

// session records one step per value of value.txt.
func session(t *testing.T, values ...string) (*store.Store, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the test commands use sh")
	}
	dir := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"config", "user.email", "t@e"}, {"config", "user.name", "t"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("deps/\n"), 0o644)
	os.MkdirAll(filepath.Join(dir, "deps"), 0o755)
	os.WriteFile(filepath.Join(dir, "deps", "lib"), []byte("ignored"), 0o644)
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	for i, v := range values {
		os.WriteFile(filepath.Join(dir, "value.txt"), []byte(v+"\n"), 0o644)
		// A file that only exists in some steps, to check deletes and re-creates.
		extra := filepath.Join(dir, "extra.txt")
		if i%2 == 1 {
			os.WriteFile(extra, []byte(v), 0o644)
		} else {
			os.Remove(extra)
		}
		if _, _, err := st.Snapshot("s", store.Meta{Kind: store.KindTool, Summary: "set " + v}); err != nil {
			t.Fatal(err)
		}
	}
	return st, dir
}

const check = `case $(cat value.txt) in ok*) exit 0;; skip*) exit 125;; *) echo "value is wrong"; exit 1;; esac`

func TestFindsTheBreakingStep(t *testing.T) {
	st, dir := session(t, "ok0", "ok1", "ok2", "ok3", "ok4", "bad5", "bad6", "bad7", "bad8", "bad9")
	// Uncommitted work after the last step must survive the bisect.
	os.WriteFile(filepath.Join(dir, "value.txt"), []byte("my edit\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "new.txt"), []byte("untracked\n"), 0o644)

	var probes int
	res, err := Run(context.Background(), st, Options{Session: "s", Good: -1, Bad: -1, Command: []string{check}, Progress: func(Probe) { probes++ }})
	if err != nil {
		t.Fatal(err)
	}
	if res.Culprit.Step != 5 || res.LastGood.Step != 4 || len(res.Candidates) != 0 {
		t.Fatalf("culprit %d, last good %d, candidates %v", res.Culprit.Step, res.LastGood.Step, res.Candidates)
	}
	if probes > 6 {
		t.Errorf("a binary search over 10 steps should need at most 6 probes, used %d", probes)
	}
	if res.BadOutput != "value is wrong\n" {
		t.Errorf("bad output = %q", res.BadOutput)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "value.txt")); string(b) != "my edit\n" {
		t.Fatalf("the work tree was not put back: value.txt = %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "new.txt")); string(b) != "untracked\n" {
		t.Fatal("untracked files must be put back")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "extra.txt")); string(b) != "bad9" {
		t.Fatalf("extra.txt was deleted by some probes and must come back, got %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "deps", "lib")); string(b) != "ignored" {
		t.Fatal("ignored files must never be touched")
	}
}

func TestSkippedSteps(t *testing.T) {
	st, _ := session(t, "ok0", "ok1", "skip2", "skip3", "bad4", "bad5")
	res, err := Run(context.Background(), st, Options{Session: "s", Good: -1, Bad: -1, Command: []string{check}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Culprit.Step != 4 || res.LastGood.Step != 1 {
		t.Fatalf("culprit %d, last good %d", res.Culprit.Step, res.LastGood.Step)
	}
	if want := []int{2, 3, 4}; len(res.Candidates) != 3 || res.Candidates[0] != 2 || res.Candidates[2] != 4 {
		t.Fatalf("candidates = %v, want %v", res.Candidates, want)
	}
}

func TestIsolated(t *testing.T) {
	st, dir := session(t, "ok0", "ok1", "bad2", "bad3")
	before, _ := st.WorkTree()
	res, err := Run(context.Background(), st, Options{Session: "s", Good: -1, Bad: -1, Command: []string{"sh", "-c", check}, Isolated: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.Culprit.Step != 2 {
		t.Fatalf("culprit %d", res.Culprit.Step)
	}
	if after, _ := st.WorkTree(); after != before {
		t.Fatal("an isolated bisect must not touch the work tree")
	}
	if _, err := os.Stat(filepath.Join(dir, "deps", "lib")); err != nil {
		t.Fatal(err)
	}
	if steps, _ := st.Steps("s"); len(steps) != 4 {
		t.Fatalf("an isolated bisect should not record steps, have %d", len(steps))
	}
}

func TestEndsAreChecked(t *testing.T) {
	st, _ := session(t, "ok0", "ok1", "ok2")
	if _, err := Run(context.Background(), st, Options{Session: "s", Good: -1, Bad: -1, Command: []string{check}}); !errors.Is(err, ErrNotBroken) {
		t.Fatalf("want ErrNotBroken, got %v", err)
	}
	st, _ = session(t, "bad0", "bad1", "bad2")
	var always ErrAlwaysBroken
	if _, err := Run(context.Background(), st, Options{Session: "s", Good: -1, Bad: -1, Command: []string{check}}); !errors.As(err, &always) || always.Step != 0 {
		t.Fatalf("want ErrAlwaysBroken at step 0, got %v", err)
	}
}

func TestTimeoutIsBad(t *testing.T) {
	st, _ := session(t, "ok0", "slow1")
	res, err := Run(context.Background(), st, Options{Session: "s", Good: -1, Bad: -1, Timeout: 300e6,
		Command: []string{`grep -q slow value.txt && sleep 5; exit 0`}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Culprit.Step != 1 || !res.Probes[0].TimedOut {
		t.Fatalf("a hang should count as a failure: %+v", res.Probes)
	}
}
