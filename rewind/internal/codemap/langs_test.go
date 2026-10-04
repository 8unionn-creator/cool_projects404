package codemap

import (
	"reflect"
	"testing"
)

func symNames(f *File) []string {
	var out []string
	for _, s := range f.Symbols {
		out = append(out, s.Kind+":"+s.Name)
	}
	return out
}

func wantSyms(t *testing.T, f *File, want ...string) {
	t.Helper()
	if got := symNames(f); !reflect.DeepEqual(got, want) {
		t.Errorf("%s symbols:\n  got  %q\n  want %q", f.Path, got, want)
	}
}

func wantExt(t *testing.T, g *Graph, p string, want ...string) {
	t.Helper()
	_, i := file(t, g, p)
	got := g.External[i]
	if len(want) == 0 && len(got) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s externals: got %q, want %q", p, got, want)
	}
}

func TestJavaAndKotlin(t *testing.T) {
	g := analyze(t, map[string]string{
		"src/main/java/com/shop/App.java": `package com.shop;

import com.shop.model.Order;
import com.shop.model.*;
import static com.shop.util.Strings.slug;
import org.springframework.boot.SpringApplication;
import java.util.List;

public class App {
    private final Cart cart = new Cart();
    public static void main(String[] args) {
        if (args.length > 0 && args[0] != null) { new Order(); }
        Item i = null;
    }
    public App() {}
    List<String> names(int n) { return null; }
}
`,
		"src/main/java/com/shop/Cart.java":         "package com.shop;\n\npublic class Cart {}\n",
		"src/main/java/com/shop/model/Order.java":  "package com.shop.model;\n\npublic record Order(int id) {}\n",
		"src/main/java/com/shop/model/Item.java":   "package com.shop.model;\n\npublic interface Item { void name(); }\n",
		"src/main/java/com/shop/util/Strings.java": "package com.shop.util;\n\npublic final class Strings {\n  public static String slug(String s) { return s; }\n}\n",
		"src/main/kotlin/com/shop/Report.kt": `package com.shop

import com.shop.model.Order
import kotlinx.serialization.Serializable

data class Report(val orders: List<Order>)

fun String.shout(): String = uppercase()

internal const val MAX = 3
val String.loud get() = uppercase()

fun main() { println(Report(emptyList())) }
`,
		"src/test/java/com/shop/AppTest.java": "package com.shop;\n\nclass AppTest { void works() { new App(); } }\n",
	})
	wantDeps(t, g,
		"src/main/java/com/shop/App.java -> src/main/java/com/shop/Cart.java",
		"src/main/java/com/shop/App.java -> src/main/java/com/shop/model/Item.java",
		"src/main/java/com/shop/App.java -> src/main/java/com/shop/model/Order.java",
		"src/main/java/com/shop/App.java -> src/main/java/com/shop/util/Strings.java",
		"src/main/kotlin/com/shop/Report.kt -> src/main/java/com/shop/model/Order.java",
		"src/test/java/com/shop/AppTest.java -> src/main/java/com/shop/App.java",
	)
	app, ai := file(t, g, "src/main/java/com/shop/App.java")
	wantSyms(t, app, "class:App", "method:App.main", "method:App.App", "method:App.names")
	if !app.Entry || app.Complexity != 2 {
		t.Errorf("App.java: entry=%v complexity=%d", app.Entry, app.Complexity)
	}
	if !reflect.DeepEqual(g.External[ai], []string{"org.springframework"}) {
		t.Errorf("externals = %q", g.External[ai])
	}
	kt, _ := file(t, g, "src/main/kotlin/com/shop/Report.kt")
	wantSyms(t, kt, "class:Report", "func:shout", "const:MAX", "const:loud", "func:main")
	if !kt.Entry {
		t.Error("fun main should be an entry point")
	}
	wantExt(t, g, "src/main/kotlin/com/shop/Report.kt", "kotlinx.serialization")
	if f, _ := file(t, g, "src/test/java/com/shop/AppTest.java"); !f.Test {
		t.Error("src/test should be tests")
	}
}

func TestCSharp(t *testing.T) {
	g := analyze(t, map[string]string{
		"Shop/Program.cs": `using Shop.Services;
using Shop.Data;
using Newtonsoft.Json;
using System.Linq;
using Model = Shop.Data.Models.Order;

namespace Shop;

public static class Program
{
    public static async Task Main(string[] args)
    {
        var svc = new OrderService();
        using (var x = Open()) { }
        foreach (var a in args) { }
    }
}
`,
		"Shop/Services/OrderService.cs": `namespace Shop.Services
{
    public class OrderService
    {
        private readonly Repo _repo;
        public OrderService() { }
        public int Count(int n) => n;
    }
    internal class Helper {}
}
`,
		"Shop/Services/Repo.cs":           "\ufeffnamespace Shop.Services;\npublic class Repo {}\n",
		"Shop/Shop.csproj":                "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>\n",
		"Shop/GlobalUsings.cs":            "global using Shop.Data;\n",
		"Shop/Jobs/Nightly.cs":            "namespace Shop.Jobs;\npublic class Nightly { Db db; }\n",
		"Shop/Data/Models/Order.cs":       "namespace Shop.Data.Models;\npublic record Order(int Id);\n",
		"Shop/Data/Db.cs":                 "namespace Shop.Data;\npublic class Db {}\n",
		"Shop.Tests/OrderServiceTests.cs": "using Shop.Services;\nnamespace Shop.Tests;\npublic class OrderServiceTests { void T() { new OrderService(); } }\n",
	})
	wantDeps(t, g,
		"Shop/Program.cs -> Shop/Data/Models/Order.cs",
		"Shop/Program.cs -> Shop/Services/OrderService.cs",
		"Shop/Jobs/Nightly.cs -> Shop/Data/Db.cs",
		"Shop/Services/OrderService.cs -> Shop/Services/Repo.cs",
		"Shop.Tests/OrderServiceTests.cs -> Shop/Services/OrderService.cs",
	)
	svc, _ := file(t, g, "Shop/Services/OrderService.cs")
	wantSyms(t, svc, "class:OrderService", "method:OrderService.OrderService", "method:OrderService.Count", "class:Helper")
	wantExt(t, g, "Shop/Program.cs", "Newtonsoft.Json")
	if p, _ := file(t, g, "Shop/Program.cs"); !p.Entry || p.Complexity != 1 {
		t.Errorf("Program.cs entry=%v complexity=%d", p.Entry, p.Complexity)
	}
	if f, _ := file(t, g, "Shop.Tests/OrderServiceTests.cs"); !f.Test {
		t.Error("*.Tests project should be tests")
	}
}

func TestCAndCpp(t *testing.T) {
	g := analyze(t, map[string]string{
		"src/main.c": `#include <stdio.h>
#include <curl/curl.h>
#include "util.h"
#include "net/http.h"

static int helper(int x) { return x > 0 && x < 9; }

int main(int argc, char **argv) {
    struct options opts;
    if (argc > 1) { return helper(argc); }
    return 0;
}
`,
		"src/util.h":         "#pragma once\nint add(int a, int b);\nstruct options { int verbose; };\n",
		"src/util.c":         "#include \"util.h\"\nint add(int a, int b) { return a + b; }\n",
		"include/net/http.h": "#include <sys/socket.h>\nvoid http_get(const char *url);\n",
		"lib/engine.cpp": `#include "engine.hpp"
#include <vector>
#include <boost/asio.hpp>

namespace eng {
Engine::Engine() {}
void Engine::run() const { for (int i = 0; i < 3; i++) {} }
}
`,
		"lib/engine.hpp":    "#pragma once\nnamespace eng {\nclass Engine final {\npublic:\n  Engine();\n  void run() const;\n};\n}\n",
		"tests/util_test.c": "#include \"../src/util.h\"\nint main(void) { return add(1, 2) != 3; }\n",
	})
	wantDeps(t, g,
		"lib/engine.cpp -> lib/engine.hpp",
		"src/main.c -> include/net/http.h",
		"src/main.c -> src/util.h",
		"src/util.c -> src/util.h",
		"tests/util_test.c -> src/util.h",
	)
	main, _ := file(t, g, "src/main.c")
	wantSyms(t, main, "func:helper", "func:main")
	if !main.Entry || main.Complexity != 2 {
		t.Errorf("main.c entry=%v complexity=%d", main.Entry, main.Complexity)
	}
	if !main.Symbols[1].Exported || main.Symbols[0].Exported {
		t.Error("static functions are file-private")
	}
	wantExt(t, g, "src/main.c", "curl")
	wantExt(t, g, "include/net/http.h")
	wantExt(t, g, "lib/engine.cpp", "boost")
	util, _ := file(t, g, "src/util.h")
	wantSyms(t, util, "func:add", "struct:options")
	hpp, _ := file(t, g, "lib/engine.hpp")
	wantSyms(t, hpp, "class:Engine", "method:Engine.Engine", "method:Engine.run")
	cpp, _ := file(t, g, "lib/engine.cpp")
	wantSyms(t, cpp, "method:Engine.Engine", "method:Engine.run")
}

func TestRust(t *testing.T) {
	g := analyze(t, map[string]string{
		"Cargo.toml":      "[workspace]\nmembers = [\"core\", \"cli\"]\n",
		"core/Cargo.toml": "[package]\nname = \"shop-core\"\nversion = \"0.1.0\"\n",
		"core/src/lib.rs": `pub mod model;
mod util;
pub use model::Order;

pub const VERSION: &str = "1";
`,
		"core/src/model/mod.rs": `use crate::util::slug;
use super::VERSION;

pub struct Order<'a> { pub name: &'a str }

impl<'a> Order<'a> {
    pub fn label(&self) -> String { if self.name.is_empty() && true { slug(self.name) } else { String::new() } }
}

pub trait Priced { fn price(&self) -> u32; }
`,
		"core/src/util.rs": "pub fn slug(s: &str) -> String { s.to_lowercase() }\nfn private() {}\n",
		"cli/Cargo.toml":   "[package]\nname = \"shop-cli\"\n",
		"cli/src/main.rs": `use shop_core::{model::Order, VERSION};
use std::collections::HashMap;
use clap::{Parser, Subcommand};

fn main() { let r = r#"raw "string" with { braces"#; }
`,
		"core/tests/order.rs": "use shop_core::Order;\n#[test]\nfn works() {}\n",
	})
	wantDeps(t, g,
		"cli/src/main.rs -> core/src/lib.rs",
		"cli/src/main.rs -> core/src/model/mod.rs",
		"core/src/lib.rs -> core/src/model/mod.rs", // pub use makes it a real dependency
		"core/src/lib.rs -> core/src/util.rs (type)",
		"core/src/model/mod.rs -> core/src/lib.rs",
		"core/src/model/mod.rs -> core/src/util.rs",
		"core/tests/order.rs -> core/src/lib.rs",
	)
	if c := g.Cycles(); len(c) != 0 { // lib.rs <-> model/mod.rs is normal within a crate
		t.Errorf("modules of one crate referring to each other are not cycles: %+v", c)
	}
	model, _ := file(t, g, "core/src/model/mod.rs")
	wantSyms(t, model, "struct:Order", "method:Order.label", "trait:Priced", "method:Priced.price")
	if model.Complexity != 2 {
		t.Errorf("complexity = %d", model.Complexity)
	}
	lib, _ := file(t, g, "core/src/lib.rs")
	wantSyms(t, lib, "const:VERSION")
	wantExt(t, g, "cli/src/main.rs", "clap")
	if f, _ := file(t, g, "cli/src/main.rs"); !f.Entry {
		t.Error("main.rs should be an entry point")
	}
	util, _ := file(t, g, "core/src/util.rs")
	if !util.Symbols[0].Exported || util.Symbols[1].Exported {
		t.Error("only pub items are exported")
	}
}

func TestPHP(t *testing.T) {
	g := analyze(t, map[string]string{
		"composer.json": `{"autoload": {"psr-4": {"App\\": "src/"}}, "autoload-dev": {"psr-4": {"Tests\\": "tests/"}}}`,
		"src/Http/Controller.php": `<?php
namespace App\Http;

use App\Models\{User, Post as P};
use App\Services\Mailer;
use Symfony\Component\HttpFoundation\Request;

class Controller
{
    use Helpers;
    public function show(int $id): string
    {
        if ($id > 0 && $id < 10) { return (new User())->name(); }
        return 'x';
    }
    private function hidden() {}
}
`,
		"src/Http/Helpers.php":    "<?php\nnamespace App\\Http;\n\ntrait Helpers {}\n",
		"src/Models/User.php":     "<?php\nnamespace App\\Models;\n\nclass User { public function name() { return 'u'; } }\n",
		"src/Models/Post.php":     "<?php\nnamespace App\\Models;\n\nfinal class Post {}\n",
		"src/Services/Mailer.php": "<?php\nnamespace App\\Services;\n\ninterface Mailer {}\n",
		"public/index.php":        "<html><?php require __DIR__ . '/../bootstrap.php'; ?><p>It's here</p></html>\n",
		"bootstrap.php":           "<?php\nfunction boot() {}\n",
		"tests/UserTest.php":      "<?php\nnamespace Tests;\nuse App\\Models\\User;\nclass UserTest {}\n",
	})
	wantDeps(t, g,
		"public/index.php -> bootstrap.php",
		"src/Http/Controller.php -> src/Http/Helpers.php",
		"src/Http/Controller.php -> src/Models/Post.php",
		"src/Http/Controller.php -> src/Models/User.php",
		"src/Http/Controller.php -> src/Services/Mailer.php",
		"tests/UserTest.php -> src/Models/User.php",
	)
	c, _ := file(t, g, "src/Http/Controller.php")
	wantSyms(t, c, "class:Controller", "method:Controller.show", "method:Controller.hidden")
	if c.Complexity != 2 || c.Symbols[2].Exported {
		t.Errorf("complexity=%d, private exported=%v", c.Complexity, c.Symbols[2].Exported)
	}
	wantExt(t, g, "src/Http/Controller.php", "Symfony\\Component")
	if f, _ := file(t, g, "public/index.php"); !f.Entry {
		t.Error("index.php should be an entry point")
	}
}

func TestRuby(t *testing.T) {
	g := analyze(t, map[string]string{
		"app/models/order.rb": `class Order < ApplicationRecord
  belongs_to :user
  def total
    items.sum(&:price) if paid? && !refunded?
  end

  def self.recent; end
end
`,
		"app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\n  self.abstract_class = true\nend\n",
		"app/models/user.rb":               "class User < ApplicationRecord\n  has_many :orders # Order\nend\n",
		"app/controllers/orders_controller.rb": `require "json"
require "stripe"
require_relative "../services/billing"

class OrdersController
  def show
    Order.find(1) # "User" in a comment and "User" in a string do not count
    Billing::Charge.new
  end
end
`,
		"app/services/billing.rb": "module Billing\n  class Charge\n    def run; end\n  end\nend\n",
		"lib/shop/version.rb":     "module Shop\n  VERSION = '1.0'\nend\n",
		"bin/shop":                "#!/usr/bin/env ruby\n",
		"bin/setup.rb":            "require 'shop/version'\nputs Shop::VERSION\n",
		"spec/order_spec.rb":      "require 'spec_helper'\nRSpec.describe Order do\nend\n",
	})
	wantDeps(t, g,
		"app/controllers/orders_controller.rb -> app/models/order.rb",
		"app/controllers/orders_controller.rb -> app/services/billing.rb",
		"app/models/order.rb -> app/models/application_record.rb",
		"app/models/user.rb -> app/models/application_record.rb",
		"bin/setup.rb -> lib/shop/version.rb",
		"spec/order_spec.rb -> app/models/order.rb",
	)
	o, _ := file(t, g, "app/models/order.rb")
	wantSyms(t, o, "class:Order", "method:Order.total", "method:Order.recent")
	if o.Complexity != 2 {
		t.Errorf("complexity = %d", o.Complexity)
	}
	b, _ := file(t, g, "app/services/billing.rb")
	wantSyms(t, b, "module:Billing", "class:Billing::Charge", "method:Billing::Charge.run")
	wantExt(t, g, "app/controllers/orders_controller.rb", "stripe")
	if f, _ := file(t, g, "spec/order_spec.rb"); !f.Test {
		t.Error("spec/ should be tests")
	}
}

func TestDart(t *testing.T) {
	g := analyze(t, map[string]string{
		"pubspec.yaml": "name: shop\ndependencies:\n  http: ^1.0.0\n",
		"lib/main.dart": `import 'package:flutter/material.dart';
import 'package:shop/src/cart.dart';
import 'src/api.dart' as api;
import 'dart:async';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});
  Widget build(BuildContext context) { return cart.isEmpty ? Text('empty') : Text('full'); }
  void _private() {}
}
`,
		"lib/src/cart.dart":      "part 'cart_item.dart';\nclass Cart {}\n",
		"lib/src/cart_item.dart": "part of 'cart.dart';\nclass CartItem {}\n",
		"lib/src/api.dart":       "import 'package:http/http.dart' as http;\nFuture<void> fetch() async {}\n",
		"test/cart_test.dart":    "import 'package:shop/src/cart.dart';\nvoid main() {}\n",
	})
	wantDeps(t, g,
		"lib/main.dart -> lib/src/api.dart",
		"lib/main.dart -> lib/src/cart.dart",
		"lib/src/cart.dart -> lib/src/cart_item.dart (type)",
		"test/cart_test.dart -> lib/src/cart.dart",
	)
	m, _ := file(t, g, "lib/main.dart")
	wantSyms(t, m, "func:main", "class:App", "method:App.App", "method:App.build", "method:App._private")
	if m.Symbols[4].Exported || !m.Entry {
		t.Error("_private is library-private; main.dart is an entry point")
	}
	wantExt(t, g, "lib/main.dart", "flutter")
	wantExt(t, g, "lib/src/api.dart", "http")
}
