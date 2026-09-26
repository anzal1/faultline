import { systemName } from "./config.js";
import type { Config, Delta, EdgeChange, FileEdge } from "./types.js";

export type Severity = "fault" | "structure" | "info";

export interface Finding {
  severity: Severity;
  title: string;
  detail?: string;
  from?: string;
  to?: string;
  evidence?: FileEdge[];
}

const base = (p: string) => p.split("/").pop() ?? p;

export function importPhrase(e: FileEdge): string {
  const names = e.names.filter((n) => n !== "*");
  const what = names.length === 0 ? "" : names.length <= 3 ? ` ${names.join(", ")}` : ` ${names.slice(0, 3).join(", ")} +${names.length - 3}`;
  const verb = e.kind === "reexport" ? "re-exports" : e.kind === "dynamic" ? "lazily imports" : "imports";
  const t = e.typeOnly ? " (types)" : "";
  return `${base(e.from)} ${verb}${what}${t} from ${base(e.to)}`;
}

/** The sentence a reviewer reads first: what the change did to the structure, in order of how much it matters. */
export function findings(delta: Delta, config: Config): Finding[] {
  const n = (id: string) => systemName(config, id);
  const out: Finding[] = [];

  for (const v of delta.violations.introduced) {
    out.push({
      severity: "fault",
      title: `Crosses a fault line: ${n(v.from)} → ${n(v.to)}`,
      detail: `${v.reason ? v.reason + ". " : ""}${v.evidence.length === 1 ? importPhrase(v.evidence[0]) : `${v.evidence.length} imports, e.g. ${importPhrase(v.evidence[0])}`}. Rule: deny ${v.rule}.`,
      from: v.from,
      to: v.to,
      evidence: v.evidence,
    });
  }
  for (const c of delta.cycles.added) {
    out.push({ severity: "fault", title: `New dependency cycle: ${c.map(n).join(" ↔ ")}`, detail: "These systems now depend on each other at runtime." });
  }
  const faulted = new Set(delta.violations.introduced.map((v) => `${v.from}\0${v.to}`));
  for (const e of delta.systemEdges.added) {
    // A new edge that is also a crossed fault line is already reported above.
    if (faulted.has(`${e.from}\0${e.to}`)) continue;
    out.push({
      severity: e.typeOnly ? "info" : "structure",
      title: `New dependency: ${n(e.from)} → ${n(e.to)}${e.typeOnly ? " (types only)" : ""}`,
      detail: evidenceLine(e),
      from: e.from,
      to: e.to,
      evidence: e.evidence,
    });
  }
  for (const e of delta.systemEdges.removed) {
    out.push({
      severity: "structure",
      title: `Dependency removed: ${n(e.from)} → ${n(e.to)}`,
      detail: `${e.count} import${e.count === 1 ? "" : "s"} gone.`,
      from: e.from,
      to: e.to,
      evidence: e.evidence,
    });
  }
  for (const x of delta.externals.added) {
    out.push({ severity: "info", title: `${n(x.system)} now uses ${x.pkg}`, detail: `First used in ${x.files.map(base).join(", ")}.` });
  }
  for (const e of delta.systemEdges.grown.slice(0, 5)) {
    out.push({
      severity: "info",
      title: `${n(e.from)} → ${n(e.to)} got ${e.count} more import${e.count === 1 ? "" : "s"}`,
      detail: evidenceLine(e),
      from: e.from,
      to: e.to,
      evidence: e.evidence,
    });
  }
  for (const c of delta.cycles.removed) out.push({ severity: "info", title: `Cycle broken: ${c.map(n).join(" ↔ ")}` });
  for (const v of delta.violations.fixed) out.push({ severity: "info", title: `Fault line repaired: ${n(v.from)} → ${n(v.to)} no longer crosses` });
  if (delta.unmapped.length > 0) {
    out.push({
      severity: "info",
      title: `${delta.unmapped.length} new file${delta.unmapped.length === 1 ? "" : "s"} outside every declared system`,
      detail: `${delta.unmapped.slice(0, 3).join(", ")}${delta.unmapped.length > 3 ? "…" : ""}. Add them to faultline.yml so the map stays honest.`,
    });
  }
  return out;
}

function evidenceLine(e: EdgeChange): string {
  if (e.evidence.length === 0) return "";
  const first = importPhrase(e.evidence[0]);
  return e.evidence.length === 1 ? `${first}.` : `${first}, and ${e.evidence.length - 1} more.`;
}

export function headline(delta: Delta, config: Config): string {
  const f = findings(delta, config);
  const faults = f.filter((x) => x.severity === "fault").length;
  const structural = f.filter((x) => x.severity === "structure").length;
  const touched = delta.touched.length;
  const fileCount = delta.files.added.length + delta.files.removed.length + delta.files.modified.length;
  if (fileCount === 0) return "No source changes.";
  const parts: string[] = [];
  if (faults) parts.push(`${faults} fault line${faults === 1 ? "" : "s"} crossed`);
  if (structural) parts.push(`${structural} structural change${structural === 1 ? "" : "s"}`);
  const scope = `${fileCount} file${fileCount === 1 ? "" : "s"} across ${touched} system${touched === 1 ? "" : "s"}`;
  if (parts.length === 0) return `Architecture unchanged. ${scope}, all inside existing boundaries.`;
  return `${parts.join(", ")}. ${scope}.`;
}
