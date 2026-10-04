package codemap

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

// Entry is one file in a git tree.
type Entry struct {
	Path string
	Blob string
	Size int64
}

// treeSource reads files straight out of git's object database, so any
// snapshot (a Rewind step, HEAD, or the current work tree written as a tree)
// can be analysed without checking it out.
type treeSource struct {
	root    string
	entries []Entry
	byPath  map[string]Entry

	mu  sync.Mutex
	cmd *exec.Cmd
	in  io.WriteCloser
	out *bufio.Reader
}

func openTree(root, tree string) (*treeSource, error) {
	cmd := exec.Command("git", "ls-tree", "-r", "-z", "--long", "--full-tree", tree)
	cmd.Dir = root
	raw, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git ls-tree %s: %w", tree, err)
	}
	s := &treeSource{root: root, byPath: map[string]Entry{}}
	for _, rec := range strings.Split(string(raw), "\x00") {
		// "<mode> SP <type> SP <oid> SP* <size> TAB <path>"
		tab := strings.IndexByte(rec, '\t')
		if tab < 0 {
			continue
		}
		f := strings.Fields(rec[:tab])
		if len(f) != 4 || f[1] != "blob" || f[0] == "120000" { // skip submodules and symlinks
			continue
		}
		size, _ := strconv.ParseInt(f[3], 10, 64)
		e := Entry{Path: rec[tab+1:], Blob: f[2], Size: size}
		s.entries = append(s.entries, e)
		s.byPath[e.Path] = e
	}
	return s, nil
}

// read returns the contents of a blob. Blobs are streamed through a single
// long-lived `git cat-file --batch` process.
func (s *treeSource) read(blob string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil {
		cmd := exec.Command("git", "cat-file", "--batch")
		cmd.Dir = s.root
		in, err := cmd.StdinPipe()
		if err != nil {
			return nil, err
		}
		out, err := cmd.StdoutPipe()
		if err != nil {
			return nil, err
		}
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		s.cmd, s.in, s.out = cmd, in, bufio.NewReaderSize(out, 1<<16)
	}
	if _, err := io.WriteString(s.in, blob+"\n"); err != nil {
		return nil, err
	}
	header, err := s.out.ReadString('\n')
	if err != nil {
		return nil, err
	}
	f := strings.Fields(header)
	if len(f) != 3 {
		return nil, fmt.Errorf("cat-file: %s", strings.TrimSpace(header))
	}
	n, err := strconv.Atoi(f[2])
	if err != nil {
		return nil, err
	}
	buf := make([]byte, n+1) // content plus trailing newline
	if _, err := io.ReadFull(s.out, buf); err != nil {
		return nil, err
	}
	return buf[:n], nil
}

func (s *treeSource) readPath(path string) ([]byte, bool) {
	e, ok := s.byPath[path]
	if !ok {
		return nil, false
	}
	b, err := s.read(e.Blob)
	return b, err == nil
}

func (s *treeSource) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil {
		s.in.Close()
		_ = s.cmd.Wait()
		s.cmd = nil
	}
}
