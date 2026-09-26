import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { diffModels } from "./diff.js";
import { buildModel } from "./graph.js";
import { ParseCache } from "./parse.js";
import { git, gitRoot, isGitRepo, makeSource, WORKTREE } from "./source.js";
import type { Config, Delta, Model } from "./types.js";

/** Shared state for one CLI invocation: repo root, config, parse cache, and memoised models. */
export class Workspace {
  readonly cache: ParseCache;
  private models = new Map<string, Promise<Model>>();

  constructor(readonly root: string, public config: Config) {
    this.cache = new ParseCache(root);
  }

  static open(cwd = process.cwd()): Workspace {
    const root = findRoot(cwd);
    const config = loadConfig(root);
    if (!config) {
      throw new Error(`No faultline.yml in ${root}. Run \`fault init\` first to declare your systems.`);
    }
    return new Workspace(root, config);
  }

  model(ref: string | undefined): Promise<Model> {
    const key = ref ?? WORKTREE;
    if (key === WORKTREE) return buildModel(makeSource(this.root, undefined), this.config, this.cache);
    let m = this.models.get(key);
    if (!m) {
      m = buildModel(makeSource(this.root, key), this.config, this.cache);
      this.models.set(key, m);
    }
    return m;
  }

  async diff(base: string | undefined, head: string | undefined): Promise<{ delta: Delta; baseModel: Model; headModel: Model }> {
    const [baseModel, headModel] = await Promise.all([this.model(base ?? "HEAD"), this.model(head)]);
    return { delta: diffModels(baseModel, headModel, this.config), baseModel, headModel };
  }

  reloadConfig() {
    const c = loadConfig(this.root);
    if (c) this.config = c;
    this.models.clear();
  }

  hasGit(): boolean {
    return isGitRepo(this.root);
  }

  defaultBranch(): string | null {
    for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
      try {
        return git(this.root, ["rev-parse", "--abbrev-ref", ref]).trim() || ref;
      } catch {
        // try next
      }
    }
    return null;
  }
}

export function findRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, "faultline.yml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot(cwd) ?? path.resolve(cwd);
}
