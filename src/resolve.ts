import path from "node:path/posix";
import { builtinModules } from "node:module";

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const TRY_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".astro", ".vue", ".svelte", ".json"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

export interface WorkspacePackage {
  name: string;
  dir: string; // repo-relative, no trailing slash ("" for root)
  exports?: unknown;
  main?: string;
  module?: string;
  types?: string;
}

export interface PathAlias {
  dir: string; // directory the tsconfig lives in
  baseUrl: string; // repo-relative
  paths: Record<string, string[]>;
}

export type Resolution =
  | { kind: "file"; path: string }
  | { kind: "external"; pkg: string }
  | { kind: "ignore" };

export class Resolver {
  private packages = new Map<string, WorkspacePackage>();
  private aliases: PathAlias[];

  constructor(private files: Set<string>, packages: WorkspacePackage[], aliases: PathAlias[]) {
    for (const p of packages) this.packages.set(p.name, p);
    // Most specific tsconfig first.
    this.aliases = [...aliases].sort((a, b) => b.dir.length - a.dir.length);
  }

  resolve(importer: string, rawSpec: string): Resolution {
    const spec = rawSpec.split("?")[0].split("#")[0];
    if (!spec || BUILTINS.has(spec) || spec.startsWith("data:") || /^https?:/.test(spec)) return { kind: "ignore" };
    if (spec.startsWith(".") || spec.startsWith("/")) {
      const base = spec.startsWith("/") ? spec.slice(1) : path.join(path.dirname(importer), spec);
      const hit = this.tryFile(path.normalize(base));
      return hit ? { kind: "file", path: hit } : { kind: "ignore" };
    }
    const aliased = this.tryAlias(importer, spec);
    if (aliased) return { kind: "file", path: aliased };
    // Vite-style virtual modules ("virtual:foo", "astro:content") read as externals.
    if (/^[a-z][\w-]*:/.test(spec)) return { kind: "external", pkg: spec };
    const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    const ws = this.packages.get(pkgName);
    if (ws) {
      const sub = spec.slice(pkgName.length).replace(/^\//, "");
      return { kind: "file", path: this.resolvePackage(ws, sub) };
    }
    return { kind: "external", pkg: pkgName };
  }

  private tryFile(base: string): string | null {
    if (this.files.has(base)) return base;
    const ext = path.extname(base);
    if (JS_TO_TS[ext]) {
      const stem = base.slice(0, -ext.length);
      for (const e of JS_TO_TS[ext]) if (this.files.has(stem + e)) return stem + e;
    }
    for (const e of TRY_EXT) if (this.files.has(base + e)) return base + e;
    for (const e of TRY_EXT) if (this.files.has(`${base}/index${e}`)) return `${base}/index${e}`;
    return null;
  }

  private tryAlias(importer: string, spec: string): string | null {
    for (const alias of this.aliases) {
      if (alias.dir && !importer.startsWith(alias.dir + "/")) continue;
      for (const [pattern, targets] of Object.entries(alias.paths)) {
        const star = pattern.indexOf("*");
        let captured: string | null = null;
        if (star < 0) {
          if (spec === pattern) captured = "";
        } else {
          const pre = pattern.slice(0, star);
          const post = pattern.slice(star + 1);
          if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) {
            captured = spec.slice(pre.length, spec.length - post.length);
          }
        }
        if (captured === null) continue;
        for (const target of targets) {
          const hit = this.tryFile(path.normalize(path.join(alias.baseUrl, target.replace("*", captured))));
          if (hit) return hit;
        }
      }
      if (alias.dir) break; // only the nearest tsconfig with paths applies
    }
    return null;
  }

  /** Maps a workspace package import to a source file, following exports and dist -> src conventions. */
  private resolvePackage(pkg: WorkspacePackage, sub: string): string {
    const join = (p: string) => path.normalize(pkg.dir ? `${pkg.dir}/${p}` : p);
    const candidates: string[] = [];
    const target = exportTarget(pkg.exports, sub ? `./${sub}` : ".");
    if (target) candidates.push(target);
    if (!sub) candidates.push(...[pkg.module, pkg.main, pkg.types].filter((x): x is string => !!x), "src/index", "index");
    else candidates.push(sub, `src/${sub}`);
    for (const c of candidates) {
      const rel = c.replace(/^\.\//, "");
      for (const variant of [rel, rel.replace(/^dist\//, "src/"), rel.replace(/^(dist|lib|build)\//, "")]) {
        const hit = this.tryFile(join(variant.replace(/\.d\.ts$/, "")));
        if (hit) return hit;
      }
    }
    // Unresolvable subpath: attribute the edge to the package itself.
    return join("package.json");
  }
}

function exportTarget(exports: unknown, key: string): string | null {
  if (!exports) return null;
  if (typeof exports === "string") return key === "." ? exports : null;
  if (typeof exports !== "object") return null;
  const map = exports as Record<string, unknown>;
  const isSubpathMap = Object.keys(map).some((k) => k.startsWith("."));
  if (!isSubpathMap) return key === "." ? pickCondition(map) : null;
  if (key in map) return pickCondition(map[key]);
  for (const [k, v] of Object.entries(map)) {
    const star = k.indexOf("*");
    if (star < 0) continue;
    const pre = k.slice(0, star);
    const post = k.slice(star + 1);
    if (key.startsWith(pre) && key.endsWith(post)) {
      const t = pickCondition(v);
      if (t) return t.replace("*", key.slice(pre.length, key.length - post.length));
    }
  }
  return null;
}

function pickCondition(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(pickCondition).find(Boolean) ?? null;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const cond of ["source", "development", "import", "module", "default", "require", "node", "types"]) {
      if (cond in o) {
        const t = pickCondition(o[cond]);
        if (t) return t;
      }
    }
  }
  return null;
}

/** Strips comments and trailing commas so tsconfig.json can go through JSON.parse. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
