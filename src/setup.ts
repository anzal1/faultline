import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Args } from "./cli.js";
import { findRoot } from "./context.js";
import { bold, dim, green, yellow } from "./render/text.js";

/**
 * Wires faultline into whichever coding agents a repo uses. Every agent gets the same MCP server and
 * the same AGENTS.md section; agents with hooks also hear about a crossed fault line mid-turn.
 */

type Writer = { id: string; label: string; detect: (root: string) => boolean; write: (root: string, cmd: Cmd) => string[] };
interface Cmd {
  exe: string;
  args: string[];
  line: string; // shell form for hook commands
}

const START = "<!-- faultline:start -->";
const END = "<!-- faultline:end -->";

const AGENTS_SECTION = `${START}
## Architecture: faultline

This repo declares its architecture in \`faultline.yml\` (systems and fault lines). Ask the map instead of exploring folders:

- \`map\`: systems, what each owns, dependencies, forbidden imports. Read once per task.
- \`place <path> [imports]\`: where a new file belongs and whether its imports are allowed.
- \`check\`: after editing, what your change did to the structure.
- \`plan "from -> to: why"\`: declare a new dependency between systems before writing it.

Use the faultline MCP tools, or the CLI: \`npx -y @anzal1/faultline <command>\`.
Fault lines are hard rules. If \`check\` reports one, route the import through an allowed system (it suggests one) instead of editing \`faultline.yml\`.
${END}`;

function readJson(file: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function upsertSection(file: string, section: string) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (text.includes(START) && text.includes(END)) text = text.replace(new RegExp(`${START}[\\s\\S]*?${END}`), section);
  else text = (text.trimEnd() ? text.trimEnd() + "\n\n" : "") + section + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function pointer(file: string, note: string) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (text.includes("faultline")) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (text.trimEnd() ? text.trimEnd() + "\n\n" : "") + note + "\n");
}

const exists = (root: string, p: string) => fs.existsSync(path.join(root, p));

const mcpEntry = (cmd: Cmd) => ({ command: cmd.exe, args: [...cmd.args, "mcp"] });

const WRITERS: Writer[] = [
  {
    id: "claude",
    label: "Claude Code",
    detect: (r) => exists(r, ".claude") || exists(r, "CLAUDE.md") || exists(r, ".mcp.json"),
    write(root, cmd) {
      const mcp = readJson(path.join(root, ".mcp.json"));
      (mcp.mcpServers ??= {}).faultline = mcpEntry(cmd);
      writeJson(path.join(root, ".mcp.json"), mcp);
      const settingsFile = path.join(root, ".claude", "settings.json");
      const settings = readJson(settingsFile);
      settings.hooks ??= {};
      const hook = { type: "command", command: `${cmd.line} hook --agent claude` };
      const add = (event: string, matcher?: string) => {
        const list: any[] = (settings.hooks[event] ??= []);
        if (!list.some((g) => (g.hooks ?? []).some((h: any) => String(h.command).includes(" hook")) && JSON.stringify(g).includes("faultline"))) {
          list.push({ ...(matcher ? { matcher } : {}), hooks: [hook] });
        }
      };
      add("PostToolUse", "Edit|Write|MultiEdit");
      add("Stop");
      writeJson(settingsFile, settings);
      pointer(path.join(root, "CLAUDE.md"), "Architecture rules and the faultline tools are described in @AGENTS.md.");
      return [".mcp.json", ".claude/settings.json (hooks)", "CLAUDE.md"];
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    detect: (r) => exists(r, ".cursor") || exists(r, ".cursorrules"),
    write(root, cmd) {
      const f = path.join(root, ".cursor", "mcp.json");
      const mcp = readJson(f);
      (mcp.mcpServers ??= {}).faultline = mcpEntry(cmd);
      writeJson(f, mcp);
      const hf = path.join(root, ".cursor", "hooks.json");
      const hooks = readJson(hf);
      hooks.version ??= 1;
      hooks.hooks ??= {};
      for (const ev of ["afterFileEdit", "stop"]) {
        const list: any[] = (hooks.hooks[ev] ??= []);
        if (!list.some((h) => String(h.command).includes("faultline"))) list.push({ command: `${cmd.line} hook --agent cursor` });
      }
      writeJson(hf, hooks);
      return [".cursor/mcp.json", ".cursor/hooks.json"];
    },
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    detect: (r) => exists(r, ".codex"),
    write(root, cmd) {
      const f = path.join(root, ".codex", "config.toml");
      let toml = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
      const q = (s: string) => JSON.stringify(s);
      if (!toml.includes("[mcp_servers.faultline]")) {
        toml += `${toml.trim() ? "\n" : ""}[mcp_servers.faultline]\ncommand = ${q(cmd.exe)}\nargs = [${[...cmd.args, "mcp"].map(q).join(", ")}]\n`;
      }
      if (!toml.includes("hook --agent codex")) {
        toml += `\n[[hooks.PostToolUse]]\n[[hooks.PostToolUse.hooks]]\ntype = "command"\ncommand = ${q(`${cmd.line} hook --agent codex`)}\n`;
      }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, toml);
      return [".codex/config.toml (MCP + PostToolUse hook)"];
    },
  },
  {
    id: "copilot",
    label: "GitHub Copilot (VS Code)",
    detect: (r) => exists(r, ".vscode") || exists(r, ".github/copilot-instructions.md"),
    write(root, cmd) {
      const f = path.join(root, ".vscode", "mcp.json");
      const mcp = readJson(f);
      (mcp.servers ??= {}).faultline = { type: "stdio", ...mcpEntry(cmd) };
      writeJson(f, mcp);
      writeJson(path.join(root, ".github", "hooks", "faultline.json"), { hooks: { PostToolUse: [{ type: "command", command: `${cmd.line} hook --agent copilot` }] } });
      pointer(path.join(root, ".github", "copilot-instructions.md"), "Architecture rules and the faultline tools are described in AGENTS.md at the repo root. Read its faultline section before adding files or imports.");
      return [".vscode/mcp.json", ".github/hooks/faultline.json", ".github/copilot-instructions.md"];
    },
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    detect: (r) => exists(r, ".gemini") || exists(r, "GEMINI.md"),
    write(root, cmd) {
      const f = path.join(root, ".gemini", "settings.json");
      const s = readJson(f);
      (s.mcpServers ??= {}).faultline = mcpEntry(cmd);
      writeJson(f, s);
      pointer(path.join(root, "GEMINI.md"), "Architecture rules and the faultline tools are described in AGENTS.md at the repo root.");
      return [".gemini/settings.json", "GEMINI.md"];
    },
  },
  {
    id: "kiro",
    label: "Kiro",
    detect: (r) => exists(r, ".kiro"),
    write(root, cmd) {
      const f = path.join(root, ".kiro", "settings", "mcp.json");
      const s = readJson(f);
      (s.mcpServers ??= {}).faultline = { ...mcpEntry(cmd), disabled: false };
      writeJson(f, s);
      pointer(path.join(root, ".kiro", "steering", "faultline.md"), "Architecture rules and the faultline tools are described in AGENTS.md at the repo root.");
      return [".kiro/settings/mcp.json", ".kiro/steering/faultline.md"];
    },
  },
  {
    id: "zed",
    label: "Zed",
    detect: (r) => exists(r, ".zed"),
    write(root, cmd) {
      const f = path.join(root, ".zed", "settings.json");
      const s = readJson(f);
      (s.context_servers ??= {}).faultline = { source: "custom", command: { path: cmd.exe, args: [...cmd.args, "mcp"] } };
      writeJson(f, s);
      return [".zed/settings.json"];
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    detect: (r) => exists(r, "opencode.json") || exists(r, ".opencode"),
    write(root, cmd) {
      const f = path.join(root, "opencode.json");
      const s = readJson(f);
      (s.mcp ??= {}).faultline = { type: "local", command: [cmd.exe, ...cmd.args, "mcp"], enabled: true };
      writeJson(f, s);
      return ["opencode.json"];
    },
  },
];

export function faultlineCommand(npx: boolean): Cmd {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  // Installed from npm: `npx` works everywhere. Running from a checkout: point at this build.
  if (npx || cli.includes(`${path.sep}node_modules${path.sep}`)) return { exe: "npx", args: ["-y", "@anzal1/faultline"], line: "npx -y @anzal1/faultline" };
  return { exe: process.execPath, args: [cli], line: `"${process.execPath}" "${cli}"` };
}

export async function cmdSetup(args: Args) {
  const root = findRoot(process.cwd());
  const cmd = faultlineCommand(!!args.flags.npx);
  const wanted = String(args.flags.agent ?? "");
  const pick = wanted === "all" ? WRITERS : wanted ? WRITERS.filter((w) => wanted.split(",").includes(w.id)) : WRITERS.filter((w) => w.detect(root));
  upsertSection(path.join(root, "AGENTS.md"), AGENTS_SECTION);
  console.log(`${green("✓")} ${bold("AGENTS.md")}: faultline section (read by Codex, Cursor, Copilot, Zed, OpenCode, Amp, Jules and others)`);
  for (const w of pick) {
    const files = w.write(root, cmd);
    console.log(`${green("✓")} ${bold(w.label)}: ${files.join(", ")}`);
  }
  if (!pick.length) console.log(dim("No agent config folders found. Pass --agent claude,cursor,codex,copilot,gemini,kiro,zed,opencode or --agent all."));
  console.log(dim("\nWindsurf and Cline keep MCP servers in a global file. Add this server there:"));
  console.log(dim(`  { "mcpServers": { "faultline": ${JSON.stringify(mcpEntry(cmd))} } }`));
  if (!args.flags["no-git-hook"]) {
    const hooked = installGitHook(root, cmd);
    if (hooked) console.log(`${green("✓")} ${bold("git pre-commit")}: blocks commits that cross a fault line (skip with --no-verify)`);
  }
}

export function installGitHook(root: string, cmd: Cmd): boolean {
  const gitDir = path.join(root, ".git");
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return false;
  const file = path.join(gitDir, "hooks", "pre-commit");
  const line = `${cmd.line} check --staged --quiet || exit 1`;
  let body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "#!/bin/sh\n";
  if (body.includes("check --staged")) return true;
  if (!body.startsWith("#!")) body = "#!/bin/sh\n" + body;
  body = body.trimEnd() + `\n# faultline: refuse commits that cross a fault line declared in faultline.yml\n${line}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return true;
}

export async function cmdInstallGitHook(_args: Args) {
  const root = findRoot(process.cwd());
  if (installGitHook(root, faultlineCommand(false))) console.log(`${green("✓")} git pre-commit hook installed`);
  else console.log(yellow("Not a git repository with a .git directory; nothing installed."));
}
