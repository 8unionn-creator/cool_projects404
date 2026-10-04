package codemap

import (
	"encoding/json"
	"path"
	"sort"
	"strings"
)

func (b *builder) filesOf(langs ...Lang) []int {
	var out []int
	for i, f := range b.g.Files {
		for _, l := range langs {
			if f.Lang == l {
				out = append(out, i)
				break
			}
		}
	}
	return out
}

// typeNames lists the symbols another file can refer to by name: types and
// top-level functions and constants (not methods).
func typeNames(f *File) []string {
	var out []string
	for _, s := range f.Symbols {
		if s.Kind != "method" {
			out = append(out, s.Name)
		}
	}
	return out
}

// linkByRefs links file i to each file in candidates that declares a name
// file i mentions. Weight is the number of names used.
func (b *builder) linkByRefs(i int, candidates []int) {
	f := b.g.Files[i]
	own := map[string]bool{}
	for _, s := range f.Symbols {
		own[s.Name[strings.LastIndex(s.Name, ".")+1:]] = true
	}
	for _, j := range candidates {
		if j == i {
			continue
		}
		w := 0
		for _, n := range typeNames(b.g.Files[j]) {
			if f.refs[n] && !own[n] { // a name the file defines itself refers to its own
				w++
			}
		}
		if w > 0 {
			b.link(i, j, w, false)
		}
	}
}

// ---------------------------------------------------------------- Java & Kotlin

var jvmStd = []string{"java.", "javax.", "kotlin.", "jdk.", "sun.", "android.", "platform."}

func resolveJVM(b *builder) {
	files := b.filesOf(Java, Kotlin)
	if len(files) == 0 {
		return
	}
	g := b.g
	fqn := map[string][]int{}
	pkgs := map[string][]int{}
	for _, i := range files {
		f := g.Files[i]
		pkgs[f.pkg] = append(pkgs[f.pkg], i)
		for _, n := range typeNames(f) {
			fqn[join(f.pkg, n, ".")] = append(fqn[join(f.pkg, n, ".")], i)
		}
	}
	for _, i := range files {
		f := g.Files[i]
		b.linkByRefs(i, pkgs[f.pkg]) // same package needs no import
		for _, imp := range f.Imports {
			spec := imp.Spec
			if strings.HasSuffix(spec, ".*") {
				p := strings.TrimSuffix(spec, ".*")
				if in, ok := pkgs[p]; ok {
					b.linkByRefs(i, in)
					continue
				}
				if js, ok := fqn[p]; ok { // import a.b.Outer.*
					for _, j := range js {
						b.link(i, j, 1, false)
					}
					continue
				}
			} else if js := lookupDotted(fqn, spec, "."); js != nil {
				for _, j := range js {
					b.link(i, j, 1, false)
				}
				continue
			}
			if !hasAnyPrefix(spec, jvmStd) {
				b.external(i, jvmLibrary(spec))
			}
		}
	}
}

// jvmLibrary names the library behind an import: reverse-domain packages
// keep two segments (org.junit, app.cash), others keep one (assertk).
func jvmLibrary(spec string) string {
	first := strings.SplitN(spec, ".", 2)[0]
	switch first {
	case "com", "org", "io", "net", "dev", "app", "me", "co", "edu", "gov", "uk", "de", "fr", "nl", "info", "jakarta", "kotlinx", "androidx":
		return firstN(spec, ".", 2)
	}
	return first
}

// lookupDotted finds the longest prefix of a dotted name that is declared:
// a.b.Outer.Inner and static imports a.b.C.member resolve to a.b.Outer / C.
func lookupDotted(m map[string][]int, name, sep string) []int {
	for k := 0; k < 3 && name != ""; k++ {
		if js, ok := m[name]; ok {
			return js
		}
		i := strings.LastIndex(name, sep)
		if i < 0 {
			break
		}
		name = name[:i]
	}
	return nil
}

// ---------------------------------------------------------------- C#

func resolveCSharp(b *builder) {
	files := b.filesOf(CSharp)
	if len(files) == 0 {
		return
	}
	g := b.g
	spaces := map[string][]int{}
	fqn := map[string][]int{}
	for _, i := range files {
		f := g.Files[i]
		spaces[f.pkg] = append(spaces[f.pkg], i)
		for _, n := range typeNames(f) {
			fqn[join(f.pkg, n, ".")] = append(fqn[join(f.pkg, n, ".")], i)
		}
	}
	// `global using` applies to every file of the project (the folder with
	// the nearest .csproj).
	var projects []string
	for _, e := range b.src.entries {
		if strings.HasSuffix(e.Path, ".csproj") {
			projects = append(projects, path.Dir(e.Path))
		}
	}
	sort.Slice(projects, func(i, j int) bool { return len(projects[i]) > len(projects[j]) })
	projectOf := func(p string) string {
		for _, d := range projects {
			if d == "." || strings.HasPrefix(p, d+"/") {
				return d
			}
		}
		return "."
	}
	globals := map[string][]string{}
	for _, i := range files {
		for _, imp := range g.Files[i].Imports {
			if imp.Alias == "global" {
				pr := projectOf(g.Files[i].Path)
				globals[pr] = append(globals[pr], imp.Spec)
			}
		}
	}
	localRoot := func(ns string) bool {
		for s := range spaces {
			if s == ns || strings.HasPrefix(s, ns+".") {
				return true
			}
		}
		return false
	}
	for _, i := range files {
		f := g.Files[i]
		// The file's own namespace and all its parents are in scope.
		var visible []string
		for ns := f.pkg; ; {
			visible = append(visible, ns)
			k := strings.LastIndex(ns, ".")
			if k < 0 {
				break
			}
			ns = ns[:k]
		}
		imports := f.Imports
		for _, spec := range globals[projectOf(f.Path)] {
			imports = append(imports, Import{Spec: spec})
		}
		for _, imp := range imports {
			if imp.Alias == "global" {
				continue // added for every file of the project above
			}
			if imp.Alias != "" {
				if js := lookupDotted(fqn, imp.Spec, "."); js != nil {
					for _, j := range js {
						b.link(i, j, 1, false)
					}
				}
				continue
			}
			if _, ok := spaces[imp.Spec]; ok {
				visible = append(visible, imp.Spec)
			} else if js := lookupDotted(fqn, imp.Spec, "."); js != nil { // using static A.B.Type
				for _, j := range js {
					b.link(i, j, 1, false)
				}
			} else if !localRoot(imp.Spec) && imp.Spec != "System" && !strings.HasPrefix(imp.Spec, "System.") {
				b.external(i, firstN(imp.Spec, ".", 2))
			}
		}
		seen := map[string]bool{}
		for _, ns := range visible {
			if !seen[ns] {
				seen[ns] = true
				b.linkByRefs(i, spaces[ns])
			}
		}
	}
}

// ---------------------------------------------------------------- C & C++

var cSystemDirs = set("sys bits linux asm arpa netinet net machine mach libkern os")

func resolveC(b *builder) {
	files := b.filesOf(C, Cpp)
	if len(files) == 0 {
		return
	}
	g := b.g
	// Index every path suffix: "src/net/http.h" answers "http.h", "net/http.h"...
	suffix := map[string][]int{}
	for _, i := range files {
		p := g.Files[i].Path
		for {
			suffix[p] = append(suffix[p], i)
			k := strings.IndexByte(p, '/')
			if k < 0 {
				break
			}
			p = p[k+1:]
		}
	}
	for _, i := range files {
		f := g.Files[i]
		dir := path.Dir(f.Path)
		for _, imp := range f.Imports {
			spec := path.Clean(imp.Spec)
			if imp.Alias != "<>" {
				if j := g.Index(path.Join(dir, spec)); j >= 0 {
					b.link(i, j, 1, false)
					continue
				}
			}
			if cands := suffix[spec]; len(cands) > 0 {
				b.link(i, closest(g, dir, cands), 1, false)
				continue
			}
			if imp.Alias == "<>" && strings.Contains(spec, "/") {
				if first := strings.SplitN(spec, "/", 2)[0]; !cSystemDirs[first] {
					b.external(i, first)
				}
			}
		}
	}
}

// closest picks the candidate whose directory shares the longest prefix
// with dir, the way an include search path usually resolves.
func closest(g *Graph, dir string, cands []int) int {
	best, bestLen := cands[0], -1
	for _, j := range cands {
		d := path.Dir(g.Files[j].Path)
		n := 0
		for n < len(d) && n < len(dir) && d[n] == dir[n] {
			n++
		}
		if n > bestLen {
			best, bestLen = j, n
		}
	}
	return best
}

// ---------------------------------------------------------------- Rust

type rustCrate struct{ name, dir string }

var rustStd = set("std core alloc proc_macro test")

func resolveRust(b *builder) {
	files := b.filesOf(Rust)
	if len(files) == 0 {
		return
	}
	g := b.g
	var crates []rustCrate
	for _, e := range b.src.entries {
		if path.Base(e.Path) != "Cargo.toml" {
			continue
		}
		data, _ := b.src.readPath(e.Path)
		name, inPkg := "", false
		for _, l := range strings.Split(string(data), "\n") {
			l = strings.TrimSpace(l)
			if strings.HasPrefix(l, "[") {
				inPkg = l == "[package]" || l == "[lib]"
				continue
			}
			if inPkg && strings.HasPrefix(l, "name") {
				if _, v, ok := strings.Cut(l, "="); ok && name == "" {
					name = strings.Trim(strings.TrimSpace(v), `"'`)
				}
			}
		}
		crates = append(crates, rustCrate{strings.ReplaceAll(name, "-", "_"), path.Dir(e.Path)})
	}
	sort.Slice(crates, func(i, j int) bool { return len(crates[i].dir) > len(crates[j].dir) })
	if len(crates) == 0 {
		crates = []rustCrate{{"crate", "."}}
	}
	crateOf := func(p string) rustCrate {
		for _, c := range crates {
			if c.dir == "." || strings.HasPrefix(p, c.dir+"/") {
				return c
			}
		}
		return crates[len(crates)-1]
	}
	src := func(c rustCrate) string { return path.Join(c.dir, "src") }
	// moduleFile is the file that defines the module living in directory d.
	moduleFile := func(d string, c rustCrate) int {
		if d == src(c) {
			if j := g.Index(path.Join(d, "lib.rs")); j >= 0 {
				return j
			}
			return g.Index(path.Join(d, "main.rs"))
		}
		if j := g.Index(path.Join(d, "mod.rs")); j >= 0 {
			return j
		}
		return g.Index(d + ".rs")
	}
	// moddir is the directory holding a file's child modules.
	moddir := func(p string) string {
		switch path.Base(p) {
		case "mod.rs", "lib.rs", "main.rs":
			return path.Dir(p)
		}
		return strings.TrimSuffix(p, ".rs")
	}
	// walk follows module path segments from directory base and returns the
	// deepest file found (the remaining segments name items inside it).
	walk := func(base string, segs []string, c rustCrate) int {
		target, cur := moduleFile(base, c), base
		for _, s := range segs {
			if s == "*" {
				break
			}
			if j := g.Index(path.Join(cur, s+".rs")); j >= 0 {
				target, cur = j, path.Join(cur, s)
			} else if j := g.Index(path.Join(cur, s, "mod.rs")); j >= 0 {
				target, cur = j, path.Join(cur, s)
			} else {
				break
			}
		}
		return target
	}
	for _, i := range files {
		f := g.Files[i]
		c := crateOf(f.Path)
		md := moddir(f.Path)
		for _, imp := range f.Imports {
			if name, ok := strings.CutPrefix(imp.Spec, "mod:"); ok {
				j := g.Index(path.Join(md, name+".rs"))
				if j < 0 {
					j = g.Index(path.Join(md, name, "mod.rs"))
				}
				// `mod child;` means containment, not dependency: children
				// using their parent (super::) is how Rust modules work.
				b.link(i, j, 1, true)
				continue
			}
			segs := strings.Split(imp.Spec, "::")
			first := segs[0]
			var base string
			rest := segs[1:]
			switch first {
			case "crate":
				base = src(c)
			case "self":
				base = md
			case "super":
				base = path.Dir(md)
				for len(rest) > 0 && rest[0] == "super" {
					base, rest = path.Dir(base), rest[1:]
				}
			default:
				found := false
				for _, other := range crates {
					if other.name == first {
						c, base, found = other, src(other), true
						break
					}
				}
				if !found {
					// A child module, or (2015 edition) a module at the crate root.
					if g.Index(path.Join(md, first+".rs")) >= 0 || g.Index(path.Join(md, first, "mod.rs")) >= 0 {
						base, rest, found = md, segs, true
					} else if g.Index(path.Join(src(c), first+".rs")) >= 0 || g.Index(path.Join(src(c), first, "mod.rs")) >= 0 {
						base, rest, found = src(c), segs, true
					}
				}
				if !found {
					if !rustStd[first] {
						b.external(i, first)
					}
					continue
				}
			}
			b.link(i, walk(base, rest, c), 1, false)
		}
	}
}

// ---------------------------------------------------------------- PHP

func resolvePHP(b *builder) {
	files := b.filesOf(PHP)
	if len(files) == 0 {
		return
	}
	g := b.g
	type psr4 struct{ prefix, dir string }
	var maps []psr4
	for _, e := range b.src.entries {
		if path.Base(e.Path) != "composer.json" || strings.Contains(e.Path, "vendor/") {
			continue
		}
		data, _ := b.src.readPath(e.Path)
		var cj struct {
			Autoload struct {
				PSR4 map[string]any `json:"psr-4"`
			} `json:"autoload"`
			AutoloadDev struct {
				PSR4 map[string]any `json:"psr-4"`
			} `json:"autoload-dev"`
		}
		if json.Unmarshal(data, &cj) != nil {
			continue
		}
		for _, m := range []map[string]any{cj.Autoload.PSR4, cj.AutoloadDev.PSR4} {
			for prefix, v := range m {
				dirs := []string{}
				switch d := v.(type) {
				case string:
					dirs = append(dirs, d)
				case []any:
					for _, x := range d {
						if s, ok := x.(string); ok {
							dirs = append(dirs, s)
						}
					}
				}
				for _, d := range dirs {
					maps = append(maps, psr4{strings.Trim(prefix, "\\"), path.Join(path.Dir(e.Path), d)})
				}
			}
		}
	}
	sort.Slice(maps, func(i, j int) bool { return len(maps[i].prefix) > len(maps[j].prefix) })
	fqn := map[string][]int{}
	spaces := map[string][]int{}
	for _, i := range files {
		f := g.Files[i]
		spaces[f.pkg] = append(spaces[f.pkg], i)
		for _, n := range typeNames(f) {
			fqn[join(f.pkg, n, "\\")] = append(fqn[join(f.pkg, n, "\\")], i)
		}
	}
	for _, i := range files {
		f := g.Files[i]
		b.linkByRefs(i, spaces[f.pkg]) // same namespace needs no `use`
		for _, imp := range f.Imports {
			if file, ok := strings.CutPrefix(imp.Spec, "file:"); ok {
				p := path.Join(path.Dir(f.Path), strings.TrimPrefix(file, "/"))
				j := g.Index(p)
				if j < 0 {
					j = g.Index(strings.TrimPrefix(path.Clean(file), "/"))
				}
				b.link(i, j, 1, false)
				continue
			}
			spec := strings.Trim(imp.Spec, "\\")
			cands := []string{spec}
			if !strings.Contains(spec, "\\") && f.pkg != "" { // trait use inside a class
				cands = append([]string{f.pkg + "\\" + spec}, cands...)
			}
			linked := false
			for _, c := range cands {
				if js := lookupDotted(fqn, c, "\\"); js != nil {
					for _, j := range js {
						b.link(i, j, 1, false)
					}
					linked = true
					break
				}
				for _, m := range maps {
					if rest, ok := strings.CutPrefix(c, m.prefix+"\\"); ok {
						if j := g.Index(path.Join(m.dir, strings.ReplaceAll(rest, "\\", "/")+".php")); j >= 0 {
							b.link(i, j, 1, false)
							linked = true
							break
						}
					}
				}
				if linked {
					break
				}
			}
			if !linked && strings.Contains(spec, "\\") {
				b.external(i, firstN(spec, "\\", 2))
			}
		}
	}
}

// ---------------------------------------------------------------- Ruby

var rbStd = set("json set yaml psych time date fileutils pathname tempfile open3 securerandom digest logger net uri " +
	"optparse ostruct erb csv socket stringio benchmark pp timeout forwardable singleton English rbconfig zlib base64 " +
	"openssl bigdecimal shellwords etc io find monitor thread delegate observer open-uri webrick minitest test")

func resolveRuby(b *builder) {
	files := b.filesOf(Ruby)
	if len(files) == 0 {
		return
	}
	g := b.g
	consts := map[string][]int{}
	var libDirs []string
	seenLib := map[string]bool{}
	for _, i := range files {
		f := g.Files[i]
		for _, s := range f.Symbols {
			if s.Kind == "class" || s.Kind == "module" {
				consts[s.Name] = appendUnique(consts[s.Name], i)
				if k := strings.LastIndex(s.Name, "::"); k >= 0 {
					short := s.Name[k+2:]
					consts[short] = appendUnique(consts[short], i)
				}
			}
		}
		for _, part := range []string{"lib", "app/models", "app/lib", "spec", "test"} {
			if k := strings.Index(f.Path, part+"/"); k >= 0 && (k == 0 || f.Path[k-1] == '/') {
				d := f.Path[:k+len(part)]
				if !seenLib[d] {
					seenLib[d] = true
					libDirs = append(libDirs, d)
				}
			}
		}
	}
	for _, i := range files {
		f := g.Files[i]
		dir := path.Dir(f.Path)
		for _, imp := range f.Imports {
			spec := strings.TrimSuffix(imp.Spec, ".rb")
			if strings.HasPrefix(spec, "./") || strings.HasPrefix(spec, "../") {
				b.link(i, g.Index(path.Join(dir, spec)+".rb"), 1, false)
				continue
			}
			j := g.Index(spec + ".rb")
			for _, d := range libDirs {
				if j >= 0 {
					break
				}
				j = g.Index(path.Join(d, spec) + ".rb")
			}
			if j >= 0 {
				b.link(i, j, 1, false)
			} else if top := strings.SplitN(spec, "/", 2)[0]; !rbStd[top] {
				b.external(i, top)
			}
		}
		// Constants (Rails autoloading, Zeitwerk): link to the file that
		// defines a referenced class or module, unless it is reopened in
		// many places, which makes the reference ambiguous.
		for ref := range f.refs {
			if js := consts[ref]; len(js) > 0 && len(js) <= 3 {
				for _, j := range js {
					b.link(i, j, 1, false)
				}
			}
		}
	}
}

// ---------------------------------------------------------------- Dart

func resolveDart(b *builder) {
	files := b.filesOf(Dart)
	if len(files) == 0 {
		return
	}
	g := b.g
	pkgs := map[string]string{}
	for _, e := range b.src.entries {
		if path.Base(e.Path) != "pubspec.yaml" {
			continue
		}
		data, _ := b.src.readPath(e.Path)
		for _, l := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(l, "name:") {
				pkgs[strings.Trim(strings.TrimSpace(strings.TrimPrefix(l, "name:")), `"'`)] = path.Dir(e.Path)
				break
			}
		}
	}
	for _, i := range files {
		f := g.Files[i]
		for _, imp := range f.Imports {
			spec := imp.Spec
			switch {
			case strings.HasPrefix(spec, "dart:"):
			case strings.HasPrefix(spec, "package:"):
				name, rest, _ := strings.Cut(strings.TrimPrefix(spec, "package:"), "/")
				if dir, ok := pkgs[name]; ok {
					b.link(i, g.Index(path.Join(dir, "lib", rest)), 1, false)
				} else {
					b.external(i, name)
				}
			default:
				// `part` files belong to the same library, like one file split in two.
				b.link(i, g.Index(path.Join(path.Dir(f.Path), spec)), 1, imp.Alias == "part")
			}
		}
	}
}

// ---------------------------------------------------------------- helpers

func join(prefix, name, sep string) string {
	if prefix == "" {
		return name
	}
	return prefix + sep + name
}

func firstN(s, sep string, n int) string {
	parts := strings.Split(s, sep)
	if len(parts) > n {
		parts = parts[:n]
	}
	return strings.Join(parts, sep)
}

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

func appendUnique(s []int, v int) []int {
	for _, x := range s {
		if x == v {
			return s
		}
	}
	return append(s, v)
}
