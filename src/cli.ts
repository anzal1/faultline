#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { configPath, serializeConfig, systemName } from "./config.js";
import { findRoot, Workspace } from "./context.js";
import { findings } from "./describe.js";
import { aggregate } from "./graph.js";
import picomatch from "picomatch";
import { collectProposeInput, defaultConfig, proposeHeuristic, proposeWithClaude, skipGlobs } from "./propose.js";
import { renderMarkdown } from "./render/markdown.js";
import { bold, dim, green, red, renderText, yellow } from "./render/text.js";
import { makeSource } from "./source.js";

const HELP = `${bold("fault")}: a living architecture map for your codebase

  fault init [--ai] [--force]        Propose systems from the repo and write faultline.yml
  fault map [--base <ref>]           Open the live map; it redraws as you (or an agent) edit
  fault diff [base] [head]           Structural diff. Defaults: HEAD → working tree
        --format text|markdown|json  --verbose  --out <file>
  fault check [base] [head]          Exit 1 if the change crosses a fault line (for CI)
        --strict                     also fail on new dependency cycles
  fault export [base] [head] -o f    Self-contained HTML map of a change, to share
  fault replay <from> [to] -o f      Replay history commit by commit as a map timeline
        --max <n>  --worktree [label]   end with uncommitted changes
  fault hook                         Claude Code hook entry point (reads the event on stdin)
  fault install-hook                 Add faultline to .claude/settings.json in this repo
  fault systems                      Print the declared systems and their dependencies

Systems live in faultline.yml. Commit it: it is the map everyone shares.`;

export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  const valued = new Set(["format", "out", "o", "base", "port", "max", "target", "label", "head", "title", "worktree", "map-url", "note"]);
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
  const all = await collectProposeInput(makeSource(root, undefined));
  const extraIgnore = args.flags["keep-all"] ? [] : skipGlobs(all.files);
  const skip = picomatch(extraIgnore);
  const input = { ...all, files: all.files.filter((f) => !skip(f)) };
  if (input.files.length === 0) {
    console.error("No JavaScript or TypeScript source files found.");
    process.exit(1);
  }
  let systems = proposeHeuristic(input, args.flags.target ? Number(args.flags.target) : undefined);
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
  const config = defaultConfig(systems, extraIgnore);
  fs.writeFileSync(file, serializeConfig(config));
  const ws = new Workspace(root, config);
  const model = await ws.model(undefined);
  const counts = new Map<string, number>();
  for (const f of Object.values(model.files)) counts.set(f.system, (counts.get(f.system) ?? 0) + 1);
  console.log(`${green("✓")} Wrote ${bold("faultline.yml")} with ${systems.length} systems, proposed ${how}.\n`);
  for (const s of systems) console.log(`  ${bold(s.name.padEnd(34))} ${dim(String(counts.get(s.id) ?? 0).padStart(5) + " files")}  ${dim(s.paths.join(", "))}`);
  const unmapped = counts.get("unmapped") ?? 0;
  if (unmapped) console.log(`  ${yellow("Unmapped".padEnd(34))} ${dim(String(unmapped).padStart(5) + " files")}`);
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
  else if (format === "markdown" || format === "md") out = renderMarkdown(delta, headModel, ws.config, { mapUrl: args.flags["map-url"] as string | undefined });
  else out = renderText(delta, ws.config, { verbose: !!args.flags.verbose });
  const target = (args.flags.out ?? args.flags.o) as string | undefined;
  if (target) fs.writeFileSync(target, out + "\n");
  else console.log(out);
}

async function cmdCheck(args: Args) {
  const ws = Workspace.open();
  const [base, head] = args._;
  const { delta } = await ws.diff(base, head);
  console.log(renderText(delta, ws.config, { verbose: true }));
  const failed = delta.violations.introduced.length > 0 || (args.flags.strict && delta.cycles.added.length > 0);
  if (failed) {
    console.log(`\n${red("✖ fault check failed")}: this change crosses a declared fault line.`);
    process.exit(1);
  }
  console.log(`\n${green("✓ fault check passed")}`);
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
