/**
 * A small scanner that blanks out comments (and optionally string contents) while keeping every
 * offset and newline in place. Import regexes then run on code that cannot be fooled by an
 * "import" inside a comment or docstring.
 */
export interface LexSpec {
  line?: string[];
  block?: [string, string][];
  nestedBlock?: boolean;
  strings: { open: string; close: string; escape?: boolean }[];
  /** Replace string contents with spaces too (for languages whose imports never use strings). */
  blankStrings?: boolean;
}

export function blank(code: string, spec: LexSpec): string {
  const out = code.split("");
  const n = code.length;
  const fill = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  outer: while (i < n) {
    const c = code[i];
    if (spec.line) {
      for (const l of spec.line) {
        if (code.startsWith(l, i)) {
          const end = code.indexOf("\n", i);
          const stop = end < 0 ? n : end;
          fill(i, stop);
          i = stop;
          continue outer;
        }
      }
    }
    if (spec.block) {
      for (const [open, close] of spec.block) {
        if (code.startsWith(open, i)) {
          let depth = 1;
          let j = i + open.length;
          while (j < n && depth > 0) {
            if (spec.nestedBlock && code.startsWith(open, j)) {
              depth++;
              j += open.length;
            } else if (code.startsWith(close, j)) {
              depth--;
              j += close.length;
            } else j++;
          }
          fill(i, j);
          i = j;
          continue outer;
        }
      }
    }
    for (const s of spec.strings) {
      if (code.startsWith(s.open, i)) {
        let j = i + s.open.length;
        while (j < n) {
          if (s.escape && code[j] === "\\") {
            j += 2;
            continue;
          }
          if (code.startsWith(s.close, j)) break;
          // Single-line strings end at a newline even when unterminated, so one bad quote cannot eat the file.
          if (s.close.length === 1 && s.open.length === 1 && code[j] === "\n" && s.open !== "`") break;
          j++;
        }
        if (spec.blankStrings) fill(i + s.open.length, j);
        i = Math.min(n, j + s.close.length);
        continue outer;
      }
    }
    i += c === undefined ? 1 : 1;
  }
  return out.join("");
}

const Q = (open: string, close = open, escape = true) => ({ open, close, escape });

export const C_LIKE: LexSpec = { line: ["//"], block: [["/*", "*/"]], strings: [Q('"'), Q("'")] };
export const LEX = {
  python: { line: ["#"], strings: [Q('"""'), Q("'''"), Q('"'), Q("'")], blankStrings: true } as LexSpec,
  go: { line: ["//"], block: [["/*", "*/"]], strings: [Q("`", "`", false), Q('"'), Q("'")] } as LexSpec,
  rust: { line: ["//"], block: [["/*", "*/"]], nestedBlock: true, strings: [Q('r#"', '"#', false), Q('"')], blankStrings: true } as LexSpec,
  jvm: { line: ["//"], block: [["/*", "*/"]], nestedBlock: true, strings: [Q('"""', '"""', false), Q('"'), Q("'")], blankStrings: true } as LexSpec,
  csharp: { line: ["//"], block: [["/*", "*/"]], strings: [Q('@"', '"', false), Q('"'), Q("'")], blankStrings: true } as LexSpec,
  c: { line: ["//"], block: [["/*", "*/"]], strings: [Q('"'), Q("'")] } as LexSpec,
  ruby: { line: ["#"], block: [["=begin", "=end"]], strings: [Q('"'), Q("'")] } as LexSpec,
  php: { line: ["//", "#"], block: [["/*", "*/"]], strings: [Q('"'), Q("'")] } as LexSpec,
  swift: { line: ["//"], block: [["/*", "*/"]], nestedBlock: true, strings: [Q('"""', '"""', false), Q('"')], blankStrings: true } as LexSpec,
  dart: { line: ["//"], block: [["/*", "*/"]], nestedBlock: true, strings: [Q("'''", "'''", false), Q('"""', '"""', false), Q('"'), Q("'")] } as LexSpec,
  elixir: { line: ["#"], strings: [Q('"""', '"""', false), Q('"'), Q("'")], blankStrings: true } as LexSpec,
  lua: { line: ["--"], block: [["--[[", "]]"]], strings: [Q("[[", "]]", false), Q('"'), Q("'")] } as LexSpec,
  haskell: { line: ["--"], block: [["{-", "-}"]], nestedBlock: true, strings: [Q('"')], blankStrings: true } as LexSpec,
  zig: { line: ["//"], strings: [Q('"')] } as LexSpec,
  xml: { block: [["<!--", "-->"]], strings: [] } as LexSpec,
};
