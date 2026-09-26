# Cold `fault init` quality

`score.mjs` compares the draft `fault init` writes on a repo with a hand-written map of the same repo,
using the adjusted Rand index over files (1.0 means the same grouping; 0 means no better than chance).

```
node bench/init/score.mjs <astro-clone> examples/astro/faultline.yml
```

On withastro/astro (967 source files) the cold draft has 16 systems against 22 hand-written ones:
ARI 0.50, Rand 0.92. The draft splits the folder tree with a budget of boxes, keeps real packages as
their own boxes, names leftover folders after their parent (the rest of `core/` is "Core"), places small
unconnected pieces by imports, and never emits a "misc" box.
