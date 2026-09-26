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
}

export async function collectProposeInput(source: Source, ignore = DEFAULT_IGNORE): Promise<ProposeInput> {
  const listing = await source.list();
  const ignored = picomatch(ignore, { dot: true });
  const files = [...listing.keys()].filter((p) => isSourceFile(p) && !ignored(p) && !p.includes("node_modules/"));
  const pkgPaths = [...listing.keys()].filter((p) => p.endsWith("package.json") && !p.includes("node_modules/"));
  const contents = await source.read(pkgPaths);
  const packageNames = new Map<string, string>();
  for (const [p, text] of contents) {
    try {
      const name = JSON.parse(text).name;
      if (typeof name === "string") packageNames.set(p === "package.json" ? "" : p.slice(0, -"/package.json".length), name);
    } catch {
      // skip
    }
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

/**
 * Splits the directory tree top-down, always opening the largest box, until the map has about
 * `target` systems. Sibling families like vite-plugin-* stay together as one system.
 */
export function proposeHeuristic(input: ProposeInput, target = defaultTarget(input.files.length)): SystemDef[] {
  const root = buildTree(input.files);
  const total = root.total || 1;
  let cands: Candidate[] = [{ dirs: [root] }];
  const splittable = (c: Candidate) => !c.rootFilesOf && c.dirs.length === 1 && c.dirs[0].children.size > 0;

  for (let guard = 0; guard < 400; guard++) {
    const next = cands.filter(splittable).sort((a, b) => size(b) - size(a))[0];
    if (!next) break;
    const dir = next.dirs[0];
    const pieces = splitDir(dir);
    const share = size(next) / total;
    // Single-child directories (src/, lib/) are free to descend through.
    const growth = pieces.filter((p) => size(p) >= (total >= 40 ? Math.max(3, total * 0.012) : 1)).length - 1;
    if (dir !== root && growth > 0) {
      if (cands.length >= target && share < 0.2) break;
      if (cands.length + growth > target * 1.8 && share < 0.35) break;
    }
    cands = cands.filter((c) => c !== next).concat(pieces);
  }

  // Fold tiny candidates into one "misc" system per parent so the map stays readable. Small repos keep
  // every folder: with a handful of files, each folder is already a meaningful box.
  const tiny = (c: Candidate) => total >= 40 && size(c) < Math.max(3, total * 0.012);
  const keep = cands.filter((c) => !tiny(c) && size(c) > 0);
  const byParent = new Map<string, Candidate[]>();
  for (const c of cands.filter((c) => tiny(c) && size(c) > 0)) {
    const d = c.rootFilesOf ?? c.dirs[0];
    const parent = c.rootFilesOf ? c.rootFilesOf.path : d.path.split("/").slice(0, -1).join("/");
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(c);
  }
  const systems: SystemDef[] = [];
  const used = new Set<string>();
  const uniqueId = (raw: string) => {
    let id = slug(raw) || "root";
    let i = 2;
    while (used.has(id)) id = `${slug(raw)}-${i++}`;
    used.add(id);
    return id;
  };
  for (const c of keep.sort((a, b) => size(b) - size(a))) systems.push(toSystem(c, input, uniqueId));
  for (const [parent, group] of byParent) {
    const paths = group.flatMap((c) => candidatePaths(c));
    const parentName = parent ? humanize(parent.split("/").pop()!) : "Root";
    systems.push({ id: uniqueId(`${parent.split("/").pop() || "root"}-misc`), name: `${parentName} (misc)`, paths });
  }
  return systems;
}

export function defaultTarget(fileCount: number): number {
  return Math.max(6, Math.min(18, Math.round(Math.sqrt(fileCount) / 2.4)));
}

/** Directories that are rarely part of the product's architecture. Proposed as ignored; easy to undo. */
export const PROPOSE_SKIP = ["examples", "example", "benchmark", "benchmarks", "bench", "scripts", "docs", "website", ".github", ".agents", ".changeset", ".vscode", "playground", "playgrounds", "demo", "demos", "sandbox"];

export function skipGlobs(files: string[]): string[] {
  const hits = new Set<string>();
  for (const f of files) {
    const top = f.split("/")[0];
    if (PROPOSE_SKIP.includes(top) && f.includes("/")) hits.add(`${top}/**`);
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
    const name = input.packageNames.get(d.path) ?? (d.path ? humanize(d.name) : "Root");
    return { id: uniqueId(`${d.name || "root"}-entry`), name: `${name} (entry files)`, paths };
  }
  if (c.label) {
    const key = c.label.replace(/[-_]\*$/, "");
    return { id: uniqueId(`${key}s`), name: `${humanize(key)}s`, paths };
  }
  const d = c.dirs[0];
  const pkg = input.packageNames.get(d.path) ?? (GENERIC.has(d.name) ? ancestorPackage(d.path, input) : undefined);
  const plainName = GENERIC.has(d.name) ? d.path.split("/").slice(-2, -1)[0] ?? d.name : d.name;
  return { id: uniqueId(pkg ? pkg.replace(/^@[^/]+\//, "") : plainName), name: pkg ?? humanize(plainName), paths };
}

/** Folder names that say nothing about what is inside: name the system after its parent instead. */
const GENERIC = new Set(["src", "lib", "source", "sources", "main", "app", "pkg", "internal"]);

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

export function defaultConfig(systems: SystemDef[], extraIgnore: string[] = []): Config {
  return { version: 1, systems, rules: [], ignore: [...DEFAULT_IGNORE, ...extraIgnore] };
}
