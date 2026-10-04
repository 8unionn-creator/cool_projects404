package codemap

import (
	"path"
	"regexp"
	"strings"
)

var (
	rbRequire  = regexp.MustCompile(`^(require_relative|require|load|autoload)\b\s*\(?\s*(?::\w+\s*,\s*)?['"]([^'"]+)['"]`)
	rbClass    = regexp.MustCompile(`^(class|module)\s+([A-Z][\w:]*)`)
	rbDef      = regexp.MustCompile(`^def\s+(?:self\.)?([\w?!=\[\]<>+\-*/%]+)`)
	rbConstRef = regexp.MustCompile(`\b[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*`)
	rbBranch   = regexp.MustCompile(`\b(?:if|elsif|unless|while|until|for|when|rescue|and|or)\b|&&|\|\|`)
)

// rbStrip blanks string contents and comments so regexes see only code.
// Heredocs and %-literals are rare enough in requires to be left alone.
func rbStrip(line string) string {
	var b strings.Builder
	quote := byte(0)
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case quote != 0:
			if c == '\\' && i+1 < len(line) {
				b.WriteString("  ")
				i++
				continue
			}
			if c == quote {
				quote = 0
				b.WriteByte(c)
				continue
			}
			b.WriteByte(' ')
		case c == '#':
			return b.String()
		case c == '"' || c == '\'':
			quote = c
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func parseRuby(f *File, src []byte) {
	p := f.Path
	base := path.Base(p)
	f.Test = strings.HasPrefix(p, "spec/") || strings.HasPrefix(p, "test/") || strings.Contains(p, "/spec/") || strings.Contains(p, "/test/") ||
		strings.HasSuffix(base, "_spec.rb") || strings.HasSuffix(base, "_test.rb")
	f.Entry = strings.HasPrefix(p, "bin/") || strings.HasPrefix(p, "exe/") || base == "config.ru" || base == "Rakefile"
	f.refs = map[string]bool{}

	type scope struct {
		name   string
		indent int
	}
	var classes []scope
	inBlockComment := false
	for n, raw := range strings.Split(string(src), "\n") {
		line := n + 1
		if strings.HasPrefix(raw, "=begin") {
			inBlockComment = true
		}
		if inBlockComment {
			if strings.HasPrefix(raw, "=end") {
				inBlockComment = false
			}
			continue
		}
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(raw) - len(strings.TrimLeft(raw, " \t"))
		if m := rbRequire.FindStringSubmatch(trimmed); m != nil {
			spec := m[2]
			if m[1] == "require_relative" {
				spec = "./" + strings.TrimPrefix(spec, "./")
			}
			f.Imports = append(f.Imports, Import{Spec: spec, Line: line})
			continue
		}
		code := rbStrip(trimmed)
		f.Complexity += len(rbBranch.FindAllStringIndex(code, -1))
		for _, ref := range rbConstRef.FindAllString(code, -1) {
			f.refs[ref] = true
		}
		// A class or module closes with `end` at its own indentation.
		if len(classes) > 0 && indent == classes[len(classes)-1].indent && (trimmed == "end" || strings.HasPrefix(trimmed, "end ") || strings.HasPrefix(trimmed, "end.")) {
			classes = classes[:len(classes)-1]
			continue
		}
		for len(classes) > 0 && indent < classes[len(classes)-1].indent {
			classes = classes[:len(classes)-1]
		}
		if m := rbClass.FindStringSubmatch(code); m != nil {
			name := m[2]
			if len(classes) > 0 && !strings.Contains(name, "::") {
				name = classes[len(classes)-1].name + "::" + name
			}
			f.Symbols = append(f.Symbols, Symbol{Name: name, Kind: m[1], Line: line, Exported: true})
			// `class Foo < Bar; end` on one line opens and closes.
			if !strings.HasSuffix(code, "end") {
				classes = append(classes, scope{name, indent})
			}
			continue
		}
		if m := rbDef.FindStringSubmatch(code); m != nil {
			name, kind := m[1], "func"
			if len(classes) > 0 {
				name, kind = classes[len(classes)-1].name+"."+name, "method"
			}
			f.Symbols = append(f.Symbols, Symbol{Name: name, Kind: kind, Line: line, Exported: !strings.HasPrefix(m[1], "_")})
		}
	}
}
