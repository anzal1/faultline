// Core data model. Everything the CLI, the PR comment and the map UI show is
// derived from a Model (one snapshot of the code) and a Delta (two models compared).

export interface SystemDef {
  id: string;
  name: string;
  description?: string;
  paths: string[];
}

export interface RuleDef {
  /** "from -> to", each side a system id or a glob over ids ("*", "ui-*"). */
  deny: string;
  reason?: string;
  /** When true, type-only imports also count as a violation. Default false. */
  types?: boolean;
}

export interface Config {
  version: 1;
  systems: SystemDef[];
  rules: RuleDef[];
  ignore: string[];
}

export type ImportKind = "static" | "dynamic" | "require" | "reexport" | "include" | "reference" | "project";

export interface ParsedImport {
  spec: string;
  names: string[];
  typeOnly: boolean;
  kind: ImportKind;
}

export interface ParsedFile {
  imports: ParsedImport[];
  exports: string[];
  /** Language family for non-JS files (python, go, rust, jvm, csharp, ...). Absent means JS/TS. */
  lang?: string;
  /** Packages, namespaces or modules this file declares. */
  declares?: string[];
  /** Type names declared in this file. */
  types?: string[];
  /** Capitalised names referenced in this file, for languages that do not import files. */
  refs?: string[];
}

export interface FileInfo {
  path: string;
  hash: string;
  system: string;
  module: string;
}

export interface FileEdge {
  from: string;
  to: string;
  names: string[];
  typeOnly: boolean;
  kind: ImportKind;
  /** exact: named by an import the language resolves. inferred: matched by a referenced type name. Rules only fire on exact edges. */
  confidence?: "exact" | "inferred";
  /** Module ids, filled in when the edge is shipped to the map UI. */
  fm?: string;
  tm?: string;
}

export interface ExternalUse {
  file: string;
  pkg: string;
  /** Every import of this package from this file is `import type`: nothing loads at runtime. */
  typeOnly?: boolean;
  /** Every import of it is a dynamic import(): it loads on demand, not at startup. */
  dynamic?: boolean;
}

export interface Model {
  ref: string;
  label: string;
  files: Record<string, FileInfo>;
  edges: FileEdge[];
  externals: ExternalUse[];
}

/** Aggregated edge between two systems or two modules. */
export interface AggEdge {
  from: string;
  to: string;
  count: number;
  typeOnly: boolean;
}

export interface Violation {
  from: string;
  to: string;
  rule: string;
  reason?: string;
  evidence: FileEdge[];
}

export interface EdgeChange {
  from: string;
  to: string;
  count: number;
  typeOnly: boolean;
  /** File-level imports that make up the change (new ones for added edges, removed ones for removed edges). */
  evidence: FileEdge[];
}

export interface SystemTouch {
  system: string;
  added: string[];
  removed: string[];
  modified: string[];
}

export interface Delta {
  base: { ref: string; label: string };
  head: { ref: string; label: string };
  systemEdges: { added: EdgeChange[]; removed: EdgeChange[]; grown: EdgeChange[]; shrunk: EdgeChange[] };
  moduleEdges: { added: EdgeChange[]; removed: EdgeChange[] };
  files: { added: string[]; removed: string[]; modified: string[]; moved: { from: string; to: string }[] };
  touched: SystemTouch[];
  modules: { added: string[]; removed: string[] };
  externals: { added: { system: string; pkg: string; files: string[] }[]; removed: { system: string; pkg: string }[] };
  cycles: { added: string[][]; removed: string[][] };
  violations: { introduced: Violation[]; existing: Violation[]; fixed: Violation[] };
  unmapped: string[];
}
