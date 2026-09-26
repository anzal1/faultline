# Agent trial: does faultline change what a coding agent ships?

Pilot run on 2026-09-26: Claude Code (Sonnet 5), headless, file tools only, on the Astro monorepo.
Three arms per task: `none` (the repo as it is), `docs` (the same rules as prose in AGENTS.md),
`faultline` (faultline.yml plus `fault setup --agent claude`). Every run gets a fresh worktree and is
scored afterwards with the same rules, and again with a plain-text import check that does not use
faultline (`independent` below). Both scorers agree on every run.

| Task | What tempts the agent | none | docs | faultline |
|---|---|---:|---:|---:|
| slow-render | `runtime -> build` (reuse `getTimeStat` from `core/build`) | 3/3 crossed | 3/3 crossed | 0/3 crossed |
| agent-errors, round 2 | production code importing `cli/agent.ts` (rule: only dev server and Vite plugins may) | 0/3 | 2/3 | 0/3 |
| agent-errors, round 1 | same, but the rule only covered `core/app` and agents wrote to `core/errors` | 2/3* | 1/3* | 2/3* |
| double-slash (control) | nothing: production already had the feature | 0/3 | 0/3 | 0/3 |

\* Not a violation of the rules as written; counted by the independent check. Faultline enforces what
the rules cover and nothing more. Round 2 widened the rule after round 1 was seen.

Pooled where the rule covers the tempting import: none 3/6, docs 5/6, faultline 0/6
(Fisher exact, faultline vs docs p = 0.015, vs none p = 0.18). All trap runs in every arm finished the task.
Faultline runs cost $0.76 on average against $0.47 (none) and $0.52 (docs), mostly because the correct
fix is a refactor; on the control task the overhead was about 7%.

This is a pilot: one repo, one model, tasks written by the builder, n = 3 per cell. Reproduce with:

```
node bench/agent-ab/run.mjs <astro-clone> bench/agent-ab/astro.faultline.yml --n 3
node bench/agent-ab/run.mjs <astro-clone> bench/agent-ab/astro.faultline.v2.yml --n 3 --only agent-errors --round 2 \
  --prose-extra "Only the dev server and Vite plugins may import from packages/astro/src/cli. No other code may import CLI code, because everything else ships or runs in production."
node bench/agent-ab/analyze.mjs
```

`results/` holds every run's metrics (`.json`) and the exact diff the agent produced (`.diff`).
