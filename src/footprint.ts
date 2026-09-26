import fs from "node:fs";
import path from "node:path/posix";
import type { Model } from "./types.js";

/** A file something outside the repo starts from: a package export, a bin, a main. */
export interface Entry {
  label: string;
  path: string;
}

export interface Cut {
  /** Stop loading this file at startup... */
  file: string;
  /** ...by changing these imports of it (the only ones on the startup path)... */
  importers: { file: string; names: string[] }[];
  /** ...and this many files, this file included, no longer load. */
  drops: number;
  /** npm packages that leave the startup path with it. */
  packages: string[];
}

export interface Footprint {
  entry: string;
  /** Files loaded at startup: static, non-type imports from the entry. */
  startup: string[];
  /** Files reachable only through a dynamic import(): loaded on demand. */
  onDemand: string[];
  bySystem: Record<string, { startup: number; onDemand: number; total: number }>;
  /** npm packages imported at runtime by startup files. */
  packages: string[];
  cuts: Cut[];
}

const SRC_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Entry files declared by the repo's manifests. For JS packages, published paths like
 * dist/core/app.js are mapped back to the source file that builds them.
 */
export function detectEntries(root: string, files: Iterable<string>): Entry[] {
  const all = new Set(files);
  const out: Entry[] = [];
  const seen = new Set<string>();
  const push = (label: string, p: string | undefined) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push({ label, path: p });
  };
  for (const f of all) {
    const base = path.basename(f);
    const dir = path.dirname(f) === "." ? "" : path.dirname(f);
    if (base === "main.rs" || base === "lib.rs") push(`${dir || "."} (${base.slice(0, -3)})`, f);
    else if (base === "main.go") push(`${dir || "."} (main)`, f);
    else if (base === "__main__.py") push(`python -m ${dir.replace(/\//g, ".")}`, f);
  }
  const manifests = [...listPackageJsons(root)].sort((a, b) => a.length - b.length);
  for (const rel of manifests) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    } catch {
      continue;
    }
    const dir = path.dirname(rel) === "." ? "" : path.dirname(rel);
    const name = typeof pkg.name === "string" ? pkg.name : dir || "root";
    const toSource = (p: string) => sourceFor(dir, p, all);
    const exp = pkg.exports;
    if (typeof exp === "string") push(name, toSource(exp));
    else if (exp && typeof exp === "object") {
      for (const [k, v] of Object.entries(exp as Record<string, unknown>)) {
        if (!k.startsWith(".")) {
          // Conditions at the top level: { import, require, default }.
          push(name, toSource(firstTarget(exp) ?? ""));
          break;
        }
        if (k.includes("*")) continue;
        const target = firstTarget(v);
        if (target) push(k === "." ? name : `${name}/${k.replace(/^\.\//, "")}`, toSource(target));
      }
    }
    for (const field of ["module", "main"]) if (typeof pkg[field] === "string") push(name, toSource(pkg[field] as string));
    const bin = pkg.bin;
    if (typeof bin === "string") push(`${name} (bin)`, toSource(bin));
    else if (bin && typeof bin === "object") for (const [k, v] of Object.entries(bin as Record<string, unknown>)) if (typeof v === "string") push(`${k} (bin)`, toSource(v));
  }
  return out;
}

function listPackageJsons(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === "package.json") out.push(rel ? `${rel}/package.json` : "package.json");
      else if (e.isDirectory() && depth < 4 && !/^(node_modules|\.|dist|build|coverage|test|tests|fixtures|examples?)/.test(e.name)) walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

/** The first file path in an exports value, preferring the runtime conditions over "types". */
function firstTarget(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = firstTarget(x);
      if (t) return t;
    }
    return undefined;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["node", "import", "default", "require", "browser"]) if (k in o) {
      const t = firstTarget(o[k]);
      if (t) return t;
    }
    for (const [k, x] of Object.entries(o)) if (k !== "types") {
      const t = firstTarget(x);
      if (t) return t;
    }
  }
  return undefined;
}

/** dist/core/app.js -> src/core/app.ts, when that file exists. */
function sourceFor(dir: string, p: string, files: Set<string>): string | undefined {
  const rel = path.normalize(path.join(dir, p));
  if (files.has(rel)) return rel;
  const stem = rel.replace(/\.(d\.)?[cm]?[jt]sx?$/, "");
  const inner = dir ? stem.slice(dir.length + 1) : stem;
  const candidates = [stem, ...["src", "lib", "source"].map((s) => path.join(dir, inner.replace(/^(dist|build|lib|out|esm|cjs)\//, `${s}/`)))];
  for (const c of candidates) for (const ext of SRC_EXT) if (files.has(c + ext)) return c + ext;
  for (const c of candidates) for (const ext of SRC_EXT) if (files.has(`${c}/index${ext}`)) return `${c}/index${ext}`;
  return undefined;
}

/** What loads when `entry` is imported: at startup, on demand, and where the cheapest cuts are. */
export function footprint(model: Model, entry: string): Footprint {
  const startupOut = new Map<string, { to: string; names: string[] }[]>();
  const lazyOut = new Map<string, string[]>();
  for (const e of model.edges) {
    if (e.typeOnly) continue;
    if (e.kind === "dynamic") (lazyOut.get(e.from) ?? lazyOut.set(e.from, []).get(e.from)!).push(e.to);
    else (startupOut.get(e.from) ?? startupOut.set(e.from, []).get(e.from)!).push({ to: e.to, names: e.names });
  }
  const reach = (starts: string[], skip: Set<string>) => {
    const seen = new Set<string>();
    const stack = [...starts];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f) || skip.has(f)) continue;
      seen.add(f);
      for (const x of startupOut.get(f) ?? []) stack.push(x.to);
    }
    return seen;
  };
  const startup = reach([entry], new Set());
  const lazyStarts = [...startup].flatMap((f) => lazyOut.get(f) ?? []);
  const later = new Set<string>();
  for (let frontier = lazyStarts; frontier.length; ) {
    const got = reach(frontier, startup);
    const next: string[] = [];
    for (const f of got) if (!later.has(f)) {
      later.add(f);
      next.push(...(lazyOut.get(f) ?? []).filter((t) => !startup.has(t) && !later.has(t)));
    }
    frontier = next;
  }

  const bySystem: Footprint["bySystem"] = {};
  for (const f of Object.values(model.files)) {
    if (f.hash === "package") continue;
    const s = (bySystem[f.system] ??= { startup: 0, onDemand: 0, total: 0 });
    s.total++;
    if (startup.has(f.path)) s.startup++;
    else if (later.has(f.path)) s.onDemand++;
  }
  const runtimePkgs = new Map<string, Set<string>>();
  for (const u of model.externals) {
    if (u.typeOnly || u.dynamic || !startup.has(u.file) || u.pkg.startsWith("virtual:")) continue;
    (runtimePkgs.get(u.pkg) ?? runtimePkgs.set(u.pkg, new Set()).get(u.pkg)!).add(u.file);
  }

  // Cut points come from the dominator tree: file d dominates f when every startup path to f
  // passes through d, so no longer importing d drops d's whole subtree.
  const order = [...startup];
  const idom = dominators(entry, (f) => (startupOut.get(f) ?? []).map((x) => x.to).filter((t) => startup.has(t)));
  const children = new Map<string, string[]>();
  for (const [f, d] of idom) if (f !== entry) (children.get(d) ?? children.set(d, []).get(d)!).push(f);
  const subtree = new Map<string, string[]>();
  const collect = (f: string): string[] => {
    const hit = subtree.get(f);
    if (hit) return hit;
    const all = [f];
    const stack = [...(children.get(f) ?? [])];
    while (stack.length) {
      const x = stack.pop()!;
      all.push(x);
      stack.push(...(children.get(x) ?? []));
    }
    subtree.set(f, all);
    return all;
  };
  const importersOf = new Map<string, { file: string; names: string[] }[]>();
  for (const f of startup) for (const x of startupOut.get(f) ?? []) if (startup.has(x.to)) (importersOf.get(x.to) ?? importersOf.set(x.to, []).get(x.to)!).push({ file: f, names: x.names });
  const candidates = order
    .filter((f) => f !== entry)
    .map((f) => ({ f, drops: collect(f) }))
    // The trunk (App, the request handler) is not a cut anyone would make.
    .filter((c) => c.drops.length >= 2 && c.drops.length <= startup.size * 0.5)
    .sort((a, b) => b.drops.length - a.drops.length);
  const cuts: Cut[] = [];
  const covered = new Set<string>();
  for (const c of candidates) {
    if (covered.has(c.f)) continue;
    for (const x of c.drops) covered.add(x);
    const dropped = new Set(c.drops);
    const packages = [...runtimePkgs].filter(([, users]) => [...users].every((u) => dropped.has(u))).map(([p]) => p).sort();
    cuts.push({ file: c.f, importers: importersOf.get(c.f) ?? [], drops: c.drops.length, packages });
    if (cuts.length >= 12) break;
  }
  return {
    entry,
    startup: [...startup].sort(),
    onDemand: [...later].sort(),
    bySystem,
    packages: [...runtimePkgs.keys()].sort(),
    cuts,
  };
}

/** Immediate dominators (Cooper, Harvey and Kennedy's iterative algorithm). */
export function dominators(entry: string, succ: (n: string) => string[]): Map<string, string> {
  const rpo: string[] = [];
  const visited = new Set<string>([entry]);
  const stack: [string, number][] = [[entry, 0]];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const next = succ(top[0]);
    if (top[1] < next.length) {
      const n = next[top[1]++];
      if (!visited.has(n)) {
        visited.add(n);
        stack.push([n, 0]);
      }
    } else {
      rpo.push(top[0]);
      stack.pop();
    }
  }
  rpo.reverse();
  const index = new Map(rpo.map((n, i) => [n, i]));
  const preds = new Map<string, string[]>();
  for (const n of rpo) for (const s of succ(n)) if (index.has(s)) (preds.get(s) ?? preds.set(s, []).get(s)!).push(n);
  const idom = new Map<string, string>([[entry, entry]]);
  const intersect = (a: string, b: string) => {
    while (a !== b) {
      while (index.get(a)! > index.get(b)!) a = idom.get(a)!;
      while (index.get(b)! > index.get(a)!) b = idom.get(b)!;
    }
    return a;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of rpo) {
      if (n === entry) continue;
      let d: string | undefined;
      for (const p of preds.get(n) ?? []) if (idom.has(p)) d = d === undefined ? p : intersect(p, d);
      if (d !== undefined && idom.get(n) !== d) {
        idom.set(n, d);
        changed = true;
      }
    }
  }
  return idom;
}

/** A shortest startup import chain from the entry to a file, for "why does this load?". */
export function chainTo(model: Model, entry: string, target: string): string[] {
  const out = new Map<string, string[]>();
  for (const e of model.edges) if (!e.typeOnly && e.kind !== "dynamic") (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  const prev = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift()!;
    if (f === target) break;
    for (const t of out.get(f) ?? []) if (!prev.has(t)) {
      prev.set(t, f);
      queue.push(t);
    }
  }
  if (!prev.has(target)) return [];
  const chain: string[] = [];
  for (let c: string | null = target; c; c = prev.get(c) ?? null) chain.unshift(c);
  return chain;
}
