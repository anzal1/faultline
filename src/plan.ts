import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/**
 * Intended new dependencies, declared before the code exists. Lives in the repo at
 * .faultline/plan.yml so the map, the agent and the PR comment all read the same intent.
 */
export interface PlannedEdge {
  from: string;
  to: string;
  why?: string;
  by?: string;
  at?: string;
}

export interface Plan {
  edges: PlannedEdge[];
}

export const PLAN_FILE = path.join(".faultline", "plan.yml");

export function loadPlan(root: string): Plan {
  const file = path.join(root, PLAN_FILE);
  try {
    const raw = YAML.parse(fs.readFileSync(file, "utf8")) as Partial<Plan> | null;
    return { edges: (raw?.edges ?? []).filter((e) => e && e.from && e.to).map((e) => ({ ...e, from: String(e.from), to: String(e.to) })) };
  } catch {
    return { edges: [] };
  }
}

export function savePlan(root: string, plan: Plan) {
  const file = path.join(root, PLAN_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# Planned dependencies between systems. faultline shows them on the map and in PR comments.\n" + YAML.stringify(plan));
}

/** "api -> billing: needs invoices" or "api -> billing" */
export function parsePlanLine(line: string): PlannedEdge | null {
  const m = /^\s*([\w.-]+)\s*->\s*([\w.-]+)\s*(?::\s*(.+))?$/.exec(line);
  return m ? { from: m[1], to: m[2], why: m[3]?.trim() } : null;
}

export function addToPlan(root: string, edges: PlannedEdge[], by = "cli"): Plan {
  const plan = loadPlan(root);
  for (const e of edges) {
    const existing = plan.edges.find((x) => x.from === e.from && x.to === e.to);
    if (existing) Object.assign(existing, { why: e.why ?? existing.why });
    else plan.edges.push({ ...e, by: e.by ?? by, at: new Date().toISOString() });
  }
  savePlan(root, plan);
  return plan;
}

export function removeFromPlan(root: string, from: string, to: string): Plan {
  const plan = loadPlan(root);
  plan.edges = plan.edges.filter((e) => !(e.from === from && e.to === to));
  savePlan(root, plan);
  return plan;
}
