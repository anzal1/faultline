import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { Assigner, configPath, parseConfig, systemName, UNMAPPED } from "./config.js";
import type { Workspace } from "./context.js";
import { aggregate } from "./graph.js";
import { humanize, slug } from "./propose.js";
import { compileRules } from "./rules.js";
import { git, INDEX, WORKTREE } from "./source.js";
import type { Config, Model } from "./types.js";

/**
 * Keeping faultline.yml true without a person tending it. Two halves, on purpose:
 * - where code lives is a fact, so new folders get placed automatically (agents may apply it);
 * - what may depend on what is a decision, so rules are only ever suggested, and any change that
 *   loosens them is flagged for a human, in the agent hook and in `fault check`.
 */

export interface Placement {
  /** Folder (or single file) outside every system. */
  path: string;
  /** The glob to add. */
  glob: string;
  files: number;
  /** Existing system it joins, or a new one to create. */
  system?: string;
  create?: { id: string; name: string };
  why: string;
}

export interface RuleSuggestion {
  deny: string;
  from: string;
  to: string;
  reason: string;
  imports: number;
}

export interface Loosening {
  kind: "rule" | "moved" | "ignored" | "types";
  detail: string;
}

// ---------- placements ----------

/** New folders outside every system, each placed where its imports go, or proposed as a system. */
export function suggestPlacements(model: Model, config: Config): Placement[] {
  const mapped = new Set<string>();
  const unmapped: string[] = [];
  for (const f of Object.values(model.files)) {
    if (f.hash === "package") continue;
    if (f.system === UNMAPPED) unmapped.push(f.path);
    else mapped.add(f.path);
  }
  if (!unmapped.length) return [];
  const mappedDirs = new Set<string>();
  for (const p of mapped) for (let d = path.posix.dirname(p); d !== "."; d = path.posix.dirname(d)) mappedDirs.add(d);
  // The largest folder that holds unmapped files and nothing mapped; a lone file otherwise.
  const groupOf = (p: string) => {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (!mappedDirs.has(d)) return d;
    }
    return p;
  };
  const groups = new Map<string, string[]>();
  for (const p of unmapped) (groups.get(groupOf(p)) ?? groups.set(groupOf(p), []).get(groupOf(p))!).push(p);

  const sysOf = new Map(Object.values(model.files).map((f) => [f.path, f.system]));
  const taken = new Set(config.systems.map((s) => s.id));
  const out: Placement[] = [];
  for (const [folder, files] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const inGroup = new Set(files);
    const ties = new Map<string, number>();
    let total = 0;
    for (const e of model.edges) {
      if (e.confidence === "inferred") continue;
      const a = inGroup.has(e.from), b = inGroup.has(e.to);
      if (a === b) continue;
      const other = sysOf.get(a ? e.to : e.from);
      if (!other || other === UNMAPPED) continue;
      ties.set(other, (ties.get(other) ?? 0) + 1);
      total++;
    }
    const ranked = [...ties].sort((x, y) => y[1] - x[1]);
    const [best, second] = ranked;
    const isFile = folder === files[0] && files.length === 1 && !folder.endsWith("/");
    const glob = isFile ? folder : `${folder}/**`;
    const clear = best && best[1] >= 2 && (!second || best[1] >= second[1] * 1.5);
    if (clear || (best && files.length < 3)) {
      out.push({ path: folder, glob, files: files.length, system: best[0], why: `${best[1]} of its ${total} imports to and from other systems involve ${systemName(config, best[0])}` });
    } else if (files.length >= 3) {
      let id = slug(path.posix.basename(folder)) || "new";
      for (let i = 2; taken.has(id); i++) id = `${slug(path.posix.basename(folder))}-${i}`;
      taken.add(id);
      out.push({ path: folder, glob, files: files.length, create: { id, name: humanize(path.posix.basename(folder)) }, why: best ? `its imports are split across systems (${ranked.slice(0, 3).map(([s, n]) => `${systemName(config, s)} ${n}`).join(", ")})` : "nothing else in the repo imports it yet" });
    }
  }
  return out;
}

/** Writes placements into faultline.yml, keeping its comments and layout. */
export function applyPlacements(root: string, placements: Placement[]): number {
  if (!placements.length) return 0;
  const file = configPath(root);
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  const systems = doc.get("systems") as YAML.YAMLSeq;
  let n = 0;
  for (const p of placements) {
    if (p.system) {
      const sys = systems.items.find((s) => YAML.isMap(s) && String(s.get("id")) === p.system) as YAML.YAMLMap | undefined;
      if (!sys) continue;
      let paths = sys.get("paths");
      if (!YAML.isSeq(paths)) {
        const list = new YAML.YAMLSeq();
        if (paths !== undefined && paths !== null) list.add(String(paths));
        sys.set("paths", list);
        paths = list;
      }
      const seq = paths as YAML.YAMLSeq;
      if (!seq.items.some((x) => String(YAML.isScalar(x) ? x.value : x) === p.glob)) {
        seq.add(p.glob);
        n++;
      }
    } else if (p.create) {
      systems.add(doc.createNode({ id: p.create.id, name: p.create.name, paths: [p.glob] }));
      n++;
    }
  }
  fs.writeFileSync(file, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  return n;
}

// ---------- rule suggestions ----------

/**
 * One-way dependencies worth writing down: A imports B, and B has not imported A at any sampled
 * point in recent history. Declaring "deny B -> A" keeps the layering from quietly inverting.
 */
export async function suggestRules(ws: Workspace, opts: { history?: number; samples?: number } = {}): Promise<RuleSuggestion[]> {
  const history = opts.history ?? 200;
  const samples = opts.samples ?? 8;
  const head = await ws.model(undefined);
  const now = aggregate(head, "system").filter((e) => !e.typeOnly && e.from !== UNMAPPED && e.to !== UNMAPPED);
  const has = (edges: { from: string; to: string }[], a: string, b: string) => edges.some((e) => e.from === a && e.to === b);
  const rules = compileRules(ws.config);
  const denied = (a: string, b: string) => rules.some((r) => r.from(a) && r.to(b));
  let candidates = now.filter((e) => e.count >= 3 && !has(now, e.to, e.from) && !denied(e.to, e.from));
  if (!candidates.length) return [];
  let shas: string[] = [];
  try {
    shas = git(ws.root, ["rev-list", `--max-count=${history}`, "HEAD"]).trim().split("\n").filter(Boolean);
  } catch {
    // not a git repo: judge by the working tree alone
  }
  const step = Math.max(1, Math.floor(shas.length / samples));
  const sampled = shas.filter((_, i) => i % step === 0).slice(0, samples);
  for (const sha of sampled) {
    if (!candidates.length) break;
    let past: ReturnType<typeof aggregate>;
    try {
      past = aggregate(await ws.model(sha), "system").filter((e) => !e.typeOnly);
    } catch {
      continue;
    }
    candidates = candidates.filter((e) => !has(past, e.to, e.from));
  }
  const n = (id: string) => systemName(ws.config, id);
  const span = shas.length ? `${Math.min(history, shas.length)} commits` : "this working tree";
  return candidates
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((e) => ({
      deny: `${e.to} -> ${e.from}`,
      from: e.to,
      to: e.from,
      imports: e.count,
      reason: `${n(e.from)} depends on ${n(e.to)} (${e.count} imports) and ${n(e.to)} has not imported ${n(e.from)} in the last ${span}. Keeps it one-way.`,
    }));
}

// ---------- loosening ----------

/** Every way `after` allows something `before` forbade, over the given files. */
export function loosenings(before: Config, after: Config, files: string[]): Loosening[] {
  const out: Loosening[] = [];
  const ids = [...new Set([...before.systems, ...after.systems].map((s) => s.id)), UNMAPPED];
  const denied = (cfg: Config, typesToo: boolean) => {
    const rules = compileRules(cfg).filter((r) => !typesToo || r.rule.types);
    const set = new Map<string, string>();
    for (const a of ids) for (const b of ids) if (a !== b) {
      const r = rules.find((x) => x.from(a) && x.to(b));
      if (r) set.set(`${a} -> ${b}`, r.rule.deny);
    }
    return set;
  };
  const was = denied(before, false), now = denied(after, false);
  // A rule is removed only when nothing it forbade is still forbidden; otherwise it was narrowed.
  const byRule = new Map<string, string[]>();
  for (const [pair, rule] of was) (byRule.get(rule) ?? byRule.set(rule, []).get(rule)!).push(pair);
  const stillThere = (rule: string) => after.rules.some((r) => r.deny.replace(/\s+/g, "") === rule.replace(/\s+/g, ""));
  for (const [rule, pairs] of byRule) {
    const lost = pairs.filter((p) => !now.has(p));
    if (!lost.length) continue;
    if (lost.length === pairs.length && !stillThere(rule)) out.push({ kind: "rule", detail: `rule "deny ${rule}" was removed` });
    else for (const p of lost) out.push({ kind: "rule", detail: `${p} is no longer denied (rule "deny ${rule}" changed)` });
  }
  const wasTyped = denied(before, true), nowTyped = denied(after, true);
  for (const pair of wasTyped.keys()) if (!nowTyped.has(pair) && now.has(pair)) out.push({ kind: "types", detail: `${pair} no longer counts type-only imports` });

  // Moving files between systems can walk code around a rule without touching it.
  const a = new Assigner(before), b = new Assigner(after);
  const moved = new Map<string, string[]>();
  const ignored: string[] = [];
  for (const f of files) {
    if (a.ignored(f)) continue;
    const from = a.assign(f).system;
    if (from === UNMAPPED) continue;
    if (b.ignored(f)) { ignored.push(f); continue; }
    const to = b.assign(f).system;
    if (to !== from) (moved.get(`${from} -> ${to}`) ?? moved.set(`${from} -> ${to}`, []).get(`${from} -> ${to}`)!).push(f);
  }
  for (const [pair, list] of moved) out.push({ kind: "moved", detail: `${list.length} file${list.length === 1 ? "" : "s"} moved from ${pair.replace(" -> ", " to ")} (e.g. ${list[0]})` });
  if (ignored.length) out.push({ kind: "ignored", detail: `${ignored.length} mapped file${ignored.length === 1 ? " is" : "s are"} now ignored (e.g. ${ignored[0]})` });
  return out;
}

/** faultline.yml as it was at a ref, in the index, or on disk. Null when it did not exist. */
export function configAt(root: string, ref: string | undefined): Config | null {
  try {
    if (!ref || ref === WORKTREE) return fs.existsSync(configPath(root)) ? parseConfig(fs.readFileSync(configPath(root), "utf8")) : null;
    // "./" resolves against root, so this works when faultline.yml sits below the git top level.
    const text = git(root, ["show", `${ref === INDEX ? "" : ref}:./faultline.yml`]);
    return parseConfig(text);
  } catch {
    return null;
  }
}

export function describeLoosenings(list: Loosening[]): string {
  return list.map((l) => `- ${l.detail}`).join("\n");
}
