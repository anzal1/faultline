// Summarise bench/agent-ab/results into per-arm numbers. Usage: node bench/agent-ab/analyze.mjs [results-dir] [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : path.join(here, "results"));
// Graders live here, applied to each run's saved diff, so a grading fix re-scores every run the same way.
const GRADERS = {
  "slow-render": (d) => /500/.test(d) && /warn/i.test(d) && /runtime\/server/.test(d),
  "double-slash": (d) => /301/.test(d) && /core\/app/.test(d),
  "agent-errors": (d) => /headers\.(set|append)\(/.test(d) && /X-Astro-Error|ASTRO_ERROR_HEADER/i.test(d),
};
const runs = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const diffFile = path.join(dir, f.replace(/\.json$/, ".diff"));
  const diff = fs.existsSync(diffFile) ? fs.readFileSync(diffFile, "utf8") : "";
  const grader = GRADERS[r.task.split("@")[0]];
  if (grader) r.done = grader(diff);
  return r;
});

/** Two-sided Fisher exact test on a 2x2 table [[a, b], [c, d]]. */
function fisher(a, b, c, d) {
  const lf = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
  const p = (x) => Math.exp(lf(a + b) + lf(c + d) + lf(a + c) + lf(b + d) - lf(a + b + c + d) - lf(x) - lf(a + b - x) - lf(a + c - x) - lf(d - a + x));
  const obs = p(a);
  let sum = 0;
  for (let x = Math.max(0, a + c - (c + d)); x <= Math.min(a + b, a + c); x++) { const q = p(x); if (q <= obs + 1e-12) sum += q; }
  return Math.min(1, sum);
}
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

// The comparison that matters: tasks whose tempting import is covered by a declared rule.
const covered = runs.filter((r) => r.task === "slow-render" || r.task === "agent-errors@2");
const crossed = (arm) => covered.filter((r) => r.arm === arm && r.violations.length).length;
const total = (arm) => covered.filter((r) => r.arm === arm).length;
out.covered = {
  tasks: ["slow-render", "agent-errors@2"],
  none: { crossed: crossed("none"), runs: total("none") },
  docs: { crossed: crossed("docs"), runs: total("docs") },
  faultline: { crossed: crossed("faultline"), runs: total("faultline") },
  pFaultlineVsDocs: fisher(crossed("faultline"), total("faultline") - crossed("faultline"), crossed("docs"), total("docs") - crossed("docs")),
  pFaultlineVsNone: fisher(crossed("faultline"), total("faultline") - crossed("faultline"), crossed("none"), total("none") - crossed("none")),
  pFaultlineVsBoth: fisher(crossed("faultline"), total("faultline") - crossed("faultline"), crossed("none") + crossed("docs"), total("none") + total("docs") - crossed("none") - crossed("docs")),
};
out.faultlineUsedTools = runs.filter((r) => r.arm === "faultline" && r.faultlineCalls.length).length + "/" + runs.filter((r) => r.arm === "faultline").length;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const fmt = (s) => `${String(s.violations).padStart(2)}/${s.runs} violated  ${String(s.done).padStart(2)}/${s.runs} done  ${String(s.cleanAndDone).padStart(2)}/${s.runs} clean+done  $${s.costMean.toFixed(2)}/run  ${Math.round(s.tokensMedian / 1000)}k tok  ${s.readsMedian} reads  ${s.searchesMedian} searches  ${s.turnsMedian} turns  ${s.minutesMedian.toFixed(1)} min  faultline calls ${s.faultlineCallsMean.toFixed(1)}  hook ${s.hookWarned}`;
  console.log("By arm");
  for (const arm of ["none", "docs", "faultline"]) if (out.perArm[arm]) console.log(`  ${arm.padEnd(10)} ${fmt(out.perArm[arm])}`);
  console.log("\nBy task and arm");
  for (const k of Object.keys(out.perTaskArm).sort()) console.log(`  ${k.padEnd(24)} ${fmt(out.perTaskArm[k])}`);
  const c = out.covered;
  console.log(`\nRule covers the tempting import (${c.tasks.join(", ")}): none ${c.none.crossed}/${c.none.runs}, docs ${c.docs.crossed}/${c.docs.runs}, faultline ${c.faultline.crossed}/${c.faultline.runs} crossed`);
  console.log(`  Fisher exact p: faultline vs docs ${c.pFaultlineVsDocs.toFixed(3)}, vs none ${c.pFaultlineVsNone.toFixed(3)}, vs both ${c.pFaultlineVsBoth.toFixed(3)}`);
  console.log(`  faultline runs that called its tools: ${out.faultlineUsedTools}`);
  console.log("\nViolations");
  for (const r of runs.filter((r) => r.violations.length)) console.log(`  ${r.id}: ${r.violations.map((v) => `${v.from} -> ${v.to} (${v.evidence[0]})`).join("; ")}`);
}
