import picomatch from "picomatch";
import { DEFAULT_IGNORE, isSourceFile } from "./config.js";
import type { Source } from "./source.js";
import type { Config, SystemDef } from "./types.js";

interface Dir {
  path: string; // "" for root
  name: string;
  files: number; // direct source files
  total: number;
  children: Map<string, Dir>;
}

export interface ProposeInput {
  files: string[];
  packageNames: Map<string, string>; // dir -> package name
  /** File-level imports [from, to], used to merge folders that belong together. */
  edges?: [string, string][];
}

export async function collectProposeInput(source: Source, ignore = DEFAULT_IGNORE): Promise<ProposeInput> {
  const listing = await source.list();
  const ignored = picomatch(ignore, { dot: true });
  const files = [...listing.keys()].filter((p) => isSourceFile(p) && !ignored(p) && !p.includes("node_modules/"));
  const manifest = /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|setup\.py|pom\.xml|build\.gradle(\.kts)?|composer\.json|pubspec\.yaml|mix\.exs|Package\.swift|[^/]+\.(csproj|fsproj|vbproj|gemspec))$/;
  const pkgPaths = [...listing.keys()].filter((p) => manifest.test(p) && !p.includes("node_modules/") && !ignored(p));
  const contents = await source.read(pkgPaths);
  const packageNames = new Map<string, string>();
  for (const [p, text] of contents) {
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    const file = p.slice(p.lastIndexOf("/") + 1);
    let name: string | undefined;
    try {
      if (file === "package.json" || file === "composer.json") name = JSON.parse(text).name;
      else if (file === "Cargo.toml") name = /\[package\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1];
      else if (file === "go.mod") name = /^\s*module\s+(\S+)/m.exec(text)?.[1]?.split("/").pop();
      else if (file === "pyproject.toml") name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
      else if (file === "pubspec.yaml") name = /^name:\s*(\S+)/m.exec(text)?.[1];
      else if (file === "pom.xml") name = /<artifactId>([^<]+)<\/artifactId>/.exec(text.replace(/<parent>[\s\S]*?<\/parent>/, ""))?.[1];
      else if (/\.(csproj|fsproj|vbproj|gemspec)$/.test(file)) name = file.replace(/\.[^.]+$/, "");
      else name = dir.split("/").pop() || undefined; // build.gradle, setup.py, mix.exs, Package.swift: the folder names it
    } catch {
      name = undefined;
    }
    // The repo root is not a package for proposal purposes: it would name everything after the repo.
    if (name && dir && !packageNames.has(dir)) packageNames.set(dir, name);
  }
  return { files, packageNames };
}

function buildTree(files: string[]): Dir {
  const root: Dir = { path: "", name: "", files: 0, total: 0, children: new Map() };
  for (const f of files) {
    const parts = f.split("/");
    let node = root;
    node.total++;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.children.get(parts[i]);
      if (!child) {
        child = { path: parts.slice(0, i + 1).join("/"), name: parts[i], files: 0, total: 0, children: new Map() };
        node.children.set(parts[i], child);
      }
      child.total++;
      node = child;
    }
    node.files++;
  }
  return root;
}

interface Candidate {
  dirs: Dir[]; // one dir, or a family of siblings grouped together
  rootFilesOf?: Dir; // this candidate is just the loose files directly inside a dir
  label?: string;
}

const size = (c: Candidate) => (c.rootFilesOf ? c.rootFilesOf.files : c.dirs.reduce((n, d) => n + d.total, 0));
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function defaultTarget(fileCount: number): number {
  return Math.max(4, Math.min(14, Math.round(Math.sqrt(fileCount) / 2.2)));
}

/** Folder names that group code without saying what it does. Their leftovers are never kept as a box. */
const CONTAINERS = new Set(["src", "lib", "source", "sources", "main", "app", "pkg", "internal", "packages", "apps", "crates", "modules", "libs", "services", "cmd", "projects", "components", "java", "kotlin", "scala", "com", "org", "net", "io"]);

/** Globs the last proposal chose to leave out (isolated top-level config files). */
export let lastLeftOut: string[] = [];

interface Box {
  lead: Candidate;
  more: Candidate[]; // pieces that joined this box
  name?: string; // set when the box is the named remainder of a folder
  id?: string;
  shelf?: string; // folder whose small unconnected pieces this box collects
}

/**
 * Drafts systems from the directory tree and the import graph.
 *
 * The largest box is split again and again, within a budget of `target` boxes. When a folder has
 * more children than the budget allows, its largest children become systems and the rest either
 * stay together as the folder itself (the rest of core/ is "Core") or, for container folders like
 * src/ and packages/, join the kept sibling they trade the most imports with. Packages with their own
 * manifest keep their own box. Nothing is ever a grab-bag named "misc".
 */
export function proposeHeuristic(input: ProposeInput, target = defaultTarget(input.files.length)): SystemDef[] {
  const root = buildTree(input.files);
  const total = root.total || 1;
  const files = input.files;
  const neighbours = new Map<string, Set<string>>();
  for (const [a, b] of input.edges ?? []) {
    if (a === b) continue;
    (neighbours.get(a) ?? neighbours.set(a, new Set()).get(a)!).add(b);
    (neighbours.get(b) ?? neighbours.set(b, new Set()).get(b)!).add(a);
  }
  const inPiece = (c: Candidate, f: string) => (c.rootFilesOf ? dirOf(f) === c.rootFilesOf.path : c.dirs.some((d) => d.path === "" || f.startsWith(d.path + "/")));
  const filesOf = (b: Box) => files.filter((f) => inPiece(b.lead, f) || b.more.some((m) => inPiece(m, f)));
  const weight = (b: Box) => size(b.lead) + b.more.reduce((s, m) => s + size(m), 0);
  const isPackage = (c: Candidate) => !c.rootFilesOf && c.dirs.length === 1 && input.packageNames.has(c.dirs[0].path);
  const tiny = total >= 40 ? Math.max(3, total * 0.012) : 1;
  const keepable = total >= 40 ? Math.max(tiny, total * 0.02) : 1;
  // A piece earns its own box at a split when it is at least about half a fair share of the map.
  const fairShare = total / Math.max(1, target);
  // Relative to the box being split, so a big folder deep in the tree can still be opened up.
  const worthABox = (p: Candidate, parentSize: number) =>
    size(p) >= Math.max(keepable, total >= 40 ? Math.min(fairShare * 0.45, parentSize * 0.1) : 1) || (isPackage(p) && size(p) >= keepable);
  const packageRoom = Math.max(target + 4, Math.round(target * 1.5));
  const done = new Set<Box>();
  const splittable = (b: Box) => !done.has(b) && !b.name && !b.lead.rootFilesOf && b.lead.dirs.length === 1 && b.lead.dirs[0].children.size > 0;

  // Association, not raw volume: edges between the two, discounted by how connected each is overall,
  // so a hub every folder imports (common/, utils/) does not swallow the map.
  const degree = (fs: Iterable<string>) => {
    let d = 0;
    for (const f of fs) d += neighbours.get(f)?.size ?? 0;
    return d;
  };
  const affinity = (piece: Candidate, box: Box, boxFiles: Set<string>) => {
    let s = 0;
    const mine = files.filter((f) => inPiece(piece, f));
    for (const f of mine) for (const n of neighbours.get(f) ?? []) if (boxFiles.has(n)) s++;
    if (!s) return 0;
    return (s * s) / ((degree(mine) || 1) * (degree(boxFiles) || 1));
  };

  let boxes: Box[] = [{ lead: { dirs: [root] }, more: [] }];
  // Only real boxes spend the budget; the labelled shelves of small pieces do not.
  const counted = () => boxes.filter((b) => !b.shelf && weight(b) >= keepable).length;
  // Leftovers of container folders wait here and are placed once, when the final boxes are known.
  const pending: Candidate[] = [];
  for (let guard = 0; guard < 400; guard++) {
    const next = boxes.filter(splittable).sort((a, b) => weight(b) - weight(a))[0];
    if (!next) break;
    // Stop once every box is a reasonable share of the repo.
    if (weight(next) < total * (1.4 / target) && boxes.length >= Math.min(target, 3)) break;
    const dir = next.lead.dirs[0];
    const pieces = splitDir(dir).filter((p) => size(p) > 0).sort((a, b) => size(b) - size(a));
    if (pieces.length === 1 && !pieces[0].rootFilesOf) {
      next.lead = pieces[0]; // walk down through a lone src/ or lib/
      continue;
    }
    const room = target - counted() + 1;
    const big = pieces.filter((p) => worthABox(p, weight(next)));
    if (room < 2) break;
    if (big.length < 2) {
      // One dominant child plus crumbs: descend into it, keeping the crumbs in this box.
      if (big.length === 1 && size(big[0]) >= 0.75 * size(next.lead) && !big[0].rootFilesOf) {
        next.more.push(...pieces.filter((p) => p !== big[0]));
        next.lead = big[0];
      } else done.add(next);
      continue;
    }
    // Loose files at the top of a named folder are that folder: they stay in its own box.
    const namedDir = !CONTAINERS.has(dir.name) && dir.path !== "";
    const eligible = big.filter((p) => !(namedDir && p.rootFilesOf));
    const kept = eligible.slice(0, room);
    // Real packages keep their own box past the budget, up to a larger allowance: their boundaries were declared on purpose.
    for (const p of eligible.slice(room)) if (isPackage(p) && counted() + kept.length < packageRoom) kept.push(p);
    const rest = pieces.filter((p) => !kept.includes(p));
    const fresh: Box[] = kept.map((p) => ({ lead: p, more: [] }));
    const restSize = rest.reduce((s, p) => s + size(p), 0);
    const named = namedDir && restSize >= keepable && (rest.length > 1 || !!rest[0]?.rootFilesOf);
    if (named) {
      // The leftovers are the folder itself: core/ minus its big children is still "Core".
      fresh.push({ lead: rest[0], more: rest.slice(1), name: input.packageNames.get(dir.path) ?? humanize(dir.name), id: dir.name });
    } else {
      for (const p of rest) {
        // A real package with no ties to its siblings keeps its own box.
        if (isPackage(p) && size(p) >= Math.max(5, tiny) && !files.some((f) => inPiece(p, f) && [...(neighbours.get(f) ?? [])].some((n) => !inPiece(p, n)))) {
          fresh.push({ lead: p, more: [] });
        } else pending.push(p);
      }
    }
    if (next.more.length) pending.push(...next.more);
    boxes = boxes.filter((b) => b !== next).concat(fresh);
  }

  // Budget left over: give the largest attached pieces their own boxes (Astro's content/, for instance).
  const promote = () => {
    for (;;) {
      if (target - counted() < 1) return;
      let bestBox: Box | undefined;
      let bestPiece: Candidate | undefined;
      for (const b of boxes) for (const m of b.more) if (!m.rootFilesOf && size(m) >= keepable && (!bestPiece || size(m) > size(bestPiece))) {
        bestBox = b;
        bestPiece = m;
      }
      if (!bestBox || !bestPiece) return;
      bestBox.more = bestBox.more.filter((m) => m !== bestPiece);
      boxes.push({ lead: bestPiece, more: [] });
    }
  };
  // Budget left over, or one box still holding more than a fifth of the repo: take the biggest parts
  // out of named remainders (Core's largest folders), a little past the budget if need be.
  for (;;) {
    const heaviest = Math.max(...boxes.map(weight));
    const room = target - counted();
    if (room < 1 && !(heaviest > total * 0.22 && counted() < target + 3)) break;
    const rem = boxes.filter((b) => b.name && !b.shelf && b.more.length).sort((a, b) => weight(b) - weight(a))[0];
    if (!rem) break;
    const parts = [rem.lead, ...rem.more].sort((a, b) => Number(!!a.rootFilesOf) - Number(!!b.rootFilesOf) || size(b) - size(a));
    const top = parts[0];
    if (top.rootFilesOf) break;
    if (size(top) < keepable || weight(rem) - size(top) < keepable) break;
    rem.lead = parts.find((p) => p.rootFilesOf) ?? parts[1];
    rem.more = parts.slice(1).filter((p) => p !== rem.lead);
    boxes.push({ lead: top, more: [] });
  }
  // Place leftovers: first where their imports go, preferring boxes in the same part of the tree.
  const boxFiles = boxes.map((b) => new Set(filesOf(b)));
  const anchorOf = (c: Candidate) => (c.rootFilesOf ? c.rootFilesOf.path : dirOf(c.dirs[0].path));
  const leadDir = (b: Box) => (b.lead.rootFilesOf ? b.lead.rootFilesOf.path : b.lead.dirs[0].path);
  const shared = (a: string, b: string) => {
    const x = a.split("/"), y = b.split("/");
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i] && x[i] !== "") i++;
    return i;
  };
  const leftOut: string[] = [];
  for (const p of pending.sort((a, b) => size(b) - size(a))) {
    const scores = boxes.map((b, i) => affinity(p, b, boxFiles[i]));
    const near = boxes.map((b) => shared(anchorOf(p), leadDir(b)));
    const maxNear = Math.max(...near.filter((_, i) => scores[i] > 0), -1);
    let best = -1;
    let bestScore = 0;
    scores.forEach((sc, i) => {
      const s2 = sc * (near[i] === maxNear ? 1.5 : 1);
      if (s2 > bestScore) {
        bestScore = s2;
        best = i;
      }
    });
    if (best < 0) {
      // No imports either way. Loose files at the top level are config, not architecture.
      if (p.rootFilesOf && p.rootFilesOf.path === "") {
        leftOut.push("*");
        continue;
      }
      if (size(p) >= keepable) {
        boxes.push({ lead: p, more: [] });
        boxFiles.push(new Set(filesOf(boxes[boxes.length - 1])));
        continue;
      }
      // Anything that is not a package sits next to its nearest box by path.
      if (!isPackage(p)) {
        const deepest = Math.max(...near);
        const at = near.indexOf(deepest);
        boxes[at].more.push(p);
        for (const f of files) if (inPiece(p, f)) boxFiles[at].add(f);
        continue;
      }
      // Small and unconnected: one clearly labelled box per folder, never folded into an unrelated system.
      const home = anchorOf(p);
      let shelf = boxes.find((b) => b.shelf === home);
      if (!shelf) {
        const homeName = home.split("/").pop() || "root";
        shelf = { lead: p, more: [], name: CONTAINERS.has(homeName) || !homeName ? `Small ${homeName === "packages" || isPackage(p) ? "packages" : "folders"}` : `${humanize(homeName)} (other)`, id: `${homeName}-small`, shelf: home };
        boxes.push(shelf);
        boxFiles.push(new Set(filesOf(shelf)));
      } else {
        shelf.more.push(p);
        for (const f of files) if (inPiece(p, f)) boxFiles[boxes.indexOf(shelf)].add(f);
      }
      continue;
    }
    boxes[best].more.push(p);
    for (const f of files) if (inPiece(p, f)) boxFiles[best].add(f);
  }
  promote();
  lastLeftOut = leftOut;

  const used = new Set<string>();
  const uniqueId = (raw: string) => {
    const base = slug(raw) || "root";
    let id = base;
    let i = 2;
    while (used.has(id)) id = `${base}-${i++}`;
    used.add(id);
    return id;
  };
  return boxes
    .filter((b) => weight(b) > 0)
    .sort((a, b) => weight(b) - weight(a))
    .map((b) => {
      const lead = b.name ? { id: uniqueId(b.id ?? b.name), name: b.name } : toSystem(b.lead, input, uniqueId);
      const parts = b.name ? [b.lead, ...b.more] : b.more;
      const extra = parts.map((c) => shortName(c, input)).filter((x, i, a) => x && a.indexOf(x) === i);
      return {
        id: lead.id,
        name: lead.name,
        ...(extra.length ? { description: `${b.name ? "Covers" : "Also covers"} ${extra.slice(0, 6).join(", ")}${extra.length > 6 ? ` and ${extra.length - 6} more` : ""}.` } : {}),
        paths: collapsePaths([b.lead, ...b.more].flatMap((c) => candidatePaths(c))),
      };
    });
}

function shortName(c: Candidate, input: ProposeInput): string {
  if (c.rootFilesOf) return c.rootFilesOf.path ? `${c.rootFilesOf.name} entry files` : "root files";
  if (c.label) return familyName(c.label.replace(/[-_]\*$/, ""), c.dirs.length);
  const d = c.dirs[0];
  return input.packageNames.get(d.path) ?? (GENERIC.has(d.name) ? d.path.split("/").slice(-2, -1)[0] ?? d.name : d.name);
}

/** a/b/** plus a/b/* is just a/b/**; keep globs sorted and free of duplicates. */
function collapsePaths(paths: string[]): string[] {
  const set = [...new Set(paths)];
  const deep = set.filter((p) => p.endsWith("/**")).map((p) => p.slice(0, -3));
  return set
    .filter((p) => !(p.endsWith("/*") && !p.endsWith("/**") && deep.includes(p.slice(0, -2))))
    .filter((p) => !deep.some((d) => p !== `${d}/**` && p.startsWith(d + "/")))
    .sort();
}

/** Directories that are rarely part of the product's architecture. Proposed as ignored; easy to undo. */
export const PROPOSE_SKIP = ["examples", "example", "benchmark", "benchmarks", "bench", "scripts", "docs", "website", ".github", ".agents", ".changeset", ".vscode", "playground", "playgrounds", "demo", "demos", "sandbox"];

/** Top-level folders that hold tests, samples or docs rather than the product (regression-test, docs_src). */
const NON_PRODUCT = /(^|[-_.])(tests?|testing|e2e|benchmarks?|bench|samples?|examples?|fixtures|demos?|docs?|playgrounds?|sandbox)([-_.]|$)/i;

export function skipGlobs(files: string[]): string[] {
  const hits = new Set<string>();
  for (const f of files) {
    if (!f.includes("/")) continue;
    const top = f.split("/")[0];
    if (PROPOSE_SKIP.includes(top) || NON_PRODUCT.test(top)) hits.add(`${top}/**`);
  }
  return [...hits].sort();
}

function splitDir(dir: Dir): Candidate[] {
  const out: Candidate[] = [];
  const children = [...dir.children.values()];
  const families = new Map<string, Dir[]>();
  for (const c of children) {
    const m = /^([a-z0-9]+)[-_]/i.exec(c.name);
    const key = m ? m[1] : "";
    if (!key) continue;
    if (!families.has(key)) families.set(key, []);
    families.get(key)!.push(c);
  }
  const inFamily = new Set<Dir>();
  for (const members of families.values()) {
    if (members.length < 3) continue;
    members.forEach((m) => inFamily.add(m));
    out.push({ dirs: members, label: `${familyPrefix(members.map((m) => m.name))}*` });
  }
  for (const c of children) if (!inFamily.has(c)) out.push({ dirs: [c] });
  if (dir.files > 0) out.push({ dirs: [dir], rootFilesOf: dir });
  return out;
}

/** "vite-plugin-astro", "vite-plugin-css" -> "vite-plugin-" */
function familyPrefix(names: string[]): string {
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const cut = prefix.lastIndexOf("-") >= 0 ? prefix.lastIndexOf("-") : prefix.lastIndexOf("_");
  return prefix.slice(0, cut + 1);
}

function candidatePaths(c: Candidate): string[] {
  if (c.rootFilesOf) return [c.rootFilesOf.path ? `${c.rootFilesOf.path}/*` : "*"];
  if (c.label) return [`${c.dirs[0].path.split("/").slice(0, -1).concat(c.label).join("/")}/**`];
  return c.dirs.map((d) => (d.path ? `${d.path}/**` : "**"));
}

function toSystem(c: Candidate, input: ProposeInput, uniqueId: (raw: string) => string): SystemDef {
  const paths = candidatePaths(c);
  if (c.rootFilesOf) {
    const d = c.rootFilesOf;
    const name = displayName(d.path, d.name, input) ?? (d.path ? humanize(d.name) : "Root");
    return { id: uniqueId(d.name || "root"), name, paths };
  }
  if (c.label) {
    const key = c.label.replace(/[-_]\*$/, "");
    return { id: uniqueId(`${key}s`), name: familyName(key, c.dirs.length), paths };
  }
  const d = c.dirs[0];
  const plainName = GENERIC.has(d.name) ? d.path.split("/").slice(-2, -1)[0] ?? d.name : d.name;
  const pkgDir = input.packageNames.has(d.path) ? d.path : GENERIC.has(d.name) ? ancestorDir(d.path, input) : undefined;
  const name = (pkgDir !== undefined ? displayName(pkgDir, plainName, input) : undefined) ?? humanize(plainName);
  return { id: uniqueId(slug(name) || plainName), name, paths };
}

/** A package name that only repeats its folder (@astrojs/cloudflare in cloudflare/) reads as the folder: "Cloudflare". */
function displayName(dirPath: string, dirName: string, input: ProposeInput): string | undefined {
  const pkg = input.packageNames.get(dirPath);
  if (!pkg) return undefined;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const last = pkg.split("/").pop()!;
  return norm(last) === norm(dirName) || norm(pkg) === norm(dirName) ? humanize(dirName) : pkg;
}

function ancestorDir(p: string, input: ProposeInput): string | undefined {
  const parts = p.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const dir = parts.slice(0, i).join("/");
    if (input.packageNames.has(dir)) return dir;
  }
  return undefined;
}

/** Words that read naturally in the plural: vite-plugin-* is "Vite plugins". Others keep the pattern: "tokio-* (6)". */
const PLURAL_OK = new Set(["plugin", "adapter", "integration", "provider", "service", "extension", "component", "loader", "handler", "driver", "module", "package", "crate", "tool", "helper", "util", "reader", "writer", "renderer", "transformer", "middleware", "hook", "worker", "client", "server", "connector", "binding", "codec", "parser", "command", "controller", "model", "view", "route", "store", "feature"]);

function familyName(key: string, count: number): string {
  const last = key.split(/[-_]/).pop()!.toLowerCase();
  if (PLURAL_OK.has(last)) return `${humanize(key)}s`;
  return `${key}-* (${count})`;
}

/** Folder names that say nothing about what is inside: name the system after its parent instead. */
const GENERIC = new Set(["src", "lib", "source", "sources", "main", "pkg"]);

function ancestorPackage(p: string, input: ProposeInput): string | undefined {
  const parts = p.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const name = input.packageNames.get(parts.slice(0, i).join("/"));
    if (name) return name;
  }
  return undefined;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const ACRONYMS = new Set(["cli", "api", "ui", "db", "sdk", "css", "jsx", "html", "i18n", "ssr", "rpc", "http", "sql", "io", "vm", "ast", "mdx"]);

function humanize(s: string): string {
  const words = s.replace(/[-_]+/g, " ").trim().split(" ").map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w));
  const out = words.join(" ");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Directory outline with file counts, the shape an LLM needs to name systems well. */
export function outline(files: string[], maxLines = 400): string {
  const root = buildTree(files);
  const lines: string[] = [];
  const visit = (d: Dir, depth: number) => {
    const kids = [...d.children.values()].sort((a, b) => b.total - a.total);
    for (const k of kids) {
      if (lines.length >= maxLines) return;
      lines.push(`${"  ".repeat(depth)}${k.name}/ (${k.total} files${k.files ? `, ${k.files} direct` : ""})`);
      if (depth < 5 && k.total >= 4) visit(k, depth + 1);
    }
  };
  visit(root, 0);
  return lines.join("\n");
}

export async function proposeWithClaude(input: ProposeInput, draft: SystemDef[], readme: string): Promise<SystemDef[]> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const { z } = await import("zod");
  const Schema = z.object({
    systems: z.array(
      z.object({
        id: z.string().describe("short kebab-case id"),
        name: z.string().describe("human name a new engineer would recognise"),
        description: z.string().describe("one sentence: what this system is responsible for"),
        paths: z.array(z.string()).describe("repo-relative globs, e.g. packages/astro/src/core/**"),
      }),
    ),
  });
  const client = new Anthropic();
  const pkgs = [...input.packageNames].map(([dir, name]) => `${dir || "."}: ${name}`).join("\n");
  const response = await client.messages.parse({
    model: process.env.FAULTLINE_MODEL ?? "claude-opus-5",
    max_tokens: 16000,
    output_config: { format: zodOutputFormat(Schema) },
    messages: [
      {
        role: "user",
        content: `You are drawing the architecture map of a codebase for the engineers who work on it. Group its source directories into 8 to 16 systems: the boxes someone would draw on a whiteboard to explain how the codebase fits together. Each system should have one clear responsibility. Prefer the team's own vocabulary (package names, directory names, README terms).

Rules for paths: every glob is repo-relative and matched against file paths with picomatch. A file belongs to the system whose glob has the longest static prefix, so you can carve a subdirectory out of a broader system. Try to cover every directory in the outline; leave out only examples, docs sites, benchmarks and scripts if they are clearly not part of the product.

Packages:
${pkgs || "(single package)"}

Directory outline (source files only, tests excluded):
${outline(input.files)}

A mechanical first draft, to improve on:
${draft.map((s) => `- ${s.id}: ${s.name} [${s.paths.join(", ")}]`).join("\n")}

README excerpt:
${readme.slice(0, 4000)}`,
      },
    ],
  });
  const parsed = response.parsed_output;
  if (!parsed || parsed.systems.length === 0) throw new Error("Claude returned no systems");
  return parsed.systems;
}

/**
 * Shortest globs that assign every file exactly as before. The most specific glob wins, so Core can
 * claim core/** while Build keeps core/build/**. Each rewrite is checked against every file.
 */
export function simplifyGlobs(systems: SystemDef[], files: string[], AssignerCls: new (c: Config) => { assign(p: string): { system: string } }): SystemDef[] {
  const assignAll = (sys: SystemDef[]) => {
    const a = new AssignerCls({ version: 1, systems: sys, rules: [], ignore: [] });
    return files.map((f) => a.assign(f).system);
  };
  const want = assignAll(systems).join("\n");
  let current = systems.map((s) => ({ ...s, paths: [...s.paths] }));
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i < current.length; i++) {
      const sys = current[i];
      if (sys.paths.length < 3) continue;
      // Candidate parents: folders that hold several of this system's globs.
      const parents = new Map<string, number>();
      for (const g of sys.paths) {
        const base = g.replace(/\/\*\*$|\/\*$/, "");
        const parent = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
        if (parent) parents.set(parent, (parents.get(parent) ?? 0) + 1);
      }
      const owners = assignAll(current);
      for (const [parent, count] of [...parents].sort((a, b) => b[1] - a[1])) {
        if (count < 3) break;
        // Only a box that already owns most of a folder may claim it: new files there should land in it.
        let inside = 0;
        let mine = 0;
        files.forEach((f, k) => {
          if (!f.startsWith(parent + "/")) return;
          inside++;
          if (owners[k] === sys.id) mine++;
        });
        if (mine < inside * 0.5) continue;
        const under = sys.paths.filter((g) => g.startsWith(parent + "/"));
        const next = current.map((s, j) => (j === i ? { ...s, paths: [...s.paths.filter((g) => !under.includes(g)), `${parent}/**`].sort() } : s));
        if (assignAll(next).join("\n") === want) {
          current = next;
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  return current;
}

/** The whole cold-start pipeline: files, a quick import graph, then a proposal. Used by `fault init`. */
export async function draftConfig(root: string, opts: { target?: number; keepAll?: boolean } = {}): Promise<{ config: Config; stats: { sizes: Record<string, number>; unmapped: number; files: number } }> {
  const { makeSource } = await import("./source.js");
  const { buildModel } = await import("./graph.js");
  const { ParseCache } = await import("./parse.js");
  const { Assigner } = await import("./config.js");
  const all = await collectProposeInput(makeSource(root, undefined));
  const extraIgnore = opts.keepAll ? [] : skipGlobs(all.files);
  const skip = extraIgnore.length ? picomatch(extraIgnore) : () => false;
  const files = all.files.filter((f) => !skip(f));
  const probe = defaultConfig([{ id: "all", name: "all", paths: ["**"] }], extraIgnore);
  const model = await buildModel(makeSource(root, undefined), probe, new ParseCache(root));
  // Type imports count too: they say which folders belong together, even if they never run.
  const edges = model.edges.map((e) => [e.from, e.to] as [string, string]);
  const drafted = proposeHeuristic({ files, packageNames: all.packageNames, edges }, opts.target);
  const systems = simplifyGlobs(drafted, files, Assigner);
  const config = defaultConfig(systems, [...extraIgnore, ...lastLeftOut]);
  const a = new Assigner(config);
  const sizes: Record<string, number> = {};
  let unmapped = 0;
  for (const f of files) {
    if (a.ignored(f)) continue;
    const sys = a.assign(f).system;
    if (sys === "unmapped") unmapped++;
    else sizes[sys] = (sizes[sys] ?? 0) + 1;
  }
  return { config, stats: { sizes, unmapped, files: files.length } };
}

export function defaultConfig(systems: SystemDef[], extraIgnore: string[] = []): Config {
  return { version: 1, systems, rules: [], ignore: [...DEFAULT_IGNORE, ...extraIgnore] };
}
