import { moduleLabel, systemName, UNMAPPED } from "./config.js";
import { findings, headline, type Finding } from "./describe.js";
import { diffModels } from "./diff.js";
import { aggregate } from "./graph.js";
import { systemLayout, type Layout } from "./layout.js";
import type { AggEdge, Config, Delta, FileEdge, Model } from "./types.js";

/** One point on the timeline: the base, a commit, an agent turn, or the live working tree. */
export interface SnapshotMeta {
  id: string;
  label: string;
  kind: "base" | "commit" | "turn" | "live";
  ref: string;
  time: number;
  subject?: string;
  author?: string;
  url?: string;
}

export interface SystemView {
  id: string;
  name: string;
  description?: string;
  files: number;
  modules: { id: string; label: string; files: number }[];
}

export interface Snapshot extends SnapshotMeta {
  /** Omitted in compact timelines when unchanged from the previous snapshot. */
  systems?: SystemView[];
  /** Omitted when identical to the previous snapshot, to keep exported timelines small. */
  systemEdges?: AggEdge[];
  moduleEdges?: AggEdge[];
  vsPrev?: DeltaView;
  vsBase?: DeltaView;
}

export interface DeltaView {
  headline: string;
  findings: Finding[];
  delta: Delta;
  /** Module id for every file the change touched, so the UI can light up modules. */
  fileModule: Record<string, string>;
}

/** The latest snapshot's full import graph, compactly: lets the UI show evidence for any edge. */
export interface CompactGraph {
  paths: string[];
  system: string[];
  module: string[];
  /** [fromIndex, toIndex, names joined by ",", flags: 1 = type-only, 2 = dynamic, 4 = re-export] */
  edges: [number, number, string, number][];
}

export interface MapState {
  mode: "live" | "static";
  repo: string;
  generatedAt: number;
  config: Pick<Config, "systems" | "rules">;
  layout: Layout;
  snapshots: Snapshot[];
  graph: CompactGraph;
  /** Optional context shown above the findings, e.g. what a shared demo contains. */
  note?: string;
}

export function systemViews(model: Model, config: Config): SystemView[] {
  const bySystem = new Map<string, Map<string, number>>();
  for (const f of Object.values(model.files)) {
    if (f.hash === "package") continue;
    if (!bySystem.has(f.system)) bySystem.set(f.system, new Map());
    const mods = bySystem.get(f.system)!;
    mods.set(f.module, (mods.get(f.module) ?? 0) + 1);
  }
  const ids = [...config.systems.map((s) => s.id), UNMAPPED];
  return ids
    .filter((id) => id !== UNMAPPED || bySystem.has(UNMAPPED))
    .map((id) => {
      const mods = bySystem.get(id) ?? new Map<string, number>();
      const def = config.systems.find((s) => s.id === id);
      return {
        id,
        name: systemName(config, id),
        description: def?.description,
        files: [...mods.values()].reduce((a, b) => a + b, 0),
        modules: [...mods].map(([mid, files]) => ({ id: mid, label: moduleLabel(mid), files })).sort((a, b) => b.files - a.files || a.id.localeCompare(b.id)),
      };
    });
}

export function deltaView(delta: Delta, config: Config, base: Model, head: Model): DeltaView {
  const moduleOf = (p: string) => head.files[p]?.module ?? base.files[p]?.module;
  const fileModule: Record<string, string> = {};
  for (const t of delta.touched) for (const p of [...t.added, ...t.modified, ...t.removed]) fileModule[p] = moduleOf(p) ?? "";
  // Copies, so the model's own edges stay untouched.
  const annotate = (edges: FileEdge[]) => edges.map((e) => ({ ...e, fm: moduleOf(e.from), tm: moduleOf(e.to) }));
  for (const list of [delta.systemEdges.added, delta.systemEdges.removed, delta.systemEdges.grown, delta.systemEdges.shrunk, delta.moduleEdges.added, delta.moduleEdges.removed]) {
    for (const c of list) c.evidence = annotate(c.evidence);
  }
  for (const v of [...delta.violations.introduced, ...delta.violations.existing, ...delta.violations.fixed]) v.evidence = annotate(v.evidence);
  const f = findings(delta, config);
  for (const x of f) if (x.evidence) x.evidence = annotate(x.evidence);
  return { headline: headline(delta, config), findings: f, delta, fileModule };
}

export function compactGraph(model: Model): CompactGraph {
  const paths = Object.keys(model.files).sort();
  const index = new Map(paths.map((p, i) => [p, i]));
  return {
    paths,
    system: paths.map((p) => model.files[p].system),
    module: paths.map((p) => model.files[p].module),
    edges: model.edges.map((e) => [index.get(e.from)!, index.get(e.to)!, e.names.join(","), (e.typeOnly ? 1 : 0) | (e.kind === "dynamic" ? 2 : 0) | (e.kind === "reexport" ? 4 : 0)]),
  };
}

const sameEdges = (a: AggEdge[] | undefined, b: AggEdge[] | undefined) =>
  !!a && !!b && a.length === b.length && a.every((e, i) => e.from === b[i].from && e.to === b[i].to && e.count === b[i].count && e.typeOnly === b[i].typeOnly);

export async function buildState(opts: {
  root: string;
  repo: string;
  config: Config;
  models: { meta: SnapshotMeta; model: Model }[];
  mode: "live" | "static";
  compact?: boolean;
  persistLayout?: boolean;
}): Promise<MapState> {
  const { config, models } = opts;
  const base = models[0].model;
  const snapshots: Snapshot[] = [];
  let lastSys: AggEdge[] | undefined;
  let lastMod: AggEdge[] | undefined;
  let lastSystemsJson = "";
  for (let i = 0; i < models.length; i++) {
    const { meta, model } = models[i];
    const systemEdges = aggregate(model, "system");
    const moduleEdges = aggregate(model, "module");
    const views = systemViews(model, config);
    const viewsJson = JSON.stringify(views);
    const snap: Snapshot = { ...meta };
    const isLast = i === models.length - 1;
    if (!opts.compact || isLast || i === 0 || viewsJson !== lastSystemsJson) snap.systems = views;
    lastSystemsJson = viewsJson;
    if (!opts.compact || isLast || !sameEdges(systemEdges, lastSys)) snap.systemEdges = systemEdges;
    if (!opts.compact || isLast || !sameEdges(moduleEdges, lastMod)) snap.moduleEdges = moduleEdges;
    lastSys = systemEdges;
    lastMod = moduleEdges;
    if (i > 0) {
      snap.vsPrev = deltaView(diffModels(models[i - 1].model, model, config), config, models[i - 1].model, model);
      // Long timelines keep only per-step deltas, plus the full picture at the end.
      if (!opts.compact || isLast || i === 1) snap.vsBase = i === 1 ? snap.vsPrev : deltaView(diffModels(base, model, config), config, base, model);
    }
    snapshots.push(snap);
  }
  // Lay out every system that appears anywhere on the timeline, using the base graph.
  const allSystems = new Map<string, { id: string; name: string; files: number }>();
  for (const s of snapshots) for (const v of s.systems ?? []) if (!allSystems.has(v.id)) allSystems.set(v.id, { id: v.id, name: v.name, files: v.files });
  const layout = await systemLayout(opts.root, [...allSystems.values()], aggregate(base, "system"), { persist: opts.persistLayout });

  const state: MapState = {
    mode: opts.mode,
    repo: opts.repo,
    generatedAt: Date.now(),
    config: { systems: config.systems, rules: config.rules },
    layout,
    snapshots,
    graph: compactGraph(models[models.length - 1].model),
  };
  return state;
}
