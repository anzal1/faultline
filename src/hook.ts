import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Args } from "./cli.js";
import { loadConfig, systemName } from "./config.js";
import { findRoot, Workspace } from "./context.js";
import { findings, importPhrase } from "./describe.js";
import { green, dim, bold } from "./render/text.js";
import { readServerInfo } from "./server.js";
import { git } from "./source.js";

interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
}

interface SessionState {
  base: string;
  reported: string[];
  lastHeadline?: string;
  turns: number;
}

async function readStdin(timeoutMs = 3000): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function sessionFile(root: string, id: string) {
  return path.join(root, ".faultline", "sessions", `${id.replace(/[^\w-]/g, "_")}.json`);
}

function loadSession(root: string, id: string): SessionState {
  const file = sessionFile(root, id);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    let base = "";
    try {
      base = git(root, ["rev-parse", "HEAD"]).trim();
    } catch {
      // not a git repo: nothing to compare against
    }
    return { base, reported: [], turns: 0 };
  }
}

function saveSession(root: string, id: string, s: SessionState) {
  const file = sessionFile(root, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s));
}

async function post(port: number, pathname: string, body: unknown): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    return res.status === 204 ? null : await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Claude Code hook. PostToolUse: if the edit crossed a fault line, tell the agent right away so it can
 * fix it in the same turn. Stop: freeze the turn on the live map and summarise what moved.
 */
export async function cmdHook(_args: Args) {
  const raw = await readStdin();
  let event: HookEvent = {};
  try {
    event = raw ? JSON.parse(raw) : {};
  } catch {
    return;
  }
  const root = findRoot(event.cwd ?? process.cwd());
  const config = loadConfig(root);
  if (!config) return; // repo not using faultline: stay silent
  const ws = new Workspace(root, config);
  const sessionId = event.session_id ?? "default";
  const session = loadSession(root, sessionId);
  if (!session.base) return;
  const server = readServerInfo(root);
  const name = event.hook_event_name ?? "";

  if (name === "PostToolUse") {
    const { delta } = await ws.diff(session.base, undefined);
    const fresh = delta.violations.introduced.filter((v) => !session.reported.includes(`${v.from}->${v.to}`));
    if (server) void post(server.port, "/api/refresh", {});
    if (fresh.length === 0) return saveSession(root, sessionId, session);
    session.reported.push(...fresh.map((v) => `${v.from}->${v.to}`));
    saveSession(root, sessionId, session);
    const n = (id: string) => systemName(config, id);
    const lines = fresh.map((v) => {
      const e = v.evidence[0];
      return `- ${n(v.from)} → ${n(v.to)} is a declared fault line (deny ${v.rule}${v.reason ? `: ${v.reason}` : ""}). ${e ? `${e.from} ${importPhrase(e).replace(/^\S+ /, "")}.` : ""}`;
    });
    const reason =
      `faultline: this edit crosses ${fresh.length === 1 ? "a fault line" : `${fresh.length} fault lines`} declared in faultline.yml:\n${lines.join("\n")}\n` +
      `Route the dependency through an allowed system instead, or ask the user before changing the rule.`;
    process.stdout.write(JSON.stringify({ decision: "block", reason, continueOnBlock: true, systemMessage: `faultline: fault line crossed, ${fresh.map((v) => `${n(v.from)} → ${n(v.to)}`).join(", ")}` }));
    return;
  }

  if (name === "Stop" || name === "SubagentStop") {
    session.turns++;
    let summary: string | null = null;
    if (server) {
      const res = (await post(server.port, "/api/turn", { label: `Agent turn ${session.turns}` })) as { summary?: string } | null;
      summary = res?.summary ?? null;
    }
    const { delta } = await ws.diff(session.base, undefined);
    const f = findings(delta, config).filter((x) => x.severity !== "info");
    const headlineNow = f.map((x) => x.title).join("; ");
    saveSession(root, sessionId, session);
    if (f.length && headlineNow !== session.lastHeadline) {
      session.lastHeadline = headlineNow;
      saveSession(root, sessionId, session);
      process.stdout.write(JSON.stringify({ systemMessage: `faultline: ${summary ?? f.slice(0, 3).map((x) => x.title).join("; ")}` }));
    }
  }
}

export async function cmdInstallHook(args: Args) {
  const root = findRoot(process.cwd());
  const file = path.join(root, ".claude", "settings.json");
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  const command = args.flags.npx ? "npx -y @anzal1/faultline hook" : `"${process.execPath}" "${cli}" hook`;
  let settings: Record<string, any> = {};
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, "utf8"));
  settings.hooks ??= {};
  const ensure = (event: string, matcher: string | undefined) => {
    const list: any[] = (settings.hooks[event] ??= []);
    const present = list.some((g) => (g.hooks ?? []).some((h: any) => typeof h.command === "string" && /fault(line)?\b.*\bhook\b|cli\.js"? hook/.test(h.command)));
    if (present) return false;
    list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });
    return true;
  };
  const a = ensure("PostToolUse", "Edit|Write|MultiEdit");
  const b = ensure("Stop", undefined);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  if (!a && !b) console.log(dim("faultline hooks were already installed in .claude/settings.json"));
  else console.log(`${green("✓")} Added faultline to ${bold(path.relative(process.cwd(), file) || file)}: agents now hear about fault lines the moment they cross one.`);
  console.log(dim("Run `fault map` alongside Claude Code to watch each turn land on the map."));
}
