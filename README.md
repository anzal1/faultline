# faultline

A living architecture map for any codebase. You declare the systems once. Every change after that, yours or any coding agent's, shows up as light on a map that never moves, as a sentence in the PR, and as a short answer the agent can read before it writes the wrong import.

```
fault init        # propose systems from the repo, write faultline.yml
fault map         # open the live map; it redraws as files change
fault setup       # connect your agents: MCP, hooks, AGENTS.md, pre-commit
fault diff main   # what this branch did to the structure, in plain English
fault check main  # exit 1 if it crosses a fault line (CI)
```

```
npm install -g @anzalabidi/faultline    # or run any command with npx -y @anzalabidi/faultline
```

Node 20 or newer. The command is `fault`.

It answers one question at a glance: **what did this change do to the shape of the system?** Not which lines moved. Which boxes started talking to each other, which boundaries got crossed, and the exact imports behind each of those.

```
✗ Crosses a fault line: Request handling → Dev server:
  packages/astro/src/core/app/origin-check.ts imports warnMissingAdapter from adapter-validation.ts.
  Allowed route: app → core-shared → dev-server
(~50 tokens)
```

## Any language

JavaScript and TypeScript are parsed with [oxc](https://oxc.rs). Every other language goes through a small adapter: a comment- and string-aware lexer that reads the imports, plus a resolver that follows that language's own rules.

| Language | Reads | Resolves through |
|---|---|---|
| TypeScript, JavaScript, Astro, Vue, Svelte | imports, re-exports, dynamic imports, `require` | relative paths, `.js` to `.ts`, index files, tsconfig `paths`, workspace `exports` |
| Python | `import`, `from … import`, `TYPE_CHECKING` blocks as type-only | package roots (`__init__.py`, src layouts), submodule-first `from` imports |
| Go | single and grouped imports | `go.mod` module paths to package directories |
| Rust | `mod`, nested `use` trees, `extern crate`, inline `crate::` and `other_crate::` paths; skips `#[cfg(test)]` | module tree (`mod.rs`, `lib.rs`), `self`, `super`, workspace crates from `Cargo.toml` |
| Java, Kotlin, Scala, Groovy | imports, wildcards, Scala `{A, B}`, Kotlin top-level functions | declared packages; same-package types by reference |
| C# (and .NET projects) | `using`, `global using`, namespaces, `.csproj` `ProjectReference` | types visible through the file's namespaces and usings |
| C, C++, Objective-C, CUDA | `#include`, `#import` | relative to the file, then the closest matching path |
| Ruby | `require`, `require_relative`, `autoload`, constants | Ruby's lexical constant lookup (`Jekyll::Document` sees `Jekyll::X` before `::X`) |
| PHP | `use` (including groups), `require`, `include` | declared namespaces and class names |
| Swift | `import`, type references | SPM targets from `Package.swift`, declared types |
| Dart | `import`, `export`, `part` | `package:` names from `pubspec.yaml`, relative paths |
| Elixir | `alias`, `import`, `use`, `require`, module references | declared `defmodule` names |
| Lua, Haskell, Zig | `require`, `import`, `@import` | module paths and declared modules |

Adding a language is one extractor and one resolver function; see `src/lang/`.

### Exact and inferred edges

Some languages name files in their imports. Others (C#, Swift, same-package Java, Ruby constants) only name types. faultline tags every edge:

- **exact**: the language's own import rules name the target file.
- **inferred**: matched by a referenced type that the repo declares somewhere visible.

Rules only fire on exact edges. A wrong edge that blocks a commit is worse than a missing one, so an inferred reference can show on the map but never fails your build. Names that shadow platform types (`String`, `File`, `View`, `Task`, and so on) are skipped rather than guessed.

### Measured accuracy

Checked against each language's own toolchain on public repos (`bench/accuracy/`, reproducible):

| Repo | Checked against | Precision | Recall |
|---|---|---:|---:|
| pallets/flask | Python `ast` + `PathFinder` | 100% | 100% |
| psf/requests | Python `ast` + `PathFinder` | 100% | 100% |
| encode/httpx | Python `ast` + `PathFinder` | 100% | 100% |
| fastapi/fastapi | Python `ast` + `PathFinder` | 100% | 97.8% (the misses are `test_*.py`, ignored on purpose) |
| BurntSushi/ripgrep | `cargo metadata`, crate to crate | 100% | 100% |
| tokio-rs/axum | `cargo metadata`, crate to crate | 100% | 100% |
| tokio-rs/tokio | `cargo metadata`, crate to crate | 100% | 72.7% (the misses are bench and test crates, ignored on purpose) |

Go, the JVM languages, C# and the rest were checked by hand on hugo, okhttp, spring-petclinic, eShop, redis, jekyll, laravel, swift-composable-architecture, cats, phoenix, telescope.nvim and zls. A native-toolchain comparison for them is the next benchmark to add.

## Any agent

```
fault setup              # agents it detects in the repo
fault setup --agent all  # or: claude,cursor,codex,copilot,gemini,kiro,zed,opencode
```

| Agent | MCP server | Told mid-turn when it crosses a fault line | Instructions |
|---|---|---|---|
| Claude Code | `.mcp.json` | PostToolUse hook | `CLAUDE.md` points to `AGENTS.md` |
| Cursor | `.cursor/mcp.json` | stop hook sends a follow-up message | `AGENTS.md` |
| OpenAI Codex | `.codex/config.toml` | PostToolUse hook (`additionalContext`) | `AGENTS.md` |
| GitHub Copilot (VS Code) | `.vscode/mcp.json` | PostToolUse hook (`.github/hooks`) | `.github/copilot-instructions.md` |
| Gemini CLI | `.gemini/settings.json` | | `GEMINI.md` |
| Kiro | `.kiro/settings/mcp.json` | | `.kiro/steering/` |
| Zed | `.zed/settings.json` | | `AGENTS.md` |
| OpenCode | `opencode.json` | | `AGENTS.md` |
| Windsurf, Cline | printed for their global config | | `AGENTS.md` |
| Anything else | `fault mcp` over stdio, or the CLI | git pre-commit hook | `AGENTS.md` |

`fault setup` also installs a git pre-commit hook (`fault check --staged`) that refuses a commit crossing a fault line, whoever wrote it. It is idempotent: run it twice and nothing changes.

### Four tools, few tokens

The MCP server has four tools, each with a description under 40 words, because every connected agent pays for the tool list in every session.

| Tool | Answers |
|---|---|
| `map` | the architecture: systems, what each owns, dependencies, fault lines, the plan |
| `place` | which system a path belongs to, what it must not import, and an allowed route when a direct import would cross a fault line |
| `check` | what your uncommitted work did to the structure, each finding with its evidence and a fix route |
| `plan` | declare a new dependency before writing it; the map and PR show planned versus actual |

The same answers are on the CLI (`fault overview`, `fault place`, `fault diff --format agent`, `fault plan`) for agents without MCP. Every answer ends with its own cost, `(~N tokens)`.

On Astro (967 source files, 22 systems), from `node bench/tokens.mjs`:

| What the agent needs | With faultline | Without |
|---|---:|---:|
| Tool list, once per session | 445 | |
| The whole architecture | 1,225 | 11,838 just to list the paths; ~935,000 to read the files and see the imports |
| Where one new file goes and what it may import | 70 to 150 | |
| What my edits did to the structure | 5 to 200 | |

## The map

`fault map` serves a local page that watches the repo and redraws as files change:

- **Systems view.** Every system with its dependencies. New edges are green, crossed fault lines red, removed edges red and dashed, planned edges dotted blue, and changed systems get an amber outline with file counts.
- **Drill in.** Double-click a system to see its modules, callers on the left and dependencies on the right.
- **Evidence.** Click an edge to see every import behind it, with the new ones highlighted.
- **Steer.** Click an edge and choose *Forbid this dependency* to turn it into a rule in `faultline.yml`. Click a system and *Plan a new dependency*. Agents read both through faultline on their next call.
- **Timeline.** Commits made during the session become steps, and so do agent turns. Scrub back through them, or compare each step to the one before.

The map is private to your machine: it binds to 127.0.0.1 and refuses writes from any other origin.

`fault export` and `fault replay` write the same UI to one HTML file you can share: a single change, or a stretch of history played back commit by commit.

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
    paths: [services/api/**]
  - id: db
    name: Database
    paths: [packages/db/**]
rules:
  - deny: web -> db
    reason: The UI talks to the API, never the database
  - deny: "{web,api} -> {scripts,tools}"
```

- A file belongs to the most specific system whose glob matches it, so you can carve `src/core/**` out of a broader `src/**`.
- Files outside every system show as **Unmapped**, and new ones are reported in each diff, so the map never drifts from the code without anyone noticing.
- Rules take system ids or globs over ids. Type-only imports don't count unless the rule sets `types: true`.
- `fault init` writes a first draft from the directory tree. `fault init --outline` prints the tree and the draft for whichever agent you use to name properly; `fault init --ai` asks Claude directly when `ANTHROPIC_API_KEY` is set.

## Plan versus actual

```
fault plan "api -> billing: invoices need customer data"
```

Planned dependencies live in `.faultline/plan.yml`, next to the code. The map draws them dotted until the imports exist. The PR comment lists each one as built or not yet, and flags any new dependency between systems that nobody planned.

## In CI

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

The action runs from its own source, so it needs no package registry. Every pull request gets one sticky comment: the headline, each structural change as a sentence, a Mermaid map of only the part that changed (GitHub renders it inline), plan versus actual, and the imports behind each change. The check fails when the PR crosses a fault line. On GitLab, Bitbucket or anything else, run `fault diff "$BASE" "$HEAD" --format markdown` and post the output.

## How it works

1. **List files.** A snapshot is a git ref (read straight from the object store, no checkout), the staged index, or the working tree.
2. **Parse.** Each file goes to its language's extractor. Results are cached by git blob hash, so after the first run a snapshot of a large repo rebuilds in a fraction of a second.
3. **Resolve.** Each import is resolved by its language's rules, and every edge is tagged exact or inferred.
4. **Assign.** Each file goes to a system and a module (the first folder under the system's root).
5. **Aggregate and diff.** File edges roll up into module and system edges, and two snapshots are compared.

Every repo named above builds its full graph in under a second on a laptop, cold, with no cache. Replaying the last 260 commits of the Astro monorepo takes about 30 seconds.

## Limits

- Imports built from runtime strings (`import(\`./locale/${lang}\`)`) are not followed.
- Edges are code dependencies. Calls over HTTP, queues or a DI container are not on the map yet.
- Inferred edges come from type names. They are good enough to draw and never enforced.

## Development

```
npm install
npm run build
npm test
node dist/cli.js -C path/to/repo map
```

MIT licensed.
