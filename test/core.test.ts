import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Assigner, parseConfig } from "../src/config.js";
import { Workspace } from "../src/context.js";
import { findings, headline } from "../src/describe.js";
import { detectEntries, dominators, footprint } from "../src/footprint.js";
import { aggregate, cycles } from "../src/graph.js";
import { parseFile } from "../src/parse.js";
import { proposeHeuristic, simplifyGlobs } from "../src/propose.js";
import { renderMarkdown } from "../src/render/markdown.js";
import { Resolver } from "../src/resolve.js";
import { buildState } from "../src/state.js";

const CLI = path.resolve(__dirname, "..", "dist", "cli.js");

function write(root: string, files: Record<string, string>) {
  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), content);
  }
}
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

const CONFIG = `version: 1
systems:
  - { id: web, name: Web UI, paths: ["src/web/**"] }
  - { id: api, name: API, paths: ["src/api/**"] }
  - { id: db, name: Database, paths: ["src/db/**"] }
  - { id: shared, name: Shared, paths: ["src/shared/**"] }
rules:
  - deny: web -> db
    reason: The UI talks to the API, never the database
`;

let repo: string;
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "faultline-test-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  write(repo, {
    "faultline.yml": CONFIG,
    "src/web/page.tsx": `import { getUser } from "../api/users.js";\nimport type { User } from "../shared/types";\nexport const Page = () => getUser();\n`,
    "src/api/users.ts": `import { query } from "../db/client";\nexport function getUser() { return query("select 1"); }\n`,
    "src/db/client.ts": `import { log } from "../shared/log";\nexport function query(sql: string) { log(sql); return sql; }\n`,
    "src/shared/log.ts": `export function log(s: string) { console.log(s); }\n`,
    "src/shared/types.ts": `export interface User { id: string }\n`,
    "src/web/page.test.tsx": `import { query } from "../db/client";\n`,
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
});
afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("parser", () => {
  it("reads static, type-only, dynamic, re-export and require imports", () => {
    const p = parseFile(
      "a.ts",
      `import a, { b as c } from "./x.js";\nimport type { T } from "./t";\nexport { f } from "./f";\nexport * from "./g";\nconst h = await import("./h");\nconst r = require("./r");\nimport "./side.css";`,
    );
    const by = Object.fromEntries(p.imports.map((i) => [i.spec, i]));
    expect(by["./x.js"].names).toEqual(["default", "b"]);
    expect(by["./x.js"].typeOnly).toBe(false);
    expect(by["./t"].typeOnly).toBe(true);
    expect(by["./f"].kind).toBe("reexport");
    expect(by["./g"].names).toEqual(["*"]);
    expect(by["./h"].kind).toBe("dynamic");
    expect(by["./r"].kind).toBe("require");
    expect(by["./side.css"]).toBeDefined();
  });

  it("reads the frontmatter of .astro components and the script of .vue files", () => {
    const astro = parseFile("Card.astro", `---\nimport Button from "./Button.astro";\nconst { title } = Astro.props;\n---\n<Button>{title}</Button>`);
    expect(astro.imports.map((i) => i.spec)).toEqual(["./Button.astro"]);
    const vue = parseFile("X.vue", `<template><div/></template>\n<script setup lang="ts">\nimport { ref } from "vue";\n</script>`);
    expect(vue.imports.map((i) => i.spec)).toEqual(["vue"]);
  });

  it("falls back to a regex pass when the file does not parse", () => {
    const p = parseFile("broken.ts", `import { a } from "./a";\nconst = ;;; {{{`);
    expect(p.imports.map((i) => i.spec)).toContain("./a");
  });
});

describe("resolver", () => {
  const files = new Set([
    "src/a.ts",
    "src/b/index.tsx",
    "src/c.mts",
    "packages/lib/src/index.ts",
    "packages/lib/src/sub/thing.ts",
    "packages/lib/package.json",
    "app/components/Button.tsx",
  ]);
  const r = new Resolver(
    files,
    [{ name: "@acme/lib", dir: "packages/lib", exports: { ".": "./dist/index.js", "./sub/*": "./dist/sub/*.js" } }],
    [{ dir: "app", baseUrl: "app", paths: { "@/*": ["./*"] } }],
  );
  it("maps .js specifiers to .ts sources and finds index files", () => {
    expect(r.resolve("src/x.ts", "./a.js")).toEqual({ kind: "file", path: "src/a.ts" });
    expect(r.resolve("src/x.ts", "./b")).toEqual({ kind: "file", path: "src/b/index.tsx" });
    expect(r.resolve("src/x.ts", "./c.mjs")).toEqual({ kind: "file", path: "src/c.mts" });
  });
  it("follows workspace package exports from dist back to src", () => {
    expect(r.resolve("src/x.ts", "@acme/lib")).toEqual({ kind: "file", path: "packages/lib/src/index.ts" });
    expect(r.resolve("src/x.ts", "@acme/lib/sub/thing")).toEqual({ kind: "file", path: "packages/lib/src/sub/thing.ts" });
  });
  it("applies tsconfig path aliases only inside their project", () => {
    expect(r.resolve("app/page.tsx", "@/components/Button")).toEqual({ kind: "file", path: "app/components/Button.tsx" });
    expect(r.resolve("src/x.ts", "@/components/Button")).toEqual({ kind: "external", pkg: "@/components" });
  });
  it("classifies builtins, packages and virtual modules", () => {
    expect(r.resolve("src/x.ts", "node:fs").kind).toBe("ignore");
    expect(r.resolve("src/x.ts", "react-dom/client")).toEqual({ kind: "external", pkg: "react-dom" });
    expect(r.resolve("src/x.ts", "astro:content")).toEqual({ kind: "external", pkg: "astro:content" });
  });
});

describe("config", () => {
  it("assigns each file to the most specific system", () => {
    const c = parseConfig(`systems:\n  - { id: pkg, paths: ["packages/app/**"] }\n  - { id: core, paths: ["packages/app/src/core/**"] }\n`);
    const a = new Assigner(c);
    expect(a.assign("packages/app/src/core/x.ts")).toEqual({ system: "core", module: "core/x" });
    expect(a.assign("packages/app/src/render/y.ts")).toEqual({ system: "pkg", module: "pkg/src" });
    expect(a.assign("other/z.ts").system).toBe("unmapped");
  });
  it("names modules after their folder when a system spans several folders", () => {
    const a = new Assigner(parseConfig(`version: 1
systems:
  - { id: app, name: App, paths: ["core/cache/**", "core/session/**", "core/request.ts"] }
  - { id: one, name: One, paths: ["lib/**"] }
`));
    expect(a.assign("core/cache/handler.ts").module).toBe("app/cache/handler");
    expect(a.assign("core/session/handler.ts").module).toBe("app/session/handler");
    expect(a.assign("core/request.ts").module).toBe("app/core/request");
    expect(a.assign("lib/util/x.ts").module).toBe("one/util");
  });

  it("rejects duplicate system ids", () => {
    expect(() => parseConfig(`systems:\n  - { id: a, paths: [a/**] }\n  - { id: a, paths: [b/**] }\n`)).toThrow(/duplicate/);
  });
});

describe("model and diff", () => {
  it("builds the system graph and ignores test files", async () => {
    const ws = Workspace.open(repo);
    const m = await ws.model("HEAD");
    expect(Object.keys(m.files)).not.toContain("src/web/page.test.tsx");
    const edges = aggregate(m, "system").map((e) => `${e.from}->${e.to}${e.typeOnly ? ":type" : ""}`);
    expect(edges.sort()).toEqual(["api->db", "db->shared", "web->api", "web->shared:type"]);
  });

  it("reports a new dependency and a crossed fault line in the working tree", async () => {
    write(repo, { "src/web/admin.tsx": `import { query } from "../db/client";\nexport const Admin = () => query("drop");\n` });
    const ws = Workspace.open(repo);
    const { delta, headModel } = await ws.diff("HEAD", undefined);
    expect(delta.files.added).toEqual(["src/web/admin.tsx"]);
    expect(delta.systemEdges.added.map((e) => `${e.from}->${e.to}`)).toEqual(["web->db"]);
    expect(delta.violations.introduced).toHaveLength(1);
    expect(delta.violations.introduced[0].evidence[0]).toMatchObject({ from: "src/web/admin.tsx", to: "src/db/client.ts", names: ["query"] });
    const f = findings(delta, ws.config);
    expect(f[0].severity).toBe("fault");
    expect(f[0].title).toBe("Crosses a fault line: Web UI → Database");
    expect(headline(delta, ws.config)).toMatch(/^1 fault line crossed/);
    const md = renderMarkdown(delta, headModel, ws.config);
    expect(md).toContain("```mermaid");
    expect(md).toContain("s_web ==> s_db");
    expect(md).toContain("<!-- faultline:pr-comment -->");
  });

  it("does not re-report a fault line that already existed at the base", async () => {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "admin page");
    write(repo, { "src/web/page.tsx": `import { getUser } from "../api/users.js";\nexport const Page = () => getUser() + "!";\n` });
    const ws = Workspace.open(repo);
    const { delta } = await ws.diff("HEAD", undefined);
    expect(delta.violations.introduced).toHaveLength(0);
    expect(delta.violations.existing).toHaveLength(1);
    expect(delta.files.modified).toEqual(["src/web/page.tsx"]);
    git(repo, "checkout", "--", ".");
  });

  it("finds new cycles between systems", async () => {
    write(repo, { "src/shared/format.ts": `import { getUser } from "../api/users";\nexport const f = () => getUser();\n` });
    const ws = Workspace.open(repo);
    const { delta } = await ws.diff("HEAD", undefined);
    expect(delta.cycles.added).toEqual([["api", "db", "shared"]]);
    fs.rmSync(path.join(repo, "src/shared/format.ts"));
  });

  it("builds a map state with fixed layout and evidence", async () => {
    const ws = Workspace.open(repo);
    const base = await ws.model("HEAD~1");
    const head = await ws.model("HEAD");
    const state = await buildState({
      root: repo,
      repo: "fixture",
      config: ws.config,
      mode: "static",
      models: [
        { meta: { id: "a", label: "a", kind: "base", ref: "a", time: 0 }, model: base },
        { meta: { id: "b", label: "b", kind: "commit", ref: "b", time: 1 }, model: head },
      ],
    });
    expect(Object.keys(state.layout.systems).sort()).toEqual(["api", "db", "shared", "web"]);
    expect(state.snapshots[1].vsPrev?.findings[0].severity).toBe("fault");
    expect(state.snapshots[1].vsPrev?.fileModule["src/web/admin.tsx"]).toBe("web/admin");
    expect(state.graph.paths).toContain("src/web/admin.tsx");
    // Layout is persisted and reused, so boxes never move between runs.
    const again = await buildState({ root: repo, repo: "fixture", config: ws.config, mode: "static", models: [{ meta: { id: "a", label: "a", kind: "base", ref: "a", time: 0 }, model: head }] });
    expect(again.layout).toEqual(state.layout);
  });

  it("finds cycles with Tarjan", () => {
    const e = (from: string, to: string) => ({ from, to, count: 1, typeOnly: false });
    expect(cycles([e("a", "b"), e("b", "c"), e("c", "a"), e("c", "d")])).toEqual([["a", "b", "c"]]);
    expect(cycles([{ ...e("a", "b"), typeOnly: true }, e("b", "a")])).toEqual([]);
  });
});

describe("footprint", () => {
  const model = (edges: [string, string, ("type" | "dynamic")?][], externals: { file: string; pkg: string; typeOnly?: boolean }[] = []) => {
    const paths = new Set(edges.flatMap(([a, b]) => [a, b]));
    return {
      ref: "x",
      label: "x",
      files: Object.fromEntries([...paths].map((p) => [p, { path: p, hash: p, system: p.split("/")[0], module: p }])),
      edges: edges.map(([from, to, k]) => ({ from, to, names: ["x"], typeOnly: k === "type", kind: k === "dynamic" ? ("dynamic" as const) : ("static" as const), confidence: "exact" as const })),
      externals,
    };
  };

  it("counts startup and on-demand files, skips type imports, and finds the cut that drops a package", () => {
    const m = model(
      [["a/entry.ts", "a/app.ts"], ["a/app.ts", "b/router.ts"], ["a/app.ts", "c/session.ts"], ["c/session.ts", "c/store.ts"], ["c/store.ts", "c/driver.ts"], ["b/router.ts", "b/types.ts", "type"], ["b/router.ts", "d/page.ts", "dynamic"], ["d/page.ts", "d/render.ts"]],
      [{ file: "c/store.ts", pkg: "unstorage" }, { file: "b/router.ts", pkg: "vite", typeOnly: true }],
    );
    const fp = footprint(m, "a/entry.ts");
    expect(fp.startup).toEqual(["a/app.ts", "a/entry.ts", "b/router.ts", "c/driver.ts", "c/session.ts", "c/store.ts"]);
    expect(fp.onDemand).toEqual(["d/page.ts", "d/render.ts"]);
    expect(fp.packages).toEqual(["unstorage"]);
    const cut = fp.cuts.find((c) => c.file === "c/session.ts");
    expect(cut).toMatchObject({ drops: 3, packages: ["unstorage"], importers: [{ file: "a/app.ts" }] });
  });

  it("computes immediate dominators through a diamond", () => {
    const succ: Record<string, string[]> = { e: ["a", "b"], a: ["c"], b: ["c"], c: ["d"], d: [] };
    const idom = dominators("e", (n) => succ[n]);
    expect(Object.fromEntries(idom)).toEqual({ e: "e", a: "e", b: "e", c: "e", d: "c" });
  });

  it("maps package exports from dist back to their source files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fl-entries-"));
    write(root, { "packages/web/package.json": JSON.stringify({ name: "web", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./app": "./dist/core/app.js", "./*": "./dist/*" }, bin: { webctl: "./dist/cli.js" } }) });
    const entries = detectEntries(root, ["packages/web/src/index.ts", "packages/web/src/core/app.ts", "packages/web/src/cli.ts", "cmd/tool/main.go"]);
    expect(entries).toEqual(expect.arrayContaining([
      { label: "web", path: "packages/web/src/index.ts" },
      { label: "web/app", path: "packages/web/src/core/app.ts" },
      { label: "webctl (bin)", path: "packages/web/src/cli.ts" },
      { label: "cmd/tool (main)", path: "cmd/tool/main.go" },
    ]));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("proposal", () => {
  it("splits big directories, groups sibling families and folds tiny ones", () => {
    const files: string[] = [];
    for (let i = 0; i < 60; i++) files.push(`packages/app/src/core/f${i}.ts`);
    for (let i = 0; i < 30; i++) files.push(`packages/app/src/runtime/r${i}.ts`);
    for (const p of ["css", "html", "pages", "routes"]) for (let i = 0; i < 5; i++) files.push(`packages/app/src/vite-plugin-${p}/i${i}.ts`);
    for (let i = 0; i < 25; i++) files.push(`packages/cli/src/c${i}.ts`);
    files.push("packages/app/src/tiny/one.ts");
    const systems = proposeHeuristic({ files, packageNames: new Map([["packages/cli", "@acme/cli"]]) }, 6);
    const byName = Object.fromEntries(systems.map((s) => [s.name, s.paths]));
    expect(Object.keys(byName).sort()).toEqual(["CLI", "Core", "Runtime", "Vite plugins"]);
    expect(byName["Core"]).toContain("packages/app/src/core/**");
    expect(byName["Vite plugins"]).toEqual(["packages/app/src/vite-plugin-*/**"]);
    // A package whose name only repeats its folder reads as the folder.
    expect(byName["CLI"]).toEqual(["packages/cli/**"]);
    expect(systems.some((s) => /misc/i.test(s.name))).toBe(false);
    const cfg = parseConfig(`systems: ${JSON.stringify(systems)}`);
    const a = new Assigner(cfg);
    expect(files.filter((f) => a.assign(f).system === "unmapped")).toEqual([]);
  });
});

describe("glob simplification", () => {
  it("collapses to a parent folder only when every file keeps its system and the box owns most of it", () => {
    const files = [
      ...["a", "b", "c", "d"].map((d) => `src/core/${d}/x.ts`),
      "src/core/build/y.ts",
      "src/core/build/z.ts",
      "src/web/w.ts",
      "src/api/q.ts",
    ];
    const systems = [
      { id: "core", name: "Core", paths: ["src/core/a/**", "src/core/b/**", "src/core/c/**", "src/core/d/**"] },
      { id: "build", name: "Build", paths: ["src/core/build/**"] },
      { id: "web", name: "Web", paths: ["src/web/**", "src/api/**", "src/other/**"] },
    ];
    const out = simplifyGlobs(systems, files, Assigner);
    expect(out[0].paths).toEqual(["src/core/**"]);
    expect(out[1].paths).toEqual(["src/core/build/**"]);
    // Web owns only 2 of the 8 files under src/, so it may not claim src/**.
    expect(out[2].paths).toEqual(["src/web/**", "src/api/**", "src/other/**"]);
  });
});

describe("cli", () => {
  it("fault check exits 1 on a crossed fault line and 0 otherwise", () => {
    const ok = spawnSync("node", [CLI, "check", "HEAD", "HEAD"], { cwd: repo, encoding: "utf8" });
    expect(ok.status).toBe(0);
    const bad = spawnSync("node", [CLI, "check", "HEAD~1", "HEAD"], { cwd: repo, encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("Crosses a fault line: Web UI → Database");
  });

  it("the Claude Code hook tells the agent when an edit crosses a fault line", () => {
    write(repo, { "src/web/reports.tsx": `import { query } from "../db/client";\nexport const R = () => query("x");\n` });
    git(repo, "rm", "-q", "src/web/admin.tsx");
    git(repo, "commit", "-q", "-m", "remove admin");
    const event = { hook_event_name: "PostToolUse", session_id: "t1", cwd: repo, tool_name: "Write" };
    const out = spawnSync("node", [CLI, "hook"], { cwd: repo, input: JSON.stringify(event), encoding: "utf8" });
    expect(out.status).toBe(0);
    const json = JSON.parse(out.stdout);
    expect(json.decision).toBe("block");
    expect(json.continueOnBlock).toBe(true);
    expect(json.reason).toContain("Web UI → Database is a declared fault line");
    // The same fault line is reported once per session, not on every edit.
    const again = spawnSync("node", [CLI, "hook"], { cwd: repo, input: JSON.stringify(event), encoding: "utf8" });
    expect(again.stdout).toBe("");
    fs.rmSync(path.join(repo, "src/web/reports.tsx"));
  });

  it("exports a self-contained HTML map", () => {
    const out = path.join(repo, "map.html");
    const r = spawnSync("node", [CLI, "export", "HEAD~2", "HEAD~1", "-o", out], { cwd: repo, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("window.__FAULTLINE_STATE__");
    expect(html).not.toMatch(/<script src=/);
    fs.rmSync(out);
  });
});
