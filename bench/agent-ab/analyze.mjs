// Summarise bench/agent-ab/results into per-arm numbers. Usage: node bench/agent-ab/analyze.mjs [results-dir] [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : path.join(here, "results"));
const runs = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
const tokens = (u) => (u ? u.input_tokens + u.output_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

const groups = {};
for (const r of runs) (groups[`${r.task}|${r.arm}`] ??= []).push(r);
const byArm = {};
for (const r of runs) (byArm[r.arm] ??= []).push(r);

const summarise = (rs) => ({
  runs: rs.length,
  violations: rs.filter((r) => r.violations.length).length,
  done: rs.filter((r) => r.done).length,
  cleanAndDone: rs.filter((r) => r.done && !r.violations.length).length,
  costMean: mean(rs.map((r) => r.cost ?? 0)),
  tokensMedian: median(rs.map((r) => tokens(r.usage))),
  outputTokensMedian: median(rs.map((r) => r.usage?.output_tokens ?? 0)),
  readsMedian: median(rs.map((r) => r.reads)),
  searchesMedian: median(rs.map((r) => r.searches)),
  turnsMedian: median(rs.map((r) => r.turns)),
  minutesMedian: median(rs.map((r) => (r.durationMs ?? r.wallMs) / 60000)),
  faultlineCallsMean: mean(rs.map((r) => r.faultlineCalls.length)),
  hookWarned: rs.filter((r) => r.hookWarnings > 0).length,
});

const out = { perArm: {}, perTaskArm: {}, runs: runs.map((r) => ({ id: r.id, task: r.task, arm: r.arm, violations: r.violations, newEdges: r.newEdges, done: r.done, cost: r.cost, tokens: tokens(r.usage), reads: r.reads, searches: r.searches, turns: r.turns, faultlineCalls: r.faultlineCalls, hookWarnings: r.hookWarnings, minutes: (r.durationMs ?? r.wallMs) / 60000 })) };
for (const [arm, rs] of Object.entries(byArm)) out.perArm[arm] = summarise(rs);
for (const [k, rs] of Object.entries(groups)) out.perTaskArm[k] = summarise(rs);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const fmt = (s) => `${String(s.violations).padStart(2)}/${s.runs} violated  ${String(s.done).padStart(2)}/${s.runs} done  ${String(s.cleanAndDone).padStart(2)}/${s.runs} clean+done  $${s.costMean.toFixed(2)}/run  ${Math.round(s.tokensMedian / 1000)}k tok  ${s.readsMedian} reads  ${s.searchesMedian} searches  ${s.turnsMedian} turns  ${s.minutesMedian.toFixed(1)} min  faultline calls ${s.faultlineCallsMean.toFixed(1)}  hook ${s.hookWarned}`;
  console.log("By arm");
  for (const arm of ["none", "docs", "faultline"]) if (out.perArm[arm]) console.log(`  ${arm.padEnd(10)} ${fmt(out.perArm[arm])}`);
  console.log("\nBy task and arm");
  for (const k of Object.keys(out.perTaskArm).sort()) console.log(`  ${k.padEnd(24)} ${fmt(out.perTaskArm[k])}`);
  console.log("\nViolations");
  for (const r of runs.filter((r) => r.violations.length)) console.log(`  ${r.id}: ${r.violations.map((v) => `${v.from} -> ${v.to} (${v.evidence[0]})`).join("; ")}`);
}
