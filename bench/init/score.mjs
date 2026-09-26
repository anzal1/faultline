// How close is a cold `fault init` draft to a hand-written map? Pairwise agreement over files:
// two files in the same system in both maps count as agreement (Rand-style), plus the adjusted Rand index.
// Usage: node bench/init/score.mjs <repo> <reference faultline.yml>
import fs from "node:fs";
import path from "node:path";
import { Assigner, parseConfig } from "../../dist/config.js";
import { buildModel } from "../../dist/graph.js";
import { ParseCache } from "../../dist/parse.js";
import { draftConfig } from "../../dist/propose.js";
import { WorktreeSource } from "../../dist/source.js";

const [repo, refFile] = process.argv.slice(2).map((p) => path.resolve(p));
const ref = parseConfig(fs.readFileSync(refFile, "utf8"));
const t0 = Date.now();
const { config: draft, stats } = await draftConfig(repo);
const ms = Date.now() - t0;
// Score over files both maps cover.
const model = await buildModel(new WorktreeSource(repo), { ...ref, systems: [{ id: "all", name: "all", paths: ["**"] }] }, new ParseCache(null));
const files = Object.keys(model.files).filter((f) => model.files[f].hash !== "package");
const a = new Assigner(ref), b = new Assigner(draft);
const pairs = files.map((f) => [a.assign(f).system, b.assign(f).system]).filter(([x, y]) => x !== "unmapped" && y !== "unmapped");
const n = pairs.length;
const c2 = (k) => (k * (k - 1)) / 2;
const table = new Map(), rows = new Map(), cols = new Map();
for (const [x, y] of pairs) {
  table.set(x + "\0" + y, (table.get(x + "\0" + y) ?? 0) + 1);
  rows.set(x, (rows.get(x) ?? 0) + 1);
  cols.set(y, (cols.get(y) ?? 0) + 1);
}
const sumIJ = [...table.values()].reduce((s, v) => s + c2(v), 0);
const sumA = [...rows.values()].reduce((s, v) => s + c2(v), 0);
const sumB = [...cols.values()].reduce((s, v) => s + c2(v), 0);
const expected = (sumA * sumB) / c2(n);
const ari = (sumIJ - expected) / ((sumA + sumB) / 2 - expected);
const rand = (c2(n) + 2 * sumIJ - sumA - sumB) / c2(n);
console.log(`${path.basename(repo)}: draft ${draft.systems.length} systems (reference ${ref.systems.length}), ARI ${ari.toFixed(3)}, Rand ${rand.toFixed(3)}, ${ms} ms`);
for (const s of draft.systems) console.log(`  ${s.name.padEnd(30)} ${String(stats.sizes[s.id] ?? "").padStart(5)}  ${s.paths.join(" ").slice(0, 110)}`);
if (stats.unmapped) console.log(`  (unmapped: ${stats.unmapped})`);
