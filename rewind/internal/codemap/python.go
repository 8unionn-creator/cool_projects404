package codemap

import (
	"path"
	"regexp"
	"strings"
)

// pyLine is one logical line: bracketed and backslash continuations joined,
// with string contents blanked and comments removed.
type pyLine struct {
	text   string
	line   int // first physical line, 1-based
	indent int
}

// pyLogicalLines strips strings and comments without breaking line numbers.
func pyLogicalLines(src string) []pyLine {
	var clean strings.Builder
	clean.Grow(len(src))
	for i := 0; i < len(src); {
		c := src[i]
		switch {
		case c == '#':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '"' || c == '\'':
			q := string(c)
			if strings.HasPrefix(src[i:], q+q+q) {
				q = q + q + q
			}
			clean.WriteString(q)
			i += len(q)
			for i < len(src) {
				if src[i] == '\\' && i+1 < len(src) {
					clean.WriteString(blank(src[i : i+2]))
					i += 2
					continue
				}
				if strings.HasPrefix(src[i:], q) {
					break
				}
				if len(q) == 1 && src[i] == '\n' { // unterminated single-quoted string
					break
				}
				clean.WriteString(blank(src[i : i+1]))
				i++
			}
			if strings.HasPrefix(src[i:], q) {
				clean.WriteString(q)
				i += len(q)
			}
		default:
			clean.WriteByte(c)
			i++
		}
	}

	var out []pyLine
	var cur strings.Builder
	start, indent, depth := 0, 0, 0
	for n, l := range strings.Split(clean.String(), "\n") {
		if cur.Len() == 0 && depth == 0 {
			trimmed := strings.TrimLeft(l, " \t")
			if trimmed == "" {
				continue
			}
			start, indent = n+1, indentWidth(l[:len(l)-len(trimmed)])
		}
		for _, c := range l {
			switch c {
			case '(', '[', '{':
				depth++
			case ')', ']', '}':
				if depth > 0 {
					depth--
				}
			}
		}
		t := strings.TrimSpace(l)
		cont := strings.HasSuffix(t, "\\")
		cur.WriteString(strings.TrimSuffix(t, "\\"))
		cur.WriteByte(' ')
		if depth == 0 && !cont {
			out = append(out, pyLine{text: strings.TrimSpace(cur.String()), line: start, indent: indent})
			cur.Reset()
		}
	}
	if cur.Len() > 0 {
		out = append(out, pyLine{text: strings.TrimSpace(cur.String()), line: start, indent: indent})
	}
	return out
}

// blank replaces every byte except newlines with a space.
func blank(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] != '\n' {
			b[i] = ' '
		}
	}
	return string(b)
}

func indentWidth(ws string) int {
	n := 0
	for _, c := range ws {
		if c == '\t' {
			n += 8 - n%8
		} else {
			n++
		}
	}
	return n
}

var (
	pyImport     = regexp.MustCompile(`^import\s+(.+)$`)
	pyFromImport = regexp.MustCompile(`^from\s+(\.*)([\w.]*)\s+import\s+(.+)$`)
	pyDef        = regexp.MustCompile(`^(?:async\s+)?def\s+(\w+)`)
	pyClass      = regexp.MustCompile(`^class\s+(\w+)`)
	pyConst      = regexp.MustCompile(`^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=[^=]`)
	pyMain       = regexp.MustCompile(`(?m)^if\s+__name__\s*==\s*['"]__main__['"]\s*:`)
	pyTypeCheck  = regexp.MustCompile(`^if\s+(?:\w+\.)?TYPE_CHECKING\s*:`)
	pyBranch     = regexp.MustCompile(`\b(?:if|elif|for|while|except|and|or|case)\b`)
)

const typeChecking = "\x00TYPE_CHECKING"

func parsePython(f *File, src []byte) {
	base := path.Base(f.Path)
	f.Test = strings.HasPrefix(base, "test_") || strings.HasSuffix(base, "_test.py") || base == "conftest.py" ||
		strings.HasPrefix(f.Path, "tests/") || strings.Contains(f.Path, "/tests/")
	f.Entry = base == "__main__.py" || base == "manage.py" || pyMain.Match(src)

	type class struct {
		name   string
		indent int
	}
	var classes []class
	for _, l := range pyLogicalLines(string(src)) {
		f.Complexity += len(pyBranch.FindAllStringIndex(l.text, -1))
		for len(classes) > 0 && l.indent <= classes[len(classes)-1].indent {
			classes = classes[:len(classes)-1]
		}
		// Imports under `if TYPE_CHECKING:` or inside a function body do not
		// run when the module loads, so they cannot cause import cycles.
		lazy := false
		for _, c := range classes {
			if c.name == "" || c.name == typeChecking {
				lazy = true
			}
		}
		if pyTypeCheck.MatchString(l.text) {
			classes = append(classes, class{typeChecking, l.indent})
			continue
		}
		if m := pyImport.FindStringSubmatch(l.text); m != nil {
			for _, part := range strings.Split(m[1], ",") {
				if name := firstWord(part); name != "" {
					f.Imports = append(f.Imports, Import{Spec: name, Line: l.line, TypeOnly: lazy})
				}
			}
			continue
		}
		if m := pyFromImport.FindStringSubmatch(l.text); m != nil {
			names := strings.Trim(strings.TrimSpace(m[3]), "()")
			imp := Import{Spec: m[1] + m[2], Line: l.line, TypeOnly: lazy}
			for _, part := range strings.Split(names, ",") {
				if n := firstWord(part); n != "" && n != "*" {
					imp.Names = append(imp.Names, n)
				}
			}
			f.Imports = append(f.Imports, imp)
			continue
		}
		if m := pyClass.FindStringSubmatch(l.text); m != nil {
			if l.indent == 0 {
				f.Symbols = append(f.Symbols, Symbol{Name: m[1], Kind: "class", Line: l.line, Exported: !strings.HasPrefix(m[1], "_")})
			}
			classes = append(classes, class{m[1], l.indent})
			continue
		}
		if m := pyDef.FindStringSubmatch(l.text); m != nil {
			switch {
			case l.indent == 0:
				f.Symbols = append(f.Symbols, Symbol{Name: m[1], Kind: "func", Line: l.line, Exported: !strings.HasPrefix(m[1], "_")})
			case len(classes) > 0 && len(classes) == 1 && classes[0].indent == 0:
				f.Symbols = append(f.Symbols, Symbol{Name: classes[0].name + "." + m[1], Kind: "method", Line: l.line, Exported: !strings.HasPrefix(m[1], "_")})
			}
			// A def opens a scope; nested defs inside it are not methods.
			classes = append(classes, class{"", l.indent})
			continue
		}
		if l.indent == 0 {
			if m := pyConst.FindStringSubmatch(l.text); m != nil {
				f.Symbols = append(f.Symbols, Symbol{Name: m[1], Kind: "const", Line: l.line, Exported: true})
			}
		}
	}
}

func firstWord(s string) string {
	f := strings.Fields(s)
	if len(f) == 0 {
		return ""
	}
	return f[0]
}

func resolvePython(b *builder) {
	g := b.g
	has := false
	for _, f := range g.Files {
		if f.Lang == Python {
			has = true
			break
		}
	}
	if !has {
		return
	}

	// Source roots: the repo root, src/, and the parent of every top-level
	// package (a directory with __init__.py whose parent has none).
	isPkg := map[string]bool{}
	for _, f := range g.Files {
		if path.Base(f.Path) == "__init__.py" {
			isPkg[path.Dir(f.Path)] = true
		}
	}
	roots := []string{"."}
	seen := map[string]bool{".": true}
	addRoot := func(r string) {
		if !seen[r] {
			seen[r] = true
			roots = append(roots, r)
		}
	}
	if _, ok := b.dirs["src"]; ok {
		addRoot("src")
	}
	for d := range isPkg {
		if parent := path.Dir(d); !isPkg[parent] {
			addRoot(parent)
		}
	}
	modules := map[string]int{} // dotted name -> file
	topLevel := map[string]bool{}
	for _, r := range roots {
		for i, f := range g.Files {
			if f.Lang != Python {
				continue
			}
			rel := f.Path
			if r != "." {
				if !strings.HasPrefix(f.Path, r+"/") {
					continue
				}
				rel = strings.TrimPrefix(f.Path, r+"/")
			}
			name := strings.ReplaceAll(strings.TrimSuffix(rel, ".py"), "/", ".")
			name = strings.TrimSuffix(strings.TrimSuffix(name, "__init__"), ".")
			if name == "" {
				continue
			}
			if _, dup := modules[name]; !dup {
				modules[name] = i
			}
			topLevel[strings.SplitN(name, ".", 2)[0]] = true
		}
	}
	byPath := func(p string) int {
		if i := g.Index(p + ".py"); i >= 0 {
			return i
		}
		return g.Index(path.Join(p, "__init__.py"))
	}

	for i, f := range g.Files {
		if f.Lang != Python {
			continue
		}
		dir := path.Dir(f.Path)
		for _, imp := range f.Imports {
			if strings.HasPrefix(imp.Spec, ".") { // relative import
				level := len(imp.Spec) - len(strings.TrimLeft(imp.Spec, "."))
				base := dir
				for k := 1; k < level; k++ {
					base = path.Dir(base)
				}
				mod := strings.TrimLeft(imp.Spec, ".")
				p := base
				if mod != "" {
					p = path.Join(base, strings.ReplaceAll(mod, ".", "/"))
				}
				linked := false
				for _, n := range imp.Names {
					if j := byPath(path.Join(p, n)); j >= 0 {
						b.link(i, j, 1, imp.TypeOnly)
						linked = true
					}
				}
				if !linked {
					b.link(i, byPath(p), max(1, len(imp.Names)), imp.TypeOnly)
				}
				continue
			}

			// Absolute import: a submodule (from pkg import mod), the module
			// itself, a sibling script, or the deepest parent package found.
			linked := false
			for _, n := range imp.Names {
				if j, ok := modules[imp.Spec+"."+n]; ok {
					b.link(i, j, 1, imp.TypeOnly)
					linked = true
				}
			}
			if linked {
				continue
			}
			if j, ok := modules[imp.Spec]; ok {
				b.link(i, j, max(1, len(imp.Names)), imp.TypeOnly)
				continue
			}
			if j := byPath(path.Join(dir, strings.ReplaceAll(imp.Spec, ".", "/"))); j >= 0 {
				b.link(i, j, max(1, len(imp.Names)), imp.TypeOnly)
				continue
			}
			found := false
			parts := strings.Split(imp.Spec, ".")
			for k := len(parts) - 1; k > 0 && !found; k-- {
				if j, ok := modules[strings.Join(parts[:k], ".")]; ok {
					b.link(i, j, 1, imp.TypeOnly)
					found = true
				}
			}
			if found {
				continue
			}
			top := parts[0]
			if !pyStdlib[top] && !topLevel[top] {
				b.external(i, top)
			}
		}
	}
}

var pyStdlib = func() map[string]bool {
	m := map[string]bool{}
	for _, n := range strings.Fields(`__future__ abc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2
	calendar cmath cmd code codecs collections colorsys concurrent configparser contextlib contextvars copy copyreg
	cProfile csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip enum
	errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob
	graphlib grp gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword
	linecache locale logging lzma mailbox marshal math mimetypes mmap multiprocessing netrc numbers operator optparse
	os pathlib pdb pickle pkgutil platform plistlib poplib posix pprint profile pstats pty pwd py_compile queue quopri
	random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal
	site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess symtable sys
	sysconfig syslog tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib
	trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref
	webbrowser winreg wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo _thread`) {
		m[n] = true
	}
	return m
}()
