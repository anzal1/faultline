import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Args } from "./cli.js";
import { agentDiff, overview, place, withCost } from "./agent.js";
import { findRoot, Workspace } from "./context.js";
import { addToPlan, loadPlan, parsePlanLine, removeFromPlan } from "./plan.js";

const VERSION = "0.2.0";

/**
 * Four tools, short descriptions: every connected agent pays for the tool list in every session,
 * so it stays small. Answers are text sized for a model to read at a glance.
 */
export async function cmdMcp(args: Args) {
  const root = findRoot(String(args.flags.cwd ?? process.cwd()));
  const server = new McpServer({ name: "faultline", version: VERSION });
  const text = (s: string) => ({ content: [{ type: "text" as const, text: withCost(s) }] });
  const ws = () => {
    try {
      return Workspace.open(root);
    } catch (e) {
      throw new Error(`${(e as Error).message}`);
    }
  };

  server.registerTool(
    "map",
    {
      description: "This repo's architecture: systems, what each owns, their dependencies and forbidden imports. Call once per task instead of exploring folders. Pass system for one system's modules and neighbours.",
      inputSchema: { system: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ system }) => text(await overview(ws(), { system })),
  );

  server.registerTool(
    "place",
    {
      description: "Before creating a file or adding an import: which system a path belongs to, what it may not import, and an allowed route when a direct import would cross a fault line.",
      inputSchema: { path: z.string(), imports: z.array(z.string()).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ path, imports }) => text(await place(ws(), path, imports ?? [])),
  );

  server.registerTool(
    "check",
    {
      description: "Structural diff of uncommitted work against base (default HEAD): new dependencies between systems, crossed fault lines with the offending import and a fix route, cycles. Run after editing.",
      inputSchema: { base: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ base }) => {
      const w = ws();
      const { delta, headModel } = await w.diff(base ?? "HEAD", undefined);
      return text(agentDiff(delta, w.config, headModel, w.root));
    },
  );

  server.registerTool(
    "plan",
    {
      description: "Declare new dependencies between systems before writing them, e.g. \"api -> billing: needs invoices\". The map and PR comment show planned versus actual. No arguments lists the plan.",
      inputSchema: { add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() },
    },
    async ({ add, remove }) => {
      const w = ws();
      const ids = new Set(w.config.systems.map((s) => s.id));
      const errors: string[] = [];
      const parsed = (add ?? []).map((l) => ({ l, e: parsePlanLine(l) }));
      const good = parsed.filter((p) => p.e && ids.has(p.e.from) && ids.has(p.e.to)).map((p) => p.e!);
      for (const p of parsed) if (!p.e || !ids.has(p.e.from) || !ids.has(p.e.to)) errors.push(`Skipped "${p.l}": use "from -> to: why" with system ids from map.`);
      if (good.length) addToPlan(w.root, good, "agent");
      for (const r of remove ?? []) {
        const e = parsePlanLine(r);
        if (e) removeFromPlan(w.root, e.from, e.to);
      }
      const plan = loadPlan(w.root);
      const body = plan.edges.length ? plan.edges.map((e) => `- ${e.from} → ${e.to}${e.why ? `: ${e.why}` : ""}`).join("\n") : "No planned dependencies.";
      return text([...errors, body].join("\n"));
    },
  );

  await server.connect(new StdioServerTransport());
}
