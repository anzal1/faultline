/* faultline map UI. Plain JS, no build step. Reads either window.__FAULTLINE_STATE__ (exported
   file) or the live server (/api/state + /events). */
(() => {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  const root = document.getElementById("faultline");
  const STATIC = window.__FAULTLINE_STATE__ || null;

  let S = null; // MapState
  const ui = {
    snap: -1, // selected snapshot index
    compare: "base", // "base" | "prev"
    view: { kind: "systems" }, // or { kind: "system", id }
    sel: null, // { type: "system"|"module"|"edge", ... }
    showTypes: false,
    playing: false,
    onlyStructural: null, // null = decide by timeline length
    transform: { x: 0, y: 0, k: 1 },
    fitted: "",
    followLive: true,
  };

  // ---------- tiny DOM helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) if (kid) el.append(kid);
    return el;
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const baseName = (p) => (p || "").split("/").pop();

  // ---------- state access ----------
  const snap = (i = ui.snap) => S.snapshots[i];
  function systemsAt(i = ui.snap) {
    for (let j = i; j >= 0; j--) if (S.snapshots[j].systems) return S.snapshots[j].systems;
    return [];
  }
  function edgesAt(i, key) {
    for (let j = i; j >= 0; j--) if (S.snapshots[j][key]) return S.snapshots[j][key];
    return [];
  }
  function dv(i = ui.snap) {
    const sn = snap(i);
    if (!sn || i === 0) return null;
    if (ui.compare === "base" && sn.vsBase) return sn.vsBase;
    return sn.vsPrev;
  }
  const canCompareBase = (i = ui.snap) => i > 0 && !!snap(i)?.vsBase;
  const sysDef = (id) => S.config.systems.find((x) => x.id === id);
  function sysName(id) {
    if (id === "unmapped") return "Unmapped";
    return sysDef(id)?.name || id;
  }
  const modLabel = (mid) => mid.slice(mid.indexOf("/") + 1);
  const modSystem = (mid) => mid.slice(0, mid.indexOf("/"));
  const key = (a, b) => `${a}\u0000${b}`;

  function changeSets(d) {
    const out = {
      newSys: new Set(), goneSys: new Map(), grownSys: new Set(), faultSys: new Set(), oldFaultSys: new Set(),
      newMod: new Set(), goneMod: new Map(), touchedSys: new Map(), touchedMod: new Map(), newEvidence: new Set(),
    };
    if (!d) return out;
    const D = d.delta;
    for (const e of D.systemEdges.added) out.newSys.add(key(e.from, e.to));
    for (const e of D.systemEdges.removed) out.goneSys.set(key(e.from, e.to), e);
    for (const e of D.systemEdges.grown) out.grownSys.add(key(e.from, e.to));
    for (const v of D.violations.introduced) out.faultSys.add(key(v.from, v.to));
    for (const v of D.violations.existing) out.oldFaultSys.add(key(v.from, v.to));
    for (const e of D.moduleEdges.added) out.newMod.add(key(e.from, e.to));
    for (const e of D.moduleEdges.removed) out.goneMod.set(key(e.from, e.to), e);
    for (const t of D.touched) out.touchedSys.set(t.system, t);
    for (const [p, m] of Object.entries(d.fileModule || {})) {
      if (!m) continue;
      let t = out.touchedMod.get(m);
      if (!t) out.touchedMod.set(m, (t = { added: [], modified: [], removed: [] }));
      const sys = modSystem(m);
      const ts = out.touchedSys.get(sys);
      if (ts?.added.includes(p)) t.added.push(p);
      else if (ts?.removed.includes(p)) t.removed.push(p);
      else t.modified.push(p);
    }
    const evKey = (e) => `${e.from}\u0000${e.to}`;
    for (const list of [D.systemEdges.added, D.systemEdges.grown, D.moduleEdges.added]) for (const c of list) for (const e of c.evidence) out.newEvidence.add(evKey(e));
    for (const v of D.violations.introduced) for (const e of v.evidence) out.newEvidence.add(evKey(e));
    return out;
  }

  // ---------- evidence ----------
  function evidence(filter) {
    const last = S.snapshots.length - 1;
    const d = dv();
    const C = changeSets(d);
    const g = S.graph;
    const results = [];
    const seen = new Set();
    const push = (e, isNew) => {
      const k = e.from + "\u0000" + e.to;
      if (seen.has(k)) return;
      seen.add(k);
      results.push({ ...e, isNew: isNew || C.newEvidence.has(k) });
    };
    let complete = false;
    if (ui.snap === last && g) {
      complete = true;
      for (const [fi, ti, names, flags] of g.edges) {
        const e = { from: g.paths[fi], to: g.paths[ti], fs: g.system[fi], ts: g.system[ti], fm: g.module[fi], tm: g.module[ti] };
        if (!filter(e)) continue;
        push({ from: e.from, to: e.to, names: names ? names.split(",") : [], typeOnly: !!(flags & 1), kind: flags & 4 ? "reexport" : flags & 2 ? "dynamic" : "static" }, false);
      }
    }
    if (d) {
      const D = d.delta;
      const fileSys = (p) => sysOfPath(p);
      const lists = [...D.systemEdges.added, ...D.systemEdges.grown, ...D.moduleEdges.added, ...D.violations.introduced];
      for (const c of lists) for (const e of c.evidence) {
        const ee = { from: e.from, to: e.to, fs: fileSys(e.from), ts: fileSys(e.to), fm: e.fm, tm: e.tm };
        if (filter(ee)) push(e, true);
      }
    }
    results.sort((a, b) => Number(b.isNew) - Number(a.isNew) || a.from.localeCompare(b.from));
    return { list: results, complete };
  }
  function sysOfPath(p) {
    const g = S.graph;
    const i = g ? binarySearch(g.paths, p) : -1;
    if (i >= 0) return g.system[i];
    // Fall back to the module annotations carried on changes.
    for (const sn of S.snapshots) {
      const m = sn.vsBase?.fileModule?.[p] || sn.vsPrev?.fileModule?.[p];
      if (m) return modSystem(m);
    }
    return "";
  }
  function binarySearch(arr, v) {
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] === v) return mid;
      if (arr[mid] < v) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  // ---------- scene building ----------
  function buildSystemScene() {
    const sn = snap();
    const d = dv();
    const C = changeSets(d);
    const present = new Map(systemsAt().map((x) => [x.id, x]));
    const everywhere = new Set();
    for (const s2 of S.snapshots) for (const x of s2.systems || []) if (x.files > 0) everywhere.add(x.id);
    const nodes = [];
    for (const [id, box] of Object.entries(S.layout.systems)) {
      const v = present.get(id);
      if (!everywhere.has(id)) continue;
      const files = v ? v.files : 0;
      nodes.push({ id, kind: "system", box, name: sysName(id), files, sub: files ? `${plural(files, "file")} · ${plural(v.modules.length, "module")}` : "no files here yet", touched: C.touchedSys.get(id), ghost: files === 0 });
    }
    const ids = new Set(nodes.map((n) => n.id));
    const edges = [];
    for (const e of edgesAt(ui.snap, "systemEdges")) {
      if (!ids.has(e.from) || !ids.has(e.to)) continue;
      const k = key(e.from, e.to);
      const state = C.faultSys.has(k) ? "fault" : C.newSys.has(k) ? "new" : C.oldFaultSys.has(k) ? "fault-old" : C.grownSys.has(k) ? "grown" : "";
      if (e.typeOnly && !ui.showTypes && !state) continue;
      edges.push({ id: "s|" + k, from: e.from, to: e.to, count: e.count, typeOnly: e.typeOnly, state, level: "system" });
    }
    for (const [k, e] of C.goneSys) if (ids.has(e.from) && ids.has(e.to)) edges.push({ id: "s|" + k, from: e.from, to: e.to, count: e.count, typeOnly: e.typeOnly, state: "gone", level: "system" });
    // Intended dependencies: dashed until the code exists, then marked as planned.
    for (const p of (S.plan && S.plan.edges) || []) {
      if (!ids.has(p.from) || !ids.has(p.to)) continue;
      const hit = edges.find((e) => e.from === p.from && e.to === p.to);
      if (hit) hit.planned = true;
      else edges.push({ id: "s|" + key(p.from, p.to), from: p.from, to: p.to, count: 0, typeOnly: false, state: "planned", level: "system", planned: true, why: p.why });
    }
    return { nodes, edges };
  }

  function buildDrillScene(sysId) {
    const sn = snap();
    const d = dv();
    const C = changeSets(d);
    const sv = systemsAt().find((x) => x.id === sysId) || { modules: [], files: 0 };
    const mods = sv.modules.slice();
    if (d) for (const mid of d.delta.modules.removed) if (modSystem(mid) === sysId && !mods.some((m) => m.id === mid)) mods.push({ id: mid, label: modLabel(mid), files: 0, ghost: true });
    // Stable order: by size, then name, so a new module lands at the end rather than reshuffling.
    const order = new Map((S.snapshots[0].systems.find((x) => x.id === sysId)?.modules || []).map((m, i) => [m.id, i]));
    mods.sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e6) - (order.has(b.id) ? order.get(b.id) : 1e6) || b.files - a.files || a.id.localeCompare(b.id));

    const modEdges = edgesAt(ui.snap, "moduleEdges");
    const inner = [];
    const outAgg = new Map();
    const inAgg = new Map();
    const bump = (map, k, e, extra) => {
      const cur = map.get(k);
      if (cur) { cur.count += e.count; cur.typeOnly = cur.typeOnly && e.typeOnly; if (extra.state && !cur.state) cur.state = extra.state; }
      else map.set(k, { ...extra, count: e.count, typeOnly: e.typeOnly });
    };
    const stateOf = (e) => {
      const k = key(e.from, e.to);
      if (C.newMod.has(k)) {
        const sk = key(modSystem(e.from), modSystem(e.to));
        return C.faultSys.has(sk) ? "fault" : "new";
      }
      const sk = key(modSystem(e.from), modSystem(e.to));
      if (C.oldFaultSys.has(sk)) return "fault-old";
      return "";
    };
    const all = modEdges.map((e) => ({ ...e, state: stateOf(e) }));
    for (const [k, e] of C.goneMod) all.push({ ...e, state: "gone" });
    for (const e of all) {
      const fs = modSystem(e.from), ts = modSystem(e.to);
      if (fs === sysId && ts === sysId) inner.push(e);
      else if (fs === sysId) bump(outAgg, key(e.from, ts), e, { from: e.from, to: "sys:" + ts, state: e.state });
      else if (ts === sysId) bump(inAgg, key(fs, e.to), e, { from: "sys:" + fs, to: e.to, state: e.state });
    }
    const weight = (id, map, side) => [...map.values()].filter((e) => (side === "to" ? e.to : e.from) === "sys:" + id).reduce((n, e) => n + e.count, 0);
    // Each neighbour sits on the side it mostly talks to: callers on the left, dependencies on the right.
    const neighbours = new Set([...[...outAgg.values()].map((e) => e.to.slice(4)), ...[...inAgg.values()].map((e) => e.from.slice(4))]);
    const inSys = [], outSys = [];
    for (const id of neighbours) (weight(id, inAgg, "from") > weight(id, outAgg, "to") ? inSys : outSys).push(id);
    outSys.sort((a, b) => weight(b, outAgg, "to") - weight(a, outAgg, "to"));
    inSys.sort((a, b) => weight(b, inAgg, "from") - weight(a, inAgg, "from"));
    // Grid of modules inside the container, neighbours in columns either side.
    const cw = 168, ch = 50, gap = 16;
    const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(mods.length * 1.5))));
    const rows = Math.ceil(mods.length / cols) || 1;
    const padTop = 40, pad = 22;
    const colW = 190;
    const perCol = Math.max(5, rows + 1);
    const leftCols = Math.ceil(inSys.length / perCol);
    const cx = leftCols ? leftCols * (colW + 24) + 70 : 0;
    const contW = cols * cw + (cols - 1) * gap + pad * 2;
    const contH = rows * ch + (rows - 1) * gap + padTop + pad;
    const rightX = cx + contW + 70;
    const nodes = [];
    mods.forEach((m, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      nodes.push({
        id: m.id, kind: "module", name: m.label, files: m.files, ghost: m.ghost || m.files === 0,
        sub: m.files ? plural(m.files, "file") : "removed",
        box: { x: cx + pad + c * (cw + gap), y: padTop + r * (ch + gap), w: cw, h: ch },
        touched: C.touchedMod.get(m.id),
      });
    });
    const column = (list, x0, dir) => {
      const hh = 44, g2 = 12;
      for (let c = 0; c * perCol < list.length; c++) {
        const chunk = list.slice(c * perCol, (c + 1) * perCol);
        const total = chunk.length * hh + Math.max(0, chunk.length - 1) * g2;
        const y0 = (contH - total) / 2;
        const x = x0 + dir * c * (colW + 24);
        chunk.forEach((id, i) => nodes.push({ id: "sys:" + id, sysId: id, kind: "neighbour", name: sysName(id), sub: "system", box: { x, y: y0 + i * (hh + g2), w: colW, h: hh }, touched: C.touchedSys.get(id) }));
      }
    };
    column(inSys, cx - 70 - colW, -1);
    column(outSys, rightX, 1);
    const edges = [];
    for (const e of inner) {
      if (e.typeOnly && !ui.showTypes && !e.state) continue;
      edges.push({ id: "m|" + key(e.from, e.to), from: e.from, to: e.to, count: e.count, typeOnly: e.typeOnly, state: e.state, level: "module" });
    }
    for (const e of [...outAgg.values(), ...inAgg.values()]) {
      if (e.typeOnly && !ui.showTypes && !e.state) continue;
      edges.push({ id: "x|" + key(e.from, e.to), from: e.from, to: e.to, count: e.count, typeOnly: e.typeOnly, state: e.state, level: "mixed" });
    }
    return { nodes, edges, container: { x: cx, y: 0, w: contW, h: contH, title: sysName(sysId) } };
  }

  // ---------- geometry ----------
  function routeAll(nodes, edges) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const pairs = new Set(edges.map((e) => key(e.from, e.to)));
    const ports = new Map(); // node|side -> [{edge, end, other}]
    const plan = [];
    for (const e of edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const A = a.box, B = b.box;
      const ax = A.x + A.w / 2, ay = A.y + A.h / 2, bx = B.x + B.w / 2, by = B.y + B.h / 2;
      const dx = bx - ax, dy = by - ay;
      const horiz = Math.abs(dx) > Math.abs(dy) * 0.9;
      const sa = horiz ? (dx >= 0 ? "r" : "l") : dy >= 0 ? "b" : "t";
      const sb = horiz ? (dx >= 0 ? "l" : "r") : dy >= 0 ? "t" : "b";
      const p = { e, a, b, sa, sb, both: pairs.has(key(e.to, e.from)) };
      plan.push(p);
      for (const [n, side, other] of [[a, sa, b], [b, sb, a]]) {
        const k = n.id + "|" + side;
        if (!ports.has(k)) ports.set(k, []);
        ports.get(k).push({ p, end: n === a ? "a" : "b", other });
      }
    }
    // Spread endpoints along each side, ordered by where the other end sits, to untangle bundles.
    const offset = new Map();
    for (const [k, list] of ports) {
      const side = k.slice(k.lastIndexOf("|") + 1);
      const vertical = side === "l" || side === "r";
      list.sort((u, v) => (vertical ? u.other.box.y - v.other.box.y : u.other.box.x - v.other.box.x));
      const n = list.length;
      list.forEach((item, i) => {
        const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * 0.7;
        offset.set(item.p.e.id + "|" + item.end, t);
      });
    }
    const pt = (box, side, t) => {
      if (side === "r") return { x: box.x + box.w, y: box.y + box.h / 2 + t * box.h, nx: 1, ny: 0 };
      if (side === "l") return { x: box.x, y: box.y + box.h / 2 + t * box.h, nx: -1, ny: 0 };
      if (side === "b") return { x: box.x + box.w / 2 + t * box.w, y: box.y + box.h, nx: 0, ny: 1 };
      return { x: box.x + box.w / 2 + t * box.w, y: box.y, nx: 0, ny: -1 };
    };
    return plan.map((p) => {
      const p1 = pt(p.a.box, p.sa, offset.get(p.e.id + "|a") || 0);
      const p2 = pt(p.b.box, p.sb, offset.get(p.e.id + "|b") || 0);
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const c = Math.max(24, Math.min(140, dist * 0.42));
      const bend = p.both ? 10 : 0;
      const bx = -p1.ny * bend, by = p1.nx * bend;
      const d = `M${r(p1.x)},${r(p1.y)} C${r(p1.x + p1.nx * c + bx)},${r(p1.y + p1.ny * c + by)} ${r(p2.x + p2.nx * (c + 8) + bx)},${r(p2.y + p2.ny * (c + 8) + by)} ${r(p2.x + p2.nx * 7)},${r(p2.y + p2.ny * 7)}`;
      return { ...p.e, d };
    });
  }
  const r = (v) => Math.round(v * 10) / 10;

  // ---------- rendering ----------
  let els = {};
  function mount() {
    root.innerHTML = "";
    root.className = "fl-app";
    els.top = h("header", { class: "fl-top" });
    els.map = h("main", { class: "fl-map", "aria-label": "Architecture map" });
    els.panel = h("aside", { class: "fl-panel" });
    root.append(els.top, els.map, els.panel);
    els.svg = s("svg", { role: "img", "aria-label": "Systems and their dependencies" });
    els.defs = s("defs");
    for (const [id, cls] of [["a-default", "arrow-default"], ["a-new", "arrow-new"], ["a-fault", "arrow-fault"], ["a-accent", "arrow-accent"], ["a-hot", "arrow-hot"]]) {
      els.defs.append(s("marker", { id, viewBox: "0 0 10 10", refX: "3", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse", markerUnits: "userSpaceOnUse" }, s("path", { d: "M0,0 L10,5 L0,10 z", class: cls })));
    }
    els.vp = s("g");
    els.svg.append(els.defs, els.vp);
    els.crumbs = h("nav", { class: "fl-crumbs", "aria-label": "Breadcrumb" });
    els.tools = h("div", { class: "fl-tools" });
    els.legend = h("div", { class: "fl-legend" },
      h("span", {}, h("i", { class: "k-new" }), "new dependency"),
      h("span", {}, h("i", { class: "k-fault" }), "crosses a fault line"),
      h("span", {}, h("i", { class: "k-gone" }), "removed"),
      h("span", {}, h("i", { class: "k-plan" }), "planned"),
      h("span", {}, h("i", { class: "k-touch" }), "changed"));
    els.map.append(els.svg, els.crumbs, els.tools, els.legend);
    bindPanZoom();
    window.addEventListener("resize", () => { ui.fitted = ""; renderMap(); });
    document.addEventListener("keydown", onKey);
  }

  function render() {
    renderTop();
    renderMap();
    renderPanel();
  }

  function renderTop() {
    const sn = snap();
    const base = S.snapshots[0];
    const from = (ui.compare === "prev" || !canCompareBase()) && ui.snap > 0 ? S.snapshots[ui.snap - 1] : base;
    const live = S.mode === "live";
    els.top.replaceChildren(...[
      h("div", { class: "fl-mark" }, logo(), "faultline"),
      h("div", { class: "fl-repo", title: S.repo }, S.repo),
      h("div", { class: "fl-spacer" }),
      ui.snap > 0 ? h("div", { class: "fl-range", title: `${from.label} → ${sn.label}` }, `${from.label} → ${sn.label}`) : h("div", { class: "fl-range" }, sn.label),
      live ? h("span", { class: "fl-live" + (liveStatus === "busy" ? " is-busy" : liveStatus === "off" ? " is-off" : ""), id: "fl-live" }, liveStatus === "off" ? "offline" : liveStatus === "busy" ? "updating" : "live") : null,
    ].filter(Boolean));
  }

  function logo() {
    return s("svg", { width: "20", height: "20", viewBox: "0 0 20 20", "aria-hidden": "true" },
      s("rect", { x: "1.5", y: "3", width: "8", height: "6", rx: "1.5", fill: "none", stroke: "currentColor", "stroke-width": "1.6" }),
      s("rect", { x: "10.5", y: "11", width: "8", height: "6", rx: "1.5", fill: "none", stroke: "currentColor", "stroke-width": "1.6" }),
      s("path", { d: "M2 16.5 L7 12.5 L10 14.5 L18 5.5", fill: "none", stroke: "var(--fault)", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" }));
  }

  let scene = null;
  let lastClick = { id: "", t: 0 };
  function renderMap() {
    scene = ui.view.kind === "system" ? buildDrillScene(ui.view.id) : buildSystemScene();
    const routed = routeAll(scene.nodes, scene.edges);
    const selEdge = ui.sel?.type === "edge" ? ui.sel.id : null;
    const selNode = ui.sel?.type === "system" || ui.sel?.type === "module" ? ui.sel.id : null;
    const anyChange = routed.some((e) => e.state && e.state !== "fault-old") || scene.nodes.some((n) => n.touched);
    const layerEdges = s("g");
    const layerHits = s("g");
    const layerNodes = s("g");
    const maxCount = Math.max(1, ...routed.map((e) => e.count));
    for (const e of routed) {
      const w = e.id === selEdge ? 3.6 : e.state === "new" || e.state === "fault" || e.state === "planned" ? 2.6 : 1 + Math.min(3.2, (Math.log2(e.count + 1) / Math.log2(maxCount + 1)) * 3.2);
      const cls = ["edge", e.typeOnly ? "is-type" : "", e.state ? "is-" + e.state : "", e.id === selEdge ? "is-selected" : "", anyChange && !e.state ? "is-faded" : ""].filter(Boolean).join(" ");
      const marker = (e.id === selEdge && !e.state) || e.state === "planned" ? "a-accent" : e.state === "new" ? "a-new" : e.state === "grown" ? "a-hot" : e.state === "fault" || e.state === "gone" || e.state === "fault-old" ? "a-fault" : "a-default";
      const path = s("path", { d: e.d, class: cls, "stroke-width": w, "marker-end": `url(#${marker})`, "data-id": e.id, "data-from": e.from, "data-to": e.to });
      layerEdges.append(path);
      const hit = s("path", { d: e.d, class: "edge-hit", "data-id": e.id });
      hit.append(s("title", { text: e.state === "planned" ? `${label(e.from)} → ${label(e.to)} · planned${e.why ? ": " + e.why : ""}` : `${label(e.from)} → ${label(e.to)} · ${plural(e.count, "import")}${e.typeOnly ? " (types only)" : ""}${e.planned ? " · planned" : ""}` }));
      hit.addEventListener("click", (ev) => { if (moved) return; ev.stopPropagation(); select({ type: "edge", id: e.id, level: e.level, from: e.from, to: e.to }); });
      layerHits.append(hit);
    }
    if (scene.container) {
      const c = scene.container;
      layerEdges.prepend(s("rect", { x: c.x, y: c.y, width: c.w, height: c.h, rx: 14, class: "container-box" }), s("text", { x: c.x + 18, y: c.y + 24, class: "container-title", text: c.title }));
    }
    for (const n of scene.nodes) layerNodes.append(nodeEl(n, selNode));
    // Edge hit areas sit under the nodes: a box is always clickable even with edges passing over it.
    els.vp.replaceChildren(layerEdges, layerHits, layerNodes);
    renderCrumbs();
    renderTools();
    const fitKey = (ui.view.kind === "system" ? "sys:" + ui.view.id : "map") + "|" + scene.nodes.length;
    if (ui.fitted !== fitKey) { fit(); ui.fitted = fitKey; }
    applyTransform();
  }

  function label(id) {
    if (id.startsWith("sys:")) return sysName(id.slice(4));
    if (id.includes("/")) return modLabel(id);
    return sysName(id);
  }

  function nodeEl(n, selNode) {
    const b = n.box;
    const t = n.touched;
    const cls = ["node", t ? "is-touched" : "", n.ghost ? "is-ghost" : "", n.kind === "neighbour" ? "is-neighbour" : "", selNode === n.id ? "is-selected" : ""].filter(Boolean).join(" ");
    const g = s("g", { class: cls, transform: `translate(${b.x},${b.y})`, tabindex: "0", role: "button", "aria-label": `${n.name}${n.sub ? ", " + n.sub : ""}`, "data-id": n.id });
    g.append(s("rect", { class: "n-box", width: b.w, height: b.h, rx: n.kind === "module" ? 8 : 10 }));
    const nameMax = Math.floor((b.w - 26) / 7.6);
    const name = n.name.length > nameMax ? n.name.slice(0, nameMax - 1) + "…" : n.name;
    g.append(s("text", { class: "n-name", x: 14, y: b.h / 2 - (n.sub ? 3 : -5), text: name }));
    if (n.sub) g.append(s("text", { class: "n-sub", x: 14, y: b.h / 2 + 14, text: n.sub }));
    if (n.name.length > nameMax) g.append(s("title", { text: n.name }));
    if (t && n.kind !== "neighbour") {
      const parts = [["+", t.added.length, "n-chip-add"], ["~", t.modified.length, "n-chip-mod"], ["−", t.removed.length, "n-chip-del"]].filter((x) => x[1] > 0);
      const text = s("text", { class: "n-chip", y: 12.5 });
      let width = 8;
      for (const [sym, count, c] of parts) {
        text.append(s("tspan", { class: c, x: width, text: `${sym}${count}` }));
        width += 7 * String(count).length + 12;
      }
      const chip = s("g", { transform: `translate(${b.w - width - 6},-9)` }, s("rect", { class: "n-chip-bg", width: width, height: 18, rx: 9 }), text);
      g.append(chip);
    }
    const open = () => {
      if (n.kind === "system" && !n.ghost) drill(n.id);
      else if (n.kind === "neighbour") drill(n.sysId);
    };
    g.addEventListener("click", (ev) => {
      if (moved) return;
      ev.stopPropagation();
      // A click re-renders the map, so a native dblclick never reaches the same element: time it instead.
      const now = Date.now();
      if (lastClick.id === n.id && now - lastClick.t < 400) {
        lastClick = { id: "", t: 0 };
        return open();
      }
      lastClick = { id: n.id, t: now };
      if (n.kind === "neighbour") return select({ type: "system", id: n.sysId, from: "neighbour" });
      select({ type: n.kind, id: n.id });
    });
    g.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); open(); } else if (ev.key === " ") { ev.preventDefault(); g.dispatchEvent(new MouseEvent("click")); } });
    g.addEventListener("mouseenter", () => hover(n.id, true));
    g.addEventListener("mouseleave", () => hover(n.id, false));
    return g;
  }

  function hover(id, on) {
    for (const p of els.vp.querySelectorAll("path.edge")) {
      const hit = p.dataset.from === id || p.dataset.to === id;
      p.classList.toggle("is-hot", on && hit && !p.classList.contains("is-new") && !p.classList.contains("is-fault"));
      if (on && !hit) p.style.opacity = "0.06"; else p.style.opacity = "";
    }
  }

  function renderCrumbs() {
    if (ui.view.kind === "system") {
      els.crumbs.replaceChildren(h("button", { onclick: () => back(), text: "All systems" }), h("span", { text: "/" }), h("strong", { text: sysName(ui.view.id) }));
    } else {
      const n = systemsAt().filter((x) => x.files > 0).length;
      els.crumbs.replaceChildren(h("strong", { text: "All systems" }), h("span", { text: `· ${n}` }));
    }
  }

  function renderTools() {
    els.tools.replaceChildren(
      h("button", { class: "fl-btn", "aria-pressed": String(ui.showTypes), title: "Show imports that only bring in types", onclick: () => { ui.showTypes = !ui.showTypes; renderMap(); } }, "Type imports"),
      h("button", { class: "fl-btn", title: "Fit to screen (F)", onclick: () => { fit(); applyTransform(); } }, "Fit"),
    );
  }

  // ---------- panel ----------
  function renderPanel() {
    const body = h("div", { class: "fl-panel-body" });
    if (ui.sel?.type === "edge") panelEdge(body);
    else if (ui.sel?.type === "system") panelSystem(body, ui.sel.id);
    else if (ui.sel?.type === "module") panelModule(body, ui.sel.id);
    else panelSummary(body);
    els.panel.replaceChildren(body, timeline());
  }

  function panelSummary(body) {
    const d = dv();
    const sn = snap();
    if (S.note) body.append(h("div", { class: "fl-note" }, ...S.note.split(/\n\n+/).map((para) => h("p", { text: para }))));
    if (!d) {
      const n = systemsAt().filter((x) => x.files > 0);
      const files = n.reduce((a, x) => a + x.files, 0);
      body.append(
        h("div", {}, h("h1", { class: "fl-headline", text: `${plural(n.length, "system")}, ${plural(files, "file")}` }),
          h("p", { class: "fl-sub", text: S.mode === "live" ? "Watching for changes. Edit a file, or let an agent work, and the map lights up what moved." : "Pick a later point on the timeline to see what changed." })),
      );
      body.append(section("Largest systems", h("div", { class: "fl-touched" }, n.slice().sort((a, b) => b.files - a.files).slice(0, 8).map((x) => h("button", { class: "fl-trow", onclick: () => select({ type: "system", id: x.id }) }, h("span", { class: "nm", text: x.name }), h("span", { class: "fl-counts" }, h("span", { text: String(x.files) })))))));
      return;
    }
    const faults = d.findings.filter((f) => f.severity === "fault").length;
    const scope = ui.view.kind === "system" ? ui.view.id : null;
    const list = d.findings.filter((f) => !scope || !f.from || f.from === scope || f.to === scope);
    body.append(h("div", {},
      h("h1", { class: "fl-headline" + (faults ? " is-fault" : ""), text: d.headline }),
      sn.subject ? h("p", { class: "fl-sub" }, sn.url ? h("a", { href: sn.url, target: "_blank", rel: "noopener" }, sn.subject) : sn.subject, sn.author ? ` · ${sn.author}` : "") : null,
    ));
    const item = (f) => {
      const edgeId = f.from && f.to ? "s|" + key(f.from, f.to) : null;
      return h("li", {}, h("button", {
        class: `fl-finding sev-${f.severity}`, "data-edge": edgeId || undefined,
        onclick: edgeId ? () => { if (ui.view.kind !== "systems") { ui.view = { kind: "systems" }; ui.fitted = ""; } select({ type: "edge", id: edgeId, level: "system", from: f.from, to: f.to }); } : undefined,
      }, h("span", { class: "dot" }), h("span", {}, h("div", { class: "t", text: f.title }), f.detail ? h("div", { class: "d", text: f.detail }) : null)));
    };
    const major = list.filter((f) => f.severity !== "info");
    const minor = list.filter((f) => f.severity === "info");
    const content = [];
    if (major.length) content.push(h("ul", { class: "fl-findings" }, major.map(item)));
    if (minor.length) {
      const det = h("details", { class: "fl-more" }, h("summary", { text: `${plural(minor.length, "smaller change")}: more imports on existing edges, new packages` }), h("ul", { class: "fl-findings" }, minor.map(item)));
      if (!major.length) det.open = true;
      content.push(det);
    }
    if (!list.length) content.push(h("div", { class: "fl-empty", text: "No new dependencies between systems, no cycles, no fault lines crossed. Everything stayed inside its boundaries." }));
    body.append(section(scope ? `What changed in ${sysName(scope)}` : "What changed", h("div", { style: "display:flex;flex-direction:column;gap:8px" }, content)));
    const planEdges = (S.plan && S.plan.edges) || [];
    if (planEdges.length) {
      const now = edgesAt(ui.snap, "systemEdges");
      body.append(section("Plan", h("ul", { class: "fl-findings" }, planEdges.map((p) => {
        const landed = now.some((e) => e.from === p.from && e.to === p.to);
        return h("li", {}, h("button", { class: "fl-finding sev-" + (landed ? "structure" : "info"), "data-edge": "1", onclick: () => select({ type: "edge", id: "s|" + key(p.from, p.to), level: "system", from: p.from, to: p.to }) },
          h("span", { class: "dot" }), h("span", {}, h("div", { class: "t", text: `${sysName(p.from)} → ${sysName(p.to)}` }), h("div", { class: "d", text: `${landed ? "Built" : "Not built yet"}${p.why ? ` · ${p.why}` : ""}` }))));
      }))));
    }
    const touched = d.delta.touched;
    if (touched.length) {
      body.append(section("Systems touched", h("div", { class: "fl-touched" }, touched.map((t) => h("button", { class: "fl-trow", onclick: () => select({ type: "system", id: t.system }) },
        h("span", { class: "nm", text: sysName(t.system) }), counts(t))))));
    }
  }

  function counts(t) {
    return h("span", { class: "fl-counts" },
      t.added.length ? h("span", { class: "c-add", text: "+" + t.added.length }) : null,
      t.modified.length ? h("span", { class: "c-mod", text: "~" + t.modified.length }) : null,
      t.removed.length ? h("span", { class: "c-del", text: "−" + t.removed.length }) : null);
  }

  function section(title, content) {
    return h("section", {}, h("h2", { class: "fl-label", text: title }), content);
  }

  function backButton() {
    return h("button", { class: "fl-back", onclick: () => select(null), text: "← What changed" });
  }

  function panelSystem(body, id) {
    const sn = snap();
    const v = systemsAt().find((x) => x.id === id);
    const def = sysDef(id);
    const d = dv();
    const C = changeSets(d);
    const t = C.touchedSys.get(id);
    body.append(backButton());
    body.append(h("div", {}, h("h1", { class: "fl-headline", text: sysName(id) }), def?.description ? h("p", { class: "fl-sub", text: def.description }) : null,
      def ? h("p", { class: "fl-sub" }, h("code", { text: def.paths.join("  ") })) : null));
    body.append(h("dl", { class: "fl-kv" }, h("dt", { text: "Files" }), h("dd", { text: String(v?.files ?? 0) }), h("dt", { text: "Modules" }), h("dd", { text: String(v?.modules.length ?? 0) }),
      t ? h("dt", { text: "This change" }) : null, t ? h("dd", {}, counts(t)) : null));
    if (ui.view.kind !== "system" || ui.view.id !== id) body.append(h("button", { class: "fl-btn", onclick: () => drill(id) }, `Open ${sysName(id)} →`));
    const edges = edgesAt(ui.snap, "systemEdges");
    const chip = (other, count, dir) => {
      const k = dir === "out" ? key(id, other) : key(other, id);
      const st = C.faultSys.has(k) ? " is-fault" : C.newSys.has(k) ? " is-new" : "";
      return h("button", { class: "fl-dep" + st, onclick: () => select({ type: "edge", id: "s|" + k, level: "system", from: dir === "out" ? id : other, to: dir === "out" ? other : id }) }, sysName(other), h("span", { class: "n", text: String(count) }));
    };
    const outs = edges.filter((e) => e.from === id && (ui.showTypes || !e.typeOnly));
    const ins = edges.filter((e) => e.to === id && (ui.showTypes || !e.typeOnly));
    body.append(section("Depends on", outs.length ? h("div", { class: "fl-deps" }, outs.map((e) => chip(e.to, e.count, "out"))) : h("div", { class: "fl-sub", text: "Nothing outside itself." })));
    body.append(section("Used by", ins.length ? h("div", { class: "fl-deps" }, ins.map((e) => chip(e.from, e.count, "in"))) : h("div", { class: "fl-sub", text: "No other system imports it." })));
    if (t) body.append(section("Changed files", fileList(t)));
    if (S.mode === "live") {
      const others = S.config.systems.filter((x) => x.id !== id && !edges.some((e) => e.from === id && e.to === x.id));
      const pick = h("select", { class: "fl-input", id: "fl-plan-target", "aria-label": "System to depend on" }, others.map((x) => h("option", { value: x.id, text: x.name })));
      const why = h("input", { class: "fl-input", id: "fl-plan-why", placeholder: "Why (optional)", "aria-label": "Why this dependency" });
      body.append(section("Plan a new dependency", h("div", { class: "fl-steer" }, pick, why, h("button", { class: "fl-btn", onclick: async () => {
        await post("/api/plan", { from: id, to: pick.value, why: why.value.trim() || undefined });
        toast(`Planned: ${id} → ${pick.value}`);
      } }, "Add to plan"))));
    }
  }

  function panelModule(body, id) {
    const sysId = modSystem(id);
    const sn = snap();
    const m = systemsAt().find((x) => x.id === sysId)?.modules.find((x) => x.id === id);
    const C = changeSets(dv());
    const t = C.touchedMod.get(id);
    body.append(backButton());
    body.append(h("div", {}, h("h1", { class: "fl-headline", text: modLabel(id) }), h("p", { class: "fl-sub", text: `Module in ${sysName(sysId)} · ${plural(m?.files ?? 0, "file")}` })));
    const edges = edgesAt(ui.snap, "moduleEdges").filter((e) => ui.showTypes || !e.typeOnly);
    const outs = edges.filter((e) => e.from === id).slice(0, 24);
    const ins = edges.filter((e) => e.to === id).slice(0, 24);
    const chip = (e, other) => {
      const st = C.newMod.has(key(e.from, e.to)) ? " is-new" : "";
      const same = modSystem(other) === sysId;
      return h("button", { class: "fl-dep" + st, onclick: () => select({ type: "edge", id: "m|" + key(e.from, e.to), level: "module", from: e.from, to: e.to }) }, same ? modLabel(other) : `${sysName(modSystem(other))} / ${modLabel(other)}`, h("span", { class: "n", text: String(e.count) }));
    };
    body.append(section("Depends on", outs.length ? h("div", { class: "fl-deps" }, outs.map((e) => chip(e, e.to))) : h("div", { class: "fl-sub", text: "Nothing outside itself." })));
    body.append(section("Used by", ins.length ? h("div", { class: "fl-deps" }, ins.map((e) => chip(e, e.from))) : h("div", { class: "fl-sub", text: "Nothing imports it." })));
    if (t) body.append(section("Changed files", fileList(t)));
  }

  function fileList(t) {
    const ul = h("ul", { class: "fl-files" });
    const add = (list, st, cls) => list.slice(0, 40).forEach((p) => ul.append(h("li", {}, h("span", { class: "st " + cls, text: st }), p)));
    add(t.added, "+", "c-add");
    add(t.modified, "~", "c-mod");
    add(t.removed, "−", "c-del");
    return ul;
  }

  function panelEdge(body) {
    const sel = ui.sel;
    const d = dv();
    const C = changeSets(d);
    const endpoint = (id) => (id.startsWith("sys:") ? { kind: "system", id: id.slice(4) } : sel.level === "system" ? { kind: "system", id } : { kind: "module", id });
    const A = endpoint(sel.from), B = endpoint(sel.to);
    const nameOf = (x) => (x.kind === "system" ? sysName(x.id) : `${modLabel(x.id)}`);
    const sysPair = key(A.kind === "system" ? A.id : modSystem(A.id), B.kind === "system" ? B.id : modSystem(B.id));
    const violation = d?.delta.violations.introduced.find((v) => key(v.from, v.to) === sysPair) || d?.delta.violations.existing.find((v) => key(v.from, v.to) === sysPair);
    const isNew = sel.level === "system" ? C.newSys.has(key(sel.from, sel.to)) : C.newMod.has(key(sel.from, sel.to));
    const gone = sel.level === "system" && C.goneSys.has(key(sel.from, sel.to));
    body.append(backButton());
    body.append(h("div", {},
      h("h1", { class: "fl-headline" + (violation ? " is-fault" : "") }, `${nameOf(A)} → ${nameOf(B)}`),
      h("p", { class: "fl-sub", text: violation ? `Crosses a fault line: deny ${violation.rule}${violation.reason ? `. ${violation.reason}` : ""}` : gone ? "This dependency was removed by the change." : isNew ? "New in this change." : "Existing dependency." }),
    ));
    const match = (x, fileSys, fileMod) => (x.kind === "system" ? fileSys === x.id : fileMod === x.id);
    const { list, complete } = evidence((e) => match(A, e.fs, e.fm) && match(B, e.ts, e.tm));
    const planned = ((S.plan && S.plan.edges) || []).find((p) => p.from === sel.from && p.to === sel.to);
    if (planned && !list.length && !gone) {
      body.append(h("p", { class: "fl-sub", text: `Planned${planned.why ? `: ${planned.why}` : ""}. No imports yet; it lights up when the code lands.` }));
      if (S.mode === "live") body.append(steerEdge(sel.from, sel.to, violation));
      return;
    }
    if (gone) {
      const g = C.goneSys.get(key(sel.from, sel.to));
      body.append(section("Imports that were removed", evList(g.evidence.map((e) => ({ ...e, isNew: false })))));
      return;
    }
    if (S.mode === "live" && sel.level === "system") body.append(steerEdge(sel.from, sel.to, violation));
    const newOnes = list.filter((e) => e.isNew).length;
    body.append(h("dl", { class: "fl-kv" }, h("dt", { text: "Imports" }), h("dd", { text: complete ? String(list.length) : "changes only" }), newOnes ? h("dt", { text: "New" }) : null, newOnes ? h("dd", { class: "c-add", text: String(newOnes) }) : null));
    body.append(section("The imports behind it", list.length ? evList(list.slice(0, 80)) : h("div", { class: "fl-empty", text: complete ? "No file-level imports match." : "Evidence for older points on the timeline covers changed imports only. Jump to the latest point to see every import." })));
    if (list.length > 80) body.append(h("p", { class: "fl-sub", text: `…and ${list.length - 80} more.` }));
  }

  /** Live mode: turn an edge into a rule, or plan and unplan it. Agents read both through faultline. */
  function steerEdge(from, to, violation) {
    const planned = ((S.plan && S.plan.edges) || []).some((p) => p.from === from && p.to === to);
    const reason = h("input", { class: "fl-input", id: "fl-rule-reason", placeholder: "Why (optional)", "aria-label": "Reason for the rule" });
    const wrap = h("div", { class: "fl-steer" });
    if (!violation) {
      wrap.append(reason, h("button", { class: "fl-btn fl-danger", onclick: async () => {
        await post("/api/rule", { from, to, reason: reason.value.trim() || undefined });
        toast(`Rule added: deny ${from} -> ${to}`);
      } }, "Forbid this dependency"));
    }
    wrap.append(h("button", { class: "fl-btn", onclick: async () => {
      await post("/api/plan", { from, to, remove: planned || undefined });
      toast(planned ? "Removed from plan" : "Added to plan");
    } }, planned ? "Remove from plan" : "Add to plan"));
    return section("Steer", wrap);
  }

  async function post(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) toast("Could not save: " + (await res.text()));
  }

  function evList(list) {
    const ul = h("ul", { class: "fl-ev" });
    for (const e of list) {
      const names = (e.names || []).filter((n) => n !== "*");
      ul.append(h("li", { class: e.isNew ? "is-new" : "" },
        h("div", { class: "path", text: e.from }),
        h("div", { class: "arrow", text: `${e.kind === "dynamic" ? "lazy import" : e.kind === "reexport" ? "re-exports from" : "imports from"}${e.typeOnly ? " (types)" : ""}${e.isNew ? " · new" : ""}` }),
        h("div", { class: "path", text: e.to }),
        names.length ? h("div", { class: "names" }, names.slice(0, 8).map((n, i) => [i ? ", " : "", h("b", { text: n })]), names.length > 8 ? ` +${names.length - 8}` : "") : null));
    }
    return ul;
  }

  // ---------- timeline ----------
  function stepKind(sn) {
    const d = sn.vsPrev;
    if (!d) return "";
    if (d.findings.some((f) => f.severity === "fault")) return "fault";
    if (d.findings.some((f) => f.severity === "structure")) return "structure";
    return "";
  }

  function timeline() {
    const n = S.snapshots.length;
    const wrap = h("div", { class: "fl-timeline" });
    const head = h("div", { class: "fl-tl-head" },
      h("h2", { class: "fl-label", style: "margin:0", text: S.mode === "live" ? "Session" : "Timeline" }),
      h("div", { class: "fl-seg", role: "group", "aria-label": "Compare against" },
        h("button", { "aria-pressed": String(ui.compare === "base" && canCompareBase()), disabled: !canCompareBase() || undefined, title: canCompareBase() ? "Everything since the first point" : "Available at the latest point", onclick: () => setCompare("base"), text: "Since start" }),
        h("button", { "aria-pressed": String(ui.compare === "prev" || !canCompareBase()), onclick: () => setCompare("prev"), text: "This step" })),
      n > 2 ? h("button", { class: "fl-btn", onclick: togglePlay, "aria-pressed": String(ui.playing), text: ui.playing ? "Pause" : "Play" }) : null,
      S.mode === "live" ? h("button", { class: "fl-btn", title: "Freeze the current state as a step", onclick: markTurn, text: "Mark step" }) : null,
    );
    wrap.append(head);
    if (n > 1) {
      const scrub = h("div", { class: "fl-scrub" });
      scrub.append(h("div", { class: "fl-track" }));
      const pct = (i) => (n === 1 ? 0 : (i / (n - 1)) * 100);
      S.snapshots.forEach((sn, i) => {
        const k = stepKind(sn);
        scrub.append(h("div", { class: "fl-tick" + (k ? " k-" + k : ""), style: `left:calc(6px + (100% - 12px) * ${pct(i) / 100})` }));
      });
      scrub.append(h("div", { class: "fl-thumb", style: `left:calc(6px + (100% - 12px) * ${pct(ui.snap) / 100})` }));
      const input = h("input", { type: "range", min: "0", max: String(n - 1), step: "1", value: String(ui.snap), "aria-label": "Point in time", id: "fl-scrub" });
      input.addEventListener("input", () => { setSnap(Number(input.value)); });
      scrub.append(input);
      wrap.append(scrub);
    }
    const onlyStructural = ui.onlyStructural ?? n > 30;
    const structuralCount = S.snapshots.filter((x) => stepKind(x)).length;
    if (n > 8) {
      wrap.append(h("label", { class: "fl-sub", style: "display:flex;gap:6px;align-items:center;margin:0;cursor:pointer" },
        h("input", { type: "checkbox", id: "fl-only-structural", checked: onlyStructural || undefined, onchange: (ev) => { ui.onlyStructural = ev.target.checked; renderPanel(); } }),
        `Only steps that changed the architecture (${structuralCount} of ${n - 1})`));
    }
    const list = h("ul", { class: "fl-steps" });
    for (let i = n - 1; i >= 0; i--) {
      const sn = S.snapshots[i];
      const k = stepKind(sn);
      if (onlyStructural && !k && i !== ui.snap && i !== 0 && i !== n - 1) continue;
      const btn = h("button", { class: "fl-step" + (i === ui.snap ? " is-current" : ""), onclick: () => setSnap(i) },
        h("span", { class: "k" + (k ? " k-" + k : "") }),
        h("span", { class: "s", text: sn.subject || sn.label }),
        h("span", { class: "r", text: sn.kind === "commit" || sn.kind === "base" ? sn.ref.slice(0, 7) : sn.kind === "live" ? "now" : timeAgo(sn.time) }));
      list.append(h("li", {}, btn));
    }
    wrap.append(list);
    requestAnimationFrame(() => { list.querySelector(".is-current")?.scrollIntoView({ block: "nearest" }); });
    return wrap;
  }

  function timeAgo(t) {
    const s2 = Math.max(0, (Date.now() - t) / 1000);
    if (s2 < 60) return `${Math.round(s2)}s ago`;
    if (s2 < 3600) return `${Math.round(s2 / 60)}m ago`;
    return `${Math.round(s2 / 3600)}h ago`;
  }

  // ---------- actions ----------
  function select(sel) {
    ui.sel = sel;
    renderMap();
    renderPanel();
  }
  function drill(id) {
    ui.view = { kind: "system", id };
    ui.sel = null;
    ui.fitted = "";
    render();
  }
  function back() {
    if (ui.sel) return select(null);
    if (ui.view.kind === "system") {
      ui.view = { kind: "systems" };
      ui.fitted = "";
      render();
    }
  }
  function setSnap(i) {
    const next = Math.max(0, Math.min(S.snapshots.length - 1, i));
    // A selection belongs to one point in time; moving on shows that step's own findings.
    if (next !== ui.snap) ui.sel = null;
    ui.snap = next;
    ui.followLive = ui.snap === S.snapshots.length - 1;
    render();
  }
  function setCompare(c) {
    ui.compare = c;
    render();
  }
  let playTimer = null;
  function togglePlay() {
    ui.playing = !ui.playing;
    clearInterval(playTimer);
    if (ui.playing) {
      if (ui.snap >= S.snapshots.length - 1) setSnap(0);
      ui.compare = "prev";
      playTimer = setInterval(() => {
        if (ui.snap >= S.snapshots.length - 1) { ui.playing = false; clearInterval(playTimer); render(); return; }
        // Skip quiet commits quickly, linger on structural ones.
        setSnap(ui.snap + 1);
      }, 900);
    }
    render();
  }
  function onKey(ev) {
    if (ev.target.closest && ev.target.closest("input, textarea")) return;
    if (ev.key === "Escape") back();
    else if (ev.key === "f" || ev.key === "F") { fit(); applyTransform(); }
    else if (ev.key === "ArrowLeft" && S.snapshots.length > 1) setSnap(ui.snap - 1);
    else if (ev.key === "ArrowRight" && S.snapshots.length > 1) setSnap(ui.snap + 1);
  }

  // ---------- pan & zoom ----------
  let moved = false;
  function applyTransform() {
    const t = ui.transform;
    els.vp.setAttribute("transform", `translate(${t.x},${t.y}) scale(${t.k})`);
  }
  function fit() {
    if (!scene) return;
    let boxes = scene.nodes.map((n) => n.box);
    if (scene.container) boxes.push(scene.container);
    // On a phone the whole map is too small to read: frame what changed instead.
    if ((els.map.clientWidth || 800) < 600 && ui.view.kind === "systems") {
      const hot = new Set();
      for (const e of scene.edges) if (e.state && e.state !== "fault-old" && e.state !== "grown") { hot.add(e.from); hot.add(e.to); }
      for (const n of scene.nodes) if (n.touched) hot.add(n.id);
      const focus = scene.nodes.filter((n) => hot.has(n.id)).map((n) => n.box);
      if (focus.length) boxes = focus;
    }
    if (!boxes.length) return;
    const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
    const W = els.map.clientWidth || 800, H = els.map.clientHeight || 600;
    const pad = 56;
    const k = Math.min((W - pad * 2) / (x1 - x0 || 1), (H - pad * 2 - 30) / (y1 - y0 || 1), 1.25);
    ui.transform = { k, x: (W - (x1 - x0) * k) / 2 - x0 * k, y: (H - (y1 - y0) * k) / 2 - y0 * k + 8 };
  }
  function bindPanZoom() {
    const pointers = new Map();
    let start = null;
    els.map.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest(".fl-crumbs, .fl-tools, .fl-legend")) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      moved = false;
      start = { t: { ...ui.transform }, pts: new Map(pointers) };
      // Capture only once a drag starts: capturing on press re-targets the click away from the node.
    });
    els.map.addEventListener("pointermove", (ev) => {
      if (!pointers.has(ev.pointerId) || !start) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const pts = [...pointers.values()];
      const spts = [...start.pts.values()];
      if (pts.length === 1 && spts.length >= 1) {
        const dx = pts[0].x - spts[0].x, dy = pts[0].y - spts[0].y;
        if (Math.abs(dx) + Math.abs(dy) > 4 && !moved) {
          moved = true;
          els.map.classList.add("is-panning");
          try { els.map.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
        }
        if (moved) { ui.transform = { ...start.t, x: start.t.x + dx, y: start.t.y + dy }; applyTransform(); }
      } else if (pts.length >= 2 && spts.length >= 2) {
        moved = true;
        const d0 = Math.hypot(spts[0].x - spts[1].x, spts[0].y - spts[1].y) || 1;
        const d1 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const rect = els.map.getBoundingClientRect();
        const cx = (spts[0].x + spts[1].x) / 2 - rect.left, cy = (spts[0].y + spts[1].y) / 2 - rect.top;
        zoomAt(start.t, cx, cy, d1 / d0);
      }
    });
    const end = (ev) => {
      pointers.delete(ev.pointerId);
      els.map.classList.remove("is-panning");
      if (pointers.size === 0) {
        if (!moved && ev.type === "pointerup" && (ev.target === els.svg || ev.target === els.map)) { if (ui.sel) select(null); }
        start = null;
        setTimeout(() => { moved = false; }, 0);
      } else start = { t: { ...ui.transform }, pts: new Map(pointers) };
    };
    els.map.addEventListener("pointerup", end);
    els.map.addEventListener("pointercancel", end);
    els.map.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const rect = els.map.getBoundingClientRect();
      const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0022));
      zoomAt(ui.transform, ev.clientX - rect.left, ev.clientY - rect.top, factor);
    }, { passive: false });
  }
  function zoomAt(t0, cx, cy, factor) {
    const k = Math.max(0.15, Math.min(4, t0.k * factor));
    const f = k / t0.k;
    ui.transform = { k, x: cx - (cx - t0.x) * f, y: cy - (cy - t0.y) * f };
    applyTransform();
  }

  // ---------- live mode ----------
  let liveStatus = "ok";
  async function loadLive() {
    const res = await fetch("/api/state", { cache: "no-store" });
    const next = await res.json();
    const wasLast = !S || ui.followLive;
    S = next;
    if (wasLast || ui.snap >= S.snapshots.length) ui.snap = S.snapshots.length - 1;
    render();
  }
  function connect() {
    const es = new EventSource("/events");
    es.addEventListener("busy", () => { liveStatus = "busy"; setLive(); });
    es.addEventListener("state", () => { liveStatus = "ok"; loadLive().catch(() => {}); });
    es.onerror = () => { liveStatus = "off"; setLive(); };
    es.onopen = () => { if (liveStatus === "off") { liveStatus = "ok"; loadLive().catch(() => {}); } };
  }
  function setLive() {
    const el = document.getElementById("fl-live");
    if (!el) return;
    el.className = "fl-live" + (liveStatus === "busy" ? " is-busy" : liveStatus === "off" ? " is-off" : "");
    el.textContent = liveStatus === "off" ? "offline" : liveStatus === "busy" ? "updating" : "live";
  }
  async function markTurn() {
    if (S.mode !== "live") return;
    await fetch("/api/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Marked step" }) });
    toast("Step marked");
  }
  function toast(text) {
    const t = h("div", { class: "fl-toast", role: "status", text });
    els.map.append(t);
    setTimeout(() => t.remove(), 1600);
  }

  // ---------- boot ----------
  mount();
  if (STATIC) {
    S = STATIC;
    // Open on the most interesting point: the latest step that changed structure, else the end.
    ui.snap = S.snapshots.length - 1;
    const hash = (location.hash || "").slice(1);
    const byHash = S.snapshots.findIndex((x) => x.ref.startsWith(hash) && hash.length >= 6);
    if (byHash >= 0) { ui.snap = byHash; ui.compare = "prev"; }
    if (S.snapshots.length > 2) {
      ui.compare = "prev";
      // Land on the most recent step that changed the architecture: that is the story.
      if (byHash < 0) for (let i = S.snapshots.length - 1; i > 0; i--) if (stepKind(S.snapshots[i])) { ui.snap = i; break; }
    }
    render();
  } else {
    loadLive().then(connect).catch((e) => { root.textContent = "Could not reach the faultline server: " + e.message; });
  }
})();
