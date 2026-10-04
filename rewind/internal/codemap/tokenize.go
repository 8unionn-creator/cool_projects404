package codemap

import (
	"strings"
	"unicode/utf8"
)

type tokKind uint8

const (
	tIdent tokKind = iota
	tString
	tPunct
)

type jsTok struct {
	kind tokKind
	text string // identifier, punctuation, or the string's value
	line int
}

// tokCfg switches on the lexical quirks of one language family.
type tokCfg struct {
	regex        bool // JS regex literals after operators
	template     bool // `template ${literals}`
	singleQuotes bool // '…' is an ordinary string (JS, PHP, Ruby, Dart)
	charLits     bool // '…' is a short char literal; an unclosed ' is a Rust lifetime
	hashComments bool // # starts a line comment (PHP, Ruby)
	triple       bool // """…""" and '''…''' (Kotlin, Dart, C# 11)
	rawStrings   bool // r#"…"# (Rust), R"d(…)d" (C++), @"…" (C#)
}

var (
	jsCfg = tokCfg{regex: true, template: true, singleQuotes: true}
	cCfg  = tokCfg{charLits: true, rawStrings: true, triple: true}
)

var regexAfterWord = map[string]bool{
	"return": true, "typeof": true, "instanceof": true, "in": true, "of": true, "new": true, "delete": true,
	"void": true, "throw": true, "case": true, "do": true, "else": true, "yield": true, "await": true,
}

// jsTokenize splits JavaScript/TypeScript into tokens.
func jsTokenize(src string) []jsTok { return tokenize(src, jsCfg) }

// tokenize splits source code into identifiers, strings and punctuation,
// skipping comments. It is deliberately forgiving: a plain string ends at
// the line break, so one odd line (JSX text with an apostrophe, a Rust
// lifetime) cannot swallow the rest of the file.
func tokenize(src string, cfg tokCfg) []jsTok {
	var toks []jsTok
	line := 1
	n := len(src)
	str := func(val string, start int) { toks = append(toks, jsTok{tString, val, start}) }
	prevAllowsRegex := func() bool {
		if len(toks) == 0 {
			return true
		}
		t := toks[len(toks)-1]
		switch t.kind {
		case tString:
			return false
		case tIdent:
			return regexAfterWord[t.text]
		}
		return t.text != ")" && t.text != "]" && t.text != "}"
	}
	// skipTo moves past the first occurrence of end, counting lines.
	skipTo := func(i int, end string) int {
		k := strings.Index(src[i:], end)
		if k < 0 {
			k = n - i
		} else {
			k += len(end)
		}
		line += strings.Count(src[i:i+k], "\n")
		return i + k
	}
	for i := 0; i < n; {
		c := src[i]
		next := byte(0)
		if i+1 < n {
			next = src[i+1]
		}
		switch {
		case c == '\n':
			line++
			i++
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '/' && next == '/', cfg.hashComments && c == '#':
			for i < n && src[i] != '\n' {
				i++
			}
		case c == '/' && next == '*':
			i = skipTo(i+2, "*/")
		case cfg.triple && (strings.HasPrefix(src[i:], `"""`) || (cfg.singleQuotes && strings.HasPrefix(src[i:], `'''`))):
			start, q := line, src[i:i+3]
			end := skipTo(i+3, q)
			str(strings.TrimSuffix(src[i+3:end], q), start)
			i = end
		case cfg.rawStrings && c == 'r' && (next == '"' || (next == '#' && strings.HasPrefix(strings.TrimLeft(src[i+1:], "#"), `"`))):
			hashes := len(src[i+1:]) - len(strings.TrimLeft(src[i+1:], "#"))
			start, open := line, i+1+hashes+1
			end := skipTo(open, `"`+strings.Repeat("#", hashes))
			str(src[open:max(open, end-1-hashes)], start)
			i = end
		case cfg.rawStrings && c == 'R' && next == '"':
			paren := strings.IndexByte(src[i+2:], '(')
			if paren < 0 || paren > 16 {
				toks = append(toks, jsTok{tIdent, "R", line})
				i++
				continue
			}
			delim := src[i+2 : i+2+paren]
			start, open := line, i+2+paren+1
			end := skipTo(open, ")"+delim+`"`)
			str(src[open:max(open, end-2-len(delim))], start)
			i = end
		case cfg.rawStrings && c == '@' && next == '"':
			start, j := line, i+2
			for j < n {
				if src[j] == '"' {
					if j+1 < n && src[j+1] == '"' {
						j += 2
						continue
					}
					break
				}
				if src[j] == '\n' {
					line++
				}
				j++
			}
			str(src[i+2:min(j, n)], start)
			i = min(j+1, n)
		case c == '"' || (c == '\'' && cfg.singleQuotes):
			start, j := line, i+1
			var val strings.Builder
			for j < n && src[j] != c && src[j] != '\n' {
				if src[j] == '\\' && j+1 < n {
					j++
				}
				val.WriteByte(src[j])
				j++
			}
			str(val.String(), start)
			if j < n && src[j] == c {
				j++
			}
			i = j
		case c == '\'' && cfg.charLits:
			// A char literal holds one character ('a', 'é') or one escape
			// ('\n', '\u{1F600}'). Anything else, like 'a in Rust, is a
			// lifetime or loop label.
			end := -1
			if next == '\\' {
				if k := strings.IndexByte(src[i+2:min(n, i+14)], '\''); k >= 0 {
					end = i + 2 + k
				}
			} else if i+1 < n {
				_, size := utf8.DecodeRuneInString(src[i+1:])
				if i+1+size < n && src[i+1+size] == '\'' {
					end = i + 1 + size
				}
			}
			if end > 0 {
				str(src[i+1:end], line)
				i = end + 1
			} else {
				toks = append(toks, jsTok{tPunct, "'", line})
				i++
			}
		case c == '`' && cfg.template:
			i = skipTemplate(src, i+1, &line)
			str("", line)
		case c == '/' && cfg.regex && prevAllowsRegex():
			j, inClass := i+1, false
			for j < n && src[j] != '\n' {
				if src[j] == '\\' {
					j += 2
					continue
				}
				if src[j] == '[' {
					inClass = true
				} else if src[j] == ']' {
					inClass = false
				} else if src[j] == '/' && !inClass {
					break
				}
				j++
			}
			j++
			for j < n && isIdentByte(src[j]) {
				j++
			}
			str("", line)
			i = min(j, n)
		case isIdentStart(c):
			j := i + 1
			for j < n && isIdentByte(src[j]) {
				j++
			}
			toks = append(toks, jsTok{tIdent, src[i:j], line})
			i = j
		case c >= '0' && c <= '9':
			j := i + 1
			for j < n && (isIdentByte(src[j]) || src[j] == '.') {
				j++
			}
			toks = append(toks, jsTok{tPunct, "0", line})
			i = j
		default:
			p := string(c)
			for _, op := range []string{"&&", "||", "??", "?.", "=>", "...", "::", "->"} {
				if strings.HasPrefix(src[i:], op) {
					p = op
					break
				}
			}
			toks = append(toks, jsTok{tPunct, p, line})
			i += len(p)
		}
	}
	return toks
}

// skipTemplate moves past a template literal, including ${...} holes.
func skipTemplate(src string, i int, line *int) int {
	for i < len(src) {
		switch src[i] {
		case '\\':
			i += 2
			continue
		case '\n':
			*line++
		case '`':
			return i + 1
		case '$':
			if i+1 < len(src) && src[i+1] == '{' {
				depth := 1
				i += 2
				for i < len(src) && depth > 0 {
					switch src[i] {
					case '{':
						depth++
					case '}':
						depth--
					case '\n':
						*line++
					case '`':
						i = skipTemplate(src, i+1, line) - 1
					}
					i++
				}
				continue
			}
		}
		i++
	}
	return i
}

func isIdentStart(c byte) bool {
	return c == '_' || c == '$' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c >= 0x80
}
func isIdentByte(c byte) bool { return isIdentStart(c) || (c >= '0' && c <= '9') }
