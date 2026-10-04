package codemap

import (
	"reflect"
	"sort"
	"testing"
)

// calls renders every resolved call as "caller -> callee" (with "?" for likely).
func calls(g *Graph) []string {
	var out []string
	for _, c := range g.Calls {
		s := g.Files[c.From.File].Path + ":" + g.SymbolLabel(c.From) + " -> " + g.Files[c.To.File].Path + ":" + g.SymbolLabel(c.To)
		if c.Likely {
			s += " ?"
		}
		out = append(out, s)
	}
	sort.Strings(out)
	return dedupe(out)
}

func wantCalls(t *testing.T, g *Graph, want ...string) {
	t.Helper()
	sort.Strings(want)
	if got := calls(g); !reflect.DeepEqual(got, want) {
		t.Errorf("calls:\n  got  %q\n  want %q", got, want)
	}
}

func symEnd(t *testing.T, g *Graph, p, name string) int {
	t.Helper()
	f, _ := file(t, g, p)
	for _, s := range f.Symbols {
		if s.Name == name {
			return s.End
		}
	}
	t.Fatalf("%s has no symbol %s", p, name)
	return 0
}

func TestCallGraphGo(t *testing.T) {
	g := analyze(t, map[string]string{
		"go.mod": "module ex.com/app\n",
		"main.go": `package main

import "ex.com/app/store"

func main() {
	db := store.Open()
	db.Close()
	run()
}

func run() { helper() }
`,
		"util.go":        "package main\n\nfunc helper() {}\n",
		"store/store.go": "package store\n\ntype DB struct{}\n\nfunc Open() *DB { return newDB() }\nfunc newDB() *DB { return &DB{} }\nfunc (d *DB) Close() { d.flush() }\n",
		"store/flush.go": "package store\n\nfunc (d *DB) flush() {}\n",
	})
	wantCalls(t, g,
		"main.go:main -> main.go:run",
		"main.go:main -> store/store.go:DB.Close ?",
		"main.go:main -> store/store.go:Open",
		"main.go:run -> util.go:helper",
		"store/store.go:DB.Close -> store/flush.go:DB.flush", // receiver type known: exact
		"store/store.go:Open -> store/store.go:newDB",
	)
	if end := symEnd(t, g, "main.go", "main"); end != 9 {
		t.Errorf("main ends at %d, want 9", end)
	}
}

func TestCallGraphPython(t *testing.T) {
	g := analyze(t, map[string]string{
		"app/__init__.py": "",
		"app/models.py": `class Cart:
    def total(self):
        return self._sum()

    def _sum(self):
        return 0


def make_cart():
    return Cart()
`,
		"app/api.py": `from app.models import make_cart
from app import models
import app.util as u

def handler(req):
    cart = make_cart()
    print(cart.total())
    u.log("x")
    return models.Cart()

handler(None)
`,
		"app/util.py": "def log(msg):\n    pass\n",
	})
	wantCalls(t, g,
		"app/api.py:(top-level code) -> app/api.py:handler",
		"app/api.py:handler -> app/models.py:Cart",
		"app/api.py:handler -> app/models.py:Cart.total ?",
		"app/api.py:handler -> app/models.py:make_cart",
		"app/api.py:handler -> app/util.py:log",
		"app/models.py:Cart.total -> app/models.py:Cart._sum",
		"app/models.py:make_cart -> app/models.py:Cart",
	)
	if end := symEnd(t, g, "app/models.py", "Cart.total"); end != 4 {
		t.Errorf("Cart.total ends at %d, want 4", end)
	}
}

func TestCallGraphTypeScript(t *testing.T) {
	g := analyze(t, map[string]string{
		"src/api.ts": `import { createUser as mk, findUser } from "./users";
import * as log from "./log";
import Store from "./store";

export async function signup(name: string) {
  const u = mk(name);
  log.info("created");
  return new Store().save(u);
}

export const lookup = (id: string) => {
  return findUser(id);
};
`,
		"src/users.ts": "export function createUser(n: string) { return validate(n); }\nfunction validate(n: string) { return n; }\nexport function findUser(id: string) { return null; }\n",
		"src/log.ts":   "export function info(msg: string) {}\n",
		"src/store.ts": `export default class Store {
  save(x: unknown) {
    return this.flush();
  }
  private flush() { return true; }
}
`,
	})
	wantCalls(t, g,
		"src/api.ts:lookup -> src/users.ts:findUser",
		"src/api.ts:signup -> src/log.ts:info",
		"src/api.ts:signup -> src/store.ts:Store", // new Store(): the constructor
		"src/api.ts:signup -> src/users.ts:createUser",
		"src/store.ts:Store.save -> src/store.ts:Store.flush",
		"src/users.ts:createUser -> src/users.ts:validate",
	)
	if end := symEnd(t, g, "src/store.ts", "Store.save"); end != 4 {
		t.Errorf("Store.save ends at %d, want 4", end)
	}
}

func TestCallGraphJava(t *testing.T) {
	g := analyze(t, map[string]string{
		"src/com/shop/OrderService.java": `package com.shop;

import com.shop.util.Money;

public class OrderService {
    public int total(Order o) {
        int sum = compute(o);
        return Money.round(sum);
    }
    private int compute(Order o) { return o.count(); }
}
`,
		"src/com/shop/Order.java":      "package com.shop;\n\npublic class Order {\n  public int count() { return 1; }\n}\n",
		"src/com/shop/util/Money.java": "package com.shop.util;\n\npublic class Money {\n  public static int round(int x) { return x; }\n}\n",
	})
	wantCalls(t, g,
		"src/com/shop/OrderService.java:OrderService.compute -> src/com/shop/Order.java:Order.count ?",
		"src/com/shop/OrderService.java:OrderService.total -> src/com/shop/OrderService.java:OrderService.compute",
		"src/com/shop/OrderService.java:OrderService.total -> src/com/shop/util/Money.java:Money.round",
	)
}

func TestCallGraphRustRubyCSharp(t *testing.T) {
	g := analyze(t, map[string]string{
		"Cargo.toml":  "[package]\nname = \"shop\"\n",
		"src/main.rs": "mod util;\nuse crate::util::slug;\n\nfn main() {\n    let s = slug(\"A\");\n    util::shout(&s);\n}\n",
		"src/util.rs": "pub fn slug(s: &str) -> String { lower(s) }\nfn lower(s: &str) -> String { s.to_lowercase() }\npub fn shout(s: &str) {}\n",
		"lib/report.rb": `class Report
  def build
    rows = fetch
    Formatter.render(rows)
  end

  def fetch
    []
  end
end
`,
		"lib/formatter.rb": "class Formatter\n  def self.render(rows)\n    rows\n  end\nend\n",
		"Svc.cs":           "namespace Shop;\npublic class Svc {\n  public void Run() { Helper.Go(); Step(); }\n  void Step() {}\n}\n",
		"Helper.cs":        "namespace Shop;\npublic static class Helper {\n  public static void Go() {}\n}\n",
	})
	wantCalls(t, g,
		"Svc.cs:Svc.Run -> Helper.cs:Helper.Go",
		"Svc.cs:Svc.Run -> Svc.cs:Svc.Step",
		"lib/report.rb:Report.build -> lib/formatter.rb:Formatter.render",
		"src/main.rs:main -> src/util.rs:shout",
		"src/main.rs:main -> src/util.rs:slug",
		"src/util.rs:slug -> src/util.rs:lower",
	)
}
