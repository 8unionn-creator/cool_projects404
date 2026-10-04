// Package store records snapshots of a work tree as a chain of git commits.
//
// Each session lives on its own ref, refs/rewind/<session>. A step is one
// commit on that ref whose tree is the full state of the work tree (tracked
// and untracked files, minus anything .gitignore excludes) at that moment.
// Snapshots are built with a private index file, so the user's branch,
// index, HEAD and stash are never touched.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/8unionn-creator/cool_projects404/rewind/internal/gitx"
)

const (
	refPrefix  = "refs/rewind/"
	metaPrefix = "rewind-meta: "
)

// Kinds of step.
const (
	KindStart   = "start"   // first snapshot of a session
	KindTool    = "tool"    // after an agent tool call
	KindPrompt  = "prompt"  // when the user sends a prompt (captures manual edits)
	KindManual  = "manual"  // `rewind snap`
	KindRestore = "restore" // after `rewind restore`
	KindWatch   = "watch"   // `rewind watch` saw files settle after a change
)

// Meta is stored as JSON on the last line of each step's commit message.
type Meta struct {
	Step    int    `json:"step"`
	Kind    string `json:"kind"`
	Tool    string `json:"tool,omitempty"`
	Summary string `json:"summary,omitempty"`
	Prompt  string `json:"prompt,omitempty"`
}

// Step is one snapshot.
type Step struct {
	Meta
	Commit string
	Tree   string
	Time   time.Time
}

// FileChange is one file's change between two steps.
type FileChange struct {
	Path    string
	Added   int // -1 for binary files
	Deleted int
}

// Session summarises one recorded session.
type Session struct {
	Name    string
	Steps   int
	Updated time.Time
	Current bool
}

// Store is a handle on one repository's recorded sessions.
type Store struct {
	Repo *gitx.Repo
	now  func() time.Time
}

// Open returns the store for the repository containing dir.
func Open(dir string) (*Store, error) {
	repo, err := gitx.Open(dir)
	if err != nil {
		return nil, err
	}
	return &Store{Repo: repo, now: time.Now}, nil
}

func (s *Store) dataDir() string { return filepath.Join(s.Repo.GitDir, "rewind") }

var validName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

// ValidName reports whether name can be used as a session name.
func ValidName(name string) bool {
	return validName.MatchString(name) && !strings.Contains(name, "..") && !strings.HasSuffix(name, ".lock")
}

// ---------------------------------------------------------------- sessions

// Current returns the name of the active session, or "" if none.
func (s *Store) Current() string {
	b, err := os.ReadFile(filepath.Join(s.dataDir(), "current"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// SetCurrent makes name the active session.
func (s *Store) SetCurrent(name string) error {
	if !ValidName(name) {
		return fmt.Errorf("invalid session name %q (use letters, digits, '.', '_' and '-')", name)
	}
	if err := os.MkdirAll(s.dataDir(), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.dataDir(), "current"), []byte(name+"\n"), 0o644)
}

// NewSessionName returns a timestamp-based session name.
func (s *Store) NewSessionName() string {
	return s.now().Format("2006-01-02-150405")
}

// Sessions lists every recorded session, most recently updated first.
func (s *Store) Sessions() ([]Session, error) {
	out, err := s.Repo.Git("for-each-ref", "--sort=-committerdate",
		"--format=%(refname)%1f%(committerdate:unix)%1f%(contents)%1e", refPrefix)
	if err != nil {
		return nil, err
	}
	cur := s.Current()
	var list []Session
	for _, rec := range strings.Split(out, "\x1e") {
		rec = strings.TrimSpace(rec)
		if rec == "" {
			continue
		}
		f := strings.SplitN(rec, "\x1f", 3)
		if len(f) != 3 {
			continue
		}
		name := strings.TrimPrefix(f[0], refPrefix)
		unix, _ := strconv.ParseInt(f[1], 10, 64)
		m := parseMeta(f[2])
		list = append(list, Session{Name: name, Steps: m.Step + 1, Updated: time.Unix(unix, 0), Current: name == cur})
	}
	return list, nil
}

// ---------------------------------------------------------------- snapshot

// Snapshot records the current state of the work tree as a new step on
// session. If nothing changed since the last step, no step is added and the
// existing tip is returned with created == false.
func (s *Store) Snapshot(session string, m Meta) (step Step, created bool, err error) {
	if !ValidName(session) {
		return Step{}, false, fmt.Errorf("invalid session name %q", session)
	}
	unlock, err := s.lock()
	if err != nil {
		return Step{}, false, err
	}
	defer unlock()

	tree, err := s.WorkTree()
	if err != nil {
		return Step{}, false, err
	}
	ref := refPrefix + session
	tip, err := s.tip(session)
	if err != nil {
		return Step{}, false, err
	}
	if tip != nil && tip.Tree == tree {
		return *tip, false, nil
	}

	m.Step = 0
	if tip != nil {
		m.Step = tip.Step + 1
	} else if m.Kind != KindStart {
		// The first step of a session is always its baseline.
		m.Kind, m.Tool = KindStart, ""
		if m.Summary == "" {
			m.Summary = "session started"
		}
	}

	args := []string{"commit-tree", tree}
	old := ""
	if tip != nil {
		args = append(args, "-p", tip.Commit)
		old = tip.Commit
	}
	now := s.now()
	date := fmt.Sprintf("%d %s", now.Unix(), now.Format("-0700"))
	commit, err := s.Repo.Run(gitx.Cmd{
		Args:  args,
		Stdin: strings.NewReader(message(m)),
		Env: []string{
			"GIT_AUTHOR_NAME=rewind", "GIT_AUTHOR_EMAIL=rewind@localhost", "GIT_AUTHOR_DATE=" + date,
			"GIT_COMMITTER_NAME=rewind", "GIT_COMMITTER_EMAIL=rewind@localhost", "GIT_COMMITTER_DATE=" + date,
		},
	})
	if err != nil {
		return Step{}, false, err
	}
	commit = strings.TrimSpace(commit)
	// Compare-and-swap on the old tip, so two writers can never fork a session.
	if _, err := s.Repo.Git("update-ref", "-m", "rewind: step "+strconv.Itoa(m.Step), ref, commit, old); err != nil {
		return Step{}, false, err
	}
	return Step{Meta: m, Commit: commit, Tree: tree, Time: time.Unix(now.Unix(), 0)}, true, nil
}

// WorkTree writes the current work tree into the object database and
// returns its tree id. It uses a private index seeded from the user's index
// (for its cached stat data), so it is fast and leaves the real index alone.
func (s *Store) WorkTree() (string, error) {
	if err := os.MkdirAll(s.dataDir(), 0o755); err != nil {
		return "", err
	}
	idx, err := s.tempIndex()
	if err != nil {
		return "", err
	}
	defer os.Remove(idx)
	// Seed from the user's index; with no index yet, git must create its own.
	if err := copyFile(filepath.Join(s.Repo.GitDir, "index"), idx); errors.Is(err, os.ErrNotExist) {
		os.Remove(idx)
	} else if err != nil {
		return "", err
	}
	env := []string{"GIT_INDEX_FILE=" + idx}
	if _, err := s.Repo.Run(gitx.Cmd{Args: []string{"add", "--all", "--", "."}, Env: env}); err != nil {
		return "", err
	}
	tree, err := s.Repo.Run(gitx.Cmd{Args: []string{"write-tree"}, Env: env})
	return strings.TrimSpace(tree), err
}

func message(m Meta) string {
	var b strings.Builder
	subject := m.Summary
	if subject == "" {
		subject = m.Kind
	}
	fmt.Fprintf(&b, "step %d: %s\n\n", m.Step, OneLine(subject, 72))
	if m.Prompt != "" {
		b.WriteString("Prompt:\n")
		b.WriteString(m.Prompt)
		b.WriteString("\n\n")
	}
	js, _ := json.Marshal(m)
	b.WriteString(metaPrefix)
	b.Write(js)
	b.WriteString("\n")
	return b.String()
}

func parseMeta(msg string) Meta {
	var m Meta
	lines := strings.Split(strings.TrimRight(msg, "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.HasPrefix(lines[i], metaPrefix) {
			_ = json.Unmarshal([]byte(strings.TrimPrefix(lines[i], metaPrefix)), &m)
			break
		}
	}
	return m
}

// ---------------------------------------------------------------- reading

// Steps returns every step of session, oldest first.
func (s *Store) Steps(session string) ([]Step, error) {
	if !ValidName(session) {
		return nil, fmt.Errorf("invalid session name %q", session)
	}
	ref := refPrefix + session
	if _, err := s.Repo.Git("rev-parse", "--verify", "--quiet", ref); err != nil {
		return nil, fmt.Errorf("no session named %q (run `rewind sessions` to list them)", session)
	}
	out, err := s.Repo.Git("log", "--first-parent", "--format=%H%x1f%T%x1f%ct%x1f%B%x1e", ref)
	if err != nil {
		return nil, err
	}
	var steps []Step
	for _, rec := range strings.Split(out, "\x1e") {
		rec = strings.TrimLeft(rec, "\n")
		if rec == "" {
			continue
		}
		f := strings.SplitN(rec, "\x1f", 4)
		if len(f) != 4 {
			continue
		}
		unix, _ := strconv.ParseInt(f[2], 10, 64)
		steps = append(steps, Step{Meta: parseMeta(f[3]), Commit: f[0], Tree: f[1], Time: time.Unix(unix, 0)})
	}
	sort.Slice(steps, func(i, j int) bool { return steps[i].Step < steps[j].Step })
	return steps, nil
}

func (s *Store) tip(session string) (*Step, error) {
	ref := refPrefix + session
	if _, err := s.Repo.Git("rev-parse", "--verify", "--quiet", ref); err != nil {
		return nil, nil // no session yet
	}
	out, err := s.Repo.Git("log", "-1", "--format=%H%x1f%T%x1f%ct%x1f%B", ref)
	if err != nil {
		return nil, err
	}
	f := strings.SplitN(out, "\x1f", 4)
	if len(f) != 4 {
		return nil, fmt.Errorf("unexpected log output for %s", ref)
	}
	unix, _ := strconv.ParseInt(f[2], 10, 64)
	return &Step{Meta: parseMeta(f[3]), Commit: f[0], Tree: f[1], Time: time.Unix(unix, 0)}, nil
}

// Changes lists the files that differ between two trees.
func (s *Store) Changes(fromTree, toTree string) ([]FileChange, error) {
	out, err := s.Repo.Git("diff-tree", "-r", "-z", "--no-renames", "--numstat", fromTree, toTree)
	if err != nil {
		return nil, err
	}
	var list []FileChange
	for _, rec := range strings.Split(out, "\x00") {
		f := strings.SplitN(rec, "\t", 3)
		if len(f) != 3 {
			continue
		}
		c := FileChange{Path: f[2], Added: -1, Deleted: -1}
		if f[0] != "-" {
			c.Added, _ = strconv.Atoi(f[0])
			c.Deleted, _ = strconv.Atoi(f[1])
		}
		list = append(list, c)
	}
	return list, nil
}

// EmptyTree returns the id of the empty tree, used to diff the first step.
func (s *Store) EmptyTree() (string, error) {
	out, err := s.Repo.Run(gitx.Cmd{Args: []string{"hash-object", "-t", "tree", "-w", "--stdin"}, Stdin: strings.NewReader("")})
	return strings.TrimSpace(out), err
}

// Diff writes a unified diff between two trees to w.
func (s *Store) Diff(w io.Writer, fromTree, toTree string, extra ...string) error {
	args := append([]string{"diff"}, extra...)
	args = append(args, fromTree, toTree)
	_, err := s.Repo.Run(gitx.Cmd{Args: args, Stdout: w})
	return err
}

// ---------------------------------------------------------------- restore

// RestorePlan describes what a restore would do to the work tree.
type RestorePlan struct {
	Write  []string // files created or overwritten
	Delete []string // files removed
}

// PlanRestore compares the current work tree with target.
func (s *Store) PlanRestore(target Step) (RestorePlan, string, error) {
	return s.plan(target.Tree)
}

func (s *Store) plan(tree string) (RestorePlan, string, error) {
	cur, err := s.WorkTree()
	if err != nil {
		return RestorePlan{}, "", err
	}
	out, err := s.Repo.Git("diff-tree", "-r", "-z", "--no-renames", "--name-status", cur, tree)
	if err != nil {
		return RestorePlan{}, "", err
	}
	var p RestorePlan
	f := strings.Split(out, "\x00")
	for i := 0; i+1 < len(f); i += 2 {
		status, path := f[i], f[i+1]
		if status == "D" {
			p.Delete = append(p.Delete, path)
		} else {
			p.Write = append(p.Write, path)
		}
	}
	return p, cur, nil
}

// Restore makes the work tree match target. Before touching anything it
// records the current state as a step on session, so a restore can itself
// be undone. Only files that differ are written; ignored files are never
// touched; the user's index, HEAD and branches are left alone.
func (s *Store) Restore(session string, target Step) (RestorePlan, error) {
	if _, _, err := s.Snapshot(session, Meta{Kind: KindManual, Summary: "before restoring step " + strconv.Itoa(target.Step)}); err != nil {
		return RestorePlan{}, err
	}
	plan, err := s.Checkout(target.Tree)
	if err != nil {
		return plan, err
	}
	_, _, err = s.Snapshot(session, Meta{Kind: KindRestore, Summary: "restored step " + strconv.Itoa(target.Step)})
	return plan, err
}

// Checkout makes the work tree match tree without recording anything. The
// caller is responsible for having saved the current state first.
func (s *Store) Checkout(tree string) (RestorePlan, error) {
	plan, _, err := s.plan(tree)
	if err != nil {
		return plan, err
	}
	for _, p := range plan.Delete {
		full := filepath.Join(s.Repo.Root, filepath.FromSlash(p))
		if err := os.Remove(full); err != nil && !errors.Is(err, os.ErrNotExist) {
			return plan, err
		}
		s.pruneEmptyDirs(filepath.Dir(full))
	}
	if len(plan.Write) > 0 {
		idx, err := s.tempIndex()
		if err != nil {
			return plan, err
		}
		os.Remove(idx) // read-tree wants to create the file itself
		defer os.Remove(idx)
		env := []string{"GIT_INDEX_FILE=" + idx}
		if _, err := s.Repo.Run(gitx.Cmd{Args: []string{"read-tree", tree}, Env: env}); err != nil {
			return plan, err
		}
		list := strings.Join(plan.Write, "\x00") + "\x00"
		if _, err := s.Repo.Run(gitx.Cmd{Args: []string{"checkout-index", "-f", "-z", "--stdin"}, Env: env, Stdin: strings.NewReader(list)}); err != nil {
			return plan, err
		}
	}
	return plan, nil
}

// Export writes the files of tree into dir, which must be empty or missing.
func (s *Store) Export(tree, dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(s.dataDir(), 0o755); err != nil {
		return err
	}
	idx, err := s.tempIndex()
	if err != nil {
		return err
	}
	os.Remove(idx)
	defer os.Remove(idx)
	env := []string{"GIT_INDEX_FILE=" + idx}
	if _, err := s.Repo.Run(gitx.Cmd{Args: []string{"read-tree", tree}, Env: env}); err != nil {
		return err
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	_, err = s.Repo.Run(gitx.Cmd{Args: []string{"--work-tree=" + abs, "checkout-index", "-a", "-f"}, Env: env})
	return err
}

// ErrUndoConflict means later edits overlap the step being undone.
var ErrUndoConflict = errors.New("later changes overlap this step")

// Undo reverses the changes of one step (prev -> step) in the current work
// tree, keeping every change made after it. The state before and after is
// recorded on session. With dry set, it only checks that the undo applies.
// On a conflict nothing is changed and the error lists the files.
func (s *Store) Undo(session string, prev, step Step, dry bool) ([]FileChange, error) {
	files, err := s.Changes(prev.Tree, step.Tree)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, nil
	}
	patch, err := s.Repo.Git("diff", "--binary", "--no-color", "--no-ext-diff", "--no-renames", "--full-index", prev.Tree, step.Tree)
	if err != nil {
		return nil, err
	}
	apply := func(check bool) error {
		args := []string{"apply", "-R", "--whitespace=nowarn"}
		if check {
			args = append(args, "--check")
		}
		_, err := s.Repo.Run(gitx.Cmd{Args: args, Stdin: strings.NewReader(patch)})
		return err
	}
	if err := apply(true); err != nil {
		return files, fmt.Errorf("%w: %v\nRestore the step before it instead, or undo the later steps first", ErrUndoConflict, conflictFiles(err))
	}
	if dry {
		return files, nil
	}
	if _, _, err := s.Snapshot(session, Meta{Kind: KindManual, Summary: "before undoing step " + strconv.Itoa(step.Step)}); err != nil {
		return files, err
	}
	if err := apply(false); err != nil {
		return files, err
	}
	_, _, err = s.Snapshot(session, Meta{Kind: KindRestore, Summary: "undid step " + strconv.Itoa(step.Step) + ": " + OneLine(step.Summary, 60)})
	return files, err
}

// conflictFiles picks the file names out of git apply's errors, which
// look like "error: path/to/file: patch does not apply".
func conflictFiles(err error) string {
	var files []string
	seen := map[string]bool{}
	for _, line := range strings.Split(err.Error(), "\n") {
		_, rest, ok := strings.Cut(line, "error: ")
		if !ok || strings.HasPrefix(rest, "patch failed") {
			continue
		}
		if f, _, ok := strings.Cut(rest, ": "); ok && !seen[f] {
			seen[f] = true
			files = append(files, f)
		}
	}
	if len(files) == 0 {
		return "the files no longer match"
	}
	return "conflicts in " + strings.Join(files, ", ")
}

func (s *Store) pruneEmptyDirs(dir string) {
	for dir != s.Repo.Root && strings.HasPrefix(dir, s.Repo.Root) {
		if os.Remove(dir) != nil { // fails unless empty
			return
		}
		dir = filepath.Dir(dir)
	}
}

// ---------------------------------------------------------------- helpers

// lock serialises writers (agent hooks can fire close together).
func (s *Store) lock() (func(), error) {
	if err := os.MkdirAll(s.dataDir(), 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(s.dataDir(), "lock")
	deadline := time.Now().Add(10 * time.Second)
	for {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintf(f, "%d\n", os.Getpid())
			f.Close()
			return func() { os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		// Break locks left behind by a crashed process.
		if fi, statErr := os.Stat(path); statErr == nil && time.Since(fi.ModTime()) > 30*time.Second {
			os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("another rewind process holds %s", path)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// tempIndex reserves a unique path for a private index file.
func (s *Store) tempIndex() (string, error) {
	f, err := os.CreateTemp(s.dataDir(), "index-*")
	if err != nil {
		return "", err
	}
	f.Close()
	return f.Name(), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// OneLine collapses whitespace and truncates s to max runes.
func OneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > max {
		return string(r[:max-1]) + "…"
	}
	return s
}
