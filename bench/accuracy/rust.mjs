// Compares faultline's crate-to-crate dependencies with `cargo metadata` (normal dependencies only).
// Usage: (cd repo && cargo metadata --no-deps --format-version 1 > meta.json); node bench/accuracy/rust.mjs <repo> <meta.json>
import fs from 'node:fs';
import { buildModel } from '../../dist/graph.js';
import { makeSource } from '../../dist/source.js';
import { ParseCache } from '../../dist/parse.js';
import { defaultConfig } from '../../dist/propose.js';
const root = (await import('node:path')).resolve(process.argv[2]);
const meta = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const rel = (p) => p.replace(root + '/', '').replace(/\/Cargo\.toml$/, '').replace(/^Cargo\.toml$/, '');
const crates = meta.packages.map(p => ({ name: p.name, dir: rel(p.manifest_path) }));
const oracle = new Set();
for (const p of meta.packages) for (const d of p.dependencies) if (d.kind === null) {
  const t = crates.find(c => c.name === d.name); if (t && t.name !== p.name) oracle.add(`${p.name} -> ${t.name}`);
}
const crateOf = (f) => crates.filter(c => c.dir === '' || f.startsWith(c.dir + '/')).sort((a,b)=>b.dir.length-a.dir.length)[0]?.name;
const m = await buildModel(makeSource(root, undefined), defaultConfig([{ id: 'all', name: 'all', paths: ['**'] }]), new ParseCache(null));
const ours = new Set();
for (const e of m.edges) { const a = crateOf(e.from), b = crateOf(e.to); if (a && b && a !== b && !/(^|\/)(tests|benches|examples|fuzz)\/|build\.rs$/.test(e.from)) ours.add(`${a} -> ${b}`); }
const both = [...ours].filter(x => oracle.has(x));
console.log(`${root.split('/').pop()} crates: cargo ${oracle.size}, faultline ${ours.size}, agree ${both.length}. precision ${(both.length/ours.size*100).toFixed(1)}%, recall ${(both.length/oracle.size*100).toFixed(1)}%`);
for (const x of ours) if (!oracle.has(x)) console.log('  + extra ', x);
for (const x of oracle) if (!ours.has(x)) console.log('  - missed', x);
