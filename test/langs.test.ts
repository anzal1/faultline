import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { buildModel } from "../src/graph.js";
import { expandUseTree } from "../src/lang/extract.js";
import { blank, LEX } from "../src/lang/lexer.js";
import { ParseCache } from "../src/parse.js";
import { WorktreeSource } from "../src/source.js";
import type { FileEdge } from "../src/types.js";

const CLI = path.resolve(__dirname, "..", "dist", "cli.js");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

async function graph(files: Record<string, string>): Promise<FileEdge[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fl-lang-"));
  dirs.push(root);
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), c);
  }
  const config = parseConfig(`systems:\n  - { id: all, paths: ["**"] }\n`);
  const m = await buildModel(new WorktreeSource(root), config, new ParseCache(null));
  return m.edges;
}
const pairs = (edges: FileEdge[]) => edges.map((e) => `${e.from} -> ${e.to}`).sort();

describe("lexer", () => {
  it("blanks comments and docstrings but keeps offsets", () => {
    const src = `x = 1  # import os\n"""import sys"""\nimport re`;
    const out = blank(src, LEX.python);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain("import os");
    expect(out).not.toContain("import sys");
    expect(out).toContain("import re");
  });
});

describe("python", () => {
  it("resolves absolute, relative, submodule and src-layout imports", async () => {
    const e = await graph({
      "src/app/__init__.py": "",
      "src/app/models.py": "from .db import engine\nfrom . import utils\n",
      "src/app/db.py": "import app.utils as u\n",
      "src/app/utils.py": "import os, json\n",
      "src/app/api/__init__.py": "",
      "src/app/api/routes.py": "from ..models import User\nfrom app.api import helpers\nfrom typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from app.db import engine\n",
      "src/app/api/helpers.py": "",
      "src/app/api/test_routes.py": "from app.api.routes import x\n",
    });
    expect(pairs(e)).toEqual([
      "src/app/api/routes.py -> src/app/api/helpers.py",
      "src/app/api/routes.py -> src/app/db.py",
      "src/app/api/routes.py -> src/app/models.py",
      "src/app/db.py -> src/app/utils.py",
      "src/app/models.py -> src/app/db.py",
      "src/app/models.py -> src/app/utils.py",
    ]);
    expect(e.find((x) => x.to === "src/app/db.py" && x.from.endsWith("routes.py"))?.typeOnly).toBe(true);
  });
});

describe("go", () => {
  it("maps import paths to packages through go.mod", async () => {
    const e = await graph({
      "go.mod": "module example.com/shop\n\ngo 1.22\n",
      "cmd/server/main.go": 'package main\n\nimport (\n  "fmt"\n  api "example.com/shop/internal/api"\n  "github.com/spf13/cobra"\n)\n',
      "internal/api/api.go": 'package api\nimport "example.com/shop/internal/store"\n',
      "internal/store/store.go": "package store\n",
      "internal/store/store_test.go": 'package store\nimport "example.com/shop/internal/api"\n',
    });
    expect(pairs(e)).toEqual(["cmd/server/main.go -> internal/api/api.go", "internal/api/api.go -> internal/store/store.go"]);
  });
});

describe("rust", () => {
  it("expands nested use trees", () => {
    expect(expandUseTree("crate::a::{b, c::{d, e}, self}")).toEqual(["crate::a::b", "crate::a::c::d", "crate::a::c::e", "crate::a"]);
  });
  it("follows mod declarations, crate paths, workspace crates and skips test modules", async () => {
    const e = await graph({
      "Cargo.toml": '[workspace]\nmembers = ["core", "cli"]\n',
      "core/Cargo.toml": '[package]\nkeywords = ["x"]\nname = "shop-core"\n',
      "core/src/lib.rs": "pub mod orders;\nmod util;\n",
      "core/src/orders.rs": "use crate::util::{money, tax::Rate};\n#[cfg(test)]\nmod tests { use crate::fake::X; }\n",
      "core/src/util/mod.rs": "pub mod money;\npub mod tax;\n",
      "core/src/util/money.rs": "",
      "core/src/util/tax.rs": "",
      "core/src/fake.rs": "",
      "cli/Cargo.toml": '[package]\nname = "shop-cli"\n',
      "cli/src/main.rs": "fn main() { shop_core::orders::run(); }\n",
    });
    expect(pairs(e)).toEqual([
      "cli/src/main.rs -> core/src/lib.rs",
      "core/src/lib.rs -> core/src/orders.rs",
      "core/src/lib.rs -> core/src/util/mod.rs",
      "core/src/orders.rs -> core/src/util/money.rs",
      "core/src/orders.rs -> core/src/util/tax.rs",
      "core/src/util/mod.rs -> core/src/util/money.rs",
      "core/src/util/mod.rs -> core/src/util/tax.rs",
    ]);
  });
});

describe("jvm", () => {
  it("resolves Java imports exactly and same-package references as inferred", async () => {
    const e = await graph({
      "src/main/java/com/shop/api/OrderController.java": "package com.shop.api;\nimport com.shop.core.OrderService;\nimport java.util.List;\npublic class OrderController { OrderService s; OrderMapper m; List<String> x; }\n",
      "src/main/java/com/shop/api/OrderMapper.java": "package com.shop.api;\npublic class OrderMapper {}\n",
      "src/main/java/com/shop/core/OrderService.java": "package com.shop.core;\npublic class OrderService {}\n",
    });
    const byTo = Object.fromEntries(e.map((x) => [x.to.split("/").pop(), x.confidence]));
    expect(byTo).toEqual({ "OrderService.java": "exact", "OrderMapper.java": "inferred" });
  });
  it("resolves Kotlin top-level function imports", async () => {
    const e = await graph({
      "app/src/main/kotlin/shop/App.kt": "package shop\nimport shop.util.formatPrice\nfun main() = formatPrice(1)\n",
      "app/src/main/kotlin/shop/util/Money.kt": "package shop.util\nfun formatPrice(x: Int) = x\n",
    });
    expect(pairs(e)).toEqual(["app/src/main/kotlin/shop/App.kt -> app/src/main/kotlin/shop/util/Money.kt"]);
  });
});

describe("csharp", () => {
  it("links types through visible namespaces and project references", async () => {
    const e = await graph({
      "Api/Api.csproj": '<Project><ItemGroup><ProjectReference Include="..\\Core\\Core.csproj" /></ItemGroup></Project>',
      "Core/Core.csproj": "<Project/>",
      "Api/Controllers/OrdersController.cs": "using Shop.Core;\nnamespace Shop.Api;\npublic class OrdersController { OrderService s; string x; }\n",
      "Core/OrderService.cs": "namespace Shop.Core { public class OrderService {} }\n",
      "Other/OrderService.cs": "namespace Other.Place { public class OrderService {} }\n",
    });
    expect(pairs(e)).toEqual(["Api/Api.csproj -> Core/Core.csproj", "Api/Controllers/OrdersController.cs -> Core/OrderService.cs"]);
  });
});

describe("c, ruby, php, swift, dart, elixir, lua, haskell, zig", () => {
  it("c includes", async () => {
    const e = await graph({ "src/main.c": '#include "util/str.h"\n#include <stdio.h>\n#include "net.h"\n', "src/util/str.h": "", "include/net.h": "" });
    expect(pairs(e)).toEqual(["src/main.c -> include/net.h", "src/main.c -> src/util/str.h"]);
  });
  it("ruby requires and scoped constants, ignoring stdlib names", async () => {
    const e = await graph({
      "lib/shop.rb": "require 'shop/order'\n",
      "lib/shop/order.rb": "module Shop\n  class Order\n    def x; File.read('a'); Pricing.new; end\n  end\nend\n",
      "lib/shop/pricing.rb": "module Shop\n  class Pricing\n  end\nend\n",
      "lib/shop/io/file.rb": "module Shop\n  module IO\n    class File\n    end\n  end\nend\n",
    });
    expect(pairs(e)).toEqual(["lib/shop.rb -> lib/shop/order.rb", "lib/shop/order.rb -> lib/shop/pricing.rb"]);
  });
  it("php use statements through declared namespaces", async () => {
    const e = await graph({
      "src/Http/Controller.php": "<?php\nnamespace App\\Http;\nuse App\\Domain\\{Order, Invoice as Bill};\nuse Psr\\Log\\LoggerInterface;\nclass Controller {}\n",
      "src/Domain/Order.php": "<?php\nnamespace App\\Domain;\nclass Order {}\n",
      "src/Domain/Invoice.php": "<?php\nnamespace App\\Domain;\nclass Invoice {}\n",
    });
    expect(pairs(e)).toEqual(["src/Http/Controller.php -> src/Domain/Invoice.php", "src/Http/Controller.php -> src/Domain/Order.php"]);
  });
  it("swift type references, skipping platform names", async () => {
    const e = await graph({ "App/Views/Cart.swift": "import SwiftUI\nstruct CartView: View { let s: CartStore; var body: some View { Text(\"\") } }\n", "App/Store/CartStore.swift": "final class CartStore {}\n", "App/Views/Text.swift": "struct Text {}\n" });
    expect(pairs(e)).toEqual(["App/Views/Cart.swift -> App/Store/CartStore.swift"]);
  });
  it("dart package and relative imports", async () => {
    const e = await graph({ "pubspec.yaml": "name: shop\n", "lib/main.dart": "import 'package:shop/cart.dart';\nimport 'package:flutter/material.dart';\nimport 'src/util.dart';\n", "lib/cart.dart": "", "lib/src/util.dart": "" });
    expect(pairs(e)).toEqual(["lib/main.dart -> lib/cart.dart", "lib/main.dart -> lib/src/util.dart"]);
  });
  it("elixir module references", async () => {
    const e = await graph({ "lib/shop/orders.ex": "defmodule Shop.Orders do\n  alias Shop.{Repo, Billing}\n  def x, do: Repo.all() && Billing.charge()\nend\n", "lib/shop/repo.ex": "defmodule Shop.Repo do\nend\n", "lib/shop/billing.ex": "defmodule Shop.Billing do\nend\n" });
    expect(pairs(e)).toEqual(["lib/shop/orders.ex -> lib/shop/billing.ex", "lib/shop/orders.ex -> lib/shop/repo.ex"]);
  });
  it("lua, haskell and zig", async () => {
    const e = await graph({
      "lua/shop/init.lua": 'local cart = require("shop.cart")\n',
      "lua/shop/cart.lua": "",
      "src/Shop/Api.hs": "module Shop.Api where\nimport qualified Shop.Db as Db\nimport Data.Text\n",
      "src/Shop/Db.hs": "module Shop.Db where\n",
      "src/main.zig": 'const std = @import("std");\nconst cart = @import("cart.zig");\n',
      "src/cart.zig": "",
    });
    expect(pairs(e)).toEqual(["lua/shop/init.lua -> lua/shop/cart.lua", "src/Shop/Api.hs -> src/Shop/Db.hs", "src/main.zig -> src/cart.zig"]);
  });
});

describe("agents", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fl-agent-"));
  dirs.push(repo);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  const run = (args: string[], input?: string) => spawnSync("node", [CLI, ...args], { cwd: repo, input, encoding: "utf8" });
  fs.mkdirSync(path.join(repo, "src/web"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src/api"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src/db"), { recursive: true });
  fs.writeFileSync(path.join(repo, "faultline.yml"), `version: 1\nsystems:\n  - { id: web, name: Web, paths: ["src/web/**"] }\n  - { id: api, name: API, paths: ["src/api/**"] }\n  - { id: db, name: DB, paths: ["src/db/**"] }\nrules:\n  - deny: web -> db\n    reason: go through the API\n`);
  fs.writeFileSync(path.join(repo, "src/web/page.py"), "from src.api import users\n");
  fs.writeFileSync(path.join(repo, "src/api/users.py"), "from src.db import client\n");
  fs.writeFileSync(path.join(repo, "src/db/client.py"), "");
  fs.writeFileSync(path.join(repo, "src/__init__.py"), "");
  for (const d of ["web", "api", "db"]) fs.writeFileSync(path.join(repo, `src/${d}/__init__.py`), "");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "base");

  it("place explains the rule and an allowed route", () => {
    const r = run(["place", "src/web/new.py", "src/db/client.py"]);
    expect(r.stdout).toContain("src/web/new.py → web (Web), module new, new file.");
    expect(r.stdout).toContain("✗ src/db/client.py (db): crosses fault line deny web -> db (go through the API). Allowed route: web → api → db.");
    expect(r.stdout).toMatch(/\(~\d+ tokens\)/);
  });

  it("check --staged blocks a staged violation", () => {
    fs.writeFileSync(path.join(repo, "src/web/admin.py"), "from src.db import client\n");
    expect(run(["check", "--staged"]).status).toBe(0);
    git("add", "src/web/admin.py");
    const r = run(["check", "--staged", "--quiet"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Crosses a fault line: Web → DB");
  });

  it("hook speaks each agent's format", () => {
    const ev = (name: string, extra = {}) => JSON.stringify({ hook_event_name: name, session_id: `s-${name}-${Math.random()}`, cwd: repo, ...extra });
    const codex = JSON.parse(run(["hook", "--agent", "codex"], ev("PostToolUse")).stdout);
    expect(codex.hookSpecificOutput.additionalContext).toContain("Allowed route: web → api → db");
    const claude = JSON.parse(run(["hook", "--agent", "claude"], ev("PostToolUse")).stdout);
    expect(claude).toMatchObject({ decision: "block", continueOnBlock: true });
    expect(run(["hook", "--agent", "cursor"], ev("afterFileEdit", { workspace_roots: [repo] })).stdout).toBe("");
    const cursor = JSON.parse(run(["hook", "--agent", "cursor"], JSON.stringify({ hook_event_name: "stop", conversation_id: "c1", workspace_roots: [repo] })).stdout);
    expect(cursor.followup_message).toContain("Web → DB is a declared fault line");
  });

  it("plan records intent and the agent diff marks unplanned dependencies", () => {
    expect(run(["plan", "web -> api: pages need data"]).status).toBe(0);
    expect(fs.readFileSync(path.join(repo, ".faultline/plan.yml"), "utf8")).toContain("why: pages need data");
    fs.writeFileSync(path.join(repo, "src/api/report.py"), "from src.web import page\n");
    const r = run(["diff", "--format", "agent"]);
    expect(r.stdout).toContain("● New dependency: API → Web");
    expect(r.stdout).toContain("(not in plan)");
  });

  it("setup wires every agent and a pre-commit hook", () => {
    const r = run(["setup", "--agent", "all"]);
    expect(r.status).toBe(0);
    for (const f of [".mcp.json", ".cursor/mcp.json", ".cursor/hooks.json", ".codex/config.toml", ".vscode/mcp.json", ".github/hooks/faultline.json", ".gemini/settings.json", ".kiro/settings/mcp.json", ".zed/settings.json", "opencode.json", "AGENTS.md", ".git/hooks/pre-commit"]) {
      expect(fs.existsSync(path.join(repo, f)), f).toBe(true);
    }
    expect(JSON.parse(fs.readFileSync(path.join(repo, ".vscode/mcp.json"), "utf8")).servers.faultline.type).toBe("stdio");
    expect(fs.readFileSync(path.join(repo, ".codex/config.toml"), "utf8")).toContain("[mcp_servers.faultline]");
    // Running it twice changes nothing.
    const before = fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8") + fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    run(["setup", "--agent", "all"]);
    expect(fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8") + fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8")).toBe(before);
  });

  it("serves four MCP tools over stdio", async () => {
    const p = spawnSync("node", [CLI, "mcp"], {
      cwd: repo,
      input: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "map", arguments: {} } },
      ].map((m) => JSON.stringify(m)).join("\n") + "\n",
      encoding: "utf8",
      timeout: 15000,
    });
    const msgs = p.stdout.trim().split("\n").map((l) => JSON.parse(l));
    const tools = msgs.find((m) => m.id === 2).result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(["map", "place", "check", "plan"]);
    expect(msgs.find((m) => m.id === 3).result.content[0].text).toContain("deny web -> db: go through the API");
  });
});
