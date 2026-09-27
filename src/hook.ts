import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Args } from "./cli.js";
import { configPath, loadConfig, parseConfig, systemName } from "./config.js";
import { configAt, describeLoosenings, loosenings } from "./maintain.js";
import { findRoot, Workspace } from "./context.js";
import { allowedRoute } from "./agent.js";
import { findings, importPhrase } from "./describe.js";
import { aggregate } from "./graph.js";
import { compileRules } from "./rules.js";
import { green, dim, bold } from "./render/text.js";
import { readServerInfo } from "./server.js";
import { git, makeSource } from "./source.js";

interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  conversation_id?: string;
  cwd?: string;
  workspace_roots?: string[];
  tool_name?: string;
  tool_input?: { file_path?: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean; edits?: { old_string: string; new_string: string; replace_all?: boolean }[] };
  file_path?: string;
}

type AgentKind = "claude" | "codex" | "copilot" | "cursor" | "generic";

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
export async function cmdHook(args: Args) {
  const raw = await readStdin();
  let event: HookEvent = {};
  try {
    event = raw ? JSON.parse(raw) : {};
  } catch {
    return;
  }
  const agent = (String(args.flags.agent ?? "") || (event.workspace_roots ? "cursor" : "claude")) as AgentKind;
  const root = findRoot(event.cwd ?? event.workspace_roots?.[0] ?? process.cwd());
  const config = loadConfig(root);
  if (!config) return; // repo not using faultline: stay silent
  const name0 = (event.hook_event_name ?? "").toLowerCase();

  // Rules are the user's. An agent may place code (fault sync --apply), never loosen a rule.
  const target = event.tool_input?.file_path ?? event.file_path;
  const touchesConfig = !!target && path.resolve(root, target) === configPath(root);
  const filesNow = async () => [...(await makeSource(root, undefined).list()).keys()];
  if (name0 === "pretooluse") {
    if (!touchesConfig) return;
    const proposed = proposedText(configPath(root), event);
    if (proposed === null) return;
    let after;
    try {
      after = parseConfig(proposed);
      for (const r of after.rules) if (!/->/.test(String(r.deny ?? ""))) throw new Error(`rule ${JSON.stringify(r)} has no "deny: from -> to"`);
    } catch (e) {
      // A broken faultline.yml enforces nothing, so it counts as loosening every rule at once.
      const reason = `faultline: this edit would leave faultline.yml invalid (${(e as Error).message}), which switches every rule off. Keep the file valid; only the user may remove rules.`;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
      return;
    }
    const loose = loosenings(config, after, await filesNow());
    if (!loose.length) return;
    const reason = `faultline: this edit would loosen faultline.yml, and only the user may do that:\n${describeLoosenings(loose)}\nLeave the rules as they are and route the code through an allowed system, or ask the user to change the rule.`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
    return;
  }
  if (touchesConfig && (name0 === "posttooluse" || name0 === "aftertool")) {
    const committed = configAt(root, "HEAD");
    const loose = committed ? loosenings(committed, config, await filesNow()) : [];
    if (loose.length) {
      const reason = `faultline: faultline.yml now allows more than the committed version:\n${describeLoosenings(loose)}\nOnly the user may loosen rules. Restore them (git checkout -- faultline.yml brings back the committed version) unless the user asked for this.`;
      if (agent === "codex" || agent === "copilot") process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: reason }, systemMessage: "faultline: rules loosened" }));
      else process.stdout.write(JSON.stringify({ decision: "block", reason, continueOnBlock: true, systemMessage: "faultline: rules loosened" }));
      return;
    }
  }
  const ws = new Workspace(root, config);
  const sessionId = event.session_id ?? event.conversation_id ?? "default";
  const session = loadSession(root, sessionId);
  if (!session.base) return;
  const server = readServerInfo(root);
  const name = (event.hook_event_name ?? "").toLowerCase();
  const isEdit = name === "posttooluse" || name === "afterfileedit" || name === "aftertool";
  const isStop = name === "stop" || name === "subagentstop" || name === "afteragent";

  const freshFaults = async () => {
    const { delta, headModel } = await ws.diff(session.base, undefined);
    const fresh = delta.violations.introduced.filter((v) => !session.reported.includes(`${v.from}->${v.to}`));
    return { delta, headModel, fresh };
  };
  const describeFaults = (fresh: Awaited<ReturnType<typeof freshFaults>>["fresh"], headModel: Parameters<typeof aggregate>[0]) => {
    const n = (id: string) => systemName(config, id);
    const edges = aggregate(headModel, "system");
    const rules = compileRules(config);
    const lines = fresh.map((v) => {
      const e = v.evidence[0];
      const route = allowedRoute(edges, rules, v.from, v.to);
      return `- ${n(v.from)} → ${n(v.to)} is a declared fault line (deny ${v.rule}${v.reason ? `: ${v.reason}` : ""}). ${e ? `${e.from} ${importPhrase(e).replace(/^\S+ /, "")}.` : ""}${route ? ` Allowed route: ${route.join(" → ")}.` : ""}`;
    });
    return (
      `faultline: this change crosses ${fresh.length === 1 ? "a fault line" : `${fresh.length} fault lines`} declared in faultline.yml:\n${lines.join("\n")}\n` +
      `Route the dependency through an allowed system instead, or ask the user before changing the rule.`
    );
  };

  if (isEdit) {
    if (server) void post(server.port, "/api/refresh", {});
    // Cursor's afterFileEdit cannot talk back to the agent; the stop hook reports instead.
    if (agent === "cursor") return;
    const { headModel, fresh } = await freshFaults();
    if (fresh.length === 0) return saveSession(root, sessionId, session);
    session.reported.push(...fresh.map((v) => `${v.from}->${v.to}`));
    saveSession(root, sessionId, session);
    const reason = describeFaults(fresh, headModel);
    const short = `faultline: fault line crossed, ${fresh.map((v) => `${systemName(config, v.from)} → ${systemName(config, v.to)}`).join(", ")}`;
    if (agent === "codex" || agent === "copilot") {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: reason }, systemMessage: short }));
    } else {
      process.stdout.write(JSON.stringify({ decision: "block", reason, continueOnBlock: true, systemMessage: short }));
    }
    return;
  }

  if (isStop) {
    session.turns++;
    let summary: string | null = null;
    if (server) {
      const res = (await post(server.port, "/api/turn", { label: `Agent turn ${session.turns}` })) as { summary?: string } | null;
      summary = res?.summary ?? null;
    }
    const { delta, headModel, fresh } = await freshFaults();
    if (agent === "cursor" && fresh.length) {
      session.reported.push(...fresh.map((v) => `${v.from}->${v.to}`));
      saveSession(root, sessionId, session);
      process.stdout.write(JSON.stringify({ followup_message: describeFaults(fresh, headModel) }));
      return;
    }
    const f = findings(delta, config).filter((x) => x.severity !== "info");
    const headlineNow = f.map((x) => x.title).join("; ");
    if (f.length && headlineNow !== session.lastHeadline) {
      session.lastHeadline = headlineNow;
      saveSession(root, sessionId, session);
      if (agent === "claude") process.stdout.write(JSON.stringify({ systemMessage: `faultline: ${summary ?? f.slice(0, 3).map((x) => x.title).join("; ")}` }));
      return;
    }
    saveSession(root, sessionId, session);
  }
}

/** What faultline.yml would contain after a Write, Edit or MultiEdit; null when it cannot tell. */
function proposedText(file: string, event: HookEvent): string | null {
  const input = event.tool_input ?? {};
  const tool = (event.tool_name ?? "").toLowerCase();
  if (typeof input.content === "string" && (tool === "write" || !input.old_string)) return input.content;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const edits = input.edits ?? (typeof input.old_string === "string" ? [{ old_string: input.old_string, new_string: input.new_string ?? "", replace_all: input.replace_all }] : []);
  if (!edits.length) return null;
  for (const e of edits) {
    if (!text.includes(e.old_string)) return null;
    text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, e.new_string);
  }
  return text;
}

export async function cmdInstallHook(args: Args) {
  const root = findRoot(process.cwd());
  const file = path.join(root, ".claude", "settings.json");
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  const command = args.flags.npx ? "npx -y @anzalabidi/faultline hook" : `"${process.execPath}" "${cli}" hook`;
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
  ensure("PreToolUse", "Edit|Write|MultiEdit");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  if (!a && !b) console.log(dim("faultline hooks were already installed in .claude/settings.json"));
  else console.log(`${green("✓")} Added faultline to ${bold(path.relative(process.cwd(), file) || file)}: agents now hear about fault lines the moment they cross one.`);
  console.log(dim("Run `fault map` alongside Claude Code to watch each turn land on the map."));
}
