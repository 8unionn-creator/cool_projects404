package store

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// newRepo creates a git repository with one commit and returns its store.
func newRepo(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	git(t, dir, "init", "-q")
	git(t, dir, "config", "user.email", "test@example.com")
	git(t, dir, "config", "user.name", "test")
	write(t, dir, "README.md", "hello\n")
	write(t, dir, ".gitignore", "build/\n")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-qm", "init")
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func exists(dir, name string) bool {
	_, err := os.Stat(filepath.Join(dir, filepath.FromSlash(name)))
	return err == nil
}

func mustSnap(t *testing.T, st *Store, session string, m Meta) Step {
	t.Helper()
	s, created, err := st.Snapshot(session, m)
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatalf("expected a new step for %q", m.Summary)
	}
	return s
}

func TestSnapshotNumbersStepsAndSkipsNoOps(t *testing.T) {
	st := newRepo(t)
	root := st.Repo.Root

	s0 := mustSnap(t, st, "s1", Meta{Kind: KindTool, Summary: "ignored kind"})
	if s0.Step != 0 || s0.Kind != KindStart {
		t.Fatalf("first step should be a start step 0, got %d %q", s0.Step, s0.Kind)
	}
	if _, created, _ := st.Snapshot("s1", Meta{Kind: KindTool}); created {
		t.Fatal("snapshot with no changes should not create a step")
	}
	write(t, root, "a.txt", "one\n")
	s1 := mustSnap(t, st, "s1", Meta{Kind: KindTool, Tool: "Write", Summary: "Write a.txt", Prompt: "make a file\nplease"})
	if s1.Step != 1 {
		t.Fatalf("want step 1, got %d", s1.Step)
	}

	steps, err := st.Steps("s1")
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 2 || steps[1].Tool != "Write" || steps[1].Prompt != "make a file\nplease" {
		t.Fatalf("metadata did not round-trip: %+v", steps)
	}
	changes, err := st.Changes(steps[0].Tree, steps[1].Tree)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 1 || changes[0].Path != "a.txt" || changes[0].Added != 1 {
		t.Fatalf("unexpected changes: %+v", changes)
	}
}

func TestSnapshotLeavesUserStateAlone(t *testing.T) {
	st := newRepo(t)
	root := st.Repo.Root
	write(t, root, "staged.txt", "staged\n")
	git(t, root, "add", "staged.txt")
	head := git(t, root, "rev-parse", "HEAD")
	indexBefore := git(t, root, "diff", "--cached", "--name-status")

	mustSnap(t, st, "s", Meta{})
	write(t, root, "untracked.txt", "x\n")
	write(t, root, "build/out.bin", "ignored\n")
	step := mustSnap(t, st, "s", Meta{Kind: KindManual})

	if got := git(t, root, "rev-parse", "HEAD"); got != head {
		t.Fatal("HEAD moved")
	}
	if got := git(t, root, "diff", "--cached", "--name-status"); got != indexBefore {
		t.Fatalf("index changed:\n%s\nwant:\n%s", got, indexBefore)
	}
	files := git(t, root, "ls-tree", "-r", "--name-only", step.Tree)
	if !strings.Contains(files, "untracked.txt") || !strings.Contains(files, "staged.txt") {
		t.Fatalf("snapshot should include untracked and staged files:\n%s", files)
	}
	if strings.Contains(files, "build/") {
		t.Fatal("snapshot should respect .gitignore")
	}
	// The objects must be valid for stock git.
	git(t, root, "fsck", "--no-progress")
}

func TestRestore(t *testing.T) {
	st := newRepo(t)
	root := st.Repo.Root
	mustSnap(t, st, "s", Meta{})
	write(t, root, "src/keep.go", "v1\n")
	write(t, root, "src/deep/gone.go", "will be deleted\n")
	target := mustSnap(t, st, "s", Meta{Kind: KindTool, Summary: "v1"})

	// The "agent" goes off the rails.
	write(t, root, "src/keep.go", "v2 broken\n")
	os.RemoveAll(filepath.Join(root, "src/deep"))
	write(t, root, "src/new/extra.go", "should disappear\n")
	write(t, root, "build/cache", "ignored, must survive\n")

	plan, _, err := st.PlanRestore(target)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Write) != 2 || len(plan.Delete) != 1 {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	if read(t, root, "src/keep.go") != "v2 broken\n" {
		t.Fatal("planning must not touch files")
	}

	if _, err := st.Restore("s", target); err != nil {
		t.Fatal(err)
	}
	if got := read(t, root, "src/keep.go"); got != "v1\n" {
		t.Fatalf("keep.go = %q", got)
	}
	if got := read(t, root, "src/deep/gone.go"); got != "will be deleted\n" {
		t.Fatalf("gone.go = %q", got)
	}
	if exists(root, "src/new/extra.go") || exists(root, "src/new") {
		t.Fatal("file created after the target step should be removed, with its empty directory")
	}
	if read(t, root, "build/cache") != "ignored, must survive\n" {
		t.Fatal("ignored files must not be touched")
	}

	// The broken state was saved before restoring, so the restore can be undone.
	steps, _ := st.Steps("s")
	if n := len(steps); n != 4 || steps[2].Kind != KindManual || steps[3].Kind != KindRestore {
		t.Fatalf("want start, tool, before-restore, restore; got %+v", steps)
	}
	if _, err := st.Restore("s", steps[2]); err != nil {
		t.Fatal(err)
	}
	if got := read(t, root, "src/keep.go"); got != "v2 broken\n" {
		t.Fatalf("undo of restore failed: keep.go = %q", got)
	}
}

func TestSessionsAndCurrent(t *testing.T) {
	st := newRepo(t)
	if st.Current() != "" {
		t.Fatal("no session should be current in a fresh repo")
	}
	if err := st.SetCurrent("../evil"); err == nil {
		t.Fatal("path-like session names must be rejected")
	}
	mustSnap(t, st, "alpha", Meta{})
	write(t, st.Repo.Root, "x", "1")
	mustSnap(t, st, "alpha", Meta{Kind: KindManual})
	mustSnap(t, st, "beta", Meta{})
	if err := st.SetCurrent("beta"); err != nil {
		t.Fatal(err)
	}
	list, err := st.Sessions()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Session{}
	for _, s := range list {
		got[s.Name] = s
	}
	if got["alpha"].Steps != 2 || got["beta"].Steps != 1 || !got["beta"].Current || got["alpha"].Current {
		t.Fatalf("unexpected sessions: %+v", list)
	}
	if _, err := st.Steps("missing"); err == nil {
		t.Fatal("unknown session should be an error")
	}
}

func TestEmptyRepoWithoutCommits(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-q")
	write(t, dir, "first.txt", "hi\n")
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	s := mustSnap(t, st, "s", Meta{})
	if out := git(t, dir, "ls-tree", "--name-only", s.Tree); strings.TrimSpace(out) != "first.txt" {
		t.Fatalf("unexpected tree: %q", out)
	}
}

// Agent hooks can fire close together; steps must stay a single, gap-free chain.
func TestConcurrentSnapshots(t *testing.T) {
	st := newRepo(t)
	mustSnap(t, st, "s", Meta{})
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			write(t, st.Repo.Root, fmt.Sprintf("f%d.txt", i), "x")
			if _, _, err := st.Snapshot("s", Meta{Kind: KindTool}); err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	steps, err := st.Steps("s")
	if err != nil {
		t.Fatal(err)
	}
	for i, s := range steps {
		if s.Step != i {
			t.Fatalf("step numbers have a gap or fork: %d at position %d", s.Step, i)
		}
	}
	last := git(t, st.Repo.Root, "ls-tree", "--name-only", steps[len(steps)-1].Tree)
	if strings.Count(last, "f") < 8 {
		t.Fatalf("final step should contain all 8 files:\n%s", last)
	}
}

func TestUndoOneStepKeepsLaterWork(t *testing.T) {
	st := newRepo(t)
	write(t, st.Repo.Root, "a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n")
	mustSnap(t, st, "s", Meta{})
	write(t, st.Repo.Root, "a.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n")
	write(t, st.Repo.Root, "b.txt", "new file\n")
	bad := mustSnap(t, st, "s", Meta{Kind: KindTool, Summary: "bad step"})
	write(t, st.Repo.Root, "a.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n")
	mustSnap(t, st, "s", Meta{Kind: KindTool, Summary: "good later step"})
	steps, _ := st.Steps("s")

	if _, err := st.Undo("s", steps[0], bad, true); err != nil {
		t.Fatal(err)
	}
	if read(t, st.Repo.Root, "a.txt") != "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n" {
		t.Fatal("a dry run must not change files")
	}
	files, err := st.Undo("s", steps[0], bad, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("files = %+v", files)
	}
	if got := read(t, st.Repo.Root, "a.txt"); got != "one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n" {
		t.Fatalf("undo should revert line 1 and keep the later edit, got %q", got)
	}
	if exists(st.Repo.Root, "b.txt") {
		t.Fatal("undo should delete the file the step added")
	}
	after, _ := st.Steps("s")
	if len(after) != 4 || after[3].Kind != KindRestore { // "before" is skipped: nothing changed since the last step
		t.Fatalf("an undo should record before and after, got %d steps", len(after))
	}

	// A later edit of the same lines conflicts: nothing may change.
	write(t, st.Repo.Root, "c.txt", "x\n")
	s1 := mustSnap(t, st, "s", Meta{Kind: KindTool})
	write(t, st.Repo.Root, "c.txt", "y\n")
	s2 := mustSnap(t, st, "s", Meta{Kind: KindTool})
	write(t, st.Repo.Root, "c.txt", "z\n")
	_, err = st.Undo("s", s1, s2, false)
	if !errors.Is(err, ErrUndoConflict) || !strings.Contains(err.Error(), "c.txt") {
		t.Fatalf("want a conflict naming c.txt, got %v", err)
	}
	if read(t, st.Repo.Root, "c.txt") != "z\n" {
		t.Fatal("a failed undo must not touch files")
	}
}
