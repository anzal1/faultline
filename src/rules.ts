import picomatch from "picomatch";
import { evidenceFor } from "./graph.js";
import type { AggEdge, Config, Model, RuleDef, Violation } from "./types.js";

export interface CompiledRule {
  rule: RuleDef;
  from: (id: string) => boolean;
  to: (id: string) => boolean;
}

export function parseRule(rule: RuleDef): { from: string; to: string } {
  const m = /^\s*(\S+)\s*->\s*(\S+)\s*$/.exec(rule.deny ?? "");
  if (!m) throw new Error(`faultline.yml: rule "${rule.deny}" must look like "from -> to"`);
  return { from: m[1], to: m[2] };
}

export function compileRules(config: Config): CompiledRule[] {
  return config.rules.map((rule) => {
    const { from, to } = parseRule(rule);
    return { rule, from: picomatch(from), to: picomatch(to) };
  });
}

export function findViolations(model: Model, systemEdges: AggEdge[], rules: CompiledRule[]): Violation[] {
  const out: Violation[] = [];
  for (const edge of systemEdges) {
    for (const r of rules) {
      if (!r.from(edge.from) || !r.to(edge.to)) continue;
      // Only edges the language itself names can break a rule; inferred references never block anyone.
      const evidence = evidenceFor(model, "system", edge.from, edge.to).filter((e) => (r.rule.types || !e.typeOnly) && e.confidence !== "inferred");
      if (evidence.length === 0) continue;
      out.push({ from: edge.from, to: edge.to, rule: r.rule.deny, reason: r.rule.reason, evidence });
      break;
    }
  }
  return out;
}
