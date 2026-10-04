package codemap

import (
	"encoding/json"
	"path"
	"sort"
	"strings"
)

// ---------------------------------------------------------------- parser

func parseJS(f *File, src []byte) {
	base := path.Base(f.Path)
	f.Test = strings.Contains(base, ".test.") || strings.Contains(base, ".spec.") ||
		strings.Contains(f.Path, "__tests__/") || strings.HasPrefix(f.Path, "e2e/")
	toks := jsTokenize(string(src))
	at := func(k int) jsTok {
		if k < 0 || k >= len(toks) {
			return jsTok{kind: tPunct}
		}
		return toks[k]
	}
	isIdent := func(k int, s string) bool { t := at(k); return t.kind == tIdent && t.text == s }
	isPunct := func(k int, s string) bool { t := at(k); return t.kind == tPunct && t.text == s }

	depth := 0
	stmtStart := -1 // index of the last `import`/`export` keyword
	for k, t := range toks {
		switch t.kind {
		case tPunct:
			switch t.text {
			case "{":
				depth++
			case "}":
				if depth > 0 {
					depth--
				}
			case "&&", "||", "??":
				f.Complexity++
			case "?":
				f.Complexity++
			}
			continue
		case tString:
			continue
		}

		switch t.text {
		case "if", "for", "while", "case", "catch":
			if !isPunct(k-1, ".") {
				f.Complexity++
			}
		case "import", "export":
			if isPunct(k-1, ".") {
				break
			}
			stmtStart = k
			if t.text == "import" && at(k+1).kind == tString { // import "./side-effect"
				f.Imports = append(f.Imports, Import{Spec: at(k + 1).text, Line: t.line})
			}
			if t.text == "import" && isPunct(k+1, "(") && at(k+2).kind == tString { // import("./lazy")
				f.Imports = append(f.Imports, Import{Spec: at(k + 2).text, Line: t.line})
			}
		case "from":
			if at(k+1).kind == tString && stmtStart >= 0 && k-stmtStart < 400 {
				typeOnly := isIdent(stmtStart+1, "type") && !isIdent(stmtStart+2, "from") && !isPunct(stmtStart+2, ",")
				imp := Import{Spec: at(k + 1).text, Line: t.line, TypeOnly: typeOnly}
				if at(stmtStart).text == "import" {
					imp.Names = jsBindings(toks[stmtStart+1 : k])
				}
				f.Imports = append(f.Imports, imp)
				stmtStart = -1
			}
		case "require":
			if !isPunct(k-1, ".") && isPunct(k+1, "(") && at(k+2).kind == tString && isPunct(k+3, ")") {
				f.Imports = append(f.Imports, Import{Spec: at(k + 2).text, Line: t.line})
			}
		}

		if depth != 0 {
			continue
		}
		// Top-level declarations, optionally exported.
		exported := isIdent(k-1, "export") || (isIdent(k-1, "default") && isIdent(k-2, "export")) ||
			(isIdent(k-1, "async") && isIdent(k-2, "export")) || (isIdent(k-1, "abstract") && isIdent(k-2, "export"))
		if isIdent(k-1, ".") || isPunct(k-1, ".") {
			continue
		}
		name := at(k + 1)
		if t.text == "function" && isPunct(k+1, "*") {
			name = at(k + 2)
		}
		if name.kind != tIdent {
			continue
		}
		switch t.text {
		case "function":
			f.Symbols = append(f.Symbols, Symbol{Name: name.text, Kind: "func", Line: t.line, Exported: exported})
		case "class", "interface", "enum":
			f.Symbols = append(f.Symbols, Symbol{Name: name.text, Kind: t.text, Line: t.line, Exported: exported})
		case "type":
			if isPunct(k+2, "=") || isPunct(k+2, "<") {
				f.Symbols = append(f.Symbols, Symbol{Name: name.text, Kind: "type", Line: t.line, Exported: exported})
			}
		case "const", "let", "var":
			kind := "var"
			if isPunct(k+2, "=") && (isIdent(k+3, "async") || isPunct(k+3, "(") || isIdent(k+3, "function")) {
				kind = "func"
			} else if t.text == "const" {
				kind = "const"
			}
			f.Symbols = append(f.Symbols, Symbol{Name: name.text, Kind: kind, Line: t.line, Exported: exported})
		}
	}
	scanCalls(f, toks)
}

// ---------------------------------------------------------------- resolver

var jsExts = []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}

type tsConfig struct {
	dir     string
	baseURL string // relative to repo root, "" when unset
	paths   map[string][]string
}

type jsPackage struct {
	name, dir string
	mains     []string          // exports["."], source, module, main
	bins      []string          // bin targets
	imports   map[string]string // "#internal" subpath imports
}

type jsResolver struct {
	b       *builder
	configs []tsConfig  // deepest directory first
	pkgs    []jsPackage // longest name first
}

func resolveJS(b *builder) {
	g := b.g
	has := false
	for _, f := range g.Files {
		if f.Lang == JavaScript || f.Lang == TypeScript {
			has = true
			break
		}
	}
	if !has {
		return
	}
	r := &jsResolver{b: b}
	r.loadConfigs()

	for _, p := range r.pkgs {
		for _, e := range p.bins {
			if j := r.built(p.dir, e); j >= 0 {
				g.Entries[j] = true
			}
		}
	}
	for i, f := range g.Files {
		if f.Lang != JavaScript && f.Lang != TypeScript {
			continue
		}
		for _, imp := range f.Imports {
			b.cur = imp.Line
			if j := r.resolve(f.Path, imp.Spec); j >= 0 {
				b.link(i, j, 1, imp.TypeOnly)
			} else if name := jsPackageName(imp.Spec); name != "" && !strings.HasPrefix(name, "#") {
				b.external(i, name)
			}
		}
	}
	b.cur = 0
}

func (r *jsResolver) loadConfigs() {
	for _, e := range r.b.src.entries {
		base := path.Base(e.Path)
		dir := path.Dir(e.Path)
		skip := false
		for _, part := range strings.Split(dir, "/") {
			if skipDir(part) {
				skip = true
			}
		}
		if skip {
			continue
		}
		switch base {
		case "tsconfig.json", "jsconfig.json":
			data, ok := r.b.src.readPath(e.Path)
			if !ok {
				continue
			}
			var cfg struct {
				CompilerOptions struct {
					BaseURL string              `json:"baseUrl"`
					Paths   map[string][]string `json:"paths"`
				} `json:"compilerOptions"`
			}
			if json.Unmarshal(stripJSONC(data), &cfg) != nil {
				continue
			}
			c := tsConfig{dir: dir, paths: cfg.CompilerOptions.Paths}
			if cfg.CompilerOptions.BaseURL != "" {
				c.baseURL = path.Join(dir, cfg.CompilerOptions.BaseURL)
			}
			if c.baseURL != "" || len(c.paths) > 0 {
				r.configs = append(r.configs, c)
			}
		case "package.json":
			data, ok := r.b.src.readPath(e.Path)
			if !ok {
				continue
			}
			var pj struct {
				Name    string                     `json:"name"`
				Main    string                     `json:"main"`
				Module  string                     `json:"module"`
				Source  string                     `json:"source"`
				Bin     json.RawMessage            `json:"bin"`
				Exports json.RawMessage            `json:"exports"`
				Imports map[string]json.RawMessage `json:"imports"`
			}
			if json.Unmarshal(data, &pj) != nil {
				continue
			}
			p := jsPackage{name: pj.Name, dir: dir, imports: map[string]string{}}
			var exports any
			if json.Unmarshal(pj.Exports, &exports) == nil {
				if m, ok := exports.(map[string]any); ok && m["."] != nil {
					exports = m["."]
				}
				if t := firstTarget(exports); t != "" {
					p.mains = append(p.mains, t)
				}
			}
			for _, s := range []string{pj.Source, pj.Module, pj.Main} {
				if s != "" {
					p.mains = append(p.mains, s)
				}
			}
			var one string
			var many map[string]string
			if json.Unmarshal(pj.Bin, &one) == nil && one != "" {
				p.bins = append(p.bins, one)
			} else if json.Unmarshal(pj.Bin, &many) == nil {
				for _, v := range many {
					p.bins = append(p.bins, v)
				}
			}
			for k, raw := range pj.Imports {
				var v any
				if json.Unmarshal(raw, &v) == nil {
					if t := firstTarget(v); t != "" {
						p.imports[k] = t
					}
				}
			}
			r.pkgs = append(r.pkgs, p)
		}
	}
	sort.Slice(r.configs, func(i, j int) bool { return len(r.configs[i].dir) > len(r.configs[j].dir) })
	sort.Slice(r.pkgs, func(i, j int) bool { return len(r.pkgs[i].name) > len(r.pkgs[j].name) })
}

func (r *jsResolver) resolve(from, spec string) int {
	if spec == "" {
		return -1
	}
	dir := path.Dir(from)
	if strings.HasPrefix(spec, "./") || strings.HasPrefix(spec, "../") || spec == "." || spec == ".." {
		return r.file(path.Join(dir, spec))
	}
	if strings.HasPrefix(spec, "/") {
		return r.file(strings.TrimPrefix(spec, "/"))
	}
	// tsconfig "paths" and "baseUrl", from the nearest config.
	for _, c := range r.configs {
		if c.dir != "." && dir != c.dir && !strings.HasPrefix(dir, c.dir+"/") {
			continue
		}
		base := c.baseURL
		if base == "" {
			base = c.dir
		}
		for pattern, targets := range c.paths {
			if star := strings.Index(pattern, "*"); star >= 0 {
				pre, suf := pattern[:star], pattern[star+1:]
				if strings.HasPrefix(spec, pre) && strings.HasSuffix(spec, suf) && len(spec) >= len(pre)+len(suf) {
					mid := spec[len(pre) : len(spec)-len(suf)]
					for _, t := range targets {
						if j := r.file(path.Join(base, strings.Replace(t, "*", mid, 1))); j >= 0 {
							return j
						}
					}
				}
			} else if spec == pattern {
				for _, t := range targets {
					if j := r.file(path.Join(base, t)); j >= 0 {
						return j
					}
				}
			}
		}
		if c.baseURL != "" {
			if j := r.file(path.Join(c.baseURL, spec)); j >= 0 {
				return j
			}
		}
		break
	}
	// "#name" subpath imports, from the nearest package.json.
	if strings.HasPrefix(spec, "#") {
		var best *jsPackage
		for k := range r.pkgs {
			p := &r.pkgs[k]
			if (p.dir == "." || dir == p.dir || strings.HasPrefix(dir, p.dir+"/")) && (best == nil || len(p.dir) > len(best.dir)) {
				best = p
			}
		}
		if best == nil {
			return -1
		}
		for pattern, target := range best.imports {
			if star := strings.Index(pattern, "*"); star >= 0 {
				if strings.HasPrefix(spec, pattern[:star]) && strings.HasSuffix(spec, pattern[star+1:]) {
					mid := spec[star : len(spec)-len(pattern)+star+1]
					return r.built(best.dir, strings.Replace(target, "*", mid, 1))
				}
			} else if spec == pattern {
				return r.built(best.dir, target)
			}
		}
		return -1
	}
	// Packages of a monorepo importing each other by name.
	for _, p := range r.pkgs {
		if p.name == "" || (spec != p.name && !strings.HasPrefix(spec, p.name+"/")) {
			continue
		}
		if sub := strings.TrimPrefix(spec, p.name); sub != "" {
			if j := r.file(path.Join(p.dir, sub)); j >= 0 {
				return j
			}
			return r.file(path.Join(p.dir, "src", sub))
		}
		for _, e := range p.mains {
			if j := r.built(p.dir, e); j >= 0 {
				return j
			}
		}
		for _, guess := range []string{"src/index", "index", "src/main", "lib/index"} {
			if j := r.file(path.Join(p.dir, guess)); j >= 0 {
				return j
			}
		}
	}
	return -1
}

// built resolves a package.json target. Targets usually point at build
// output that is not committed (dist/index.js), so the matching source file
// under src/ is tried too.
func (r *jsResolver) built(dir, target string) int {
	target = strings.TrimPrefix(target, "./")
	if j := r.file(path.Join(dir, target)); j >= 0 {
		return j
	}
	for _, out := range []string{"dist/", "lib/", "build/", "out/"} {
		if strings.HasPrefix(target, out) {
			if j := r.file(path.Join(dir, "src", strings.TrimPrefix(target, out))); j >= 0 {
				return j
			}
		}
	}
	return -1
}

// firstTarget digs the first file path out of a package.json "exports" or
// "imports" value, which may be a string or nested conditions.
func firstTarget(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case map[string]any:
		for _, k := range []string{"source", "development", "import", "default", "require", "node", "types"} {
			if s := firstTarget(t[k]); s != "" && !strings.HasSuffix(s, ".d.ts") {
				return s
			}
		}
	case []any:
		for _, x := range t {
			if s := firstTarget(x); s != "" {
				return s
			}
		}
	}
	return ""
}

// file finds the source file for an import path, trying TypeScript and
// JavaScript extensions, index files, and TS's ".js means .ts" convention.
func (r *jsResolver) file(p string) int {
	g := r.b.g
	p = path.Clean(p)
	if i := g.Index(p); i >= 0 {
		return i
	}
	stem := p
	for _, e := range []string{".js", ".jsx", ".mjs", ".cjs"} {
		if strings.HasSuffix(p, e) {
			stem = strings.TrimSuffix(p, e)
		}
	}
	for _, e := range jsExts {
		if i := g.Index(stem + e); i >= 0 {
			return i
		}
	}
	for _, e := range jsExts {
		if i := g.Index(path.Join(p, "index"+e)); i >= 0 {
			return i
		}
	}
	return -1
}

// jsPackageName returns the npm package an import refers to, or "" for
// Node built-ins and paths.
func jsPackageName(spec string) string {
	if spec == "" || strings.HasPrefix(spec, ".") || strings.HasPrefix(spec, "/") || strings.HasPrefix(spec, "node:") {
		return ""
	}
	parts := strings.Split(spec, "/")
	name := parts[0]
	if strings.HasPrefix(name, "@") && len(parts) > 1 {
		name += "/" + parts[1]
	}
	if nodeBuiltins[name] {
		return ""
	}
	return name
}

var nodeBuiltins = func() map[string]bool {
	m := map[string]bool{}
	for _, n := range strings.Fields(`assert async_hooks buffer child_process cluster console constants crypto dgram dns domain
	events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream
	string_decoder timers tls trace_events tty url util v8 vm wasi worker_threads zlib`) {
		m[n] = true
	}
	return m
}()

// stripJSONC removes comments and trailing commas so tsconfig files parse.
func stripJSONC(b []byte) []byte {
	var out []byte
	inStr := false
	for i := 0; i < len(b); i++ {
		c := b[i]
		if inStr {
			out = append(out, c)
			if c == '\\' && i+1 < len(b) {
				i++
				out = append(out, b[i])
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		switch {
		case c == '"':
			inStr = true
			out = append(out, c)
		case c == '/' && i+1 < len(b) && b[i+1] == '/':
			for i < len(b) && b[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(b) && b[i+1] == '*':
			i += 2
			for i+1 < len(b) && !(b[i] == '*' && b[i+1] == '/') {
				i++
			}
			i++
		case c == '}' || c == ']':
			// Drop a trailing comma before a closing bracket.
			k := len(out) - 1
			for k >= 0 && (out[k] == ' ' || out[k] == '\n' || out[k] == '\t' || out[k] == '\r') {
				k--
			}
			if k >= 0 && out[k] == ',' {
				out = append(out[:k], out[k+1:]...)
			}
			out = append(out, c)
		default:
			out = append(out, c)
		}
	}
	return out
}

// jsBindings reads the names an import statement binds, as "imported=local":
// `X` -> default=X, `{ a, b as c }` -> a=a, b=c, `* as ns` -> *=ns.
func jsBindings(toks []jsTok) []string {
	var out []string
	inBraces := false
	for k := 0; k < len(toks); k++ {
		t := toks[k]
		if t.kind == tPunct {
			switch t.text {
			case "{":
				inBraces = true
			case "}":
				inBraces = false
			case "*":
				if k+2 < len(toks) && toks[k+1].text == "as" {
					out = append(out, "*="+toks[k+2].text)
					k += 2
				}
			}
			continue
		}
		if t.kind != tIdent || t.text == "type" || t.text == "typeof" {
			continue
		}
		name, local := t.text, t.text
		if k+2 < len(toks) && toks[k+1].text == "as" {
			local = toks[k+2].text
			k += 2
		}
		if inBraces {
			out = append(out, name+"="+local)
		} else {
			out = append(out, "default="+local)
		}
	}
	return out
}
