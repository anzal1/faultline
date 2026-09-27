import { Assigner, systemName, UNMAPPED } from "./config.js";
import type { Workspace } from "./context.js";
import { findings, importPhrase } from "./describe.js";
import { aggregate } from "./graph.js";
import { loadPlan } from "./plan.js";
import { compileRules, type CompiledRule } from "./rules.js";
import type { AggEdge, Config, Delta, Model } from "./types.js";

/**
 * Answers for coding agents. Every answer is plain text sized to be read in one glance by a model:
 * the point is that an agent asks the map instead of opening hundreds of files.
 */

export const approxTokens = (s: string) => Math.ceil(s.length / 4);
export const withCost = (s: string) => `${s.trimEnd()}\n(~${approxTokens(s)} tokens)`;

const clip = (s: string | undefined, n: number) => (!s ? "" : s.length > n ? s.slice(0, n - 1) + "…" : s);

function denyRule(rules: CompiledRule[], from: string, to: string): CompiledRule | undefined {
  return rules.find((r) => r.from(from) && r.to(to));
}

/** Shortest chain of existing, allowed runtime dependencies from one system to another. */
export function allowedRoute(edges: AggEdge[], rules: CompiledRule[], from: string, to: string): string[] | null {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.typeOnly || denyRule(rules, e.from, e.to)) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const prev = new Map<string, string>([[from, ""]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of adj.get(cur) ?? []) {
      if (prev.has(n)) continue;
      prev.set(n, cur);
      if (n === to) {
        const pathOut = [to];
        let p = cur;
        while (p) {
          pathOut.unshift(p);
          p = prev.get(p)!;
        }
        return pathOut.length > 2 ? pathOut : null;
      }
      queue.push(n);
    }
  }
  return null;
}

export async function overview(ws: Workspace, opts: { system?: string; ref?: string } = {}): Promise<string> {
  const config = ws.config;
  const model = await ws.model(opts.ref);
  const edges = aggregate(model, "system").filter((e) => !e.typeOnly);
  const counts = new Map<string, number>();
  for (const f of Object.values(model.files)) if (f.hash !== "package") counts.set(f.system, (counts.get(f.system) ?? 0) + 1);
  if (opts.system) return systemDetail(ws, model, opts.system);
  const lines: string[] = [];
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  lines.push(`${config.systems.length} systems, ${total} source files. Each file belongs to the most specific system whose paths match it.`);
  lines.push("", "Systems (id: name, files, what it owns):");
  for (const s of config.systems) {
    const c = counts.get(s.id) ?? 0;
    if (!c) continue;
    lines.push(`- ${s.id}: ${s.name}, ${c}${s.description ? `. ${clip(s.description, 90)}` : ""} [${clip(s.paths.join(" "), 80)}]`);
  }
  if (counts.get(UNMAPPED)) lines.push(`- unmapped: ${counts.get(UNMAPPED)} files outside every system`);
  lines.push("", "Depends on (runtime imports, strongest first):");
  for (const s of config.systems) {
    const outs = edges.filter((e) => e.from === s.id).slice(0, 5);
    if (outs.length) lines.push(`- ${s.id} → ${outs.map((e) => `${e.to} ${e.count}`).join(", ")}`);
  }
  if (config.rules.length) {
    lines.push("", "Fault lines (never add these imports):");
    for (const r of config.rules) lines.push(`- deny ${r.deny}${r.reason ? `: ${r.reason}` : ""}`);
  }
  const plan = loadPlan(ws.root);
  if (plan.edges.length) {
    lines.push("", "Planned new dependencies:");
    for (const e of plan.edges) lines.push(`- ${e.from} → ${e.to}${e.why ? `: ${e.why}` : ""}`);
  }
  return lines.join("\n");
}

async function systemDetail(ws: Workspace, model: Model, id: string): Promise<string> {
  const config = ws.config;
  const def = config.systems.find((s) => s.id === id || s.name.toLowerCase() === id.toLowerCase());
  if (!def) return `No system "${id}". Systems: ${config.systems.map((s) => s.id).join(", ")}`;
  const mods = new Map<string, number>();
  for (const f of Object.values(model.files)) if (f.system === def.id && f.hash !== "package") mods.set(f.module, (mods.get(f.module) ?? 0) + 1);
  const edges = aggregate(model, "system").filter((e) => !e.typeOnly);
  const lines = [`${def.id}: ${def.name}${def.description ? `. ${def.description}` : ""}`, `Paths: ${def.paths.join(" ")}`];
  lines.push(`Modules: ${[...mods].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([m, c]) => `${m.slice(def.id.length + 1)} ${c}`).join(", ")}`);
  const outs = edges.filter((e) => e.from === def.id);
  const ins = edges.filter((e) => e.to === def.id);
  lines.push(`Depends on: ${outs.map((e) => `${e.to} ${e.count}`).join(", ") || "nothing"}`);
  lines.push(`Used by: ${ins.map((e) => `${e.from} ${e.count}`).join(", ") || "nothing"}`);
  const rules = compileRules(config);
  const denied = config.systems.filter((s) => s.id !== def.id && denyRule(rules, def.id, s.id)).map((s) => s.id);
  if (denied.length) lines.push(`Must not import: ${denied.join(", ")}`);
  return lines.join("\n");
}

/** Where a path belongs and what it may import. Works for files that do not exist yet. */
export async function place(ws: Workspace, filePath: string, imports: string[] = []): Promise<string> {
  const config = ws.config;
  const rel = filePath.replace(/^\.\//, "").replace(ws.root + "/", "");
  const a = new Assigner(config).assign(rel);
  const model = await ws.model(undefined);
  const exists = !!model.files[rel];
  const n = (id: string) => systemName(config, id);
  const rules = compileRules(config);
  const edges = aggregate(model, "system");
  const lines: string[] = [];
  if (a.system === UNMAPPED) {
    lines.push(`${rel} is outside every declared system. Run \`fault sync --apply\` to place its folder where its imports go (this never loosens a rule).`);
    return lines.join("\n");
  }
  lines.push(`${rel} → ${a.system} (${n(a.system)}), module ${a.module.slice(a.system.length + 1)}${exists ? "" : ", new file"}.`);
  const denied = config.systems.filter((s) => s.id !== a.system && denyRule(rules, a.system, s.id));
  if (denied.length) {
    const reasons = [...new Set(denied.map((s) => denyRule(rules, a.system, s.id)!.rule.reason).filter(Boolean))];
    lines.push(`Must not import: ${denied.map((s) => s.id).join(", ")}${reasons.length ? ` (${reasons.join("; ")})` : ""}.`);
  } else lines.push("May import any system; no fault lines start here.");
  const outs = edges.filter((e) => e.from === a.system && !e.typeOnly).slice(0, 6);
  if (outs.length) lines.push(`Already depends on: ${outs.map((e) => e.to).join(", ")}.`);
  for (const target of imports) {
    const t = target.replace(/^\.\//, "");
    const tSys = config.systems.some((s) => s.id === t) ? t : new Assigner(config).assign(t).system;
    if (tSys === a.system) {
      lines.push(`✓ ${t}: same system.`);
      continue;
    }
    const r = denyRule(rules, a.system, tSys);
    if (!r) {
      const known = edges.some((e) => e.from === a.system && e.to === tSys);
      lines.push(`✓ ${t} (${tSys}): allowed${known ? "" : ", but new: a new dependency between systems, declare it with plan"}.`);
      continue;
    }
    const route = allowedRoute(edges, rules, a.system, tSys);
    lines.push(`✗ ${t} (${tSys}): crosses fault line deny ${r.rule.deny}${r.rule.reason ? ` (${r.rule.reason})` : ""}.${route ? ` Allowed route: ${route.join(" → ")}.` : " No allowed route exists; ask before adding one."}`);
  }
  return lines.join("\n");
}

/** Structural diff for an agent: only what changed shape, each with its evidence and a fix route. */
export function agentDiff(delta: Delta, config: Config, head: Model, root: string): string {
  const f = findings(delta, config).filter((x) => x.severity !== "info" || /now uses|outside every/.test(x.title));
  const lines: string[] = [];
  const touched = delta.files.added.length + delta.files.modified.length + delta.files.removed.length;
  if (!touched) return "No source changes.";
  const rules = compileRules(config);
  const edges = aggregate(head, "system");
  const plan = loadPlan(root);
  const planned = new Set(plan.edges.map((e) => `${e.from}>${e.to}`));
  if (!f.length) lines.push(`No structural changes: ${touched} files changed inside existing boundaries.`);
  for (const x of f) {
    const mark = x.severity === "fault" ? "✗" : x.severity === "structure" ? "●" : "·";
    let line = `${mark} ${x.title}`;
    if (x.evidence?.length) line += `: ${x.evidence.slice(0, 2).map((e) => `${e.from} ${importPhrase(e).replace(/^\S+ /, "")}`).join("; ")}${x.evidence.length > 2 ? ` (+${x.evidence.length - 2})` : ""}`;
    if (x.severity === "fault" && x.from && x.to) {
      const route = allowedRoute(edges, rules, x.from, x.to);
      line += route ? `. Allowed route: ${route.join(" → ")}` : ". No allowed route; ask the user before changing faultline.yml";
    }
    if (x.severity === "structure" && x.title.startsWith("New dependency") && x.from && x.to) {
      line += planned.has(`${x.from}>${x.to}`) ? " (planned)" : plan.edges.length ? " (not in plan)" : "";
    }
    lines.push(line);
  }
  const pending = plan.edges.filter((e) => !edges.some((x) => x.from === e.from && x.to === e.to));
  if (pending.length) lines.push(`Planned but not built yet: ${pending.map((e) => `${e.from} → ${e.to}`).join(", ")}`);
  return lines.join("\n");
}
