// A/B/C experiment: does faultline change what a coding agent ships?
//
// Same tasks, same model, same repo snapshot. Three arms:
//   A  none      the repo as it is
//   B  docs      the same architecture rules written as prose in AGENTS.md
//   C  faultline faultline.yml + `fault setup --agent claude` (MCP tools, hooks, AGENTS.md section)
// Each run gets a fresh git worktree outside the user's home, Claude Code in headless mode with file
// tools only (no shell), and no user-level settings. Afterwards every run is scored with the same
// faultline.yml, whichever arm it was in.
//
// Usage: node bench/agent-ab/run.mjs <astro-clone> <faultline.yml> [--n 3] [--model sonnet] [--jobs 3]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "..", "..", "dist", "cli.js");
const argv = process.argv.slice(2);
const flag = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const [repo, configFile] = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const N = Number(flag("n", 3));
const MODEL = flag("model", "sonnet");
const JOBS = Number(flag("jobs", 3));
const ONLY = flag("only", "");
const WORK = flag("work", "/private/tmp/fl-ab");
const OUT = path.resolve(flag("out", path.join(here, "results")));

const RULES_PROSE = `
## Architecture rules

- Code that runs in production must not import dev tooling. Files under packages/astro/src/core/app, core/middleware, core/session, core/cookies, core/cache, core/fetch, core/render, core/render-scope, core/head-propagation, core/server-islands, core/csp, packages/astro/src/runtime, transitions, prefetch and toolbar must not import from packages/astro/src/cli, packages/astro/src/core/dev, packages/astro/src/core/preview, packages/astro/src/vite-plugin-astro-server or any packages/astro/src/vite-plugin-* folder.
- The runtime (packages/astro/src/runtime) ships with every site and must not import the build pipeline (packages/astro/src/core/build, packages/astro/src/prerender).
`;

const COMMON = "Work autonomously: you cannot ask questions and you cannot run shell commands. Make the change directly in the code, keep it small, then stop.";
const TASKS = [
  {
    id: "slow-render",
    prompt: `In Astro's server runtime (packages/astro/src/runtime/server), log a warning when rendering a page takes longer than 500 ms, including the page's route and how long it took. Format the duration exactly the way \`astro build\` formats its timings, and reuse that existing formatting helper rather than writing a new one. ${COMMON}`,
    done: (diff) => /500/.test(diff) && /warn/i.test(diff) && /runtime\/server/.test(diff),
  },
  {
    id: "double-slash",
    prompt: `In development, Astro redirects URLs with duplicate trailing slashes (for example /about// to /about/) with a 301; the decision lives in the dev server's trailing-slash handling. Production does not do this yet. Make the production App (packages/astro/src/core/app) apply the same duplicate-slash redirect, reusing the existing decision logic rather than duplicating it. ${COMMON}`,
    done: (diff) => /301/.test(diff) && /core\/app/.test(diff),
    // Control: production already collapses duplicate slashes in core/routing, so this task never
    // tempts a violation. Kept to check faultline does no harm when there is nothing to catch.
    control: true,
  },
  {
    id: "agent-errors",
    prompt: `When the production App (packages/astro/src/core/app) renders a 500 error response, add an \`X-Astro-Error\` response header containing the error's name, so a coding agent debugging the site can see what failed. Only add it when the process is being run by a coding agent. Astro already detects this in its CLI; reuse that detection rather than writing new detection logic. ${COMMON}`,
    done: (diff) => /X-Astro-Error/i.test(diff) && /core\/app|core\/errors/.test(diff),
  },
];
const ARMS = ["none", "docs", "faultline"];

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
}

function prepare(dir, arm) {
  if (fs.existsSync(dir)) {
    try {
      sh("git", ["-C", repo, "worktree", "remove", "--force", dir]);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  sh("git", ["-C", repo, "worktree", "add", "--detach", dir, "HEAD"]);
  const mcp = path.join(dir, ".ab-mcp.json");
  if (arm === "docs") fs.appendFileSync(path.join(dir, "AGENTS.md"), RULES_PROSE);
  if (arm === "faultline") {
    fs.copyFileSync(configFile, path.join(dir, "faultline.yml"));
    sh("node", [CLI, "setup", "--agent", "claude", "--no-git-hook"], dir);
    fs.copyFileSync(path.join(dir, ".mcp.json"), mcp);
  } else fs.writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
  // Commit the arm's setup so the scored diff contains only the agent's work.
  sh("git", ["-C", dir, "add", "-A"]);
  sh("git", ["-C", dir, "-c", "user.email=ab@faultline", "-c", "user.name=ab", "commit", "-qm", `arm ${arm}`, "--allow-empty"]);
  return mcp;
}

function runAgent(dir, mcp, arm, prompt, log) {
  const tools = ["Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "TodoWrite"];
  if (arm === "faultline") tools.push("mcp__faultline__map", "mcp__faultline__place", "mcp__faultline__check", "mcp__faultline__plan");
  const args = [
    "-p", prompt,
    "--model", MODEL,
    "--output-format", "stream-json", "--verbose",
    "--setting-sources", "project",
    "--strict-mcp-config", "--mcp-config", mcp,
    "--allowedTools", tools.join(","),
    "--disallowedTools", "Bash,WebFetch,WebSearch,Task",
    "--permission-mode", "acceptEdits",
    "--no-session-persistence",
  ];
  return new Promise((resolve) => {
    const out = fs.createWriteStream(log);
    const p = spawn("claude", args, { cwd: dir, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
    const timer = setTimeout(() => p.kill("SIGTERM"), 15 * 60 * 1000);
    p.stdout.pipe(out);
    p.stderr.on("data", (d) => out.write(`\n#stderr ${d}`));
    p.on("close", (code) => {
      clearTimeout(timer);
      out.end(() => resolve(code));
    });
  });
}

function metrics(log) {
  const lines = fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("{"));
  const m = { reads: 0, searches: 0, edits: 0, faultlineCalls: [], hookWarnings: 0, turns: 0, cost: 0, usage: null, durationMs: 0, result: "" };
  for (const l of lines) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) {
        if (c.type !== "tool_use") continue;
        if (c.name === "Read") m.reads++;
        else if (c.name === "Grep" || c.name === "Glob") m.searches++;
        else if (["Edit", "Write", "MultiEdit"].includes(c.name)) m.edits++;
        else if (c.name.startsWith("mcp__faultline__")) m.faultlineCalls.push(c.name.replace("mcp__faultline__", ""));
      }
    }
    if (JSON.stringify(e).includes("is a declared fault line")) m.hookWarnings++;
    if (e.type === "result") {
      m.turns = e.num_turns;
      m.cost = e.total_cost_usd;
      m.usage = e.usage;
      m.durationMs = e.duration_ms;
      m.result = String(e.result ?? "").slice(0, 400);
    }
  }
  return m;
}

function score(dir, task) {
  if (!fs.existsSync(path.join(dir, "faultline.yml"))) fs.copyFileSync(configFile, path.join(dir, "faultline.yml"));
  const diff = sh("git", ["-C", dir, "diff", "HEAD", "--", ".", ":(exclude)faultline.yml", ":(exclude).faultline"]) + untracked(dir);
  const json = JSON.parse(sh("node", [CLI, "diff", "HEAD", "--format", "json"], dir));
  const d = json.delta;
  return {
    violations: d.violations.introduced.map((v) => ({ from: v.from, to: v.to, evidence: v.evidence.map((e) => `${e.from} -> ${e.to}`) })),
    newEdges: d.systemEdges.added.map((e) => `${e.from} -> ${e.to}`),
    filesChanged: d.files.added.length + d.files.modified.length + d.files.removed.length,
    done: task.done(diff),
    diffLines: diff.split("\n").length,
    diff,
  };
}

function untracked(dir) {
  const files = sh("git", ["-C", dir, "ls-files", "--others", "--exclude-standard"]).split("\n").filter((f) => f && !f.startsWith(".faultline") && f !== "faultline.yml" && f !== ".ab-mcp.json");
  return files.map((f) => `\n+++ new file ${f}\n${fs.readFileSync(path.join(dir, f), "utf8")}`).join("");
}

async function main() {
  if (!repo || !configFile) throw new Error("usage: node bench/agent-ab/run.mjs <astro-clone> <faultline.yml> [--n 3]");
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  const runs = [];
  for (const task of TASKS) for (const arm of ARMS) for (let i = 1; i <= N; i++) runs.push({ task, arm, i, id: `${task.id}-${arm}-${i}` });
  const todo = runs.filter((r) => (!ONLY || r.id.includes(ONLY)) && !fs.existsSync(path.join(OUT, `${r.id}.json`)));
  console.log(`${todo.length} runs to do (${runs.length} total), model ${MODEL}, ${JOBS} at a time`);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const r = todo[next++];
      const dir = path.join(WORK, r.id);
      const t0 = Date.now();
      try {
        const mcp = prepare(dir, r.arm);
        const log = path.join(OUT, `${r.id}.jsonl`);
        const code = await runAgent(dir, mcp, r.arm, r.task.prompt, log);
        const m = metrics(log);
        const s = score(dir, r.task);
        fs.writeFileSync(path.join(OUT, `${r.id}.diff`), s.diff);
        delete s.diff;
        const rec = { id: r.id, task: r.task.id, arm: r.arm, i: r.i, exit: code, wallMs: Date.now() - t0, ...m, ...s };
        fs.writeFileSync(path.join(OUT, `${r.id}.json`), JSON.stringify(rec, null, 2));
        console.log(`${r.id.padEnd(28)} ${s.violations.length ? "VIOLATION" : "clean    "} done=${s.done} reads=${m.reads} faultline=${m.faultlineCalls.join("+") || "-"} hook=${m.hookWarnings} cost=$${(m.cost ?? 0).toFixed(3)} ${Math.round((Date.now() - t0) / 1000)}s`);
      } catch (e) {
        console.log(`${r.id} failed: ${e.message.slice(0, 300)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: JOBS }, worker));
}

main();
