# faultline

A living architecture map for your codebase. You declare the systems once, and every change after that (yours or an agent's) shows up as light on a map that never moves.

```
fault init        # propose systems from the repo, write faultline.yml
fault map         # open the live map; it redraws as files change
fault diff main   # what this branch did to the structure, in plain English
fault check main  # exit 1 if it crosses a fault line (CI)
```

> Status: working, not yet on npm. Until it is, install from source: `npm install && npm run build && npm link`, then `fault` is on your PATH.

It answers one question in a way a reviewer can take in at a glance: **what did this change do to the shape of the system?** Not which lines moved. Which boxes started talking to each other, which boundaries got crossed, and the exact imports behind each of those.

```
1 fault line crossed. 1 file across 1 system.
HEAD (3f3d580) → working tree

✖ Crosses a fault line: Request handling → Dev server
  Code that runs in production must not pull in dev tooling.
  origin-check.ts imports warnMissingAdapter from adapter-validation.ts.
```

## Why it works where diagram tools went stale

Most code-to-diagram tools regenerate the picture from scratch every time. The grouping shifts from run to run, the layout reshuffles, and after a week nobody trusts it. faultline does the opposite:

- **The systems are declared, not guessed.** `faultline.yml` maps paths to named systems, like CODEOWNERS for architecture. `fault init` proposes a first draft from the directory tree (or asks Claude with `--ai`). You edit it until the boxes match how your team talks, then commit it. "What level of detail?" becomes "the level you declared."
- **Edges are ground truth.** Every edge on the map comes from a real import, parsed with [oxc](https://oxc.rs). Nothing is inferred by a model. Click any edge to see the files and names behind it.
- **The map never moves.** Box positions are computed once and saved to `.faultline/layout.json`. A change lights up the map; it doesn't rearrange it.
- **It diffs the model, not the picture.** Two snapshots of the model are compared: new and removed dependencies between systems, new cycles, new packages, and imports that cross a rule. The picture is just how that diff gets shown.

## The map

`fault map` serves a local page that watches the repo and redraws as files change:

- **Systems view.** Every system with its dependencies. New edges are green, crossed fault lines are red, removed edges are red and dashed, and changed systems get an amber outline with file counts.
- **Drill in.** Double-click a system to see its modules, with callers on the left and dependencies on the right.
- **Evidence.** Click an edge to see every import behind it, with new ones highlighted.
- **Timeline.** Commits made during the session become steps. When Claude Code finishes a turn (see below), that turn becomes a step too. Scrub back through them, or compare each step to the one before.

`fault export` and `fault replay` write the same UI to a single HTML file you can share: one change, or a whole stretch of history played back commit by commit.

## faultline.yml

```yaml
version: 1
systems:
  - id: web
    name: Web UI
    description: Pages and components.
    paths: [apps/web/src/**]
  - id: api
    name: API
    paths: [apps/api/src/**]
  - id: db
    name: Database
    paths: [packages/db/**]
rules:
  - deny: web -> db
    reason: The UI talks to the API, never the database
  - deny: "{web,api} -> {scripts,tools}"
ignore:
  - "**/node_modules/**"
  - "**/*.test.*"
```

- A file belongs to the most specific system whose glob matches it, so you can carve `src/core/**` out of a broader `src/**`.
- Files outside every system show up as **Unmapped**, and new ones are reported in each diff, so the map never silently drifts from the code.
- Rules take system ids or globs over ids. Type-only imports don't count as violations unless you set `types: true` on the rule.

## In CI

Once the package is published, add this workflow:

```yaml
# .github/workflows/faultline.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  faultline:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: anzal1/faultline@v0
```

Every pull request gets one sticky comment. It holds the headline, each structural change as a sentence, a Mermaid map of just the neighbourhood that changed (GitHub renders it inline), and the imports behind each change. The check fails when the PR crosses a fault line.

## With Claude Code

```
fault install-hook
```

This adds two hooks to `.claude/settings.json`:

- **After every edit**, if the agent just crossed a fault line, the hook tells the agent right away, with the rule and the offending import, so it can route around the boundary in the same turn instead of in review.
- **When a turn ends**, the turn is frozen as a step on the live map, and you get a one-line summary of what moved.

Run `fault map` next to your session and you can watch the agent's work land on the architecture as it happens.

## How it works

1. **List files.** A snapshot is either a git ref (read straight from the object store, no checkout) or the working tree.
2. **Parse.** Every JS, TS, `.astro`, `.vue` and `.svelte` file is parsed with oxc for static imports, re-exports, dynamic imports and `require`. Results are cached by git blob hash, so after the first run a snapshot of a large repo rebuilds in a fraction of a second.
3. **Resolve.** Relative paths, `.js` → `.ts` mapping, index files, tsconfig `paths`, and workspace packages. A monorepo package import is followed through its `exports` map and from `dist/` back to `src/`.
4. **Assign.** Each file goes to a system and a module (the first folder under the system's root).
5. **Aggregate and diff.** File edges roll up into module and system edges, and two snapshots are compared.

Replaying the last 260 commits of the Astro monorepo takes about 30 seconds on a laptop.

## Limits

- JavaScript and TypeScript (plus Astro, Vue and Svelte components) only, for now.
- Imports built from runtime strings (`import(\`./locale/${lang}\`)`) are not followed.
- Edges are imports. Calls over HTTP, queues or a DI container are not on the map yet.

## Development

```
npm install
npm run build
npm test
node dist/cli.js -C path/to/repo map
```

MIT licensed.
