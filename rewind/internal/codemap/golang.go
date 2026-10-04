package codemap

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path"
	"sort"
	"strconv"
	"strings"
)

func parseGo(f *File, src []byte) {
	f.Test = strings.HasSuffix(f.Path, "_test.go")
	fset := token.NewFileSet()
	// A file with syntax errors still yields a partial AST worth using.
	file, _ := parser.ParseFile(fset, f.Path, src, parser.ParseComments|parser.SkipObjectResolution)
	if file == nil {
		return
	}
	f.pkg = file.Name.Name
	line := func(p token.Pos) int { return fset.Position(p).Line }

	for _, imp := range file.Imports {
		spec, _ := strconv.Unquote(imp.Path.Value)
		i := Import{Spec: spec, Line: line(imp.Pos())}
		if imp.Name != nil {
			i.Alias = imp.Name.Name
		}
		f.Imports = append(f.Imports, i)
	}

	for _, d := range file.Decls {
		switch d := d.(type) {
		case *ast.FuncDecl:
			name, kind := d.Name.Name, "func"
			if d.Recv != nil && len(d.Recv.List) > 0 {
				name, kind = recvName(d.Recv.List[0].Type)+"."+name, "method"
			}
			f.Symbols = append(f.Symbols, Symbol{Name: name, Kind: kind, Line: line(d.Pos()), End: line(d.End()), Exported: d.Name.IsExported()})
			if d.Body != nil {
				// The receiver's name tells us the type of `s` in s.lock().
				recv, recvType := "", ""
				if d.Recv != nil && len(d.Recv.List) > 0 && len(d.Recv.List[0].Names) > 0 {
					recv, recvType = d.Recv.List[0].Names[0].Name, recvName(d.Recv.List[0].Type)
				}
				ast.Inspect(d.Body, func(n ast.Node) bool {
					c, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					switch fn := c.Fun.(type) {
					case *ast.Ident:
						if !callNoise[fn.Name] {
							f.calls = append(f.calls, call{"", fn.Name, line(fn.Pos())})
						}
					case *ast.SelectorExpr:
						switch x := fn.X.(type) {
						case *ast.Ident:
							q := x.Name
							if q == recv && recv != "" {
								q = "self:" + recvType
							}
							f.calls = append(f.calls, call{q, fn.Sel.Name, line(fn.Sel.Pos())})
						case *ast.SelectorExpr: // c.st.Snapshot(): a field, type unknown
							f.calls = append(f.calls, call{x.Sel.Name, fn.Sel.Name, line(fn.Sel.Pos())})
						}
					}
					return true
				})
			}
			if f.pkg == "main" && d.Recv == nil && d.Name.Name == "main" {
				f.Entry = true
			}
		case *ast.GenDecl:
			for _, s := range d.Specs {
				switch s := s.(type) {
				case *ast.TypeSpec:
					kind := "type"
					switch s.Type.(type) {
					case *ast.StructType:
						kind = "struct"
					case *ast.InterfaceType:
						kind = "interface"
					}
					f.Symbols = append(f.Symbols, Symbol{Name: s.Name.Name, Kind: kind, Line: line(s.Pos()), End: line(s.End()), Exported: s.Name.IsExported()})
				case *ast.ValueSpec:
					kind := "var"
					if d.Tok == token.CONST {
						kind = "const"
					}
					for _, n := range s.Names {
						if n.Name != "_" {
							f.Symbols = append(f.Symbols, Symbol{Name: n.Name, Kind: kind, Line: line(n.Pos()), Exported: n.IsExported()})
						}
					}
				}
			}
		}
	}

	f.refs = map[string]bool{}
	f.selectors = map[string][]string{}
	seenSel := map[string]bool{}
	ast.Inspect(file, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.Ident:
			f.refs[n.Name] = true
		case *ast.SelectorExpr:
			if x, ok := n.X.(*ast.Ident); ok {
				k := x.Name + "." + n.Sel.Name
				if !seenSel[k] {
					seenSel[k] = true
					f.selectors[x.Name] = append(f.selectors[x.Name], n.Sel.Name)
				}
			}
		case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt, *ast.CaseClause, *ast.CommClause:
			f.Complexity++
		case *ast.BinaryExpr:
			if n.Op == token.LAND || n.Op == token.LOR {
				f.Complexity++
			}
		}
		return true
	})
}

func recvName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return recvName(t.X)
	case *ast.Ident:
		return t.Name
	case *ast.IndexExpr: // generic receiver T[K]
		return recvName(t.X)
	case *ast.IndexListExpr:
		return recvName(t.X)
	}
	return "?"
}

// goModule is one go.mod in the tree.
type goModule struct{ path, dir string }

func goModules(b *builder) []goModule {
	var mods []goModule
	for _, e := range b.src.entries {
		if path.Base(e.Path) != "go.mod" {
			continue
		}
		data, ok := b.src.readPath(e.Path)
		if !ok {
			continue
		}
		for _, l := range strings.Split(string(data), "\n") {
			l = strings.TrimSpace(l)
			if strings.HasPrefix(l, "module ") {
				mp := strings.Trim(strings.TrimSpace(strings.TrimPrefix(l, "module")), `"`)
				mods = append(mods, goModule{path: mp, dir: path.Dir(e.Path)})
				break
			}
		}
	}
	// Longest module path first, so nested modules win.
	sort.Slice(mods, func(i, j int) bool { return len(mods[i].path) > len(mods[j].path) })
	return mods
}

func resolveGo(b *builder) {
	g := b.g
	var mods []goModule
	loaded := false
	for i, f := range g.Files {
		if f.Lang != Go {
			continue
		}
		if !loaded {
			mods, loaded = goModules(b), true
		}
		dir := path.Dir(f.Path)

		// Same-package links: a file uses top-level names declared in a sibling.
		// Test files in package foo_test are a separate package.
		for _, j := range b.dirs[dir] {
			o := g.Files[j]
			if j == i || o.Lang != Go || o.pkg != f.pkg {
				continue
			}
			w := 0
			for _, s := range o.Symbols {
				if s.Kind != "method" && f.refs[s.Name] && !declares(f, s.Name) {
					w++
				}
			}
			if w > 0 {
				b.link(i, j, w, false)
			}
		}

		// Imports of other packages in this repository.
		for _, imp := range f.Imports {
			target, local := "", false
			for _, m := range mods {
				if imp.Spec == m.path || strings.HasPrefix(imp.Spec, m.path+"/") {
					target, local = path.Join(m.dir, strings.TrimPrefix(imp.Spec, m.path)), true
					break
				}
			}
			if !local {
				if isGoStdlib(imp.Spec) {
					continue
				}
				b.external(i, goModuleRoot(imp.Spec))
				continue
			}
			target = path.Clean(target)
			pkgFiles := nonTestGo(g, b.dirs[target])
			if len(pkgFiles) == 0 {
				b.external(i, imp.Spec)
				continue
			}
			name := imp.Alias
			if name == "" {
				name = g.Files[pkgFiles[0]].pkg
			}
			// Link to the files that define the selectors used (pkg.Name).
			linked := false
			for _, sel := range f.selectors[name] {
				for _, j := range pkgFiles {
					if declares(g.Files[j], sel) {
						b.link(i, j, 1, false)
						linked = true
					}
				}
			}
			if !linked { // blank or dot import, or only methods used
				b.link(i, representative(g, pkgFiles), 1, false)
			}
		}
	}
}

func declares(f *File, name string) bool {
	for _, s := range f.Symbols {
		if s.Name == name {
			return true
		}
	}
	return false
}

func nonTestGo(g *Graph, idx []int) []int {
	var out []int
	for _, j := range idx {
		if f := g.Files[j]; f.Lang == Go && !f.Test {
			out = append(out, j)
		}
	}
	return out
}

// representative picks the file that best stands for a package: one named
// after the package, else the largest.
func representative(g *Graph, idx []int) int {
	best := idx[0]
	for _, j := range idx {
		f := g.Files[j]
		if strings.TrimSuffix(path.Base(f.Path), ".go") == f.pkg {
			return j
		}
		if f.Lines > g.Files[best].Lines {
			best = j
		}
	}
	return best
}

// isGoStdlib: standard library import paths have no dot in their first element.
func isGoStdlib(spec string) bool {
	first := strings.SplitN(spec, "/", 2)[0]
	return !strings.Contains(first, ".")
}

// goModuleRoot trims an import path to its likely module (host/owner/repo).
func goModuleRoot(spec string) string {
	parts := strings.Split(spec, "/")
	switch {
	case len(parts) >= 3 && (parts[0] == "github.com" || parts[0] == "gitlab.com" || parts[0] == "bitbucket.org"):
		return strings.Join(parts[:3], "/")
	case len(parts) >= 2 && parts[0] == "golang.org" && len(parts) >= 3:
		return strings.Join(parts[:3], "/")
	}
	return spec
}
