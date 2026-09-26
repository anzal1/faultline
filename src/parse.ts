import fs from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";
import { extractorFor } from "./lang/extract.js";
import type { ParsedFile, ParsedImport } from "./types.js";

const PARSER_VERSION = 3;

/** Pulls the script parts out of component files so the JS parser can read them. */
export function extractScript(file: string, code: string): { code: string; lang: string } {
  const ext = path.extname(file);
  if (ext === ".astro") {
    const m = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(code);
    const scripts = [...code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((s) => s[1]);
    return { code: [m ? m[1] : "", ...scripts].join("\n;\n"), lang: "ts" };
  }
  if (ext === ".vue" || ext === ".svelte") {
    const scripts = [...code.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    const isTs = scripts.some((s) => /lang=["']ts["']/.test(s[1]));
    return { code: scripts.map((s) => s[2]).join("\n;\n"), lang: isTs ? "ts" : "js" };
  }
  return { code, lang: ext.slice(1) };
}

const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

export function parseFile(file: string, source: string): ParsedFile {
  const other = extractorFor(file);
  if (other) {
    try {
      return other.extract(file, source);
    } catch {
      return { imports: [], exports: [], lang: other.lang };
    }
  }
  const { code, lang } = extractScript(file, source);
  const fakeName = lang === ext(file) ? file : `${file}.${lang === "js" ? "js" : "ts"}`;
  const imports: ParsedImport[] = [];
  const exports: string[] = [];
  let result;
  try {
    result = parseSync(fakeName, code);
  } catch {
    return { imports: regexImports(code), exports };
  }
  const mod = result.module;
  // A file that fails to parse still gets a best-effort regex pass, so one syntax error never hides an edge.
  if (result.errors.length > 0 && mod.staticImports.length === 0 && mod.staticExports.length === 0) {
    return { imports: regexImports(code), exports };
  }
  for (const imp of mod.staticImports) {
    const names: string[] = [];
    let allType = imp.entries.length > 0;
    for (const e of imp.entries) {
      names.push(e.importName.kind === "Name" ? e.importName.name! : e.importName.kind === "Default" ? "default" : "*");
      if (!e.isType) allType = false;
    }
    // `import type X from` marks entries as type; `import './side'` has no entries and is a runtime edge.
    const stmt = code.slice(imp.start, imp.end);
    if (/^import\s+type\s/.test(stmt)) allType = true;
    imports.push({ spec: imp.moduleRequest.value, names, typeOnly: allType, kind: "static" });
  }
  for (const exp of mod.staticExports) {
    const byReq = new Map<string, ParsedImport>();
    for (const e of exp.entries) {
      if (e.exportName.kind === "Name" && e.exportName.name) exports.push(e.exportName.name);
      else if (e.exportName.kind === "Default") exports.push("default");
      if (!e.moduleRequest) continue;
      const spec = e.moduleRequest.value;
      let entry = byReq.get(spec);
      if (!entry) {
        entry = { spec, names: [], typeOnly: true, kind: "reexport" };
        byReq.set(spec, entry);
        imports.push(entry);
      }
      entry.names.push(e.importName.kind === "Name" ? e.importName.name! : "*");
      if (!e.isType) entry.typeOnly = false;
    }
  }
  for (const dyn of mod.dynamicImports) {
    const raw = code.slice(dyn.moduleRequest.start, dyn.moduleRequest.end).trim();
    const m = /^(['"`])([^'"`$]+)\1$/.exec(raw);
    if (m) imports.push({ spec: m[2], names: ["*"], typeOnly: false, kind: "dynamic" });
  }
  for (const m of code.matchAll(REQUIRE_RE)) {
    imports.push({ spec: m[2], names: ["*"], typeOnly: false, kind: "require" });
  }
  return { imports, exports: [...new Set(exports)] };
}

function ext(file: string): string {
  return path.extname(file).slice(1);
}

function regexImports(code: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  const re = /(?:import|export)\s+(type\s+)?(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"\n]+)['"]/g;
  for (const m of code.matchAll(re)) out.push({ spec: m[2], names: [], typeOnly: !!m[1], kind: "static" });
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) out.push({ spec: m[1], names: ["*"], typeOnly: false, kind: "dynamic" });
  for (const m of code.matchAll(REQUIRE_RE)) out.push({ spec: m[2], names: ["*"], typeOnly: false, kind: "require" });
  return out;
}

/** Parse results keyed by git blob hash, persisted under .faultline/cache. */
export class ParseCache {
  private data = new Map<string, ParsedFile>();
  private dirty = false;
  private file: string | null;

  constructor(root: string | null) {
    this.file = root ? path.join(root, ".faultline", "cache", `parse-v${PARSER_VERSION}.json`) : null;
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, ParsedFile>;
        for (const [k, v] of Object.entries(raw)) this.data.set(k, v);
      } catch {
        // corrupt cache: start fresh
      }
    }
  }

  get(hash: string): ParsedFile | undefined {
    return this.data.get(hash);
  }

  set(hash: string, parsed: ParsedFile) {
    this.data.set(hash, parsed);
    this.dirty = true;
  }

  save() {
    if (!this.file || !this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.data)));
    this.dirty = false;
  }
}
