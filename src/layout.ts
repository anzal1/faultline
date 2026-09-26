import fs from "node:fs";
import path from "node:path";
import type { AggEdge } from "./types.js";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  version: 1;
  /** Hash of the system id list the layout was computed for. A new system triggers a relayout. */
  key: string;
  systems: Record<string, Box>;
}

const LAYOUT_FILE = path.join(".faultline", "layout.json");

export function nodeSize(name: string, files: number): { w: number; h: number } {
  // Width follows the label; height is fixed so rows line up.
  return { w: Math.max(150, Math.min(260, 64 + name.length * 7.4)), h: files > 0 ? 64 : 52 };
}

/**
 * Positions are computed once from the declared systems and the base graph, then saved to
 * .faultline/layout.json. Edits never move boxes, so a change reads as light on a fixed map.
 */
export async function systemLayout(
  root: string,
  systems: { id: string; name: string; files: number }[],
  edges: AggEdge[],
  opts: { persist?: boolean } = {},
): Promise<Layout> {
  const key = systems.map((s) => s.id).sort().join(",");
  const file = path.join(root, LAYOUT_FILE);
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Layout;
      if (saved.version === 1 && saved.key === key) return saved;
      // Keep the positions of systems that still exist, place newcomers in free space.
      if (saved.version === 1) {
        const missing = systems.filter((s) => !saved.systems[s.id]);
        const kept: Record<string, Box> = {};
        for (const s of systems) if (saved.systems[s.id]) kept[s.id] = saved.systems[s.id];
        if (missing.length <= 2 && Object.keys(kept).length > 0) {
          for (const s of missing) kept[s.id] = placeNear(kept, s, edges);
          const layout: Layout = { version: 1, key, systems: kept };
          if (opts.persist !== false) save(file, layout);
          return layout;
        }
      }
    } catch {
      // unreadable layout: recompute
    }
  }
  const layout = await elkLayout(systems, edges);
  layout.key = key;
  if (opts.persist !== false) save(file, layout);
  return layout;
}

function save(file: string, layout: Layout) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(layout, null, 1));
}

async function elkLayout(systems: { id: string; name: string; files: number }[], edges: AggEdge[]): Promise<Layout> {
  // elkjs is CommonJS; depending on the loader the class sits on .default or .default.default.
  const mod: any = await import("elkjs/lib/elk.bundled.js");
  const ELK = mod.default?.default ?? mod.default ?? mod;
  const elk = new ELK();
  const ids = new Set(systems.map((s) => s.id));
  // Weak and type-only edges would pull the layout apart for no visual gain.
  const strong = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && !e.typeOnly);
  const children = systems.map((s) => ({ id: s.id, ...wh(nodeSize(s.name, s.files)) }));
  const elkEdges = strong.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] }));
  type Out = { children?: { id: string; x?: number; y?: number; width?: number; height?: number }[] };
  let out: Out;
  const dense = systems.length > 10 || strong.length > systems.length * 1.8;
  if (!dense) {
    // Small, mostly acyclic maps read best as a left-to-right flow.
    out = await elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.spacing.nodeNode": "36",
        "elk.layered.spacing.nodeNodeBetweenLayers": "110",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.separateConnectedComponents": "true",
        "elk.spacing.componentComponent": "60",
      },
      children,
      edges: elkEdges,
    });
  } else {
    // Dense, tangled maps: stress places systems near what they talk to, then spore removes overlaps.
    const stressed: Out = await elk.layout({
      id: "root",
      layoutOptions: { "elk.algorithm": "stress", "elk.stress.desiredEdgeLength": String(180 + systems.length * 4), "elk.stress.epsilon": "0.0001" },
      children,
      edges: elkEdges,
    });
    out = await elk.layout({
      id: "root",
      layoutOptions: { "elk.algorithm": "sporeOverlap", "elk.spacing.nodeNode": "44", "elk.overlapRemoval.maxIterations": "200" },
      children: (stressed.children ?? []).map((c) => ({ id: c.id, x: c.x, y: c.y, width: c.width, height: c.height })),
      edges: [],
    });
  }
  const boxes: Record<string, Box> = {};
  for (const c of out.children ?? []) boxes[c.id] = { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0), w: Math.round(c.width ?? 150), h: Math.round(c.height ?? 60) };
  return { version: 1, key: "", systems: boxes };
}

function wh(s: { w: number; h: number }) {
  return { width: s.w, height: s.h };
}

/** Deterministic free spot next to the newcomer's most connected neighbour. */
export function placeNear(boxes: Record<string, Box>, sys: { id: string; name: string; files: number }, edges: AggEdge[]): Box {
  const size = nodeSize(sys.name, sys.files);
  const neighbours = edges
    .filter((e) => (e.from === sys.id && boxes[e.to]) || (e.to === sys.id && boxes[e.from]))
    .sort((a, b) => b.count - a.count);
  const values = Object.values(boxes);
  const maxX = Math.max(0, ...values.map((b) => b.x + b.w));
  const anchor = neighbours.length ? boxes[neighbours[0].from === sys.id ? neighbours[0].to : neighbours[0].from] : { x: maxX + 60, y: 0, w: 0, h: 0 };
  const overlaps = (b: Box) => values.some((o) => b.x < o.x + o.w + 24 && b.x + b.w + 24 > o.x && b.y < o.y + o.h + 24 && b.y + b.h + 24 > o.y);
  for (let r = 1; r < 40; r++) {
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const b = { x: Math.round(anchor.x + dx * r * (size.w * 0.6 + 30)), y: Math.round(anchor.y + dy * r * (size.h + 30)), ...size };
      if (!overlaps(b)) return b;
    }
  }
  return { x: maxX + 60, y: 0, ...size };
}
