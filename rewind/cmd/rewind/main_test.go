package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestCLI drives the commands end to end in a scratch repository.
func TestCLI(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"config", "user.email", "t@e"}, {"config", "user.name", "t"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	wd, _ := os.Getwd()
	t.Cleanup(func() { os.Chdir(wd) })
	os.Chdir(dir)

	sh := func(args ...string) string {
		t.Helper()
		var out bytes.Buffer
		if err := run(args, strings.NewReader(""), &out); err != nil {
			t.Fatalf("rewind %v: %v", args, err)
		}
		return out.String()
	}
	file := filepath.Join(dir, "notes.txt")

	os.WriteFile(file, []byte("v0\n"), 0o644)
	if out := sh("start", "demo"); !strings.Contains(out, "Started session demo") {
		t.Fatal(out)
	}
	os.WriteFile(file, []byte("v1\n"), 0o644)
	sh("snap", "-m", "first edit")
	if out := sh("snap"); !strings.Contains(out, "Nothing changed") {
		t.Fatal(out)
	}
	os.WriteFile(file, []byte("v2\n"), 0o644)
	sh("snap", "-m", "second edit")

	log := sh("log")
	for _, want := range []string{"Session demo", "first edit", "second edit", "+1 -1 1 file"} {
		if !strings.Contains(log, want) {
			t.Fatalf("log missing %q:\n%s", want, log)
		}
	}
	if out := sh("show", "1", "-p"); !strings.Contains(out, "+v1") {
		t.Fatalf("show -p should print the patch:\n%s", out)
	}
	if out := sh("diff", "1", "2"); !strings.Contains(out, "-v1") || !strings.Contains(out, "+v2") {
		t.Fatalf("diff:\n%s", out)
	}
	if out := sh("restore", "-n", "1"); !strings.Contains(out, "would write") {
		t.Fatalf("dry run:\n%s", out)
	}
	if b, _ := os.ReadFile(file); string(b) != "v2\n" {
		t.Fatal("dry run must not change files")
	}
	sh("restore", "demo:1")
	if b, _ := os.ReadFile(file); string(b) != "v1\n" {
		t.Fatalf("restore: file is %q", b)
	}
	if out := sh("diff", "-w", "last"); strings.TrimSpace(out) != "" {
		t.Fatalf("work tree should match the last step after restore:\n%s", out)
	}
	if out := sh("sessions"); !strings.Contains(out, "* demo") {
		t.Fatal(out)
	}

	var out bytes.Buffer
	if err := run([]string{"show", "99"}, nil, &out); err == nil || !strings.Contains(err.Error(), "no step 99") {
		t.Fatalf("want a clear error for a missing step, got %v", err)
	}
}
