import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import YAML from "yaml";
import { EXTRA_EXTENSIONS } from "./lang/extract.js";
import type { Config, SystemDef } from "./types.js";

export const CONFIG_FILE = "faultline.yml";
export const UNMAPPED = "unmapped";

export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/.astro/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/*.d.ts",
  "**/*.min.js",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/fixtures/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/e2e/**",
  "**/testdata/**",
  "**/spec/**",
  "**/Tests/**",
  "**/src/test/**",
  "**/src/androidTest/**",
  "**/src/*Test/**",
  "**/*.docc/**",
  "**/src/*Tests/**",
  "**/benches/**",
  "**/fuzz/**",
  "**/tests.rs",
  "**/test.rs",
  "**/tests.py",
  "**/test_*.py",
  "**/*_test.py",
  "**/conftest.py",
  "**/*_test.go",
  "**/*_spec.rb",
  "**/*_test.rb",
  "**/*Test.java",
  "**/*Test.kt",
  "**/*Spec.scala",
  "**/*.Tests/**",
  "**/*.UnitTests/**",
  "**/*.IntegrationTests/**",
  "**/*.FunctionalTests/**",
  "**/target/**",
  "**/bin/Debug/**",
  "**/bin/Release/**",
  "**/obj/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/Pods/**",
  "**/.build/**",
  "**/_build/**",
  "**/deps/**",
];

export const SOURCE_EXTENSIONS = [
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".astro", ".vue", ".svelte",
];

const ALL_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ...EXTRA_EXTENSIONS]);

export function isSourceFile(p: string): boolean {
  return ALL_EXTENSIONS.has(path.extname(p).toLowerCase());
}

export function isJsFile(p: string): boolean {
  return SOURCE_EXTENSIONS.includes(path.extname(p));
}

export function configPath(root: string): string {
  return path.join(root, CONFIG_FILE);
}

export function loadConfig(root: string): Config | null {
  const file = configPath(root);
  if (!fs.existsSync(file)) return null;
  return parseConfig(fs.readFileSync(file, "utf8"));
}

export function parseConfig(text: string): Config {
  const raw = (YAML.parse(text) ?? {}) as Partial<Config>;
  const systems = (raw.systems ?? []).map((s) => ({
    ...s,
    id: String(s.id),
    name: s.name ?? String(s.id),
    paths: Array.isArray(s.paths) ? s.paths.map(String) : [String(s.paths)],
  }));
  const ids = new Set<string>();
  for (const s of systems) {
    if (ids.has(s.id)) throw new Error(`faultline.yml: duplicate system id "${s.id}"`);
    if (s.id === UNMAPPED) throw new Error(`faultline.yml: "${UNMAPPED}" is reserved`);
    ids.add(s.id);
  }
  return {
    version: 1,
    systems,
    rules: raw.rules ?? [],
    ignore: raw.ignore ?? DEFAULT_IGNORE,
  };
}

export function serializeConfig(config: Config): string {
  const doc = new YAML.Document({
    version: 1,
    systems: config.systems.map((s) => {
      const out: Record<string, unknown> = { id: s.id, name: s.name };
      if (s.description) out.description = s.description;
      out.paths = s.paths;
      return out;
    }),
    rules: config.rules,
    ignore: config.ignore,
  });
  const header =
    "# faultline.yml: the declared architecture of this repo.\n" +
    "# Systems are the boxes on the map. Each file belongs to the most specific system whose paths match it.\n" +
    "# Rules turn an edge into a fault line: `deny: web -> db` fails `fault check` when that import appears.\n";
  return header + doc.toString({ lineWidth: 0 });
}

/** Adds a deny rule to faultline.yml, keeping the file's comments and layout. */
export function addRuleToFile(root: string, deny: string, reason?: string): boolean {
  const file = configPath(root);
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  let rules = doc.get("rules") as YAML.YAMLSeq | undefined;
  if (!rules || !YAML.isSeq(rules)) {
    rules = new YAML.YAMLSeq();
    doc.set("rules", rules);
  }
  if (rules.items.some((r) => YAML.isMap(r) && String(r.get("deny")).replace(/\s+/g, "") === deny.replace(/\s+/g, ""))) return false;
  const entry: Record<string, string> = { deny };
  if (reason) entry.reason = reason;
  rules.add(doc.createNode(entry));
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  return true;
}

/** Assigns files to systems and modules. Compiled once per config. */
export class Assigner {
  private matchers: { system: SystemDef; base: string; match: (p: string) => boolean }[] = [];
  private ignoreMatch: (p: string) => boolean;
  private cache = new Map<string, { system: string; module: string }>();

  constructor(readonly config: Config) {
    for (const system of config.systems) {
      for (const glob of system.paths) {
        const base = picomatch.scan(glob).base;
        this.matchers.push({ system, base: base ? base.replace(/\/$/, "") + "/" : "", match: picomatch(glob, { dot: true }) });
      }
    }
    this.matchers.sort((a, b) => b.base.length - a.base.length);
    this.ignoreMatch = picomatch(config.ignore, { dot: true });
  }

  ignored(p: string): boolean {
    return this.ignoreMatch(p);
  }

  assign(p: string): { system: string; module: string } {
    const hit = this.cache.get(p);
    if (hit) return hit;
    let result = { system: UNMAPPED, module: `${UNMAPPED}/${topSegment(p)}` };
    for (const m of this.matchers) {
      if (m.match(p)) {
        const rest = p.startsWith(m.base) ? p.slice(m.base.length) : p;
        result = { system: m.system.id, module: `${m.system.id}/${topSegment(rest)}` };
        break;
      }
    }
    this.cache.set(p, result);
    return result;
  }
}

function topSegment(rest: string): string {
  const slash = rest.indexOf("/");
  if (slash >= 0) return rest.slice(0, slash);
  const ext = path.extname(rest);
  return ext ? rest.slice(0, -ext.length) : rest;
}

export function systemName(config: Config, id: string): string {
  if (id === UNMAPPED) return "Unmapped";
  return config.systems.find((s) => s.id === id)?.name ?? id;
}

export function moduleLabel(moduleId: string): string {
  const slash = moduleId.indexOf("/");
  return slash >= 0 ? moduleId.slice(slash + 1) : moduleId;
}

export function systemOfModule(moduleId: string): string {
  const slash = moduleId.indexOf("/");
  return slash >= 0 ? moduleId.slice(0, slash) : moduleId;
}
