import path from "node:path/posix";
import { Assigner, isSourceFile } from "./config.js";
import { MANIFEST_NAMES, Project } from "./lang/project.js";
import { ParseCache, parseFile } from "./parse.js";
import { parseJsonc, Resolver, type PathAlias, type WorkspacePackage } from "./resolve.js";
import { blobHash, type Source, WORKTREE } from "./source.js";
import type { AggEdge, Config, ExternalUse, FileEdge, FileInfo, Model, ParsedFile } from "./types.js";

const NOISE_DIRS = /(^|\/)(node_modules|\.git)\//;

export async function buildModel(source: Source, config: Config, cache: ParseCache): Promise<Model> {
  const assigner = new Assigner(config);
  const listing = await source.list();
  const allPaths = new Set<string>();
  for (const p of listing.keys()) if (!NOISE_DIRS.test(p)) allPaths.add(p);

  const pkgFiles = [...allPaths].filter((p) => p === "package.json" || p.endsWith("/package.json"));
  const tsconfigFiles = [...allPaths].filter((p) => /(^|\/)(tsconfig|jsconfig)(\.[\w-]+)?\.json$/.test(p));
  const manifestFiles = [...allPaths].filter((p) => MANIFEST_NAMES.has(p.slice(p.lastIndexOf("/") + 1)) && !assigner.ignored(p));
  const meta = await source.read([...pkgFiles, ...tsconfigFiles, ...manifestFiles]);

  const packages: WorkspacePackage[] = [];
  for (const p of pkgFiles) {
    try {
      const json = JSON.parse(meta.get(p) ?? "{}");
      if (typeof json.name === "string") {
        packages.push({ name: json.name, dir: path.dirname(p) === "." ? "" : path.dirname(p), exports: json.exports, main: json.main, module: json.module, types: json.types });
      }
    } catch {
      // malformed package.json: skip
    }
  }
  const aliases = readAliases(tsconfigFiles, meta);

  const sourceFiles = [...allPaths].filter((p) => isSourceFile(p) && !assigner.ignored(p));
  const parsed = new Map<string, { hash: string; pf: ParsedFile }>();
  const toRead: string[] = [];
  for (const p of sourceFiles) {
    const sha = listing.get(p)!;
    const cached = source.ref !== WORKTREE ? cache.get(sha) : undefined; // git refs and the index carry blob hashes
    if (cached) parsed.set(p, { hash: sha, pf: cached });
    else toRead.push(p);
  }
  const contents = await source.read(toRead);
  for (const [p, content] of contents) {
    const hash = blobHash(content);
    let result = cache.get(hash);
    if (!result) {
      result = parseFile(p, content);
      cache.set(hash, result);
    }
    parsed.set(p, { hash, pf: result });
  }

  const resolver = new Resolver(allPaths, packages, aliases);
  const files: Record<string, FileInfo> = {};
  const edges: FileEdge[] = [];
  const externals: ExternalUse[] = [];
  const seenExternal = new Map<string, ExternalUse>();

  for (const [p, { hash }] of parsed) {
    const { system, module } = assigner.assign(p);
    files[p] = { path: p, hash, system, module };
  }
  const project = new Project({
    paths: allPaths,
    parsed: new Map([...parsed].map(([p, v]) => [p, v.pf])),
    manifests: new Map(manifestFiles.map((p) => [p, meta.get(p) ?? ""])),
  });
  const addExternal = (file: string, pkg: string, typeOnly: boolean, kind: string) => {
    const key = `${file}\0${pkg}`;
    const dynamic = kind === "dynamic";
    const seen = seenExternal.get(key);
    if (seen) {
      if (!typeOnly) delete seen.typeOnly;
      if (!dynamic) delete seen.dynamic;
      return;
    }
    const use: ExternalUse = { file, pkg, ...(typeOnly ? { typeOnly } : {}), ...(dynamic ? { dynamic } : {}) };
    seenExternal.set(key, use);
    externals.push(use);
  };
  for (const [p, { pf }] of parsed) {
    const merged = new Map<string, FileEdge>();
    const add = (target: string, names: string[], typeOnly: boolean, kind: FileEdge["kind"], confidence: "exact" | "inferred") => {
      if (target === p) return;
      if (!files[target]) {
        // Edges into ignored files (tests, fixtures) are not architecture. Workspace package roots are.
        if (!target.endsWith("package.json") || assigner.ignored(target)) return;
        const { system, module } = assigner.assign(target);
        files[target] = { path: target, hash: "package", system, module };
      }
      const existing = merged.get(target);
      if (existing) {
        existing.names = [...new Set([...existing.names, ...names])];
        existing.typeOnly = existing.typeOnly && typeOnly;
        if (confidence === "exact") existing.confidence = "exact";
      } else merged.set(target, { from: p, to: target, names: [...names], typeOnly, kind, confidence });
    };
    if (!pf.lang) {
      for (const imp of pf.imports) {
        const r = resolver.resolve(p, imp.spec);
        if (r.kind === "external") addExternal(p, r.pkg, imp.typeOnly, imp.kind);
        else if (r.kind === "file") add(r.path, imp.names, imp.typeOnly, imp.kind, "exact");
      }
    } else {
      for (const imp of pf.imports) {
        const r = project.resolve(p, pf, imp);
        if (r.external) addExternal(p, r.external, imp.typeOnly, imp.kind);
        for (const t of r.targets) add(t.path, t.names ?? imp.names, imp.typeOnly, imp.kind, t.confidence);
      }
      for (const t of project.references(p, pf)) {
        if (!merged.has(t.path)) add(t.path, t.names ?? [], false, "reference", t.confidence);
        else {
          const e = merged.get(t.path)!;
          e.names = [...new Set([...e.names, ...(t.names ?? [])])];
        }
      }
    }
    edges.push(...merged.values());
  }
  cache.save();
  return { ref: source.ref, label: source.label, files, edges, externals };
}

function readAliases(tsconfigFiles: string[], meta: Map<string, string>): PathAlias[] {
  const parsedConfigs = new Map<string, Record<string, any>>();
  for (const p of tsconfigFiles) {
    try {
      parsedConfigs.set(p, parseJsonc(meta.get(p) ?? "{}") as Record<string, any>);
    } catch {
      // ignore unparseable tsconfig
    }
  }
  const aliases: PathAlias[] = [];
  for (const [p, json] of parsedConfigs) {
    const dir = path.dirname(p) === "." ? "" : path.dirname(p);
    let opts = json.compilerOptions ?? {};
    let optsDir = dir;
    if (!opts.paths && typeof json.extends === "string" && json.extends.startsWith(".")) {
      const parentPath = path.normalize(path.join(dir, json.extends.endsWith(".json") ? json.extends : `${json.extends}.json`));
      const parent = parsedConfigs.get(parentPath);
      if (parent?.compilerOptions?.paths) {
        opts = parent.compilerOptions;
        optsDir = path.dirname(parentPath) === "." ? "" : path.dirname(parentPath);
      }
    }
    if (!opts.paths) continue;
    aliases.push({ dir, baseUrl: path.normalize(path.join(optsDir, opts.baseUrl ?? ".")), paths: opts.paths });
  }
  return aliases;
}

/** Collapses file edges into system-level or module-level edges. */
export function aggregate(model: Model, level: "system" | "module"): AggEdge[] {
  const out = new Map<string, AggEdge>();
  for (const e of model.edges) {
    const a = model.files[e.from]?.[level];
    const b = model.files[e.to]?.[level];
    if (!a || !b || a === b) continue;
    const key = `${a}\0${b}`;
    const agg = out.get(key);
    if (agg) {
      agg.count++;
      agg.typeOnly = agg.typeOnly && e.typeOnly;
    } else out.set(key, { from: a, to: b, count: 1, typeOnly: e.typeOnly });
  }
  return [...out.values()].sort((x, y) => y.count - x.count);
}

export function evidenceFor(model: Model, level: "system" | "module", from: string, to: string): FileEdge[] {
  return model.edges.filter((e) => model.files[e.from]?.[level] === from && model.files[e.to]?.[level] === to);
}

/** Strongly connected components with more than one node: the dependency cycles between systems. */
export function cycles(edges: AggEdge[], includeTypeOnly = false): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.typeOnly && !includeTypeOnly) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
    if (!adj.has(e.to)) adj.set(e.to, []);
  }
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const out: string[][] = [];
  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const v of [...adj.keys()].sort()) if (!idx.has(v)) strong(v);
  return out;
}
