import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A snapshot of the repo's files: either a git ref or the working tree. */
export interface Source {
  ref: string;
  label: string;
  /** Every path in the snapshot (source or not), used for resolution and package discovery. */
  list(): Promise<Map<string, string>>; // path -> blob hash
  read(paths: string[]): Promise<Map<string, string>>; // path -> content
}

export const WORKTREE = "WORKTREE";

export function git(root: string, args: string[], input?: string): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

export function isGitRepo(root: string): boolean {
  return spawnSync("git", ["rev-parse", "--git-dir"], { cwd: root }).status === 0;
}

export function gitRoot(dir: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function resolveRef(root: string, ref: string): string {
  return git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

export function shortRef(root: string, ref: string): string {
  try {
    return git(root, ["rev-parse", "--short", ref]).trim();
  } catch {
    return ref.slice(0, 8);
  }
}

/** Same hash git uses for blobs, so working-tree files and committed files share one parse cache. */
export function blobHash(content: string | Buffer): string {
  const buf = typeof content === "string" ? Buffer.from(content) : content;
  return crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export class GitRefSource implements Source {
  private listing?: Map<string, string>;
  constructor(readonly root: string, readonly ref: string, readonly label: string) {}

  async list(): Promise<Map<string, string>> {
    if (this.listing) return this.listing;
    const out = git(this.root, ["ls-tree", "-r", "-z", "--full-tree", this.ref]);
    const files = new Map<string, string>();
    for (const entry of out.split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      const [, type, sha] = entry.slice(0, tab).split(" ");
      if (type === "blob") files.set(entry.slice(tab + 1), sha);
    }
    this.listing = files;
    return files;
  }

  async read(paths: string[]): Promise<Map<string, string>> {
    const listing = await this.list();
    const shas = paths.map((p) => listing.get(p)).filter((s): s is string => !!s);
    const bySha = await catFileBatch(this.root, shas);
    const out = new Map<string, string>();
    for (const p of paths) {
      const sha = listing.get(p);
      const content = sha ? bySha.get(sha) : undefined;
      if (content !== undefined) out.set(p, content);
    }
    return out;
  }
}

/** Streams blobs through one `git cat-file --batch` process. */
export function catFileBatch(root: string, shas: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(shas)];
  const result = new Map<string, string>();
  if (unique.length === 0) return Promise.resolve(result);
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["cat-file", "--batch"], { cwd: root });
    let buf = Buffer.alloc(0);
    let idx = 0;
    proc.stdout.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const header = buf.subarray(0, nl).toString();
        const parts = header.split(" ");
        if (parts[1] === "missing") {
          buf = buf.subarray(nl + 1);
          idx++;
          continue;
        }
        const size = Number(parts[2]);
        if (buf.length < nl + 1 + size + 1) return;
        result.set(parts[0], buf.subarray(nl + 1, nl + 1 + size).toString("utf8"));
        buf = buf.subarray(nl + 1 + size + 1);
        idx++;
      }
    });
    proc.on("error", reject);
    proc.on("close", () => resolve(result));
    proc.stdin.write(unique.join("\n") + "\n");
    proc.stdin.end();
  });
}

export class WorktreeSource implements Source {
  readonly ref = WORKTREE;
  private contents = new Map<string, string>();
  constructor(readonly root: string, readonly label = "working tree") {}

  async list(): Promise<Map<string, string>> {
    const paths = isGitRepo(this.root)
      ? git(this.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean)
      : walk(this.root);
    const files = new Map<string, string>();
    for (const p of paths) {
      const abs = path.join(this.root, p);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue; // deleted but still in the index
      }
      if (!stat.isFile()) continue;
      // Hash lazily for non-source files: only size+mtime matter for them.
      files.set(p, `wt:${stat.size}:${stat.mtimeMs}`);
    }
    return files;
  }

  async read(paths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const p of paths) {
      try {
        const content = fs.readFileSync(path.join(this.root, p), "utf8");
        this.contents.set(p, content);
        out.set(p, content);
      } catch {
        // vanished between list and read
      }
    }
    return out;
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".next"]);
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  visit("");
  return out;
}

export function makeSource(root: string, ref: string | undefined): Source {
  if (!ref || ref === WORKTREE) return new WorktreeSource(root);
  const sha = resolveRef(root, ref);
  return new GitRefSource(root, sha, ref === sha ? shortRef(root, sha) : `${ref} (${shortRef(root, sha)})`);
}
