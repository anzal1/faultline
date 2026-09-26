import path from "node:path";
import type { ParsedFile, ParsedImport } from "../types.js";
import { blank, LEX, type LexSpec } from "./lexer.js";

/**
 * One adapter per language family: which files it reads and how it pulls imports, declared
 * namespaces and declared types out of them. Resolution lives in project.ts.
 */
export interface Extractor {
  lang: string;
  extensions: string[];
  /** Exact file names (no extension) this adapter reads, e.g. project manifests. */
  names?: string[];
  extract(file: string, code: string): ParsedFile;
}

const imp = (spec: string, names: string[] = [], kind: ParsedImport["kind"] = "static", typeOnly = false): ParsedImport => ({ spec, names, typeOnly, kind });
const lines = (code: string) => code.split("\n");
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** Capitalised identifiers in code with comments and strings removed: candidate type references. */
function typeRefs(clean: string, own: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of clean.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) if (!own.has(m[0]) && m[0].length > 1) out.add(m[0]);
  return [...out];
}

// ---------- Python ----------
const python: Extractor = {
  lang: "python",
  extensions: [".py", ".pyi"],
  extract(_file, code) {
    const c = blank(code, LEX.python).replace(/\\\n/g, "  ");
    const imports: ParsedImport[] = [];
    let typeBlockIndent = -1;
    const ls = lines(c);
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i];
      const indent = line.length - line.trimStart().length;
      if (/^\s*if\s+(typing\.)?TYPE_CHECKING\s*:/.test(line)) {
        typeBlockIndent = indent;
        continue;
      }
      if (typeBlockIndent >= 0 && line.trim() && indent <= typeBlockIndent) typeBlockIndent = -1;
      const typeOnly = typeBlockIndent >= 0;
      let m = /^\s*from\s+([.\w]+)\s+import\s+(.*)$/.exec(line);
      if (m) {
        let rest = m[2];
        if (rest.trimStart().startsWith("(")) {
          while (!rest.includes(")") && i + 1 < ls.length) rest += " " + ls[++i];
          rest = rest.replace(/[()]/g, " ");
        }
        const names = rest.split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter((s) => /^[\w*]+$/.test(s));
        imports.push(imp(m[1], names, "static", typeOnly));
        continue;
      }
      m = /^\s*import\s+(.+)$/.exec(line);
      if (m) {
        for (const part of m[1].split(",")) {
          const mod = part.trim().split(/\s+as\s+/)[0].trim();
          if (/^[\w.]+$/.test(mod)) imports.push(imp(mod, [], "static", typeOnly));
        }
      }
    }
    return { imports, exports: [], lang: "python" };
  },
};

// ---------- Go ----------
const go: Extractor = {
  lang: "go",
  extensions: [".go"],
  extract(_file, code) {
    const c = blank(code, LEX.go);
    const imports: ParsedImport[] = [];
    for (const m of c.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
      for (const l of m[1].split("\n")) {
        const s = /^\s*(?:[\w.]+\s+)?["`]([^"`]+)["`]/.exec(l);
        if (s) imports.push(imp(s[1]));
      }
    }
    for (const m of c.matchAll(/^\s*import\s+(?:[\w.]+\s+)?["`]([^"`]+)["`]/gm)) imports.push(imp(m[1]));
    const pkg = /^\s*package\s+(\w+)/m.exec(c)?.[1];
    return { imports, exports: [], lang: "go", declares: pkg ? [pkg] : [] };
  },
};

// ---------- Rust ----------
/** Expands `a::b::{c, d::{e, f}, self}` into flat paths. */
export function expandUseTree(tree: string): string[] {
  const t = tree.replace(/\s+/g, "");
  const out: string[] = [];
  const walk = (prefix: string, s: string) => {
    const brace = s.indexOf("{");
    if (brace < 0) {
      const p = (prefix ? prefix + "::" : "") + s.replace(/as\w+$/, "");
      if (s) out.push(p.replace(/::self$/, ""));
      return;
    }
    const head = s.slice(0, brace).replace(/::$/, "");
    const inner = s.slice(brace + 1, s.lastIndexOf("}"));
    const base = [prefix, head].filter(Boolean).join("::");
    let depth = 0;
    let start = 0;
    for (let i = 0; i <= inner.length; i++) {
      const ch = inner[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if ((ch === "," && depth === 0) || i === inner.length) {
        const part = inner.slice(start, i);
        if (part) walk(base, part);
        start = i + 1;
      }
    }
  };
  walk("", t.replace(/\bas\b\w+/g, ""));
  return out.map((p) => p.replace(/as[A-Za-z_]\w*$/, ""));
}

/** Removes `#[cfg(test)]` items (usually `mod tests { ... }`): test-only imports are not architecture. */
function stripRustTests(c: string): string {
  let out = c;
  for (;;) {
    const hit = /#\[cfg\((?:test|(?:all|any)\(\s*test\b[^\]]*)\)\]/.exec(out);
    if (!hit) return out;
    const at = hit.index;
    let i = at + hit[0].length;
    // The attribute applies to the next item: a block (mod, fn, impl) or a single statement.
    let j = i;
    while (j < out.length && out[j] !== "{" && out[j] !== ";") j++;
    if (out[j] === "{") {
      let depth = 0;
      for (; j < out.length; j++) {
        if (out[j] === "{") depth++;
        else if (out[j] === "}" && --depth === 0) break;
      }
    }
    out = out.slice(0, at) + out.slice(at, j + 1).replace(/[^\n]/g, " ") + out.slice(j + 1);
    i = j;
  }
}

const RUST_KEYWORDS = new Set(["self", "super", "crate", "std", "core", "alloc", "Self"]);

const rust: Extractor = {
  lang: "rust",
  extensions: [".rs"],
  extract(_file, code) {
    const c = stripRustTests(blank(code.replace(/'"'/g, "' '"), LEX.rust));
    const imports: ParsedImport[] = [];
    const vis = "(?:pub(?:\\([^)]*\\))?\\s+)?";
    for (const m of c.matchAll(new RegExp(`^\\s*${vis}mod\\s+(\\w+)\\s*;`, "gm"))) imports.push(imp(`mod:${m[1]}`, [m[1]]));
    for (const m of c.matchAll(new RegExp(`^\\s*${vis}use\\s+([^;]+);`, "gm"))) {
      for (const p of expandUseTree(m[1].replace(/\s+as\s+\w+/g, ""))) {
        const segs = p.split("::").filter(Boolean);
        if (segs.length) imports.push(imp(`use:${segs.join("::")}`, [segs[segs.length - 1]].filter((n) => n !== "*")));
      }
    }
    for (const m of c.matchAll(new RegExp(`^\\s*${vis}extern\\s+crate\\s+(\\w+)`, "gm"))) imports.push(imp(`use:${m[1]}`, []));
    // Qualified paths used inline, without a `use`: crate::a::b::f() or other_crate::Type.
    const body = c.replace(new RegExp(`^\\s*${vis}(?:use|mod|extern\\s+crate)\\b[^;]*;`, "gm"), (m) => m.replace(/[^\n]/g, " "));
    for (const m of body.matchAll(/(?<![\w:])((?:crate|super|self)(?:::[a-z_]\w*)+)(?=::|\b)/g)) imports.push(imp(`use:${m[1]}`, []));
    const roots = new Set<string>();
    for (const m of body.matchAll(/(?<![\w:])([a-z_][a-z0-9_]*)::/g)) if (!RUST_KEYWORDS.has(m[1])) roots.add(m[1]);
    return { imports, exports: [], lang: "rust", refs: [...roots] };
  },
};

// ---------- JVM: Java, Kotlin, Scala, Groovy ----------
const DECL_TYPE = /\b(?:class|interface|enum|record|object|trait|struct|protocol|actor|typealias|annotation\s+class|data\s+class|sealed\s+class|abstract\s+class)\s+([A-Z]\w*)/g;

const jvm: Extractor = {
  lang: "jvm",
  extensions: [".java", ".kt", ".kts", ".scala", ".sc", ".groovy"],
  extract(file, code) {
    const c = blank(code, LEX.jvm);
    const imports: ParsedImport[] = [];
    const pkg = /^\s*package\s+([\w.]+)/m.exec(c)?.[1] ?? "";
    for (const m of c.matchAll(/^\s*import\s+(static\s+)?([\w.`]+?)(\.\*|\._|\.\{[^}\n]*\})?\s*(?:as\s+\w+)?\s*;?\s*$/gm)) {
      const base = m[2].replace(/`/g, "");
      const tail = m[3];
      if (!tail) imports.push(imp(base, [base.split(".").pop()!]));
      else if (tail === ".*" || tail === "._") imports.push(imp(`${base}.*`, ["*"]));
      else for (const n of tail.slice(2, -1).split(",")) {
        const name = n.trim().split(/\s*=>\s*|\s+as\s+/)[0];
        if (name === "_" || name === "*") imports.push(imp(`${base}.*`, ["*"]));
        else if (name) imports.push(imp(`${base}.${name}`, [name]));
      }
    }
    const types = uniq([...c.matchAll(DECL_TYPE)].map((m) => m[1]));
    // Kotlin and Scala allow top-level functions and vals that other packages import by name.
    const topLevel = /\.(kt|kts|scala)$/.test(file) ? uniq([...c.matchAll(/^(?:(?:public|internal|private|inline|suspend|operator|infix|tailrec)\s+)*(?:fun|val|var|def)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/gm)].map((m) => m[1])) : [];
    const own = new Set(types);
    return { imports, exports: topLevel, lang: "jvm", declares: [pkg], types, refs: typeRefs(c, own) };
  },
};

// ---------- C# (and F# namespaces) ----------
const csharp: Extractor = {
  lang: "csharp",
  extensions: [".cs"],
  extract(_file, code) {
    const c = blank(code, LEX.csharp);
    const imports: ParsedImport[] = [];
    for (const m of c.matchAll(/^\s*(?:global\s+)?using\s+(static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/gm)) imports.push(imp(`ns:${m[3]}`, [], m[1] ? "static" : "static"));
    const declares = uniq([...c.matchAll(/^\s*namespace\s+([\w.]+)/gm)].map((m) => m[1]));
    const types = uniq([...c.matchAll(/\b(?:class|interface|enum|record|struct|delegate\s+\w+)\s+([A-Z]\w*)/g)].map((m) => m[1]));
    return { imports, exports: [], lang: "csharp", declares, types, refs: typeRefs(c, new Set(types)) };
  },
};

/** .csproj / .fsproj / .vbproj: project references are the real architecture of a .NET solution. */
const msbuild: Extractor = {
  lang: "msbuild",
  extensions: [".csproj", ".fsproj", ".vbproj"],
  extract(_file, code) {
    const c = blank(code, LEX.xml);
    const imports = [...c.matchAll(/<ProjectReference\s+Include\s*=\s*"([^"]+)"/g)].map((m) => imp(m[1].replace(/\\/g, "/"), [], "project"));
    return { imports, exports: [], lang: "msbuild" };
  },
};

// ---------- C / C++ / Objective-C ----------
const cfamily: Extractor = {
  lang: "c",
  extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".ipp", ".m", ".mm", ".cu", ".cuh"],
  extract(_file, code) {
    const c = blank(code, LEX.c);
    const imports: ParsedImport[] = [];
    for (const m of c.matchAll(/^\s*#\s*(?:include|import)\s*([<"])([^>"\n]+)[>"]/gm)) imports.push(imp(`${m[1] === "<" ? "sys:" : ""}${m[2].trim()}`, [], "include"));
    return { imports, exports: [], lang: "c" };
  },
};

// ---------- Ruby ----------
/** Full constant names declared in a Ruby file, from `module`/`class` nesting by indentation. */
function rubyDeclarations(clean: string): string[] {
  const stack: { indent: number; full: string }[] = [];
  const out: string[] = [];
  for (const line of clean.split("\n")) {
    const m = /^(\s*)(?:class|module)\s+(?:::)?([A-Z][\w:]*)/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const full = stack.length ? `${stack[stack.length - 1].full}::${m[2]}` : m[2];
    stack.push({ indent, full });
    out.push(full);
  }
  return uniq(out);
}

const ruby: Extractor = {
  lang: "ruby",
  extensions: [".rb", ".rake"],
  extract(_file, code) {
    const c = blank(code, LEX.ruby);
    const imports: ParsedImport[] = [];
    for (const m of c.matchAll(/\brequire_relative\s*\(?\s*['"]([^'"]+)['"]/g)) imports.push(imp(`./${m[1].replace(/^\.\//, "")}`, [], "require"));
    for (const m of c.matchAll(/(?:^|[\s;(])require\s*\(?\s*['"]([^'"]+)['"]/gm)) imports.push(imp(m[1], [], "require"));
    for (const m of c.matchAll(/\bautoload\s*\(?\s*:\w+\s*,\s*['"]([^'"]+)['"]/g)) imports.push(imp(m[1], [], "require"));
    const clean = blank(code, { ...LEX.ruby, blankStrings: true });
    const declares = rubyDeclarations(clean);
    const own = new Set(declares);
    const refs = uniq([...clean.matchAll(/(?<![\w:])(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*/g)].map((m) => m[0])).filter((r) => !own.has(r));
    return { imports, exports: [], lang: "ruby", declares, types: declares, refs };
  },
};

// ---------- PHP ----------
const php: Extractor = {
  lang: "php",
  extensions: [".php"],
  extract(_file, code) {
    const c = blank(code, LEX.php);
    const imports: ParsedImport[] = [];
    for (const m of c.matchAll(/^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)\s*\{([^}]*)\}\s*;/gm)) {
      for (const part of m[2].split(",")) {
        const n = part.trim().split(/\s+as\s+/i)[0];
        if (n) imports.push(imp(`${m[1].replace(/\\$/, "")}\\${n}`.replace(/^\\/, ""), [n.split("\\").pop()!]));
      }
    }
    for (const m of c.matchAll(/^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)(?:\s+as\s+\w+)?\s*(?:,\s*[\w\\]+(?:\s+as\s+\w+)?\s*)*;/gm)) {
      for (const part of m[0].replace(/^\s*use\s+(function\s+|const\s+)?/, "").replace(/;\s*$/, "").split(",")) {
        const n = part.trim().split(/\s+as\s+/i)[0].replace(/^\\/, "");
        if (n && !n.includes("{")) imports.push(imp(n, [n.split("\\").pop()!]));
      }
    }
    for (const m of c.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+\.php)['"]/g)) imports.push(imp(`./${m[1].replace(/^\/?/, "")}`, [], "require"));
    const clean = blank(code, { ...LEX.php, blankStrings: true });
    const declares = uniq([...clean.matchAll(/^\s*namespace\s+([\w\\]+)\s*[;{]/gm)].map((m) => m[1]));
    const types = uniq([...clean.matchAll(/\b(?:class|interface|trait|enum)\s+([A-Z]\w*)/g)].map((m) => m[1]));
    return { imports, exports: [], lang: "php", declares, types, refs: typeRefs(clean, new Set(types)) };
  },
};

// ---------- Swift ----------
const swift: Extractor = {
  lang: "swift",
  extensions: [".swift"],
  extract(_file, code) {
    const c = blank(code, LEX.swift);
    const imports = [...c.matchAll(/^\s*(?:@\w+\s+)*import\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?([\w.]+)/gm)].map((m) => imp(`mod:${m[1].split(".")[0]}`));
    const types = uniq([...c.matchAll(/\b(?:class|struct|enum|protocol|actor|typealias)\s+([A-Z]\w*)/g)].map((m) => m[1]));
    return { imports, exports: [], lang: "swift", types, refs: typeRefs(c, new Set(types)) };
  },
};

// ---------- Dart ----------
const dart: Extractor = {
  lang: "dart",
  extensions: [".dart"],
  extract(_file, code) {
    const c = blank(code, LEX.dart);
    const imports = [...c.matchAll(/^\s*(import|export|part)\s+['"]([^'"]+)['"]/gm)].map((m) => imp(m[2], [], m[1] === "export" ? "reexport" : "static"));
    return { imports, exports: [], lang: "dart" };
  },
};

// ---------- Elixir ----------
const elixir: Extractor = {
  lang: "elixir",
  extensions: [".ex", ".exs"],
  extract(_file, code) {
    const c = blank(code, LEX.elixir);
    const declares = uniq([...c.matchAll(/\bdefmodule\s+([A-Z][\w.]*)/g)].map((m) => m[1]));
    const refs = new Set<string>();
    for (const m of c.matchAll(/\b(?:alias|import|use|require)\s+([A-Z][\w.]*)\.\{([^}]*)\}/g)) for (const n of m[2].split(",")) refs.add(`${m[1]}.${n.trim()}`);
    for (const m of c.matchAll(/\b[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)+/g)) refs.add(m[0]);
    for (const m of c.matchAll(/\b(?:alias|import|use|require)\s+([A-Z][A-Za-z0-9_]*)\b/g)) refs.add(m[1]);
    const own = new Set(declares);
    return { imports: [], exports: [], lang: "elixir", declares, refs: [...refs].filter((r) => !own.has(r)) };
  },
};

// ---------- Lua ----------
const lua: Extractor = {
  lang: "lua",
  extensions: [".lua"],
  extract(_file, code) {
    const c = blank(code, LEX.lua);
    const imports = [...c.matchAll(/\brequire\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => imp(m[1], [], "require"));
    return { imports, exports: [], lang: "lua" };
  },
};

// ---------- Haskell ----------
const haskell: Extractor = {
  lang: "haskell",
  extensions: [".hs", ".lhs"],
  extract(_file, code) {
    const c = blank(code, LEX.haskell);
    const imports = [...c.matchAll(/^\s*import\s+(?:safe\s+)?(?:qualified\s+)?(?:"[^"]*"\s+)?([A-Z][\w.]*)/gm)].map((m) => imp(`mod:${m[1]}`));
    const declares = uniq([...c.matchAll(/^\s*module\s+([A-Z][\w.]*)/gm)].map((m) => m[1]));
    return { imports, exports: [], lang: "haskell", declares };
  },
};

// ---------- Zig ----------
const zig: Extractor = {
  lang: "zig",
  extensions: [".zig"],
  extract(_file, code) {
    const c = blank(code, LEX.zig);
    const imports = [...c.matchAll(/@import\s*\(\s*"([^"]+)"\s*\)/g)].map((m) => imp(m[1]));
    return { imports, exports: [], lang: "zig" };
  },
};

// ---------- Elm, OCaml-ish and others can slot in here with the same contract. ----------

export const EXTRACTORS: Extractor[] = [python, go, rust, jvm, csharp, msbuild, cfamily, ruby, php, swift, dart, elixir, lua, haskell, zig];

const byExt = new Map<string, Extractor>();
for (const x of EXTRACTORS) for (const e of x.extensions) byExt.set(e, x);

export function extractorFor(file: string): Extractor | undefined {
  return byExt.get(path.extname(file).toLowerCase());
}

export const EXTRA_EXTENSIONS = [...byExt.keys()];

export function blankFor(lang: string): LexSpec | undefined {
  return (LEX as Record<string, LexSpec>)[lang];
}
