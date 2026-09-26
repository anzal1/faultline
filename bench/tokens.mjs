// What faultline costs an agent, and what it replaces. Usage: node bench/tokens.mjs <repo with faultline.yml> [path-to-place]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "../dist/context.js";
import { overview, place, agentDiff, approxTokens } from "../dist/agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? ".");
const ws = Workspace.open(root);
const model = await ws.model(undefined);
const files = Object.values(model.files).filter((f) => f.hash !== "package").map((f) => f.path);
const bytes = files.reduce((n, f) => n + fs.statSync(path.join(root, f)).size, 0);

const cli = path.join(here, "..", "dist", "cli.js");
const input = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
].map((m) => JSON.stringify(m)).join("\n") + "\n";
const out = spawnSync("node", [cli, "mcp"], { cwd: root, input, encoding: "utf8", timeout: 20000 }).stdout.trim().split("\n").map((l) => JSON.parse(l));
const toolList = JSON.stringify(out.find((m) => m.id === 2).result.tools);

const ov = await overview(ws);
const target = process.argv[3] ?? files[Math.floor(files.length / 2)];
const pl = await place(ws, target);
const { delta, headModel } = await ws.diff("HEAD", undefined);
const ck = agentDiff(delta, ws.config, headModel, root);
const row = (label, tokens, note = "") => console.log(`${label.padEnd(44)} ${String(tokens).padStart(9)} tokens  ${note}`);
console.log(`${path.basename(root)}: ${files.length} source files, ${ws.config.systems.length} systems\n`);
row("MCP tool list (paid once per session)", approxTokens(toolList));
row("map: the whole architecture", approxTokens(ov));
row("place: where one file goes", approxTokens(pl), target);
row("check: structural diff of your edits", approxTokens(ck));
console.log("");
row("Listing every source path", approxTokens(files.join("\n")), "what ls -R / find returns");
row("Reading every source file", Math.round(bytes / 4), "the only way to see all imports without a tool");
