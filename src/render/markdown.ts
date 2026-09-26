import { systemName } from "../config.js";
import { findings, headline, importPhrase } from "../describe.js";
import { aggregate } from "../graph.js";
import type { AggEdge, Config, Delta, Model } from "../types.js";

export const COMMENT_MARKER = "<!-- faultline:pr-comment -->";

const mid = (id: string) => "s_" + id.replace(/[^A-Za-z0-9_]/g, "_");
const esc = (s: string) => s.replace(/"/g, "'").replace(/[<>]/g, "");

/** A Mermaid map of only the neighbourhood the change touched. GitHub renders it inline in the comment. */
export function mermaidDelta(delta: Delta, head: Model, config: Config, maxNodes = 14): string | null {
  const focus = new Set<string>();
  for (const e of [...delta.violations.introduced, ...delta.systemEdges.added, ...delta.systemEdges.removed]) {
    focus.add(e.from);
    focus.add(e.to);
  }
  for (const c of delta.cycles.added) c.forEach((s) => focus.add(s));
  for (const t of delta.touched) if (focus.size < maxNodes) focus.add(t.system);
  if (focus.size === 0) return null;

  const all = aggregate(head, "system").filter((e) => !e.typeOnly || focus.has(e.from));
  // Pull in the strongest neighbours for context until the map is full.
  for (const e of all) {
    if (focus.size >= maxNodes) break;
    if (focus.has(e.from) && !focus.has(e.to)) focus.add(e.to);
  }
  const key = (e: { from: string; to: string }) => `${e.from}\0${e.to}`;
  const violation = new Set(delta.violations.introduced.map(key));
  const added = new Set(delta.systemEdges.added.map(key));
  const touched = new Set(delta.touched.map((t) => t.system));

  const lines = ["flowchart LR"];
  for (const id of focus) {
    const t = delta.touched.find((x) => x.system === id);
    const count = t ? t.added.length + t.removed.length + t.modified.length : 0;
    lines.push(`  ${mid(id)}["${esc(systemName(config, id))}${count ? `<br/><small>${count} file${count === 1 ? "" : "s"} changed</small>` : ""}"]`);
  }
  const styles: string[] = [];
  let i = 0;
  const emit = (e: AggEdge | { from: string; to: string }, arrow: string, style?: string) => {
    lines.push(`  ${mid(e.from)} ${arrow} ${mid(e.to)}`);
    if (style) styles.push(`  linkStyle ${i} ${style}`);
    i++;
  };
  const drawn = new Set<string>();
  for (const e of all) {
    if (!focus.has(e.from) || !focus.has(e.to)) continue;
    drawn.add(key(e));
    if (violation.has(key(e))) emit(e, "==>", "stroke:#e5484d,stroke-width:3px");
    else if (added.has(key(e))) emit(e, "==>", "stroke:#30a46c,stroke-width:3px");
    else emit(e, "-->", "stroke:#8b8d98,stroke-width:1px,opacity:0.5");
  }
  for (const e of delta.systemEdges.removed) {
    if (focus.has(e.from) && focus.has(e.to) && !drawn.has(key(e))) emit(e, "-.->", "stroke:#e5484d,stroke-width:2px,stroke-dasharray:4");
  }
  lines.push(...styles);
  lines.push("  classDef touched stroke:#f5a524,stroke-width:2px");
  const touchedIds = [...focus].filter((id) => touched.has(id)).map(mid);
  if (touchedIds.length) lines.push(`  class ${touchedIds.join(",")} touched`);
  return lines.join("\n");
}

export function renderMarkdown(delta: Delta, head: Model, config: Config, opts: { mapUrl?: string } = {}): string {
  const f = findings(delta, config);
  const n = (id: string) => systemName(config, id);
  const faults = f.filter((x) => x.severity === "fault");
  const rest = f.filter((x) => x.severity !== "fault");
  const out: string[] = [COMMENT_MARKER];
  const icon = faults.length ? "🔴" : f.some((x) => x.severity === "structure") ? "🟡" : "🟢";
  out.push(`### ${icon} faultline: ${headline(delta, config)}`);
  out.push("");
  for (const x of faults) out.push(`- **${x.title}**${x.detail ? `  \n  ${x.detail}` : ""}`);
  for (const x of rest.slice(0, 10)) out.push(`- ${x.severity === "structure" ? "**" + x.title + "**" : x.title}${x.detail ? `  \n  ${x.detail}` : ""}`);
  if (rest.length > 10) out.push(`- …and ${rest.length - 10} smaller changes`);
  if (f.length === 0) out.push("No new dependencies between systems, no cycles, no fault lines crossed.");
  const diagram = mermaidDelta(delta, head, config);
  if (diagram && (faults.length || f.some((x) => x.severity === "structure"))) {
    out.push("", "```mermaid", diagram, "```");
    out.push("<sub>🟩 new dependency · 🟥 fault line or removed · 🟧 system touched by this PR</sub>");
  }
  const evidence = [...delta.violations.introduced, ...delta.systemEdges.added].filter((e) => e.evidence.length);
  if (evidence.length) {
    out.push("", "<details><summary>Evidence: the imports behind each change</summary>", "");
    for (const e of evidence.slice(0, 12)) {
      out.push(`**${n(e.from)} → ${n(e.to)}**`);
      for (const ev of e.evidence.slice(0, 6)) out.push(`- \`${ev.from}\` → \`${ev.to}\`: ${importPhrase(ev)}`);
      if (e.evidence.length > 6) out.push(`- …${e.evidence.length - 6} more`);
      out.push("");
    }
    out.push("</details>");
  }
  if (delta.touched.length) {
    out.push("", "<details><summary>Systems touched</summary>", "");
    out.push("| System | Added | Modified | Removed |", "|---|---:|---:|---:|");
    for (const t of delta.touched) out.push(`| ${n(t.system)} | ${t.added.length} | ${t.modified.length} | ${t.removed.length} |`);
    out.push("</details>");
  }
  out.push("", `<sub>${opts.mapUrl ? `[Open the live map](${opts.mapUrl}) · ` : ""}Systems are declared in \`faultline.yml\` · ${delta.base.label} → ${delta.head.label}</sub>`);
  return out.join("\n");
}
