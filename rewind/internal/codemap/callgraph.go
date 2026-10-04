package codemap

import (
	"path"
	"regexp"
	"sort"
	"strings"
)

// The call graph: which function calls which. Parsers record each call site
// as (qualifier, name, line) plus the line range of every function; after
// files are linked, calls are resolved through what each file can see:
// its own definitions, its imports and the files it depends on. A call on
// a variable (obj.save()) cannot be resolved without types, so it is linked
// only when exactly one visible method has that name, and marked "likely".

type call struct {
	qual string // pkg, module, Type, self, this, or a variable name
	name string
	line int
}

// SymRef points at a symbol; Sym is -1 for code outside any function.
type SymRef struct{ File, Sym int }

// Call is one resolved call from one function to another.
type Call struct {
	From, To SymRef
	Line     int  // where the call is made, in From's file
	Likely   bool // matched by method name only
}

var callNoise = set("if for while switch catch return new sizeof typeof assert print super this self function fn fun " +
	"elif and or not in is lambda yield await async def class with except raise del global nonlocal defined " +
	"len str int float bool list dict set tuple range isinstance hasattr getattr setattr type repr make append cap copy panic recover")

// ---------------------------------------------------------------- Python & Ruby

var (
	pyCall = regexp.MustCompile(`([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\(`)
	rbCall = regexp.MustCompile(`(?:([A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*|self|@?[a-z_][A-Za-z0-9_]*)\.)?([a-z_][A-Za-z0-9_]*[?!]?)\s*\(|([A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*)\.([a-z_][A-Za-z0-9_]*[?!]?)`)
)

// addDottedCalls records calls like `a.b.c(` as (qual "a.b", name "c").
func addDottedCalls(f *File, code string, line int, skip string) {
	for _, m := range pyCall.FindAllStringSubmatch(code, -1) {
		full := m[1]
		qual, name := "", full
		if k := strings.LastIndex(full, "."); k >= 0 {
			qual, name = full[:k], full[k+1:]
		}
		if (qual == "" && callNoise[name]) || full == skip {
			continue
		}
		f.calls = append(f.calls, call{qual, name, line})
	}
}

func addRubyCalls(f *File, code string, line int) {
	for _, m := range rbCall.FindAllStringSubmatch(code, -1) {
		qual, name := m[1], m[2]
		if name == "" {
			qual, name = m[3], m[4]
		}
		if qual == "" && (callNoise[name] || name == "def" || name == "puts" || name == "require") {
			continue
		}
		f.calls = append(f.calls, call{strings.TrimPrefix(qual, "@"), name, line})
	}
}

// ---------------------------------------------------------------- token languages

var classWords = set("class struct interface trait object record enum mixin extension")

// scanCalls walks a token stream once more to find function bodies (to set
// each symbol's last line) and call sites. JS/TS class methods are added
// to the symbols here, since the JS parser lists top-level definitions only.
func scanCalls(f *File, toks []jsTok) {
	at := func(k int) jsTok {
		if k < 0 || k >= len(toks) {
			return jsTok{kind: tPunct}
		}
		return toks[k]
	}
	isP := func(k int, s string) bool { t := at(k); return t.kind == tPunct && t.text == s }
	isI := func(k int) bool { return at(k).kind == tIdent }
	jsLike := f.Lang == JavaScript || f.Lang == TypeScript

	// Symbols by line, to match a function head to its symbol.
	byLine := map[int][]int{}
	for i, s := range f.Symbols {
		byLine[s.Line] = append(byLine[s.Line], i)
	}
	find := func(name string, line int) int {
		for _, l := range []int{line, line - 1, line + 1} {
			for _, i := range byLine[l] {
				n := f.Symbols[i].Name
				if n == name || strings.HasSuffix(n, "."+name) {
					return i
				}
			}
		}
		return -1
	}

	type scope struct {
		sym   int
		class string
	}
	var stack []scope
	pendingSym, pendingClass := -1, ""
	lastAssign, lastAssignLine := "", 0
	className := func() string {
		for k := len(stack) - 1; k >= 0; k-- {
			if stack[k].class != "" {
				return stack[k].class
			}
			if stack[k].sym >= 0 {
				return ""
			}
		}
		return ""
	}
	for k := 0; k < len(toks); k++ {
		t := toks[k]
		if t.kind == tPunct {
			switch t.text {
			case "{":
				stack = append(stack, scope{pendingSym, pendingClass})
				pendingSym, pendingClass = -1, ""
			case "}":
				if n := len(stack); n > 0 {
					if s := stack[n-1].sym; s >= 0 {
						f.Symbols[s].End = t.line
					}
					stack = stack[:n-1]
				}
			case ";":
				pendingClass = ""
			case "=>": // const handler = (req) => { ... }
				if isP(k+1, "{") && lastAssign != "" && t.line-lastAssignLine <= 3 {
					if s := find(lastAssign, lastAssignLine); s >= 0 {
						pendingSym = s
					}
				}
			case "=":
				if isI(k - 1) {
					lastAssign, lastAssignLine = at(k-1).text, at(k-1).line
				}
			case ":": // object methods `name: (x) => {` or `name: function`, not `id: string`
				if isI(k-1) && (isP(k+1, "(") || at(k+1).text == "function" || at(k+1).text == "async") {
					lastAssign, lastAssignLine = at(k-1).text, at(k-1).line
				}
			}
			continue
		}
		if t.kind != tIdent {
			continue
		}
		if classWords[t.text] && isI(k+1) && !isP(k-1, ".") {
			pendingClass = at(k + 1).text
			pendingSym = find(pendingClass, at(k+1).line) // to record where the type ends
			continue
		}
		if t.text == "function" && isI(k+1) && isP(k+2, "(") { // function name(...) {
			if s := find(at(k+1).text, at(k+1).line); s >= 0 {
				pendingSym = s
			}
			k++
			continue
		}
		if t.text == "function" && isP(k+1, "(") && lastAssign != "" { // const f = function (...) {
			if s := find(lastAssign, lastAssignLine); s >= 0 {
				pendingSym = s
			}
			continue
		}
		if !isP(k+1, "(") {
			continue
		}
		prev := at(k - 1)
		qualified := prev.kind == tPunct && (prev.text == "." || prev.text == "::" || prev.text == "->" || prev.text == "?.")
		if !qualified || (f.Lang == Cpp && prev.text == "::") {
			if j, body := funcBody(toks, k+1); body && !callNoise[t.text] && !notFuncs[t.text] && prev.text != "new" && prev.text != "=" && prev.text != "return" {
				// A definition: Type name(...) {, fn name(...) {, or a JS method.
				s := find(t.text, t.line)
				if s < 0 && jsLike && className() != "" && (prev.kind != tIdent || modifiers[prev.text] || prev.text == "get" || prev.text == "set") {
					f.Symbols = append(f.Symbols, Symbol{Name: className() + "." + t.text, Kind: "method", Line: t.line, Exported: !strings.HasPrefix(t.text, "#")})
					s = len(f.Symbols) - 1
					byLine[t.line] = append(byLine[t.line], s)
				}
				if s >= 0 {
					if isP(j+1, "{") || isP(j+2, "{") || isP(j+1, ":") || isP(j+1, "->") || isI(j+1) {
						pendingSym = s
					} else {
						f.Symbols[s].End = t.line // expression body: name() => expr;
					}
					continue
				}
			}
		}
		if callNoise[t.text] && !qualified {
			continue
		}
		qual := ""
		if qualified {
			if q := at(k - 2); q.kind == tIdent {
				qual = q.text
			} else {
				continue // a(b).c() and similar chains: unknown receiver
			}
		}
		f.calls = append(f.calls, call{qual, t.text, t.line})
	}
	for i := range f.Symbols {
		if f.Symbols[i].End < f.Symbols[i].Line {
			f.Symbols[i].End = f.Symbols[i].Line
		}
	}
}

// ---------------------------------------------------------------- resolution

func symBase(name string) string {
	if k := strings.LastIndexAny(name, ".:"); k >= 0 {
		return name[k+1:]
	}
	return name
}

// containing returns the innermost symbol whose range holds line, or -1.
func containing(f *File, line int) int {
	best, size := -1, 1<<30
	for i, s := range f.Symbols {
		if s.Kind == "const" || s.Kind == "var" {
			continue
		}
		if s.Line <= line && line <= s.End && s.End-s.Line < size {
			best, size = i, s.End-s.Line
		}
	}
	return best
}

func resolveCalls(b *builder) {
	g := b.g
	out := make([][]int, len(g.Files))
	for k := range b.edges {
		out[k[0]] = append(out[k[0]], k[1])
	}
	goBind := goBindings(b)
	type key struct {
		file int
		name string
	}
	index := map[key][]int{} // (file, base name) -> symbols
	for j, f := range g.Files {
		for s, sym := range f.Symbols {
			index[key{j, symBase(sym.Name)}] = append(index[key{j, symBase(sym.Name)}], s)
			if strings.Contains(sym.Name, ".") || strings.Contains(sym.Name, "::") {
				index[key{j, sym.Name}] = append(index[key{j, sym.Name}], s)
			}
		}
	}
	lookup := func(files []int, name string, wantType string) []SymRef {
		var refs []SymRef
		for _, j := range files {
			for _, s := range index[key{j, name}] {
				sym := g.Files[j].Symbols[s]
				if wantType != "" && !strings.HasPrefix(sym.Name, wantType+".") && !strings.HasPrefix(sym.Name, wantType+"::") && sym.Name != wantType {
					continue
				}
				if sym.Kind == "const" || sym.Kind == "var" {
					continue
				}
				refs = append(refs, SymRef{j, s})
			}
		}
		return refs
	}
	isType := func(files []int, name string) []int {
		var js []int
		for _, j := range files {
			for _, s := range index[key{j, name}] {
				switch g.Files[j].Symbols[s].Kind {
				case "class", "struct", "interface", "trait", "enum", "record", "object", "type", "module", "mixin", "union":
					js = append(js, j)
				}
			}
		}
		return js
	}
	seen := map[[5]int]bool{}
	for i, f := range g.Files {
		if len(f.calls) == 0 {
			continue
		}
		visible := append([]int{i}, out[i]...)
		if f.Lang == Go { // a Go package is one namespace across its files
			for _, j := range b.dirs[path.Dir(f.Path)] {
				if j != i && g.Files[j].Lang == Go && g.Files[j].pkg == f.pkg {
					visible = append(visible, j)
				}
			}
		}
		bind := map[string][]int{}   // qualifier or imported name -> files
		alias := map[string]string{} // local name -> name in the other file
		for name, files := range goBind[i] {
			bind[name] = files
		}
		for _, imp := range f.Imports {
			targets := b.importTargets(i, imp)
			if len(targets) == 0 {
				continue
			}
			switch f.Lang {
			case Python:
				if len(imp.Names) == 0 { // import a.b [as x] -> a.b.func() / x.func()
					bind[imp.Spec] = targets
					if imp.Alias != "" {
						bind[imp.Alias] = targets
					}
				}
				for _, n := range imp.Names {
					bind[n] = targets
				}
			case JavaScript, TypeScript:
				for _, n := range imp.Names { // "imported=local"
					imported, local, _ := strings.Cut(n, "=")
					bind[local] = targets
					if imported != "*" && imported != "default" && imported != local {
						alias[local] = imported
					}
				}
			}
		}
		for _, c := range f.calls {
			from := SymRef{i, containing(f, c.line)}
			var to []SymRef
			likely := false
			callerClass := ""
			if from.Sym >= 0 {
				if n := f.Symbols[from.Sym].Name; strings.Contains(n, ".") {
					callerClass = n[:strings.LastIndex(n, ".")]
				}
			}
			if t, ok := strings.CutPrefix(c.qual, "self:"); ok { // Go receiver with a known type
				callerClass = t
				c.qual = "self"
			}
			switch {
			case c.qual == "self" || c.qual == "this" || c.qual == "Self" || c.qual == "$this" || c.qual == "static":
				if callerClass != "" {
					to = lookup(visible, callerClass+"."+c.name, "") // Go methods may live in sibling files
				}
				if len(to) == 0 {
					to = lookup(visible, c.name, "")
					likely = true
				}
			case c.qual != "" && bind[c.qual] != nil: // module or package: pkg.Func(), ns.fn()
				to = lookup(bind[c.qual], c.name, "")
				if len(to) == 0 { // an imported class: Cart.create()
					to = lookup(bind[c.qual], c.name, c.qual)
				}
			case c.qual != "":
				if ts := isType(visible, c.qual); len(ts) > 0 { // Type.staticMethod()
					to = lookup(ts, c.name, c.qual)
				} else if mods := moduleFiles(g, visible, c.qual); len(mods) > 0 { // Rust util::f(), Ruby/PHP files
					to = topLevel(lookup(mods, c.name, ""), g)
				} else if bind[c.qual] == nil {
					// A variable: link only if exactly one visible method has this name.
					var cands []SymRef
					for _, r := range lookup(visible, c.name, "") {
						if g.Files[r.File].Symbols[r.Sym].Kind == "method" {
							cands = append(cands, r)
						}
					}
					if len(cands) == 1 {
						to, likely = cands, true
					}
				}
			default:
				if callerClass != "" { // implicit this in Java, C#, C++, Kotlin, Dart
					to = lookup([]int{i}, callerClass+"."+c.name, "")
				}
				if len(to) == 0 {
					to = topLevel(lookup([]int{i}, c.name, ""), g)
				}
				if len(to) == 0 && bind[c.name] != nil {
					name := c.name
					if a, ok := alias[name]; ok {
						name = a
					}
					to = topLevel(lookup(bind[c.name], name, ""), g)
				}
				if len(to) == 0 {
					to = topLevel(lookup(out[i], c.name, ""), g)
				}
			}
			if len(to) > 3 { // too ambiguous to be useful
				continue
			}
			for _, t := range to {
				k := [5]int{from.File, from.Sym, t.File, t.Sym, c.line}
				if seen[k] || (t == from) {
					continue
				}
				seen[k] = true
				g.Calls = append(g.Calls, Call{From: from, To: t, Line: c.line, Likely: likely})
			}
		}
	}
	sort.Slice(g.Calls, func(a, c int) bool {
		x, y := g.Calls[a], g.Calls[c]
		if x.From.File != y.From.File {
			return x.From.File < y.From.File
		}
		return x.Line < y.Line
	})
}

// topLevel keeps functions, types and constructors, dropping methods that
// only matched by their short name.
func topLevel(refs []SymRef, g *Graph) []SymRef {
	var out []SymRef
	for _, r := range refs {
		if s := g.Files[r.File].Symbols[r.Sym]; s.Kind != "method" || isCtor(s.Name) {
			out = append(out, r)
		}
	}
	return out
}

func isCtor(name string) bool {
	k := strings.LastIndex(name, ".")
	return k > 0 && name[:k] == name[k+1:]
}

// importTargets returns the files an import statement resolved to.
func (b *builder) importTargets(i int, imp Import) []int { return b.importsOf[i][imp.Line] }

// goBindings maps each Go file's package qualifiers (fmt, store, ...) to
// the files of the imported package, for pkg.Func() calls.
func goBindings(b *builder) map[int]map[string][]int {
	g := b.g
	res := map[int]map[string][]int{}
	var mods []goModule
	loaded := false
	for i, f := range g.Files {
		if f.Lang != Go {
			continue
		}
		if !loaded {
			mods, loaded = goModules(b), true
		}
		for _, imp := range f.Imports {
			for _, m := range mods {
				if imp.Spec == m.path || strings.HasPrefix(imp.Spec, m.path+"/") {
					dir := path.Clean(path.Join(m.dir, strings.TrimPrefix(imp.Spec, m.path)))
					files := nonTestGo(g, b.dirs[dir])
					if len(files) == 0 {
						break
					}
					name := imp.Alias
					if name == "" {
						name = g.Files[files[0]].pkg
					}
					if res[i] == nil {
						res[i] = map[string][]int{}
					}
					res[i][name] = files
					break
				}
			}
		}
	}
	return res
}

// ---------------------------------------------------------------- queries

// CallersOf lists the calls into a symbol.
func (g *Graph) CallersOf(file, sym int) []Call {
	var out []Call
	for _, c := range g.Calls {
		if c.To.File == file && c.To.Sym == sym {
			out = append(out, c)
		}
	}
	return out
}

// CalleesOf lists the calls a symbol makes.
func (g *Graph) CalleesOf(file, sym int) []Call {
	var out []Call
	for _, c := range g.Calls {
		if c.From.File == file && c.From.Sym == sym {
			out = append(out, c)
		}
	}
	return out
}

// SymbolLabel names a symbol reference for display.
func (g *Graph) SymbolLabel(r SymRef) string {
	if r.Sym < 0 {
		return "(top-level code)"
	}
	return g.Files[r.File].Symbols[r.Sym].Name
}

// moduleFiles returns the visible files that a qualifier names as a module:
// util -> util.rs, util/mod.rs, util.py...
func moduleFiles(g *Graph, visible []int, qual string) []int {
	var out []int
	for _, j := range visible {
		p := g.Files[j].Path
		stem := strings.TrimSuffix(path.Base(p), path.Ext(p))
		if stem == "mod" || stem == "__init__" || stem == "index" {
			stem = path.Base(path.Dir(p))
		}
		if stem == qual {
			out = append(out, j)
		}
	}
	return out
}
