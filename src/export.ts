import fs from "node:fs";
import path from "node:path";
import type { Args } from "./cli.js";
import { Workspace } from "./context.js";
import { headline } from "./describe.js";
import { diffModels } from "./diff.js";
import { bold, dim, green } from "./render/text.js";
import { repoName, UI_DIR } from "./server.js";
import { git, resolveRef, shortRef, WORKTREE } from "./source.js";
import { buildState, type MapState, type SnapshotMeta } from "./state.js";
import type { Model } from "./types.js";

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">';

/** One self-contained HTML file: the UI, its styles and the map data inline. */
export function renderStandalone(state: MapState, opts: { title: string; fragment?: boolean }): string {
  const css = fs.readFileSync(path.join(UI_DIR, "app.css"), "utf8");
  const js = fs.readFileSync(path.join(UI_DIR, "app.js"), "utf8");
  const data = JSON.stringify(state).replace(/</g, "\\u003c");
  const title = opts.title.replace(/[<>&]/g, "");
  const inner = `<title>${title}</title>\n${FONTS}\n<style>\n${css}\n</style>\n<div id="faultline"></div>\n<script>window.__FAULTLINE_STATE__ = ${data};</script>\n<script>\n${js.replace(/<\/script/gi, "<\\/script")}\n</script>\n`;
  if (opts.fragment) return inner;
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${inner.replace('<div id="faultline"></div>', "</head>\n<body>\n<div id=\"faultline\"></div>")}</body>\n</html>\n`;
}

function commitMeta(root: string, sha: string, kind: SnapshotMeta["kind"], webBase: string | null): SnapshotMeta {
  const [subj, author, time] = git(root, ["log", "-1", "--format=%s%x00%an%x00%ct", sha]).trim().split("\0");
  const pr = /\(#(\d+)\)\s*$/.exec(subj);
  const url = webBase ? (pr ? `${webBase}/pull/${pr[1]}` : `${webBase}/commit/${sha}`) : undefined;
  return { id: sha.slice(0, 12), label: shortRef(root, sha), kind, ref: sha, time: Number(time) * 1000, subject: subj, author, url };
}

function webBase(root: string): string | null {
  try {
    const url = git(root, ["config", "--get", "remote.origin.url"]).trim();
    const m = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(url);
    return m ? `https://github.com/${m[1]}` : null;
  } catch {
    return null;
  }
}

function outPath(args: Args, fallback: string): string {
  return String(args.flags.o ?? args.flags.out ?? fallback);
}

export async function cmdExport(args: Args) {
  const ws = Workspace.open();
  const [baseRef = "HEAD", headRef] = args._;
  const web = webBase(ws.root);
  const baseSha = resolveRef(ws.root, baseRef);
  const frames: { meta: SnapshotMeta; model: Model }[] = [{ meta: commitMeta(ws.root, baseSha, "base", web), model: await ws.model(baseSha) }];
  if (headRef && headRef !== WORKTREE) {
    const sha = resolveRef(ws.root, headRef);
    frames.push({ meta: commitMeta(ws.root, sha, "commit", web), model: await ws.model(sha) });
  } else {
    frames.push({ meta: { id: "worktree", label: "working tree", kind: "live", ref: WORKTREE, time: Date.now(), subject: "Uncommitted changes" }, model: await ws.model(undefined) });
  }
  const state = await buildState({ root: ws.root, repo: repoName(ws.root), config: ws.config, models: frames, mode: "static" });
  if (typeof args.flags.note === "string") state.note = args.flags.note;
  const file = outPath(args, "faultline-map.html");
  fs.writeFileSync(file, renderStandalone(state, { title: String(args.flags.title ?? `${repoName(ws.root)} map`), fragment: !!args.flags.fragment }));
  const d = diffModels(frames[0].model, frames[1].model, ws.config);
  console.log(`${green("✓")} Wrote ${bold(file)}  ${dim(headline(d, ws.config))}`);
}

export async function cmdReplay(args: Args) {
  const ws = Workspace.open();
  const [fromRef, toRef = "HEAD"] = args._;
  if (!fromRef) throw new Error("Usage: fault replay <from-ref> [to-ref] -o map.html");
  const web = webBase(ws.root);
  const max = Number(args.flags.max ?? 60);
  const revs = git(ws.root, ["rev-list", "--reverse", ...(args.flags["all-parents"] ? [] : ["--first-parent"]), `${fromRef}..${toRef}`]).trim().split("\n").filter(Boolean);
  const picked = revs.slice(-max);
  const baseSha = picked.length < revs.length ? resolveRef(ws.root, `${picked[0]}~1`) : resolveRef(ws.root, fromRef);
  process.stderr.write(dim(`Replaying ${picked.length} commits…\n`));
  const frames: { meta: SnapshotMeta; model: Model }[] = [{ meta: commitMeta(ws.root, baseSha, "base", web), model: await ws.model(baseSha) }];
  let structural = 0;
  for (const sha of picked) {
    const model = await ws.model(sha);
    const prev = frames[frames.length - 1].model;
    const d = diffModels(prev, model, ws.config);
    if (d.systemEdges.added.length + d.systemEdges.removed.length + d.violations.introduced.length + d.cycles.added.length) structural++;
    frames.push({ meta: commitMeta(ws.root, sha, "commit", web), model });
  }
  if (args.flags.worktree) {
    // Append uncommitted work as the final step, e.g. an agent's edit that has not landed yet.
    const label = typeof args.flags.worktree === "string" ? args.flags.worktree : "Uncommitted changes";
    frames.push({ meta: { id: "worktree", label: "working tree", kind: "live", ref: WORKTREE, time: Date.now(), subject: label }, model: await ws.model(undefined) });
  }
  const state = await buildState({ root: ws.root, repo: repoName(ws.root), config: ws.config, models: frames, mode: "static", compact: true });
  if (typeof args.flags.note === "string") state.note = args.flags.note;
  const file = outPath(args, "faultline-replay.html");
  fs.writeFileSync(file, renderStandalone(state, { title: String(args.flags.title ?? `${repoName(ws.root)} history`), fragment: !!args.flags.fragment }));
  const size = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
  console.log(`${green("✓")} Wrote ${bold(file)} ${dim(`(${size} MB)`)}: ${picked.length} commits, ${structural} changed the architecture.`);
}
