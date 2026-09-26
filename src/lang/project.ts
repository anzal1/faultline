import path from "node:path/posix";
import type { ParsedFile, ParsedImport } from "../types.js";

/**
 * Everything a non-JS resolver needs about the snapshot: the file set, manifests, and indexes of what
 * each file declares. Built once per snapshot from parse results, so resolution is plain lookups.
 */
export interface Target {
  path: string;
  /** exact: the language's own rules name this file. inferred: matched by a declared type or name. */
  confidence: "exact" | "inferred";
  names?: string[];
}

export interface ProjectInput {
  paths: Set<string>;
  parsed: Map<string, ParsedFile>;
  manifests: Map<string, string>; // go.mod, Cargo.toml, pubspec.yaml, Package.swift contents by path
}

const dirOf = (p: string) => (path.dirname(p) === "." ? "" : path.dirname(p));
const join = (...parts: string[]) => path.normalize(parts.filter(Boolean).join("/")).replace(/^\.\//, "");
const stem = (p: string) => path.basename(p).replace(/\.[^.]+$/, "");

export class Project {
  private byLang = new Map<string, string[]>();
  private ns = new Map<string, Map<string, string[]>>(); // lang -> namespace -> files
  private types = new Map<string, Map<string, string[]>>(); // lang -> type name -> files
  private topLevel = new Map<string, string[]>(); // kotlin/scala "pkg.name" -> files
  private basenames = new Map<string, string[]>();
  private goMods: { module: string; dir: string }[] = [];
  private crates: { name: string; dir: string; src: string }[] = [];
  private dartPkgs: { name: string; dir: string }[] = [];
  private swiftTargets = new Map<string, string>(); // module name -> dir
  private pyRoots: string[] = [];
  private pyModules = new Map<string, string>(); // dotted module -> file

  constructor(private input: ProjectInput) {
    for (const p of input.paths) {
      const b = path.basename(p);
      if (!this.basenames.has(b)) this.basenames.set(b, []);
      this.basenames.get(b)!.push(p);
    }
    for (const [file, pf] of input.parsed) {
      const lang = pf.lang ?? "js";
      if (!this.byLang.has(lang)) this.byLang.set(lang, []);
      this.byLang.get(lang)!.push(file);
      for (const d of pf.declares ?? []) push(this.ns, lang, d, file);
      for (const t of pf.types ?? []) push(this.types, lang, t, file);
      if (lang === "jvm") for (const n of pf.exports ?? []) {
        const k = `${pf.declares?.[0] ?? ""}.${n}`;
        if (!this.topLevel.has(k)) this.topLevel.set(k, []);
        this.topLevel.get(k)!.push(file);
      }
    }
    this.readManifests();
    this.indexPython();
  }

  private readManifests() {
    for (const [p, text] of this.input.manifests) {
      const dir = dirOf(p);
      const base = path.basename(p);
      if (base === "go.mod") {
        const m = /^\s*module\s+(\S+)/m.exec(text);
        if (m) this.goMods.push({ module: m[1], dir });
      } else if (base === "Cargo.toml") {
        const section = (h: string) => new RegExp(`^\\[${h}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m").exec(text)?.[1] ?? "";
        const pkg = /^\s*name\s*=\s*"([^"]+)"/m.exec(section("package"));
        const lib = /^\s*name\s*=\s*"([^"]+)"/m.exec(section("lib"));
        const name = (lib?.[1] ?? pkg?.[1])?.replace(/-/g, "_");
        if (name) this.crates.push({ name, dir, src: join(dir, "src") });
      } else if (base === "pubspec.yaml") {
        const m = /^name:\s*(\S+)/m.exec(text);
        if (m) this.dartPkgs.push({ name: m[1], dir });
      } else if (base === "Package.swift") {
        for (const m of text.matchAll(/\.(?:target|executableTarget|macro)\s*\(\s*name:\s*"([^"]+)"(?:[^)]*?path:\s*"([^"]+)")?/gs)) {
          this.swiftTargets.set(m[1], join(dir, m[2] ?? `Sources/${m[1]}`));
        }
      }
    }
    this.goMods.sort((a, b) => b.module.length - a.module.length);
    // Xcode projects without Package.swift: a top-level folder per module is the usual layout.
    if (this.swiftTargets.size === 0) {
      for (const f of this.byLang.get("swift") ?? []) {
        const top = f.split("/")[0];
        if (f.includes("/") && !this.swiftTargets.has(top)) this.swiftTargets.set(top, top);
      }
    }
  }

  /** A Python file's import root is the first ancestor that is not a package (has no __init__.py). */
  private indexPython() {
    const files = this.byLang.get("python") ?? [];
    const roots = new Set<string>(["", "src", "lib"]);
    for (const f of files) {
      let dir = dirOf(f);
      while (dir && this.input.paths.has(join(dir, "__init__.py"))) dir = dirOf(dir);
      roots.add(dir);
    }
    this.pyRoots = [...roots].sort((a, b) => b.length - a.length);
    for (const f of files) {
      for (const root of this.pyRoots) {
        if (root && !f.startsWith(root + "/")) continue;
        const rel = root ? f.slice(root.length + 1) : f;
        let mod = rel.replace(/\.pyi?$/, "").replace(/\//g, ".");
        if (mod.endsWith(".__init__")) mod = mod.slice(0, -9);
        else if (mod === "__init__") continue;
        if (!this.pyModules.has(mod)) this.pyModules.set(mod, f);
      }
    }
  }

  /** Resolve one import of `file`. Empty result with external set means a third-party dependency. */
  resolve(file: string, pf: ParsedFile, imp: ParsedImport): { targets: Target[]; external?: string } {
    switch (pf.lang) {
      case "python":
        return this.python(file, imp);
      case "go":
        return this.go(imp);
      case "rust":
        return this.rust(file, imp);
      case "jvm":
        return this.jvm(file, imp);
      case "csharp":
        return { targets: [] }; // namespaces only set visibility; references resolve the files
      case "msbuild":
        return this.relative(file, imp.spec, "exact");
      case "c":
        return this.cInclude(file, imp.spec);
      case "ruby":
        return this.ruby(file, imp.spec);
      case "php":
        return this.php(file, imp);
      case "swift":
        return { targets: [], external: this.swiftTargets.has(imp.spec.slice(4)) ? undefined : imp.spec.slice(4) };
      case "dart":
        return this.dart(file, imp.spec);
      case "lua":
        return this.lua(imp.spec);
      case "haskell":
        return this.nsLookup("haskell", imp.spec.slice(4));
      case "zig":
        return imp.spec.endsWith(".zig") ? this.relative(file, imp.spec, "exact") : { targets: [], external: imp.spec };
      default:
        return { targets: [] };
    }
  }

  /**
   * Type-reference edges for languages where files do not import files (C#, Swift, same-package
   * Java/Kotlin, PHP, Ruby autoloading, Elixir). Only names declared somewhere in the repo count.
   */
  references(file: string, pf: ParsedFile): Target[] {
    const lang = pf.lang ?? "";
    const refs = pf.refs ?? [];
    if (!refs.length) return [];
    const out: Target[] = [];
    if (lang === "rust") {
      // A path rooted at another workspace crate's name is an exact dependency on that crate.
      const mine = this.crateOf(file)?.name;
      for (const r of refs) {
        if (r === mine) continue;
        const c = this.crates.find((x) => x.name === r);
        const root = c ? this.crateRoot(c) : null;
        if (root) out.push({ path: root, confidence: "exact", names: [] });
      }
      return dedupe(out);
    }
    if (lang === "elixir") {
      for (const r of refs) {
        const hit = this.nsLookup("elixir", r).targets.length ? this.nsLookup("elixir", r) : this.nsLookup("elixir", r.split(".").slice(0, -1).join("."));
        for (const t of hit.targets) if (t.path !== file) out.push({ path: t.path, confidence: "exact", names: [r] });
      }
      return dedupe(out);
    }
    const index = this.types.get(lang);
    if (!index) return [];
    if (lang === "ruby") return this.rubyRefs(file, pf, index);
    const visible = this.visibleNamespaces(file, pf);
    const platform = PLATFORM_NAMES[lang];
    for (const r of refs) {
      if (platform?.has(r)) continue;
      const name = r;
      const decl = index.get(name);
      if (!decl) continue;
      let candidates = decl.filter((d) => d !== file);
      if (!candidates.length) continue;
      if (visible) {
        const scoped = candidates.filter((d) => visible.has(this.input.parsed.get(d)?.declares?.[0] ?? ""));
        if (scoped.length) candidates = scoped;
        else if (lang === "jvm" || lang === "php") continue; // other packages need an import, which we resolved exactly
      }
      // Ambiguous names (declared in many places) are skipped rather than guessed.
      if (candidates.length > 3) continue;
      if (candidates.length > 1) {
        const near = nearest(file, candidates);
        candidates = [near];
      }
      out.push({ path: candidates[0], confidence: "inferred", names: [name] });
    }
    return dedupe(out);
  }

  /**
   * Ruby looks constants up through the lexical scopes of the reference: inside Jekyll::Document,
   * `File` means Jekyll::Document::File, then Jekyll::File, then ::File. We follow the same chain and
   * only link a constant this repo declares on it.
   */
  private rubyRefs(file: string, pf: ParsedFile, index: Map<string, string[]>): Target[] {
    const scopes = [...(pf.declares ?? [])].sort((a, b) => b.split("::").length - a.split("::").length);
    const chains = new Set<string>();
    for (const sc of scopes) {
      const parts = sc.split("::");
      for (let i = parts.length; i > 0; i--) chains.add(parts.slice(0, i).join("::"));
    }
    const order = [...chains].sort((a, b) => b.split("::").length - a.split("::").length);
    const out: Target[] = [];
    for (const raw of pf.refs ?? []) {
      const r = raw.replace(/^::/, "");
      const tries = raw.startsWith("::") ? [r] : [...order.map((sc) => `${sc}::${r}`), r];
      for (const t of tries) {
        // A module on this file's own scope chain, or one reopened across many files, is a namespace, not a dependency.
        if (chains.has(t) || (index.get(t)?.length ?? 0) > 2) break;
        const files = index.get(t)?.filter((f) => f !== file);
        if (files?.length) {
          out.push({ path: nearest(file, files), confidence: "inferred", names: [t] });
          break;
        }
        if (index.has(t)) break; // declared in this very file
      }
    }
    return dedupe(out);
  }

  private visibleNamespaces(file: string, pf: ParsedFile): Set<string> | null {
    const lang = pf.lang;
    if (lang === "csharp") {
      const v = new Set<string>();
      for (const d of pf.declares ?? []) {
        const parts = d.split(".");
        for (let i = 1; i <= parts.length; i++) v.add(parts.slice(0, i).join("."));
      }
      for (const i of pf.imports) if (i.spec.startsWith("ns:")) v.add(i.spec.slice(3));
      return v.size ? v : null;
    }
    if (lang === "jvm") {
      const v = new Set<string>([pf.declares?.[0] ?? ""]);
      for (const i of pf.imports) if (i.spec.endsWith(".*")) v.add(i.spec.slice(0, -2));
      return v;
    }
    if (lang === "php") return new Set<string>([pf.declares?.[0] ?? ""]);
    return null;
  }

  // ---------- per-language resolution ----------

  private python(file: string, imp: ParsedImport): { targets: Target[]; external?: string } {
    let mod = imp.spec;
    if (mod.startsWith(".")) {
      const dots = /^\.+/.exec(mod)![0].length;
      let pkgDir = dirOf(file);
      for (let i = 1; i < dots; i++) pkgDir = dirOf(pkgDir);
      const rest = mod.slice(dots);
      const root = this.pyRoots.find((r) => !r || pkgDir === r || pkgDir.startsWith(r + "/")) ?? "";
      const pkgMod = (root ? pkgDir.slice(root.length).replace(/^\//, "") : pkgDir).replace(/\//g, ".");
      mod = [pkgMod, rest].filter(Boolean).join(".");
    }
    const targets: Target[] = [];
    // `from pkg import sub` may name a submodule; prefer it when it exists.
    for (const n of imp.names) {
      if (n === "*") continue;
      const sub = this.pyModules.get(mod ? `${mod}.${n}` : n);
      if (sub) targets.push({ path: sub, confidence: "exact", names: [n] });
    }
    if (targets.length < imp.names.filter((n) => n !== "*").length || imp.names.length === 0) {
      const parts = mod.split(".");
      for (let k = parts.length; k > 0; k--) {
        const hit = this.pyModules.get(parts.slice(0, k).join("."));
        if (hit) {
          targets.push({ path: hit, confidence: "exact", names: imp.names.filter((n) => !targets.some((t) => t.names?.includes(n))) });
          break;
        }
      }
    }
    if (targets.length) return { targets: dedupe(targets).filter((t) => t.path !== file) };
    return { targets: [], external: mod.split(".")[0] || undefined };
  }

  private go(imp: ParsedImport): { targets: Target[]; external?: string } {
    const spec = imp.spec;
    for (const m of this.goMods) {
      if (spec !== m.module && !spec.startsWith(m.module + "/")) continue;
      const dir = join(m.dir, spec.slice(m.module.length).replace(/^\//, ""));
      const files = (this.byLang.get("go") ?? []).filter((f) => dirOf(f) === dir).sort();
      // A Go import names a package, which is a directory. The directory is the exact target.
      if (files.length) return { targets: [{ path: files.find((f) => !f.endsWith("_test.go")) ?? files[0], confidence: "exact" }] };
      return { targets: [] };
    }
    if (!spec.includes(".") ) return { targets: [] }; // standard library
    return { targets: [], external: spec.split("/").slice(0, 3).join("/") };
  }

  private rustModuleDir(file: string): string {
    const b = path.basename(file);
    if (b === "mod.rs" || b === "lib.rs" || b === "main.rs") return dirOf(file);
    return join(dirOf(file), stem(file));
  }

  private rustFind(base: string, segs: string[]): string | null {
    for (let k = segs.length; k > 0; k--) {
      const p = join(base, ...segs.slice(0, k));
      for (const cand of [`${p}.rs`, `${p}/mod.rs`]) if (this.input.paths.has(cand)) return cand;
    }
    return null;
  }

  private crateOf(file: string) {
    return this.crates.filter((c) => file.startsWith(c.dir ? c.dir + "/" : "")).sort((a, b) => b.dir.length - a.dir.length)[0];
  }

  private crateRoot(c: { src: string }): string | null {
    for (const r of ["lib.rs", "main.rs"]) if (this.input.paths.has(join(c.src, r))) return join(c.src, r);
    return null;
  }

  private rust(file: string, imp: ParsedImport): { targets: Target[]; external?: string } {
    if (imp.spec.startsWith("mod:")) {
      const hit = this.rustFind(this.rustModuleDir(file), [imp.spec.slice(4)]);
      return { targets: hit ? [{ path: hit, confidence: "exact" }] : [] };
    }
    const segs = imp.spec.slice(4).split("::").filter((s) => s && s !== "*");
    if (!segs.length) return { targets: [] };
    const crate = this.crateOf(file);
    const one = (p: string | null) => ({ targets: p && p !== file ? [{ path: p, confidence: "exact" as const, names: imp.names }] : [] });
    if (segs[0] === "crate" && crate) return one(this.rustFind(crate.src, segs.slice(1)) ?? this.crateRoot(crate));
    if (segs[0] === "self") return one(this.rustFind(this.rustModuleDir(file), segs.slice(1)));
    if (segs[0] === "super") {
      // For src/a/b.rs (crate::a::b), super is crate::a, whose children live in src/a.
      let i = 0;
      let modDir = this.rustModuleDir(file);
      while (segs[i] === "super") {
        modDir = dirOf(modDir);
        i++;
      }
      const rest = segs.slice(i);
      return one(rest.length ? this.rustFind(modDir, rest) : null);
    }
    if (["std", "core", "alloc"].includes(segs[0])) return { targets: [] };
    // 2018 edition: a bare path can name a child module of the current module.
    const child = this.rustFind(this.rustModuleDir(file), segs);
    if (child && segs.length) return one(child);
    const other = this.crates.find((c) => c.name === segs[0]);
    if (other) return one(this.rustFind(other.src, segs.slice(1)) ?? this.crateRoot(other));
    return { targets: [], external: segs[0] };
  }

  private jvm(file: string, imp: ParsedImport): { targets: Target[]; external?: string } {
    const spec = imp.spec;
    if (spec.endsWith(".*")) {
      // Wildcard: which files are used is decided by the references pass.
      const known = this.ns.get("jvm")?.has(spec.slice(0, -2));
      return { targets: [], external: known ? undefined : spec.split(".").slice(0, 2).join(".") };
    }
    const segs = spec.split(".");
    const pkgs = this.ns.get("jvm");
    for (let k = segs.length - 1; k > 0; k--) {
      const pkg = segs.slice(0, k).join(".");
      const files = pkgs?.get(pkg);
      if (!files) continue;
      const cls = segs[k];
      const byName = files.filter((f) => stem(f) === cls);
      if (byName.length) return { targets: [{ path: nearest(file, byName), confidence: "exact", names: [segs[segs.length - 1]] }] };
      const declared = files.filter((f) => this.input.parsed.get(f)?.types?.includes(cls));
      if (declared.length) return { targets: [{ path: nearest(file, declared), confidence: "exact", names: [cls] }] };
      const top = this.topLevel.get(`${pkg}.${cls}`);
      if (top?.length) return { targets: [{ path: nearest(file, top), confidence: "exact", names: [cls] }] };
      return { targets: [] };
    }
    return { targets: [], external: segs.slice(0, 2).join(".") };
  }

  private nsLookup(lang: string, name: string): { targets: Target[]; external?: string } {
    const files = this.ns.get(lang)?.get(name);
    if (files?.length) return { targets: files.map((f) => ({ path: f, confidence: "exact" as const })) };
    return { targets: [], external: name.split(".")[0] };
  }

  private relative(file: string, spec: string, confidence: Target["confidence"]): { targets: Target[] } {
    const p = join(dirOf(file), spec);
    return { targets: this.input.paths.has(p) ? [{ path: p, confidence }] : [] };
  }

  private suffix(file: string, spec: string): string | null {
    const cands = (this.basenames.get(path.basename(spec)) ?? []).filter((p) => p === spec || p.endsWith("/" + spec));
    if (!cands.length) return null;
    return nearest(file, cands);
  }

  private cInclude(file: string, raw: string): { targets: Target[]; external?: string } {
    const system = raw.startsWith("sys:");
    const spec = system ? raw.slice(4) : raw;
    if (!system) {
      const rel = join(dirOf(file), spec);
      if (this.input.paths.has(rel)) return { targets: [{ path: rel, confidence: "exact" }] };
    }
    const hit = this.suffix(file, spec);
    if (hit) return { targets: [{ path: hit, confidence: system ? "inferred" : "exact" }] };
    return { targets: [] };
  }

  private ruby(file: string, spec: string): { targets: Target[]; external?: string } {
    const withExt = spec.endsWith(".rb") ? spec : `${spec}.rb`;
    if (spec.startsWith("./")) return this.relative(file, withExt.slice(2), "exact");
    const hit = this.suffix(file, withExt);
    if (hit) return { targets: [{ path: hit, confidence: "exact" }] };
    return { targets: [], external: spec.split("/")[0] };
  }

  private php(file: string, imp: ParsedImport): { targets: Target[]; external?: string } {
    if (imp.kind === "require") return this.relative(file, imp.spec.slice(2), "exact");
    const segs = imp.spec.split("\\");
    const cls = segs.pop()!;
    const nsName = segs.join("\\");
    const files = this.ns.get("php")?.get(nsName);
    if (files) {
      const hit = files.filter((f) => stem(f) === cls || this.input.parsed.get(f)?.types?.includes(cls));
      if (hit.length) return { targets: [{ path: nearest(file, hit), confidence: "exact", names: [cls] }] };
    }
    const asNs = this.ns.get("php")?.get(imp.spec);
    if (asNs?.length) return { targets: [] };
    return { targets: [], external: segs[0] };
  }

  private dart(file: string, spec: string): { targets: Target[]; external?: string } {
    if (spec.startsWith("dart:")) return { targets: [] };
    const m = /^package:([^/]+)\/(.+)$/.exec(spec);
    if (m) {
      const pkg = this.dartPkgs.find((p) => p.name === m[1]);
      if (!pkg) return { targets: [], external: m[1] };
      const p = join(pkg.dir, "lib", m[2]);
      return { targets: this.input.paths.has(p) ? [{ path: p, confidence: "exact" }] : [] };
    }
    return this.relative(file, spec, "exact");
  }

  private lua(spec: string): { targets: Target[]; external?: string } {
    const rel = spec.replace(/\./g, "/");
    for (const cand of [`${rel}.lua`, `${rel}/init.lua`, `lua/${rel}.lua`, `lua/${rel}/init.lua`]) {
      const hit = [...this.input.paths].find((p) => p === cand || p.endsWith("/" + cand));
      if (hit) return { targets: [{ path: hit, confidence: "exact" }] };
    }
    return { targets: [], external: spec.split(".")[0] };
  }
}

function push(map: Map<string, Map<string, string[]>>, lang: string, key: string, file: string) {
  if (!map.has(lang)) map.set(lang, new Map());
  const m = map.get(lang)!;
  if (!m.has(key)) m.set(key, []);
  m.get(key)!.push(file);
}

function dedupe(ts: Target[]): Target[] {
  const seen = new Map<string, Target>();
  for (const t of ts) {
    const cur = seen.get(t.path);
    if (!cur) seen.set(t.path, { ...t, names: [...(t.names ?? [])] });
    else {
      cur.names = [...new Set([...(cur.names ?? []), ...(t.names ?? [])])];
      if (t.confidence === "exact") cur.confidence = "exact";
    }
  }
  return [...seen.values()];
}

/** The candidate that shares the longest directory prefix with the importing file. */
export function nearest(file: string, cands: string[]): string {
  let best = cands[0];
  let bestScore = -1;
  const a = file.split("/");
  for (const c of cands) {
    const b = c.split("/");
    let i = 0;
    while (i < a.length - 1 && i < b.length - 1 && a[i] === b[i]) i++;
    if (i > bestScore || (i === bestScore && c < best)) {
      best = c;
      bestScore = i;
    }
  }
  return best;
}

/** Platform type names an app often shadows; an inferred edge on these would usually be wrong. */
const PLATFORM_NAMES: Record<string, Set<string>> = {
  swift: new Set("String Int Double Float Bool Array Dictionary Set Error Result Task Date Data URL UUID View Text Button Image List Color Font Binding State Environment Timer Notification Array Optional Never Any Void Character Section Label Toggle Picker Form Group Stack Spacer Divider Menu Link Path Shape Animation Transaction Scene App Window Logger Duration Clock".split(" ")),
  csharp: new Set("String Task List Dictionary HashSet Exception Console File Path Guid DateTime DateTimeOffset TimeSpan Action Func Type Attribute Stream Uri HttpClient Encoding Math Convert Enum Array Object Nullable Environment Thread Timer Random Regex Process Directory Json JsonSerializer ILogger CancellationToken IServiceCollection IConfiguration Assembly Activity Result".split(" ")),
  jvm: new Set("String List Map Set Object Exception RuntimeException File Path Optional Stream Duration Instant LocalDate LocalDateTime Context Log Logger Thread Runnable Integer Long Boolean Double Float Character Byte Short Math System Class Iterable Iterator Collection Collections Arrays Objects UUID Random Pattern Matcher Unit Any Nothing Pair Triple Result Array Sequence Flow Job Builder Test Override Deprecated".split(" ")),
  php: new Set("Exception Closure Throwable DateTime DateTimeImmutable DateTimeInterface ArrayObject Iterator IteratorAggregate Countable Stringable Traversable Generator JsonSerializable ArrayAccess RuntimeException InvalidArgumentException LogicException".split(" ")),
};

export const MANIFEST_NAMES = new Set(["go.mod", "Cargo.toml", "pubspec.yaml", "Package.swift"]);
