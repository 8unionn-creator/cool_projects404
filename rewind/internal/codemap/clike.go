package codemap

import (
	"path"
	"regexp"
	"strings"
)

// More languages. Brace languages (Java, Kotlin, C#, C/C++, Rust, PHP, Dart)
// share one structure walker over the tokenizer's output; Ruby is
// line-based like Python. Each language adds its own import syntax and
// resolution rules on top.
const (
	Java   Lang = "java"
	Kotlin Lang = "kt"
	CSharp Lang = "cs"
	C      Lang = "c"
	Cpp    Lang = "cpp"
	Rust   Lang = "rs"
	PHP    Lang = "php"
	Ruby   Lang = "rb"
	Dart   Lang = "dart"
)

// langSpec describes how a brace language declares things.
type langSpec struct {
	cfg     tokCfg
	types   map[string]string // keyword -> symbol kind ("class", "struct"...)
	spaces  map[string]bool   // keywords that open a namespace or module scope
	fnWords map[string]bool   // keywords that introduce a function ("fn", "fun"...)
	cStyle  bool              // functions declared as `Type name(...) {`
	protos  bool              // count `Type name(...);` prototypes (C/C++ headers)
}

func set(words string) map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(words) {
		m[w] = true
	}
	return m
}

func kinds(pairs string) map[string]string {
	m := map[string]string{}
	for _, p := range strings.Fields(pairs) {
		k, v, _ := strings.Cut(p, "=")
		if v == "" {
			v = k
		}
		m[k] = v
	}
	return m
}

var specs = map[Lang]langSpec{
	Java:   {cfg: cCfg, types: kinds("class interface enum record"), cStyle: true},
	Kotlin: {cfg: cCfg, types: kinds("class interface object typealias=type"), fnWords: set("fun")},
	CSharp: {cfg: cCfg, types: kinds("class interface enum struct record"), spaces: set("namespace"), cStyle: true},
	C:      {cfg: cCfg, types: kinds("struct enum union"), cStyle: true, protos: true},
	Cpp:    {cfg: cCfg, types: kinds("class struct enum union"), spaces: set("namespace"), cStyle: true, protos: true},
	Rust:   {cfg: cCfg, types: kinds("struct enum trait union type impl"), spaces: set("mod"), fnWords: set("fn")},
	PHP:    {cfg: tokCfg{singleQuotes: true, hashComments: true}, types: kinds("class interface trait enum"), fnWords: set("function")},
	Dart:   {cfg: tokCfg{singleQuotes: true, triple: true, rawStrings: false}, types: kinds("class mixin enum extension"), cStyle: true},
}

// Words that look like `name(` but are not function names.
var notFuncs = set("if for foreach while switch catch return new sizeof typeof alignof decltype when using lock fixed " +
	"else do try throw yield await assert super this base delete defined elif synchronized")

// Modifiers that may precede a constructor or method name directly.
var modifiers = set("public private protected internal static final abstract virtual override async inline " +
	"extern const constexpr explicit unsafe partial sealed open suspend operator factory external")

type scope struct {
	kind  string // "type", "space" or "block"
	name  string
	depth int
}

// parseBrace extracts symbols, references and complexity from a brace
// language, and returns the tokens for the language's import pass.
func parseBrace(f *File, src string, spec langSpec) []jsTok {
	toks := tokenize(src, spec.cfg)
	at := func(k int) jsTok {
		if k < 0 || k >= len(toks) {
			return jsTok{kind: tPunct}
		}
		return toks[k]
	}
	isP := func(k int, s string) bool { t := at(k); return t.kind == tPunct && t.text == s }
	isI := func(k int) bool { return at(k).kind == tIdent }

	f.refs = map[string]bool{}
	var stack []scope
	pending := scope{}
	declLevel := func() bool { return len(stack) == 0 || stack[len(stack)-1].kind != "block" }
	typeName := func() string {
		for k := len(stack) - 1; k >= 0; k-- {
			if stack[k].kind == "type" {
				return stack[k].name
			}
			if stack[k].kind == "block" {
				return ""
			}
		}
		return ""
	}
	add := func(name, kind string, line int) {
		if t := typeName(); t != "" && (kind == "func" || kind == "method") {
			name, kind = t+"."+name, "method"
		}
		f.Symbols = append(f.Symbols, Symbol{Name: name, Kind: kind, Line: line, Exported: exported(f.Lang, toks, line, name)})
	}

	for k := 0; k < len(toks); k++ {
		t := toks[k]
		if t.kind == tPunct {
			switch t.text {
			case "{":
				s := pending
				if s.kind == "" {
					s.kind = "block"
				}
				s.depth = len(stack)
				stack = append(stack, s)
				pending = scope{}
			case "}":
				if len(stack) > 0 {
					stack = stack[:len(stack)-1]
				}
			case ";":
				pending = scope{}
			case "&&", "||", "?":
				f.Complexity++
			}
			continue
		}
		if t.kind != tIdent {
			continue
		}
		f.refs[t.text] = true
		switch t.text {
		case "if", "for", "foreach", "while", "case", "catch", "elif", "when":
			if !isP(k-1, ".") {
				f.Complexity++
			}
		}
		// C++ out-of-class definitions: void Engine::run() const { ... }
		if f.Lang == Cpp && declLevel() && isP(k-1, "::") && isI(k-2) && isP(k+1, "(") && typeName() == "" {
			if j, body := funcBody(toks, k+1); body {
				f.Symbols = append(f.Symbols, Symbol{Name: at(k-2).text + "." + t.text, Kind: "method", Line: t.line, Exported: true})
				pending = scope{kind: "block"}
				k = j
			}
			continue
		}
		if !declLevel() || isP(k-1, ".") || isP(k-1, "::") || isP(k-1, "->") {
			continue
		}

		// Types and namespaces.
		if kind, ok := spec.types[t.text]; ok {
			name := ""
			if t.text == "impl" { // impl<'a, T> Trait<T> for Type<'a> { ... } names Type
				angle, afterFor := 0, false
				for j := k + 1; j < len(toks) && !isP(j, "{") && !isP(j, ";"); j++ {
					switch {
					case isP(j, "<"):
						angle++
					case isP(j, ">"):
						angle--
					case angle == 0 && isI(j) && !isP(j-1, "'"):
						switch at(j).text {
						case "for":
							afterFor, name = true, ""
						case "dyn", "unsafe", "where":
						default:
							if name == "" || (afterFor && name == "") {
								name = at(j).text
							}
						}
					}
					if at(j).text == "where" {
						break
					}
				}
				if name != "" {
					pending = scope{kind: "type", name: name}
				}
				continue
			}
			if t.text == "enum" && (at(k+1).text == "class" || at(k+1).text == "struct") { // C++ enum class X
				k++
			}
			if isI(k + 1) {
				name = at(k + 1).text
				// In C and C++, `struct foo x;` uses a type; only a body defines one.
				if (f.Lang == C || f.Lang == Cpp) && !isP(k+2, "{") && !isP(k+2, ":") && at(k+2).text != "final" {
					continue
				}
				add(name, kind, t.line)
				pending = scope{kind: "type", name: name}
			}
			continue
		}
		if spec.spaces[t.text] {
			pending = scope{kind: "space", name: at(k + 1).text}
			continue
		}

		// Functions introduced by a keyword: fn, fun, function.
		if spec.fnWords[t.text] {
			// Kotlin extension functions: fun String.slug(...) -> slug
			j := k + 1
			if isP(j, "<") { // fun <T> name
				for d := 0; j < len(toks); j++ {
					if isP(j, "<") {
						d++
					} else if isP(j, ">") {
						d--
						if d == 0 {
							j++
							break
						}
					}
				}
			}
			name := ""
			for ; j < len(toks) && !isP(j, "(") && !isP(j, "{") && !isP(j, ";"); j++ {
				if isI(j) {
					name = at(j).text
				}
				if isP(j, "<") && name != "" {
					break
				}
			}
			if name != "" && name != "function" {
				add(name, "func", t.line)
				pending = scope{kind: "block"}
			}
			continue
		}

		// C-style functions: `Type name(...) {` or a constructor `public Name(...) {`.
		if spec.cStyle && isP(k+1, "(") && !notFuncs[t.text] {
			prev := at(k - 1)
			typed := (prev.kind == tIdent && !notFuncs[prev.text] && prev.text != "else") ||
				(prev.kind == tPunct && (prev.text == ">" || prev.text == "*" || prev.text == "&" || prev.text == "]" || prev.text == "?" || prev.text == "~"))
			ctor := typeName() == t.text && (prev.kind != tIdent || modifiers[prev.text])
			if !typed && !ctor {
				continue
			}
			j, body := funcBody(toks, k+1)
			semi := isP(j+1, ";") || (at(j+1).kind == tIdent && isP(j+2, ";"))
			// Declarations without a body: C/C++ prototypes and in-class
			// methods, and Dart/C++ constructors like `App(this.x);`.
			proto := semi && ((spec.protos && (prev.kind == tIdent || typeName() != "")) || (ctor && f.Lang == Dart))
			if body || proto {
				add(t.text, "func", t.line)
				if body {
					pending = scope{kind: "block"}
				}
				k = j
			}
			continue
		}
		// Kotlin top-level properties: val NAME = ..., val String.ext get() = ...
		if f.Lang == Kotlin && (t.text == "val" || t.text == "var") && typeName() == "" && isI(k+1) && !isP(k-1, "(") && !isP(k-1, ",") {
			name := at(k + 1).text
			if isP(k+2, ".") && isI(k+3) {
				name = at(k + 3).text
			}
			kind := "var"
			if at(k-1).text == "const" || t.text == "val" {
				kind = "const"
			}
			add(name, kind, t.line)
			continue
		}
		// Rust constants and statics.
		if f.Lang == Rust && (t.text == "const" || t.text == "static") && isI(k+1) && isP(k+2, ":") {
			add(at(k+1).text, "const", t.line)
		}
	}
	return toks
}

// exported decides visibility from the modifiers on the declaration's line.
func exported(lang Lang, toks []jsTok, line int, name string) bool {
	base := name[strings.LastIndex(name, ".")+1:]
	words := map[string]bool{}
	for _, t := range toks {
		if t.line == line && t.kind == tIdent {
			words[t.text] = true
		}
		if t.line > line {
			break
		}
	}
	switch lang {
	case Rust:
		return words["pub"]
	case Java:
		return words["public"]
	case CSharp:
		return words["public"] || words["internal"]
	case Kotlin:
		return !words["private"] && !words["internal"]
	case Dart:
		return !strings.HasPrefix(base, "_")
	case PHP:
		return !words["private"] && !words["protected"]
	case C, Cpp:
		return !words["static"]
	}
	return true
}

// ---------------------------------------------------------------- per-language parsing

var (
	cInclude  = regexp.MustCompile(`(?m)^[ \t]*#[ \t]*(?:include|import)[ \t]*([<"])([^>"\n]+)[>"]`)
	jvmMain   = regexp.MustCompile(`(?m)\bstatic\s+(?:public\s+)?void\s+main\s*\(|^\s*fun\s+main\s*\(`)
	csMain    = regexp.MustCompile(`\bstatic\s+(?:async\s+)?(?:void|int|Task(?:<int>)?)\s+Main\s*\(`)
	cMain     = regexp.MustCompile(`(?m)^\s*(?:int|void)\s+(?:w?main|WinMain)\s*\(`)
	phpUseSep = regexp.MustCompile(`\s*,\s*`)
)

func parseCLike(f *File, src []byte) {
	s := string(src)
	p := f.Path
	base := path.Base(p)
	lower := strings.ToLower(p)
	inDir := func(names ...string) bool {
		for _, n := range names {
			if strings.HasPrefix(lower, n+"/") || strings.Contains(lower, "/"+n+"/") {
				return true
			}
		}
		return false
	}
	switch f.Lang {
	case PHP:
		s = phpOnly(s)
	}
	toks := parseBrace(f, s, specs[f.Lang])
	at := func(k int) jsTok {
		if k < 0 || k >= len(toks) {
			return jsTok{kind: tPunct}
		}
		return toks[k]
	}
	isP := func(k int, x string) bool { t := at(k); return t.kind == tPunct && t.text == x }
	firstOnLine := func(k int) bool { return k == 0 || toks[k-1].line != toks[k].line }

	// dotted reads a.b.c (or a\b\c, a::b::c) starting at k.
	dotted := func(k int, seps ...string) (string, int) {
		var b strings.Builder
		for k < len(toks) {
			t := toks[k]
			if t.kind == tIdent || (t.kind == tPunct && t.text == "*") {
				b.WriteString(t.text)
				k++
				sep := false
				for _, sp := range seps {
					if isP(k, sp) {
						b.WriteString(sp)
						k++
						sep = true
						break
					}
				}
				if !sep {
					break
				}
				continue
			}
			break
		}
		return b.String(), k
	}

	switch f.Lang {
	case Java, Kotlin:
		f.Test = inDir("src/test", "test", "tests") || strings.HasSuffix(base, "Test.java") || strings.HasSuffix(base, "Tests.java") ||
			strings.HasSuffix(base, "Test.kt") || strings.HasSuffix(base, "Tests.kt")
		for k, t := range toks {
			if t.kind != tIdent || !firstOnLine(k) {
				continue
			}
			switch t.text {
			case "package":
				f.pkg, _ = dotted(k+1, ".")
			case "import":
				j := k + 1
				static := at(j).text == "static"
				if static {
					j++
				}
				spec, _ := dotted(j, ".")
				if spec != "" {
					imp := Import{Spec: spec, Line: t.line}
					if static {
						imp.Alias = "static"
					}
					f.Imports = append(f.Imports, imp)
				}
			}
		}
		f.Entry = jvmMain.MatchString(s)
	case CSharp:
		f.Test = strings.Contains(p, ".Tests/") || strings.Contains(p, ".Test/") || strings.HasSuffix(base, "Tests.cs") || strings.HasSuffix(base, "Test.cs") || inDir("tests", "test")
		depth := 0
		for k, t := range toks {
			if t.kind == tPunct {
				if t.text == "{" {
					depth++
				} else if t.text == "}" {
					depth--
				}
				continue
			}
			if t.kind != tIdent || isP(k-1, ".") {
				continue
			}
			switch t.text {
			case "namespace":
				if f.pkg == "" {
					f.pkg, _ = dotted(k+1, ".")
				}
			case "using":
				if depth > 1 || isP(k+1, "(") || at(k+1).text == "var" {
					continue
				}
				j := k + 1
				if at(j).text == "static" {
					j++
				}
				if at(j+1).kind == tPunct && at(j+1).text == "=" { // using Alias = A.B.C;
					spec, _ := dotted(j+2, ".")
					f.Imports = append(f.Imports, Import{Spec: spec, Line: t.line, Alias: at(j).text})
					continue
				}
				if spec, end := dotted(j, "."); spec != "" && isP(end, ";") {
					imp := Import{Spec: spec, Line: t.line}
					if at(k-1).text == "global" { // C# 10: applies to the whole project
						imp.Alias = "global"
					}
					f.Imports = append(f.Imports, imp)
				}
			}
		}
		f.Entry = csMain.MatchString(s) || base == "Program.cs"
	case C, Cpp:
		f.Test = inDir("test", "tests", "unittest", "unittests") || strings.Contains(base, "_test.") || strings.Contains(base, "_unittest.")
		for _, m := range cInclude.FindAllStringSubmatchIndex(s, -1) {
			delim, spec := s[m[2]:m[3]], strings.TrimSpace(s[m[4]:m[5]])
			imp := Import{Spec: spec, Line: strings.Count(s[:m[0]], "\n") + 1}
			if delim == "<" {
				imp.Alias = "<>"
			}
			f.Imports = append(f.Imports, imp)
		}
		f.Entry = cMain.MatchString(s)
	case Rust:
		f.Test = inDir("tests", "benches")
		f.Entry = base == "main.rs" || inDir("src/bin") || inDir("examples")
		for k := 0; k < len(toks); k++ {
			t := toks[k]
			if t.kind != tIdent || isP(k-1, "::") || isP(k-1, ".") {
				continue
			}
			switch t.text {
			case "mod":
				if at(k+1).kind == tIdent && isP(k+2, ";") {
					f.Imports = append(f.Imports, Import{Spec: "mod:" + at(k+1).text, Line: t.line})
				}
			case "use":
				var paths []string
				end := rustUseTree(toks, k+1, "", &paths)
				for _, up := range paths {
					f.Imports = append(f.Imports, Import{Spec: up, Line: t.line})
				}
				k = end
			case "extern":
				if at(k+1).text == "crate" && at(k+2).kind == tIdent {
					f.Imports = append(f.Imports, Import{Spec: at(k + 2).text, Line: t.line})
				}
			}
		}
	case PHP:
		f.Test = inDir("tests", "test") || strings.HasSuffix(base, "Test.php")
		f.Entry = base == "index.php" || base == "artisan" || inDir("bin")
		for k := 0; k < len(toks); k++ {
			t := toks[k]
			if t.kind != tIdent || isP(k-1, "->") || isP(k-1, "::") {
				continue
			}
			switch strings.ToLower(t.text) {
			case "namespace":
				if f.pkg == "" {
					f.pkg, _ = dotted(k+1, "\\")
				}
			case "use":
				if isP(k+1, "(") { // closure use (...)
					continue
				}
				// Rebuild the statement, e.g. `App\Models\{User, Post as P}`.
				var stmt strings.Builder
				j := k + 1
				for ; j < len(toks) && !isP(j, ";") && !(isP(j, "{") && !isP(j-1, "\\")); j++ {
					switch {
					case toks[j].kind == tIdent && toks[j].text == "as":
						stmt.WriteString(" as ")
					case toks[j].kind == tIdent && (toks[j].text == "function" || toks[j].text == "const") && j == k+1:
					default:
						stmt.WriteString(toks[j].text)
					}
				}
				k = j
				for _, spec := range phpUseSpecs(stmt.String()) {
					f.Imports = append(f.Imports, Import{Spec: spec, Line: t.line})
				}
			case "require", "require_once", "include", "include_once":
				last := ""
				for j := k + 1; j < len(toks) && !isP(j, ";"); j++ {
					if toks[j].kind == tString {
						last = toks[j].text
					}
				}
				if strings.HasSuffix(last, ".php") {
					f.Imports = append(f.Imports, Import{Spec: "file:" + last, Line: t.line})
				}
			}
		}
	case Dart:
		f.Test = inDir("test", "integration_test") || strings.HasSuffix(base, "_test.dart")
		f.Entry = inDir("bin") || base == "main.dart"
		for k, t := range toks {
			if t.kind != tIdent || !firstOnLine(k) {
				continue
			}
			switch t.text {
			case "import", "export", "part":
				if at(k+1).kind == tString {
					imp := Import{Spec: at(k + 1).text, Line: t.line}
					if t.text == "part" {
						imp.Alias = "part"
					}
					f.Imports = append(f.Imports, imp)
				}
			}
		}
	}
}

// rustUseTree expands `a::b::{c, d::{e, f}}` into full paths and returns
// the index of the closing ";".
func rustUseTree(toks []jsTok, k int, prefix string, out *[]string) int {
	cur := prefix
	for k < len(toks) {
		t := toks[k]
		switch {
		case t.kind == tIdent:
			if t.text == "as" { // rename: skip the alias
				k += 2
				continue
			}
			if cur != "" && !strings.HasSuffix(cur, "::") {
				*out = append(*out, cur)
				cur = prefix
			}
			cur += t.text
			k++
		case t.kind == tPunct && t.text == "::":
			cur += "::"
			k++
		case t.kind == tPunct && t.text == "*":
			cur += "*"
			k++
		case t.kind == tPunct && t.text == "{":
			k = rustUseTree(toks, k+1, cur, out)
			cur = prefix
			k++
			continue
		case t.kind == tPunct && t.text == ",":
			if cur != prefix && cur != "" {
				*out = append(*out, strings.TrimSuffix(cur, "::"))
			}
			cur = prefix
			k++
		case t.kind == tPunct && (t.text == "}" || t.text == ";"):
			if cur != prefix && cur != "" {
				*out = append(*out, strings.TrimSuffix(cur, "::"))
			}
			return k
		default:
			k++
		}
	}
	return k
}

// phpOnly blanks everything outside <?php ... ?> blocks, keeping lines.
func phpOnly(s string) string {
	if !strings.Contains(s, "<?") {
		return s
	}
	var b strings.Builder
	in := false
	for i := 0; i < len(s); {
		if !in && strings.HasPrefix(s[i:], "<?") {
			in = true
			i += 2
			if strings.HasPrefix(s[i:], "php") {
				i += 3
			} else if strings.HasPrefix(s[i:], "=") {
				i++
			}
			b.WriteString("     ")
			continue
		}
		if in && strings.HasPrefix(s[i:], "?>") {
			in = false
			i += 2
			b.WriteString("  ")
			continue
		}
		if in || s[i] == '\n' {
			b.WriteByte(s[i])
		} else {
			b.WriteByte(' ')
		}
		i++
	}
	return b.String()
}

// phpUseSpecs expands `A\B, C\{D, E as F}` into fully qualified names.
func phpUseSpecs(stmt string) []string {
	var out []string
	add := func(x string) {
		x = strings.TrimSpace(x)
		if i := strings.Index(x, " as "); i >= 0 {
			x = x[:i]
		}
		if x = strings.Trim(x, "\\ "); x != "" {
			out = append(out, x)
		}
	}
	for stmt != "" {
		open := strings.Index(stmt, "{")
		comma := strings.Index(stmt, ",")
		if open >= 0 && (comma < 0 || open < comma) {
			close := strings.Index(stmt, "}")
			if close < open {
				close = len(stmt)
			}
			prefix := strings.TrimRight(stmt[:open], "\\")
			for _, part := range phpUseSep.Split(stmt[open+1:close], -1) {
				if part = strings.TrimSpace(part); part != "" {
					add(prefix + "\\" + part)
				}
			}
			stmt = strings.TrimLeft(stmt[min(close+1, len(stmt)):], ", ")
			continue
		}
		if comma < 0 {
			add(stmt)
			break
		}
		add(stmt[:comma])
		stmt = stmt[comma+1:]
	}
	return out
}

// funcBody finds the ")" matching the "(" at k and reports whether a body
// follows, skipping qualifiers such as `const`, `noexcept` or `throws X`.
func funcBody(toks []jsTok, k int) (int, bool) {
	d, j := 0, k
	for ; j < len(toks); j++ {
		if toks[j].kind == tPunct && toks[j].text == "(" {
			d++
		} else if toks[j].kind == tPunct && toks[j].text == ")" {
			d--
			if d == 0 {
				break
			}
		}
	}
	for n := j + 1; n < len(toks) && n < j+24; n++ {
		t := toks[n]
		if t.kind == tPunct {
			switch t.text {
			case "{", "=>", "->":
				return j, true
			case ":": // C++ initializer list, Dart initializers, Kotlin/TS return types
				return j, true
			case ",", ".", "&", "*", "<", ">", "::":
				continue // throws A, B / trailing qualifiers
			}
			return j, false
		}
		if t.kind == tIdent {
			switch t.text {
			case "const", "override", "noexcept", "throws", "async", "final", "where", "mutable", "volatile", "sync", "sealed":
				continue
			}
			if n > j+1 && (toks[n-1].text == "throws" || toks[n-1].text == "," || toks[n-1].text == ".") {
				continue // exception type names
			}
			return j, false
		}
		return j, false
	}
	return j, false
}
