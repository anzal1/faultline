// Compares faultline's Python edges with Python's own parser (ast) and import finder (PathFinder).
// Usage: node bench/accuracy/python.mjs <repo> <source-root, e.g. src or .>
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildModel } from "../../dist/graph.js";
import { makeSource } from "../../dist/source.js";
import { ParseCache } from "../../dist/parse.js";
import { defaultConfig } from "../../dist/propose.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const [root, srcroot = "."] = process.argv.slice(2).map((a, i) => (i === 0 ? path.resolve(a) : a));
const oracle = new Set(JSON.parse(execFileSync("python3", [path.join(here, "python_oracle.py"), root, srcroot], { encoding: "utf8" })).map(([a, b]) => `${a} -> ${b}`));
const m = await buildModel(makeSource(root, undefined), defaultConfig([{ id: "all", name: "all", paths: ["**"] }]), new ParseCache(null));
const ours = new Set(m.edges.filter((e) => (srcroot === "." || e.from.startsWith(srcroot + "/")) && !/\/tests?\//.test(e.from)).map((e) => `${e.from} -> ${e.to}`));
const agree = [...ours].filter((x) => oracle.has(x)).length;
console.log(`${path.basename(root)}: python ${oracle.size} edges, faultline ${ours.size}, agree ${agree}. precision ${((agree / ours.size) * 100).toFixed(1)}%, recall ${((agree / oracle.size) * 100).toFixed(1)}%`);
for (const x of [...ours].filter((x) => !oracle.has(x)).slice(0, 10)) console.log("  + only faultline", x);
for (const x of [...oracle].filter((x) => !ours.has(x)).slice(0, 10)) console.log("  - only python   ", x);
