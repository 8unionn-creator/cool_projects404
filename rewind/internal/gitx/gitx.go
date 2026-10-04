// Package gitx is a thin wrapper around the git command line.
//
// Rewind stores everything as ordinary git objects, so shelling out to git
// keeps it byte-for-byte compatible with whatever git the user already has.
package gitx

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ErrNotRepo is returned by Open when the directory is not inside a work tree.
var ErrNotRepo = errors.New("not inside a git work tree")

// Repo is a git work tree.
type Repo struct {
	Root   string // absolute path of the work tree
	GitDir string // absolute path of the .git directory
}

// Open finds the repository that contains dir.
func Open(dir string) (*Repo, error) {
	out, err := run(dir, nil, nil, "rev-parse", "--show-toplevel", "--absolute-git-dir")
	if err != nil {
		return nil, ErrNotRepo
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 || lines[0] == "" {
		return nil, ErrNotRepo
	}
	return &Repo{Root: filepath.Clean(lines[0]), GitDir: filepath.Clean(lines[1])}, nil
}

// Cmd describes one git invocation.
type Cmd struct {
	Args   []string
	Env    []string  // extra KEY=VALUE pairs
	Stdin  io.Reader // optional
	Stdout io.Writer // optional; when set, output is streamed instead of returned
}

// Run executes git in the work tree root and returns its stdout.
func (r *Repo) Run(c Cmd) (string, error) {
	if c.Stdout != nil {
		cmd := exec.Command("git", c.Args...)
		cmd.Dir = r.Root
		cmd.Env = append(os.Environ(), c.Env...)
		cmd.Stdin = c.Stdin
		cmd.Stdout = c.Stdout
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			return "", wrap(c.Args, err, stderr.String())
		}
		return "", nil
	}
	return run(r.Root, c.Env, c.Stdin, c.Args...)
}

// Git is shorthand for Run with only arguments.
func (r *Repo) Git(args ...string) (string, error) {
	return r.Run(Cmd{Args: args})
}

func run(dir string, env []string, stdin io.Reader, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdin = stdin
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return stdout.String(), wrap(args, err, stderr.String())
	}
	return stdout.String(), nil
}

func wrap(args []string, err error, stderr string) error {
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		msg = err.Error()
	}
	return fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
}
