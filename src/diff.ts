import { UNMAPPED } from "./config.js";
import { aggregate, cycles } from "./graph.js";
import { compileRules, findViolations } from "./rules.js";
import type { AggEdge, Config, Delta, EdgeChange, FileEdge, Model, SystemTouch, Violation } from "./types.js";

const MAX_EVIDENCE = 25;

const edgeKey = (e: { from: string; to: string }) => `${e.from}\0${e.to}`;

export function diffModels(base: Model, head: Model, config: Config): Delta {
  const baseFiles = new Set(Object.keys(base.files).filter((p) => base.files[p].hash !== "package"));
  const headFiles = new Set(Object.keys(head.files).filter((p) => head.files[p].hash !== "package"));
  const added = [...headFiles].filter((p) => !baseFiles.has(p)).sort();
  const removed = [...baseFiles].filter((p) => !headFiles.has(p)).sort();
  const modified = [...headFiles].filter((p) => baseFiles.has(p) && base.files[p].hash !== head.files[p].hash).sort();

  const moved: { from: string; to: string }[] = [];
  const removedByHash = new Map<string, string>();
  for (const p of removed) removedByHash.set(base.files[p].hash, p);
  for (const p of added) {
    const from = removedByHash.get(head.files[p].hash);
    if (from) {
      moved.push({ from, to: p });
      removedByHash.delete(head.files[p].hash);
    }
  }

  const touchedMap = new Map<string, SystemTouch>();
  const touch = (system: string) => {
    let t = touchedMap.get(system);
    if (!t) touchedMap.set(system, (t = { system, added: [], removed: [], modified: [] }));
    return t;
  };
  for (const p of added) touch(head.files[p].system).added.push(p);
  for (const p of removed) touch(base.files[p].system).removed.push(p);
  for (const p of modified) touch(head.files[p].system).modified.push(p);

  const baseFileEdges = new Set(base.edges.map(edgeKey));
  const headFileEdges = new Set(head.edges.map(edgeKey));
  const newFileEdges = head.edges.filter((e) => !baseFileEdges.has(edgeKey(e)));
  const goneFileEdges = base.edges.filter((e) => !headFileEdges.has(edgeKey(e)));

  const systemEdges = compareAgg(base, head, "system", newFileEdges, goneFileEdges);
  const moduleEdgesFull = compareAgg(base, head, "module", newFileEdges, goneFileEdges);

  const baseModules = new Set(Object.values(base.files).map((f) => f.module));
  const headModules = new Set(Object.values(head.files).map((f) => f.module));

  const extSet = (m: Model) => {
    const out = new Map<string, Map<string, string[]>>();
    for (const u of m.externals) {
      const sys = m.files[u.file]?.system;
      if (!sys) continue;
      if (!out.has(sys)) out.set(sys, new Map());
      const byPkg = out.get(sys)!;
      if (!byPkg.has(u.pkg)) byPkg.set(u.pkg, []);
      byPkg.get(u.pkg)!.push(u.file);
    }
    return out;
  };
  const baseExt = extSet(base);
  const headExt = extSet(head);
  const externalsAdded: Delta["externals"]["added"] = [];
  const externalsRemoved: Delta["externals"]["removed"] = [];
  for (const [sys, pkgs] of headExt) {
    for (const [pkg, files] of pkgs) if (!baseExt.get(sys)?.has(pkg)) externalsAdded.push({ system: sys, pkg, files: files.slice(0, 5) });
  }
  for (const [sys, pkgs] of baseExt) {
    for (const pkg of pkgs.keys()) if (!headExt.get(sys)?.has(pkg)) externalsRemoved.push({ system: sys, pkg });
  }

  const baseAgg = aggregate(base, "system");
  const headAgg = aggregate(head, "system");
  const baseCycles = cycles(baseAgg);
  const headCycles = cycles(headAgg);
  const cycleKey = (c: string[]) => c.join("\0");
  const baseCycleKeys = new Set(baseCycles.map(cycleKey));
  const headCycleKeys = new Set(headCycles.map(cycleKey));

  const rules = compileRules(config);
  const baseViolations = findViolations(base, baseAgg, rules);
  const headViolations = findViolations(head, headAgg, rules);
  const baseViolationKeys = new Set(baseViolations.map(edgeKey));
  const introduced: Violation[] = [];
  const existing: Violation[] = [];
  for (const v of headViolations) {
    const fresh = v.evidence.filter((e) => !baseFileEdges.has(edgeKey(e)));
    if (!baseViolationKeys.has(edgeKey(v))) introduced.push(v);
    else if (fresh.length > 0) introduced.push({ ...v, evidence: fresh });
    else existing.push(v);
  }
  const headViolationKeys = new Set(headViolations.map(edgeKey));
  const fixed = baseViolations.filter((v) => !headViolationKeys.has(edgeKey(v)));

  return {
    base: { ref: base.ref, label: base.label },
    head: { ref: head.ref, label: head.label },
    systemEdges,
    moduleEdges: { added: moduleEdgesFull.added, removed: moduleEdgesFull.removed },
    files: { added, removed, modified, moved },
    touched: [...touchedMap.values()].sort((a, b) => total(b) - total(a)),
    modules: {
      added: [...headModules].filter((m) => !baseModules.has(m)).sort(),
      removed: [...baseModules].filter((m) => !headModules.has(m)).sort(),
    },
    externals: { added: externalsAdded, removed: externalsRemoved },
    cycles: {
      added: headCycles.filter((c) => !baseCycleKeys.has(cycleKey(c))),
      removed: baseCycles.filter((c) => !headCycleKeys.has(cycleKey(c))),
    },
    violations: { introduced, existing, fixed },
    unmapped: added.filter((p) => head.files[p].system === UNMAPPED),
  };
}

function total(t: SystemTouch) {
  return t.added.length + t.removed.length + t.modified.length;
}

function compareAgg(base: Model, head: Model, level: "system" | "module", newEdges: FileEdge[], goneEdges: FileEdge[]) {
  const baseAgg = new Map(aggregate(base, level).map((e) => [edgeKey(e), e]));
  const headAgg = new Map(aggregate(head, level).map((e) => [edgeKey(e), e]));
  const group = (edges: FileEdge[], m: Model) => {
    const out = new Map<string, FileEdge[]>();
    for (const e of edges) {
      const a = m.files[e.from]?.[level];
      const b = m.files[e.to]?.[level];
      if (!a || !b || a === b) continue;
      const k = `${a}\0${b}`;
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push(e);
    }
    return out;
  };
  const newByKey = group(newEdges, head);
  const goneByKey = group(goneEdges, base);
  const change = (e: AggEdge, evidence: FileEdge[] | undefined): EdgeChange => ({
    from: e.from,
    to: e.to,
    count: e.count,
    typeOnly: e.typeOnly,
    evidence: (evidence ?? []).slice(0, MAX_EVIDENCE),
  });
  const added: EdgeChange[] = [];
  const removed: EdgeChange[] = [];
  const grown: EdgeChange[] = [];
  const shrunk: EdgeChange[] = [];
  for (const [k, e] of headAgg) {
    const b = baseAgg.get(k);
    if (!b) added.push(change(e, newByKey.get(k)));
    else if (newByKey.has(k) && e.count > b.count) grown.push({ ...change(e, newByKey.get(k)), count: e.count - b.count });
  }
  for (const [k, e] of baseAgg) {
    const h = headAgg.get(k);
    if (!h) removed.push(change(e, goneByKey.get(k)));
    else if (goneByKey.has(k) && h.count < e.count) shrunk.push({ ...change(e, goneByKey.get(k)), count: e.count - h.count });
  }
  // Runtime edges before type-only ones: they are the ones that change behaviour.
  const order = (a: EdgeChange, b: EdgeChange) => Number(a.typeOnly) - Number(b.typeOnly) || b.count - a.count;
  return { added: added.sort(order), removed: removed.sort(order), grown: grown.sort(order), shrunk: shrunk.sort(order) };
}

export function isEmptyDelta(d: Delta): boolean {
  return (
    d.systemEdges.added.length + d.systemEdges.removed.length + d.violations.introduced.length + d.cycles.added.length + d.externals.added.length === 0
  );
}
