package codemap

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// repoWith commits files into a fresh repository and returns its root.
func repoWith(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "t@e")
	run("config", "user.name", "t")
	writeFiles(t, dir, files)
	run("add", "-A")
	run("commit", "-qm", "init")
	return dir
}

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for p, c := range files {
		full := filepath.Join(dir, filepath.FromSlash(p))
		os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func analyze(t *testing.T, files map[string]string) *Graph {
	t.Helper()
	g, err := NewAnalyzer(repoWith(t, files)).Analyze("HEAD")
	if err != nil {
		t.Fatal(err)
	}
	return g
}

// deps returns "a -> b" strings for every edge, sorted.
func deps(g *Graph) []string {
	var out []string
	for _, e := range g.Edges {
		s := g.Files[e.From].Path + " -> " + g.Files[e.To].Path
		if e.TypeOnly {
			s += " (type)"
		}
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

func wantDeps(t *testing.T, g *Graph, want ...string) {
	t.Helper()
	sort.Strings(want)
	if got := deps(g); !reflect.DeepEqual(got, want) {
		t.Fatalf("edges:\n  got  %q\n  want %q", got, want)
	}
}

func file(t *testing.T, g *Graph, p string) (*File, int) {
	t.Helper()
	i := g.Index(p)
	if i < 0 {
		t.Fatalf("%s not in graph", p)
	}
	return g.Files[i], i
}

func TestGo(t *testing.T) {
	g := analyze(t, map[string]string{
		"go.mod": "module example.com/app\n\ngo 1.22\n",
		"cmd/app/main.go": `package main

import (
	"fmt"
	"github.com/spf13/cobra/doc"
	"example.com/app/store"
)

func main() { fmt.Println(store.Open(), doc.X) }
`,
		"store/store.go": `package store

// Open opens it.
func Open() *DB { return newDB() }
`,
		"store/db.go": `package store

type DB struct{ n int }

func newDB() *DB { if true && false { return nil }; return &DB{} }
func (d *DB) Close() {}
`,
		"store/store_test.go": "package store\n\nimport \"testing\"\n\nfunc TestOpen(t *testing.T) { Open() }\n",
		"vendor/x/x.go":       "package x\n",
	})
	wantDeps(t, g,
		"cmd/app/main.go -> store/store.go",
		"store/store.go -> store/db.go",
		"store/store_test.go -> store/store.go",
	)
	main, mi := file(t, g, "cmd/app/main.go")
	if !main.Entry || !g.Entries[mi] {
		t.Error("main.main should be an entry point")
	}
	if got := g.External[mi]; !reflect.DeepEqual(got, []string{"github.com/spf13/cobra"}) {
		t.Errorf("externals = %q (stdlib should be skipped)", got)
	}
	db, _ := file(t, g, "store/db.go")
	var names []string
	for _, s := range db.Symbols {
		names = append(names, s.Kind+":"+s.Name)
	}
	if !reflect.DeepEqual(names, []string{"struct:DB", "func:newDB", "method:DB.Close"}) {
		t.Errorf("symbols = %q", names)
	}
	if db.Complexity != 2 {
		t.Errorf("complexity = %d, want 2 (if + &&)", db.Complexity)
	}
	if st, _ := file(t, g, "store/store_test.go"); !st.Test {
		t.Error("_test.go should be marked as a test")
	}
	if g.Index("vendor/x/x.go") >= 0 {
		t.Error("vendored code should be skipped")
	}
}

func TestGoNestedModules(t *testing.T) {
	g := analyze(t, map[string]string{
		"go.mod":           "module example.com/root\n",
		"tool/go.mod":      "module example.com/tool\n",
		"tool/main.go":     "package main\n\nimport \"example.com/tool/lib\"\n\nfunc main() { lib.Run() }\n",
		"tool/lib/run.go":  "package lib\n\nfunc Run() {}\n",
		"lib/unrelated.go": "package lib\n\nfunc Run() {}\n",
	})
	wantDeps(t, g, "tool/main.go -> tool/lib/run.go")
}

func TestPython(t *testing.T) {
	g := analyze(t, map[string]string{
		"src/shop/__init__.py": "",
		"src/shop/models.py": `"""Models.

import fake_in_docstring
"""
import os, json as j
from dataclasses import dataclass
MAX_ITEMS = 10

@dataclass
class Cart:
    items: list

    def total(self):
        if self.items and len(self.items) > 0:
            return 1
        def helper():  # nested, not a method
            pass

def _private(): pass
`,
		"src/shop/api.py": `from . import models
from .models import Cart
from .util import (
    slugify,
    money as m,
)
import requests
`,
		"src/shop/util.py":     "def slugify(s): ...\ndef money(x): ...\n",
		"src/shop/__main__.py": "from shop.api import Cart\n",
		"tests/test_api.py":    "from shop import api\nimport pytest\n",
		"scripts/run.py":       "import helpers\n\nif __name__ == \"__main__\":\n    helpers.go()\n",
		"scripts/helpers.py":   "def go(): pass\n",
	})
	wantDeps(t, g,
		"src/shop/api.py -> src/shop/models.py",
		"src/shop/api.py -> src/shop/util.py",
		"src/shop/__main__.py -> src/shop/api.py",
		"tests/test_api.py -> src/shop/api.py",
		"scripts/run.py -> scripts/helpers.py",
	)
	models, mi := file(t, g, "src/shop/models.py")
	var names []string
	for _, s := range models.Symbols {
		names = append(names, s.Kind+":"+s.Name)
	}
	if !reflect.DeepEqual(names, []string{"const:MAX_ITEMS", "class:Cart", "method:Cart.total", "func:_private"}) {
		t.Errorf("symbols = %q", names)
	}
	if len(g.External[mi]) != 0 {
		t.Errorf("stdlib and docstring imports should not be external: %q", g.External[mi])
	}
	_, ai := file(t, g, "src/shop/api.py")
	if !reflect.DeepEqual(g.External[ai], []string{"requests"}) {
		t.Errorf("externals = %q", g.External[ai])
	}
	if f, _ := file(t, g, "scripts/run.py"); !f.Entry {
		t.Error(`if __name__ == "__main__" should mark an entry point`)
	}
	if f, _ := file(t, g, "tests/test_api.py"); !f.Test {
		t.Error("tests/ should be marked as tests")
	}
}

func TestJSAndTS(t *testing.T) {
	g := analyze(t, map[string]string{
		"tsconfig.json": `{
  // comments and trailing commas are allowed here
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, },
}`,
		"package.json": `{"name": "web", "bin": {"web": "src/cli.ts"}}`,
		"src/cli.ts":   "import { start } from './server.js'\nstart()\n",
		"src/server.ts": `import type { Config } from "@/config";
import express from 'express';
import { readFile } from 'node:fs/promises';
import * as path from "path";
const fake = "import x from './nope'";
const re = /from 'regex'/g;
// import { y } from './commented'
export async function start(port = 3000) {
  const t = ` + "`template ${fake ? `nested ${1}` : 'x'} import z from './tpl'`" + `;
  if (port > 0 && re.test(t)) { return import('./lazy') }
}
export default class Server {}
export interface Options { port: number }
export type Handler = (r: Request) => void;
`,
		"src/config/index.ts":           "export const config = {}\nexport type Config = typeof config\n",
		"src/lazy.tsx":                  "const legacy = require('../lib/legacy')\nexport const Lazy = () => <p>It's lazy</p>\n",
		"lib/legacy.js":                 "module.exports = {}\n",
		"packages/ui/package.json":      `{"name": "@acme/ui", "main": "src/index.ts"}`,
		"packages/ui/src/index.ts":      "export const Button = 1\n",
		"src/uses-ui.ts":                "import { Button } from '@acme/ui'\nimport { x } from '@scope/pkg/deep'\n",
		"src/server.test.ts":            "import { start } from './server'\n",
		"node_modules/express/index.js": "module.exports = 1\n",
		"src/types.d.ts":                "declare const x: number\n",
		"src/vendor.min.js":             "!function(){}()\n",
		"src/config/index.test.ts":      "import { config } from '.'\n",
	})
	wantDeps(t, g,
		"src/cli.ts -> src/server.ts",
		"src/server.ts -> src/config/index.ts (type)",
		"src/server.ts -> src/lazy.tsx",
		"src/lazy.tsx -> lib/legacy.js",
		"src/uses-ui.ts -> packages/ui/src/index.ts",
		"src/server.test.ts -> src/server.ts",
		"src/config/index.test.ts -> src/config/index.ts",
	)
	server, si := file(t, g, "src/server.ts")
	if !reflect.DeepEqual(g.External[si], []string{"express"}) {
		t.Errorf("externals = %q (node built-ins should be skipped)", g.External[si])
	}
	var names []string
	for _, s := range server.Symbols {
		e := ""
		if s.Exported {
			e = "+"
		}
		names = append(names, e+s.Kind+":"+s.Name)
	}
	want := []string{"const:fake", "const:re", "+func:start", "+class:Server", "+interface:Options", "+type:Handler"}
	if !reflect.DeepEqual(names, want) {
		t.Errorf("symbols:\n got  %q\n want %q", names, want)
	}
	_, ui := file(t, g, "src/uses-ui.ts")
	if !reflect.DeepEqual(g.External[ui], []string{"@scope/pkg"}) {
		t.Errorf("scoped externals = %q", g.External[ui])
	}
	if _, ci := file(t, g, "src/cli.ts"); !g.Entries[ci] {
		t.Error("package.json bin should mark an entry point")
	}
	if g.Index("src/types.d.ts") >= 0 || g.Index("src/vendor.min.js") >= 0 {
		t.Error(".d.ts and .min.js files should be skipped")
	}
	if f, _ := file(t, g, "src/server.test.ts"); !f.Test {
		t.Error(".test.ts should be a test")
	}
}

func TestCyclesImpactAndCompare(t *testing.T) {
	files := map[string]string{
		"app/a.py":        "from app import b\n",
		"app/b.py":        "from app import c\n",
		"app/c.py":        "x = 1\n",
		"app/__init__.py": "",
		"web/a.ts":        "import type { B } from './b'\nexport type A = 1\n",
		"web/b.ts":        "import type { A } from './a'\nexport type B = 2\n",
	}
	dir := repoWith(t, files)
	an := NewAnalyzer(dir)
	before, err := an.Analyze("HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if c := before.Cycles(); len(c) != 0 {
		t.Fatalf("type-only cycles should be ignored, got %+v", c)
	}
	imp := before.Impact([]string{"app/c.py"})
	if !reflect.DeepEqual(imp, map[string]int{"app/b.py": 1, "app/a.py": 2}) {
		t.Fatalf("impact = %v", imp)
	}

	// Introduce a cycle (c imports a), a new directory dependency and a package.
	writeFiles(t, dir, map[string]string{
		"app/c.py":    "from app import a\nimport numpy\n",
		"lib/util.py": "from app import c\n",
	})
	for _, args := range [][]string{{"add", "-A"}, {"commit", "-qm", "two"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s", out)
		}
	}
	after, err := an.Analyze("HEAD")
	if err != nil {
		t.Fatal(err)
	}
	cycles := after.Cycles()
	if len(cycles) != 1 || cycles[0].Level != "file" || strings.Join(cycles[0].Members, ",") != "app/a.py,app/b.py,app/c.py" {
		t.Fatalf("cycles = %+v", cycles)
	}
	d := Compare(before, after)
	if !reflect.DeepEqual(d.AddedFiles, []string{"lib/util.py"}) ||
		!reflect.DeepEqual(d.AddedDeps, []DirEdge{{"lib", "app"}}) ||
		!reflect.DeepEqual(d.AddedExternal, []string{"numpy"}) ||
		len(d.NewCycles) != 1 {
		t.Fatalf("diff = %+v", d)
	}
	if !Compare(after, after).Empty() {
		t.Fatal("a graph compared with itself should have no diff")
	}

	// Unchanged blobs come from the cache: the same *File is reused.
	fa, _ := file(t, before, "app/b.py")
	fb, _ := file(t, after, "app/b.py")
	if fa != fb {
		t.Error("unchanged files should be parsed once and shared between snapshots")
	}
}

func TestHotspots(t *testing.T) {
	g := &Graph{Files: []*File{
		{Path: "a.go", Complexity: 10},
		{Path: "b.go", Complexity: 1},
		{Path: "a_test.go", Complexity: 50, Test: true},
	}}
	hs := g.Hotspots(map[string]int{"a.go": 3, "b.go": 20, "a_test.go": 9}, 5)
	if len(hs) != 2 || hs[0].Path != "b.go" || hs[0].Score != 40 || hs[1].Score != 33 {
		t.Fatalf("hotspots = %+v", hs)
	}
}

func TestTokenizerEdgeCases(t *testing.T) {
	toks := jsTokenize("a = b / c; d = /re[/]x/.test(e) // tail\n`x${'}'}y` + '\\''")
	var kinds []string
	for _, tk := range toks {
		switch tk.kind {
		case tString:
			kinds = append(kinds, "S")
		case tIdent:
			kinds = append(kinds, tk.text)
		default:
			kinds = append(kinds, tk.text)
		}
	}
	got := strings.Join(kinds, " ")
	want := "a = b / c ; d = S . test ( e ) S + S"
	if got != want {
		t.Fatalf("tokens:\n got  %s\n want %s", got, want)
	}
}

func TestJSPackageExportsAndSubpathImports(t *testing.T) {
	g := analyze(t, map[string]string{
		"packages/core/package.json": `{"name": "core", "bin": {"core": "bin/core.js"},
			"exports": {".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"}},
			"imports": {"#types": "./src/types.ts", "#utils/*": "./src/utils/*.ts"}}`,
		"packages/core/bin/core.js":       "import '../dist/index.js'\n",
		"packages/core/src/index.ts":      "import type { T } from '#types'\nimport { slug } from '#utils/text'\n",
		"packages/core/src/types.ts":      "export type T = 1\n",
		"packages/core/src/utils/text.ts": "export const slug = 1\n",
		"apps/web/main.ts":                "import { x } from 'core'\n",
	})
	wantDeps(t, g,
		"apps/web/main.ts -> packages/core/src/index.ts",
		"packages/core/src/index.ts -> packages/core/src/types.ts (type)",
		"packages/core/src/index.ts -> packages/core/src/utils/text.ts",
	)
	if _, i := file(t, g, "packages/core/bin/core.js"); !g.Entries[i] {
		t.Error("bin should be an entry point")
	}
	if _, i := file(t, g, "packages/core/src/index.ts"); len(g.External[i]) != 0 {
		t.Errorf("#imports are internal, got externals %q", g.External[i])
	}
}

func TestPythonLazyImportsDoNotFormCycles(t *testing.T) {
	g := analyze(t, map[string]string{
		"pkg/__init__.py": "",
		"pkg/app.py":      "from pkg import ctx\n",
		"pkg/ctx.py": `import typing as t
if t.TYPE_CHECKING:
    from pkg.app import App

def current():
    from pkg import app  # deferred to break the cycle
    return app
x = 1
`,
	})
	wantDeps(t, g, "pkg/app.py -> pkg/ctx.py", "pkg/ctx.py -> pkg/app.py (type)")
	if c := g.Cycles(); len(c) != 0 {
		t.Fatalf("TYPE_CHECKING and function-local imports must not count as cycles: %+v", c)
	}
	f, _ := file(t, g, "pkg/ctx.py")
	if len(f.Symbols) != 1 { // only current(): nothing inside TYPE_CHECKING, and x is not a CONSTANT
		t.Fatalf("symbols = %+v", f.Symbols)
	}
}
