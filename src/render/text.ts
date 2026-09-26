import { systemName } from "../config.js";
import { findings, headline, importPhrase } from "../describe.js";
import type { Config, Delta } from "../types.js";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const red = c("31");
export const green = c("32");
export const yellow = c("33");
export const dim = c("2");
export const bold = c("1");

export function renderText(delta: Delta, config: Config, opts: { verbose?: boolean } = {}): string {
  const out: string[] = [];
  out.push(bold(headline(delta, config)));
  out.push(dim(`${delta.base.label} → ${delta.head.label}`));
  const f = findings(delta, config);
  if (f.length) out.push("");
  for (const x of f) {
    const mark = x.severity === "fault" ? red("✖") : x.severity === "structure" ? yellow("●") : dim("·");
    out.push(`${mark} ${x.severity === "info" ? x.title : bold(x.title)}`);
    if (x.detail) out.push(`  ${dim(x.detail)}`);
    if (opts.verbose && x.evidence) for (const e of x.evidence.slice(0, 8)) out.push(`    ${dim(e.from)} → ${dim(e.to)}  ${importPhrase(e)}`);
  }
  if (delta.touched.length) {
    out.push("");
    out.push(
      dim("touched: ") +
        delta.touched
          .map((t) => `${systemName(config, t.system)} ${green("+" + t.added.length)} ${yellow("~" + t.modified.length)} ${red("-" + t.removed.length)}`)
          .join(dim("  ·  ")),
    );
  }
  return out.join("\n");
}
