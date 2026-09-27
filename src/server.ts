import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Args } from "./cli.js";
import { addRuleToFile, Assigner } from "./config.js";
import { addToPlan, removeFromPlan } from "./plan.js";
import { Workspace } from "./context.js";
import { headline } from "./describe.js";
import { diffModels } from "./diff.js";
import { bold, dim, green } from "./render/text.js";
import { git, resolveRef, shortRef } from "./source.js";
import { applyPlacements, configAt, loosenings, suggestPlacements, suggestRules, type Placement, type RuleSuggestion } from "./maintain.js";
import { buildState, type SnapshotMeta } from "./state.js";
import type { Config, Model } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const UI_DIR = path.resolve(here, "..", "ui");
const SERVER_FILE = path.join(".faultline", "server.json");

interface Frame {
  meta: SnapshotMeta;
  model: Model;
}

/** Re-applies system assignment when faultline.yml changes, so frozen turns follow the new map. */
function reassign(model: Model, config: Config): Model {
  const a = new Assigner(config);
  const files: Model["files"] = {};
  for (const [p, f] of Object.entries(model.files)) files[p] = { ...f, ...a.assign(p) };
  return { ...model, files };
}

export class LiveSession {
  base!: Frame;
  turns: Frame[] = [];
  live!: Frame;
  private stateJson = "{}";
  private clients = new Set<http.ServerResponse>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pending = false;
  private headSha = "";
  private turnCount = 0;
  placements: Placement[] = [];
  private ruleSuggestions: RuleSuggestion[] = [];
  private scanning = false;

  constructor(readonly ws: Workspace, readonly baseRef: string) {}

  async start() {
    const sha = resolveRef(this.ws.root, this.baseRef);
    this.headSha = this.currentHead();
    const model = await this.ws.model(sha);
    this.base = { meta: { id: "base", label: this.baseRef === sha ? shortRef(this.ws.root, sha) : `${this.baseRef} (${shortRef(this.ws.root, sha)})`, kind: "base", ref: sha, time: Date.now(), subject: subject(this.ws.root, sha) }, model };
    await this.rebuild();
    void this.scanRules();
  }

  /** Rule suggestions read history, so they run in the background and land on the next redraw. */
  async scanRules() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      this.ruleSuggestions = await suggestRules(this.ws);
    } catch {
      this.ruleSuggestions = [];
    } finally {
      this.scanning = false;
    }
    this.schedule(0);
  }

  private dismissed(): string[] {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.ws.root, ".faultline", "dismissed.json"), "utf8"));
    } catch {
      return [];
    }
  }

  dismiss(deny: string) {
    const file = path.join(this.ws.root, ".faultline", "dismissed.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...new Set([...this.dismissed(), deny.replace(/\s+/g, "")])]));
    this.schedule(0);
  }

  private currentHead(): string {
    try {
      return git(this.ws.root, ["rev-parse", "HEAD"]).trim();
    } catch {
      return "";
    }
  }

  schedule(delay = 250) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.rebuild(), delay);
  }

  async rebuild() {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    this.broadcast("busy", "{}");
    try {
      const model = await this.ws.model(undefined);
      const head = this.currentHead();
      if (head && head !== this.headSha) {
        // A commit landed mid-session: freeze it as a step on the timeline.
        this.headSha = head;
        void this.scanRules();
        this.turns.push({ meta: { id: `c-${head.slice(0, 8)}`, label: shortRef(this.ws.root, head), kind: "commit", ref: head, time: Date.now(), subject: subject(this.ws.root, head) }, model });
      }
      this.live = { meta: { id: "live", label: "working tree", kind: "live", ref: "WORKTREE", time: Date.now(), subject: "Working tree (now)" }, model };
      this.placements = suggestPlacements(model, this.ws.config);
      const committed = configAt(this.ws.root, "HEAD");
      const hidden = new Set(this.dismissed());
      const maintenance = {
        placements: this.placements,
        rules: this.ruleSuggestions.filter((r) => !hidden.has(r.deny.replace(/\s+/g, "")) && !this.ws.config.rules.some((x) => x.deny.replace(/\s+/g, "") === r.deny.replace(/\s+/g, ""))),
        loosened: committed ? loosenings(committed, this.ws.config, Object.keys(model.files)) : [],
      };
      const state = await buildState({
        maintenance,
        root: this.ws.root,
        repo: repoName(this.ws.root),
        config: this.ws.config,
        models: [this.base, ...this.turns, this.live],
        mode: "live",
      });
      this.stateJson = JSON.stringify(state);
      this.broadcast("state", JSON.stringify({ at: Date.now() }));
    } catch (e) {
      process.stderr.write(`faultline: rebuild failed: ${(e as Error).message}\n`);
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        this.schedule(50);
      }
    }
  }

  async markTurn(label?: string) {
    await this.rebuild();
    this.turnCount++;
    const frame: Frame = { meta: { ...this.live.meta, id: `t-${this.turnCount}`, kind: "turn", label: label || `Step ${this.turnCount}`, subject: label || `Step ${this.turnCount}`, time: Date.now() }, model: this.live.model };
    const prev = this.turns.length ? this.turns[this.turns.length - 1].model : this.base.model;
    const d = diffModels(prev, frame.model, this.ws.config);
    this.turns.push(frame);
    await this.rebuild();
    return headline(d, this.ws.config);
  }

  async configChanged() {
    this.ws.reloadConfig();
    void this.scanRules();
    this.base = { ...this.base, model: reassign(this.base.model, this.ws.config) };
    this.turns = this.turns.map((t) => ({ ...t, model: reassign(t.model, this.ws.config) }));
    await this.rebuild();
  }

  state() {
    return this.stateJson;
  }

  addClient(res: http.ServerResponse) {
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  broadcast(event: string, data: string) {
    for (const c of this.clients) c.write(`event: ${event}\ndata: ${data}\n\n`);
  }
}

function subject(root: string, sha: string): string {
  try {
    return git(root, ["log", "-1", "--format=%s", sha]).trim();
  } catch {
    return "";
  }
}

export function repoName(root: string): string {
  try {
    const url = git(root, ["config", "--get", "remote.origin.url"]).trim();
    const m = /[:/]([^/:]+\/[^/]+?)(\.git)?$/.exec(url);
    if (m) return m[1];
  } catch {
    // no remote
  }
  return path.basename(root);
}

const MIME: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml" };

export async function cmdMap(args: Args) {
  const ws = Workspace.open();
  const baseRef = String(args.flags.base ?? args._[0] ?? "HEAD");
  const port = Number(args.flags.port ?? process.env.FAULTLINE_PORT ?? 4777);
  const session = new LiveSession(ws, baseRef);
  process.stderr.write(dim("Building the map…\n"));
  await session.start();

  // Only this page may change files: no other origin, no DNS-rebound host, JSON bodies only
  // (a cross-site JSON POST needs a CORS preflight, which this server never grants).
  const localHost = (h: string | undefined) => !!h && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h);
  const trusted = (req: http.IncomingMessage) => {
    if (!localHost(req.headers.host)) return false;
    const origin = req.headers.origin;
    if (origin && !localHost(origin.replace(/^https?:\/\//, ""))) return false;
    if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) return false;
    return true;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!trusted(req)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    if (url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(session.state());
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      session.addClient(res);
      return;
    }
    if (url.pathname === "/api/turn" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let label: string | undefined;
      try {
        label = JSON.parse(body || "{}").label;
      } catch {
        // no label
      }
      const summary = await session.markTurn(label);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, summary }));
    }
    if ((url.pathname === "/api/plan" || url.pathname === "/api/rule") && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let data: { from?: string; to?: string; why?: string; reason?: string; remove?: boolean } = {};
      try {
        data = JSON.parse(body || "{}");
      } catch {
        // empty
      }
      const ids = new Set(ws.config.systems.map((s) => s.id));
      if (!data.from || !data.to || !ids.has(data.from) || !ids.has(data.to)) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "from and to must be system ids" }));
      }
      if (url.pathname === "/api/plan") {
        if (data.remove) removeFromPlan(ws.root, data.from, data.to);
        else addToPlan(ws.root, [{ from: data.from, to: data.to, why: data.why }], "map");
        session.schedule(0);
      } else {
        addRuleToFile(ws.root, `${data.from} -> ${data.to}`, data.reason);
        await session.configChanged();
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if ((url.pathname === "/api/place" || url.pathname === "/api/dismiss") && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let data: { glob?: string; deny?: string } = {};
      try {
        data = JSON.parse(body || "{}");
      } catch {
        // empty
      }
      if (url.pathname === "/api/dismiss") {
        if (typeof data.deny !== "string") return void res.writeHead(400).end();
        session.dismiss(data.deny);
      } else {
        const p = session.placements.find((x) => x.glob === data.glob);
        if (!p) {
          res.writeHead(404, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "no such suggestion" }));
        }
        applyPlacements(ws.root, [p]);
        await session.configChanged();
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === "/api/refresh" && req.method === "POST") {
      session.schedule(0);
      res.writeHead(204);
      return res.end();
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const abs = path.join(UI_DIR, path.normalize(file));
    if (!abs.startsWith(UI_DIR) || !fs.existsSync(abs)) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(abs)] ?? "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(abs).pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const addr = `http://localhost:${port}`;
  const serverFile = path.join(ws.root, SERVER_FILE);
  fs.mkdirSync(path.dirname(serverFile), { recursive: true });
  fs.writeFileSync(serverFile, JSON.stringify({ port, pid: process.pid, base: baseRef }));
  const cleanup = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(serverFile, "utf8"));
      if (cur.pid === process.pid) fs.unlinkSync(serverFile);
    } catch {
      // already gone
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Watch the repo; ignore build output and tooling churn.
  const ignore = /(^|[\\/])(node_modules|dist|build|target|\.next|\.astro|coverage|\.turbo|__pycache__|\.venv)([\\/]|$)|\.faultline[\\/](cache|sessions|layout|server)/;
  fs.watch(ws.root, { recursive: true }, (_event, name) => {
    if (!name) return;
    const rel = name.toString();
    if (ignore.test(rel)) return;
    if (rel === "faultline.yml") return void session.configChanged();
    if (rel.replace(/\\/g, "/") === ".faultline/plan.yml") return session.schedule();
    if (rel.startsWith(".git")) {
      if (/^\.git[\\/](HEAD|refs[\\/]heads|index$)/.test(rel)) session.schedule(400);
      return;
    }
    session.schedule();
  });

  console.log(`${green("●")} faultline map for ${bold(repoName(ws.root))} at ${bold(addr)}`);
  console.log(dim(`  comparing against ${baseRef}. Edits redraw the map live. Ctrl+C to stop.`));
  if (!args.flags["no-open"]) openBrowser(addr);
}

export function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, argv, { stdio: "ignore", detached: true }).unref();
  } catch {
    // headless: the URL is printed above
  }
}

export function readServerInfo(root: string): { port: number; pid: number } | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(root, SERVER_FILE), "utf8"));
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}
