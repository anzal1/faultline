#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { configPath, DEFAULT_IGNORE, serializeConfig, systemName } from "./config.js";
import { findRoot, Workspace } from "./context.js";
import { findings } from "./describe.js";
import { aggregate } from "./graph.js";
import picomatch from "picomatch";
import { collectProposeInput, draftConfig, outline, proposeWithClaude } from "./propose.js";
import { renderMarkdown } from "./render/markdown.js";
import { bold, dim, green, red, renderText, yellow } from "./render/text.js";
import { agentDiff, overview, place, withCost } from "./agent.js";
import { addToPlan, loadPlan, parsePlanLine, removeFromPlan } from "./plan.js";
import { INDEX, makeSource } from "./source.js";

const HELP = `${bold("fault")}: a living architecture map for any codebase, any language, any agent

  fault init [--force]               Propose systems from the repo and write faultline.yml
        --outline  print the outline for your agent to name   --ai  name them with Claude
  fault map [--base <ref>]           Open the live map; it redraws as you (or an agent) edit
  fault diff [base] [head]           Structural diff. Defaults: HEAD → working tree
        --format text|markdown|json|agent  --verbose  --out <file>
  fault check [base] [head]          Exit 1 if the change crosses a fault line (CI, pre-commit)
        --staged  --strict (also fail on new cycles)  --quiet
  fault export [base] [head] -o f    Self-contained HTML map of a change, to share
  fault replay <from> [to] -o f      Replay history commit by commit as a map timeline
        --max <n>  --worktree [label]   end with uncommitted changes

For agents (compact answers, a few hundred tokens each):
  fault setup [--agent all|claude,cursor,codex,copilot,gemini,kiro,zed,opencode]
                                     Register the MCP server, hooks, AGENTS.md and a pre-commit hook
  fault mcp                          MCP server over stdio: tools map, place, check, plan
  fault overview [system]            The architecture in one screen
  fault footprint [entry]            What an entry loads at startup, and where to cut it
        no entry: list the entries in package.json, main.go, main.rs...  --why <pkg>  --format json
  fault place <path> [imports...]    Which system a path belongs to and what it may import
  fault plan ["a -> b: why"] [--remove "a -> b"]   Declare intended new dependencies
  fault hook --agent <name>          Hook entry point for Claude Code, Codex, Copilot, Cursor

Systems live in faultline.yml. Commit it: it is the map everyone shares.`;

export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  const valued = new Set(["why", "format", "out", "o", "base", "port", "max", "target", "label", "head", "title", "worktree", "map-url", "note", "agent", "remove", "cwd"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) out.flags[k] = v;
      else if (valued.has(k) && argv[i + 1] && !argv[i + 1].startsWith("-")) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else if (a.startsWith("-") && a.length === 2) {
      const k = a.slice(1);
      if (valued.has(k) && argv[i + 1]) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

async function cmdInit(args: Args) {
  const root = findRoot(process.cwd());
  const file = configPath(root);
  if (fs.existsSync(file) && !args.flags.force) {
    console.error(`faultline.yml already exists at ${file}. Use --force to regenerate it.`);
    process.exit(1);
  }
  process.stderr.write(dim("Reading the code and its imports…\n"));
  const draft = await draftConfig(root, { target: args.flags.target ? Number(args.flags.target) : undefined, keepAll: !!args.flags["keep-all"] });
  if (draft.stats.files === 0) {
    console.error("No source files found in any supported language.");
    process.exit(1);
  }
  const all = await collectProposeInput(makeSource(root, undefined));
  const skip = picomatch(draft.config.ignore);
  const input = { ...all, files: all.files.filter((f) => !skip(f)) };
  let systems = draft.config.systems;
  if (args.flags.outline) {
    // Provider-neutral naming: hand the outline and the draft to whichever agent you already use.
    console.log("Name these systems well and write faultline.yml. Group directories into 8 to 16 systems, one responsibility each, using the team's own words.\n");
    console.log("Directory outline (source files only):\n" + outline(input.files) + "\n");
    console.log("Mechanical draft:\n" + systems.map((s) => `- ${s.id}: ${s.name} [${s.paths.join(", ")}]`).join("\n"));
    return;
  }
  let how = "from the directory structure";
  const wantAi = args.flags.ai || (process.env.ANTHROPIC_API_KEY && !args.flags["no-ai"]);
  if (wantAi) {
    try {
      const readmePath = ["README.md", "readme.md", "README"].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
      process.stderr.write(dim("Asking Claude to name the systems…\n"));
      systems = await proposeWithClaude(input, systems, readmePath ? fs.readFileSync(readmePath, "utf8") : "");
      how = "by Claude, from the directory structure and README";
    } catch (e) {
      process.stderr.write(yellow(`Claude proposal failed (${(e as Error).message}); keeping the structural draft.\n`));
    }
  }
  const config = { ...draft.config, systems };
  fs.writeFileSync(file, serializeConfig(config));
  const ws = new Workspace(root, config);
  const model = await ws.model(undefined);
  const counts = new Map<string, number>();
  for (const f of Object.values(model.files)) counts.set(f.system, (counts.get(f.system) ?? 0) + 1);
  console.log(`${green("✓")} Wrote ${bold("faultline.yml")} with ${systems.length} systems, proposed ${how}.\n`);
  for (const s of systems) console.log(`  ${bold(s.name.padEnd(34))} ${dim(String(counts.get(s.id) ?? 0).padStart(5) + " files")}  ${dim(s.paths.join(", "))}`);
  const unmapped = counts.get("unmapped") ?? 0;
  if (unmapped) console.log(`  ${yellow("Unmapped".padEnd(34))} ${dim(String(unmapped).padStart(5) + " files")}`);
  const extraIgnore = draft.config.ignore.filter((g) => !DEFAULT_IGNORE.includes(g));
  if (extraIgnore.length) console.log(dim(`\n  Left out as non-product code: ${extraIgnore.join(", ")} (see ignore: in faultline.yml)`));
  console.log(`\nEdit names and paths until the boxes match how your team talks about the code, then run ${bold("fault map")}.`);
  console.log(dim("Add rules to turn edges into fault lines, e.g.  rules: [{ deny: \"ui -> db\", reason: \"UI goes through the API\" }]"));
}

async function cmdDiff(args: Args) {
  const ws = Workspace.open();
  const [base, head] = args._;
  const { delta, headModel } = await ws.diff(base, head);
  const format = String(args.flags.format ?? "text");
  let out: string;
  if (format === "json") out = JSON.stringify({ delta, findings: findings(delta, ws.config) }, null, 2);
  else if (format === "agent") out = withCost(agentDiff(delta, ws.config, headModel, ws.root));
  else if (format === "markdown" || format === "md") out = renderMarkdown(delta, headModel, ws.config, { mapUrl: args.flags["map-url"] as string | undefined, plan: loadPlan(ws.root) });
  else out = renderText(delta, ws.config, { verbose: !!args.flags.verbose });
  const target = (args.flags.out ?? args.flags.o) as string | undefined;
  if (target) fs.writeFileSync(target, out + "\n");
  else console.log(out);
}

async function cmdCheck(args: Args) {
  const ws = Workspace.open();
  let [base, head] = args._;
  if (args.flags.staged) {
    base = base ?? "HEAD";
    head = INDEX;
  }
  const { delta } = await ws.diff(base, head);
  const failed = delta.violations.introduced.length > 0 || (args.flags.strict && delta.cycles.added.length > 0);
  if (!args.flags.quiet || failed) console.log(renderText(delta, ws.config, { verbose: true }));
  if (failed) {
    console.log(`\n${red("✖ fault check failed")}: this change crosses a declared fault line.`);
    process.exit(1);
  }
  if (!args.flags.quiet) console.log(`\n${green("✓ fault check passed")}`);
}

async function cmdOverview(args: Args) {
  const ws = Workspace.open();
  console.log(withCost(await overview(ws, { system: args._[0] })));
}

async function cmdPlace(args: Args) {
  const ws = Workspace.open();
  const [p, ...imports] = args._;
  if (!p) throw new Error("Usage: fault place <path> [import targets...]");
  console.log(withCost(await place(ws, p, imports)));
}

async function cmdPlan(args: Args) {
  const ws = Workspace.open();
  const ids = new Set(ws.config.systems.map((s) => s.id));
  for (const line of args._) {
    const e = parsePlanLine(line);
    if (!e || !ids.has(e.from) || !ids.has(e.to)) throw new Error(`"${line}" is not "from -> to: why" with system ids (${[...ids].join(", ")})`);
    addToPlan(ws.root, [e], "cli");
  }
  if (typeof args.flags.remove === "string") {
    const e = parsePlanLine(args.flags.remove);
    if (e) removeFromPlan(ws.root, e.from, e.to);
  }
  const plan = loadPlan(ws.root);
  if (!plan.edges.length) console.log(dim("No planned dependencies. Add one: fault plan \"api -> billing: needs invoices\""));
  for (const e of plan.edges) console.log(`${e.from} → ${e.to}${e.why ? dim(`  ${e.why}`) : ""}`);
}

async function cmdSystems() {
  const ws = Workspace.open();
  const model = await ws.model(undefined);
  const edges = aggregate(model, "system");
  const counts = new Map<string, number>();
  for (const f of Object.values(model.files)) counts.set(f.system, (counts.get(f.system) ?? 0) + 1);
  for (const s of [...ws.config.systems.map((s) => s.id), "unmapped"]) {
    if (!counts.get(s)) continue;
    const outs = edges.filter((e) => e.from === s && !e.typeOnly);
    console.log(`${bold(systemName(ws.config, s))} ${dim(`(${counts.get(s)} files)`)}`);
    if (outs.length) console.log(`  → ${outs.map((e) => `${systemName(ws.config, e.to)} ${dim(String(e.count))}`).join(", ")}`);
  }
}

async function cmdFootprint(args: Args) {
  const { detectEntries, footprint } = await import("./footprint.js");
  const ws = Workspace.open();
  const model = await ws.model(undefined);
  const files = Object.keys(model.files);
  const entries = detectEntries(ws.root, files);
  const want = args._[0];
  const json = args.flags.format === "json";
  if (!want) {
    if (json) return console.log(JSON.stringify(entries));
    if (!entries.length) return console.log("No entries found in the manifests. Pass a file: fault footprint src/main.ts");
    for (const e of entries) console.log(`${e.label.padEnd(36)} ${dim(e.path)}`);
    return;
  }
  const asPath = path.relative(ws.root, path.resolve(process.cwd(), want)).split(path.sep).join("/");
  const entry = model.files[asPath] ? asPath : model.files[want] ? want : (entries.find((e) => e.label === want) ?? entries.filter((e) => e.label.endsWith(want)).sort((a, b) => a.label.length - b.label.length)[0])?.path;
  if (!entry) {
    console.error(`No file or entry named "${want}". Run \`fault footprint\` to list the entries.`);
    process.exit(1);
  }
  const fp = footprint(model, entry);
  if (json) return console.log(JSON.stringify({ ...fp, startup: fp.startup.length, onDemand: fp.onDemand.length, startupFiles: fp.startup }));
  const systems = Object.entries(fp.bySystem).filter(([, v]) => v.startup || v.onDemand).sort((a, b) => b[1].startup - a[1].startup);
  const label = entries.find((e) => e.path === entry)?.label;
  // Paths print relative to the folder every loaded file shares, so the lists stay readable.
  const prefix = fp.startup.reduce((p, f) => { while (p && !f.startsWith(p)) p = p.slice(0, p.slice(0, -1).lastIndexOf("/") + 1); return p; }, entry.slice(0, entry.lastIndexOf("/") + 1));
  const short = (f: string) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f);
  console.log(`${bold(label ?? entry)}${label ? dim(`  ${entry}`) : ""}`);
  console.log(`Loads ${bold(String(fp.startup.length))} files at startup across ${systems.filter(([, v]) => v.startup).length} systems${fp.onDemand.length ? `, ${fp.onDemand.length} more on demand` : ""}.`);
  for (const [id, v] of systems) console.log(`  ${systemName(ws.config, id).padEnd(26)} ${String(v.startup).padStart(4)} of ${v.total}${v.onDemand ? dim(`  +${v.onDemand} on demand`) : ""}`);
  if (fp.packages.length) console.log(`npm at startup: ${fp.packages.join(", ")}`);
  if (fp.cuts.length) {
    console.log(`\nCut points${prefix ? dim(` (paths under ${prefix})`) : ""}: stop importing the file and this many files stop loading at startup`);
    // The top cuts by size, plus every cut that takes an npm package off the startup path.
    for (const c of fp.cuts.filter((c, i) => i < (args.flags.verbose ? 12 : 6) || c.packages.length)) {
      const by = c.importers.slice(0, 3).map((i) => `${short(i.file)}${i.names.length ? ` {${i.names.slice(0, 3).join(", ")}}` : ""}`).join(", ") + (c.importers.length > 3 ? ` and ${c.importers.length - 3} more` : "");
      console.log(`  ${String(c.drops).padStart(4)}  ${short(c.file)}${c.packages.length ? yellow(`  drops ${c.packages.join(", ")}`) : ""}\n        ${dim(`imported by ${by}`)}`);
    }
  }
  const why = typeof args.flags.why === "string" ? args.flags.why : undefined;
  if (why) {
    const { chainTo } = await import("./footprint.js");
    const users = model.externals.filter((u) => u.pkg === why && !u.typeOnly && !u.dynamic && fp.startup.includes(u.file));
    console.log(`\nWhy ${bold(why)} loads at startup${users.length ? "" : ": it does not"}`);
    const names = new Map(model.edges.map((e) => [`${e.from}\0${e.to}`, e.names]));
    for (const u of users) {
      const chain = chainTo(model, entry, u.file);
      console.log(`  ${chain.map((f, i) => (i ? `${short(f)}${dim(` {${(names.get(`${chain[i - 1]}\0${f}`) ?? []).slice(0, 3).join(", ")}}`)}` : short(f))).join(dim(" > "))}`);
    }
  }
}

async function main() {
  let argv = process.argv.slice(2);
  // `fault -C <dir> <command>` runs as if started in <dir>, like git -C.
  while (argv[0] === "-C" && argv[1]) {
    process.chdir(argv[1]);
    argv = argv.slice(2);
  }
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case "init":
      return cmdInit(args);
    case "diff":
      return cmdDiff(args);
    case "check":
      return cmdCheck(args);
    case "systems":
      return cmdSystems();
    case "overview":
      return cmdOverview(args);
    case "footprint":
      return cmdFootprint(args);
    case "place":
      return cmdPlace(args);
    case "plan":
      return cmdPlan(args);
    case "mcp": {
      const { cmdMcp } = await import("./mcp.js");
      return cmdMcp(args);
    }
    case "setup": {
      const { cmdSetup } = await import("./setup.js");
      return cmdSetup(args);
    }
    case "install-git-hook": {
      const { cmdInstallGitHook } = await import("./setup.js");
      return cmdInstallGitHook(args);
    }
    case "map":
    case "watch": {
      const { cmdMap } = await import("./server.js");
      return cmdMap(args);
    }
    case "export": {
      const { cmdExport } = await import("./export.js");
      return cmdExport(args);
    }
    case "replay": {
      const { cmdReplay } = await import("./export.js");
      return cmdReplay(args);
    }
    case "hook": {
      const { cmdHook } = await import("./hook.js");
      return cmdHook(args);
    }
    case "install-hook": {
      const { cmdInstallHook } = await import("./hook.js");
      return cmdInstallHook(args);
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command "${cmd}".\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(red(`fault: ${(e as Error).message}`));
  if (process.env.FAULTLINE_DEBUG) console.error(e);
  process.exit(1);
});
