'use strict';
// Knowledge graph over the code index. Nodes: files, types, functions/methods and variables (module
// variables, constants, fields, properties). Edges: contains, calls, uses (type references),
// inherits, imports, reads and writes (function -> variable). Pure data and queries, no parsing:
// shared by the IDE's index worker and the knowledge-graph tools for agents (CLI and MCP server).
const path = require('path');

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'record', 'enum', 'delegate']);
const CALLABLE_KINDS = new Set(['method', 'function', 'constructor', 'delegate']);
const VAR_KINDS = new Set(['variable', 'constant', 'field', 'property']);
const SELF = 1;
const MEMBER = 2;

function createState(root = null) {
  return { root, files: new Map(), defsByName: new Map(), counts: new Map(), history: new Map(), kindCache: new Map() };
}

const crypto = require('crypto');

/** File name of a project's saved graph inside <userData>/knowledge (shared by the IDE and agent tools). */
function graphFileName(root, branch) {
  const id = crypto.createHash('sha1').update(root).digest('hex').slice(0, 16);
  const suffix = branch ? `@${String(branch).replace(/[^\w.-]/g, '_')}` : '';
  return `${path.basename(root).replace(/[^\w.-]/g, '_')}-${id}${suffix}.json`;
}

const defKey = (rel, d) => `${rel}::${d.container ? d.container + '.' : ''}${d.name}::${d.kind}`;
const nodeIdOf = (d) => `d:${d.file}::${d.container ? d.container + '.' : ''}${d.name}::${d.kind}`;
const qualified = (d) => (d.container ? `${d.container}.${d.name}` : d.name);

// ------------------------------------------------------------------ state

function removeFile(state, rel) {
  const e = state.files.get(rel);
  if (!e) return;
  for (const d of e.defs) {
    const list = state.defsByName.get(d.name);
    if (list) {
      const next = list.filter((x) => x.file !== rel);
      if (next.length) state.defsByName.set(d.name, next);
      else state.defsByName.delete(d.name);
    }
    state.history.delete(defKey(rel, d));
  }
  for (const [name, n] of Object.entries(e.counts || {})) {
    const left = (state.counts.get(name) || 0) - n;
    if (left > 0) state.counts.set(name, left);
    else state.counts.delete(name);
  }
  state.files.delete(rel);
  state.kindCache.clear();
}

function addEntry(state, rel, entry, { trackHistory = true, now = Date.now() } = {}) {
  const prevHistory = new Map();
  if (state.files.has(rel)) {
    for (const d of state.files.get(rel).defs) prevHistory.set(defKey(rel, d), state.history.get(defKey(rel, d)));
    removeFile(state, rel);
  }
  entry.uses = entry.uses || [];
  entry.locals = entry.locals || [];
  for (const d of entry.defs) {
    d.file = rel;
    const list = state.defsByName.get(d.name);
    if (list) list.push(d);
    else state.defsByName.set(d.name, [d]);
    if (trackHistory) {
      const key = defKey(rel, d);
      const prev = prevHistory.get(key) || state.history.get(key);
      if (!prev) state.history.set(key, { firstSeen: now, modifiedAt: now, hash: d.h });
      else if (prev.hash !== d.h) state.history.set(key, { firstSeen: prev.firstSeen, modifiedAt: now, hash: d.h });
      else state.history.set(key, prev);
    }
  }
  for (const [name, n] of Object.entries(entry.counts || {})) state.counts.set(name, (state.counts.get(name) || 0) + n);
  state.files.set(rel, entry);
  state.kindCache.clear();
}

function serialize(state, version) {
  return {
    version,
    root: state.root,
    commit: state.commit || undefined,
    ref: state.ref || undefined,
    branch: state.branch || undefined,
    savedAt: Date.now(),
    files: Object.fromEntries([...state.files].map(([rel, e]) => [rel, { lang: e.lang, mtime: e.mtime, size: e.size, defs: e.defs.map(({ file, ...d }) => d), counts: e.counts, calls: e.calls, bases: e.bases, imports: e.imports, uses: e.uses, locals: e.locals }])),
    history: Object.fromEntries(state.history),
  };
}

/** State from a saved graph file (as written by serialize). */
function deserialize(data) {
  const state = createState(data.root);
  state.commit = data.commit || null;
  state.ref = data.ref || null;
  state.branch = data.branch || null;
  for (const [k, v] of Object.entries(data.history || {})) state.history.set(k, v);
  for (const [rel, e] of Object.entries(data.files || {})) addEntry(state, rel, { ...e, defs: e.defs.map((d) => ({ ...d })) }, { trackHistory: false });
  return state;
}

function statsOf(state) {
  let defs = 0;
  let calls = 0;
  let variables = 0;
  const byLang = {};
  for (const e of state.files.values()) {
    defs += e.defs.length;
    calls += e.calls.length;
    variables += e.defs.filter((d) => VAR_KINDS.has(d.kind)).length;
    byLang[e.lang] = (byLang[e.lang] || 0) + 1;
  }
  return { files: state.files.size, defs, calls, variables, byLang };
}

// ------------------------------------------------------------- resolving

function moduleFiles(state) {
  // Python module name -> rel path, for resolving imports to project files.
  const map = new Map();
  for (const [rel, e] of state.files) {
    if (e.lang !== 'python') continue;
    const parts = rel.replace(/\.pyi?$/, '').replace(/\/__init__$/, '').split('/');
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(i).join('.');
      if (!map.has(key)) map.set(key, rel);
    }
  }
  return map;
}

function importedFiles(state, rel, mods) {
  const e = state.files.get(rel);
  const out = new Set();
  for (const [mod] of (e && e.imports) || []) {
    const t = mods.get(mod) || mods.get(mod.split('.').slice(0, -1).join('.'));
    if (t) out.add(t);
  }
  return out;
}

function resolveCallee(state, name, kind, fromRel, fromContainer) {
  const defs = state.defsByName.get(name);
  if (!defs || !defs.length) return [];
  let cands = defs.filter((d) => (kind === 'call' ? CALLABLE_KINDS.has(d.kind) || TYPE_KINDS.has(d.kind) : TYPE_KINDS.has(d.kind)));
  if (!cands.length) return [];
  if (kind === 'call') {
    const callables = cands.filter((d) => CALLABLE_KINDS.has(d.kind));
    if (callables.length) cands = callables;
  }
  const sameFile = cands.filter((d) => d.file === fromRel);
  if (sameFile.length) {
    const sameContainer = sameFile.filter((d) => d.container === fromContainer);
    return (sameContainer.length ? sameContainer : sameFile).slice(0, 1);
  }
  if (fromContainer) {
    const sc = cands.filter((d) => d.container === fromContainer);
    if (sc.length) return sc.slice(0, 1);
  }
  if (cands.length === 1) return cands;
  const dir = path.posix.dirname(fromRel);
  const sameDir = cands.filter((d) => path.posix.dirname(d.file) === dir);
  if (sameDir.length === 1) return sameDir;
  return cands.length <= 3 ? cands : [];
}

/** The class a definition belongs to (for methods: their container; for types: themselves). */
function classOf(owner) {
  if (!owner) return '';
  return TYPE_KINDS.has(owner.kind) ? qualified(owner) : owner.container || '';
}

/** Which variable definition does a use refer to? null when it is unknown or ambiguous. */
function resolveVariable(state, name, flags, fromRel, owner, imported) {
  const defs = (state.defsByName.get(name) || []).filter((d) => VAR_KINDS.has(d.kind));
  if (!defs.length) return null;
  const cls = classOf(owner);
  if (flags & SELF) return defs.find((d) => d.container === cls && d.file === fromRel) || defs.find((d) => d.container === cls) || null;
  if (flags & MEMBER) {
    const members = defs.filter((d) => d.container);
    if (members.length === 1) return members[0];
    const same = members.filter((d) => d.file === fromRel);
    return same.length === 1 ? same[0] : null;
  }
  if (cls) {
    const member = defs.find((d) => d.container === cls);
    if (member) return member;
  }
  const local = defs.find((d) => d.file === fromRel && !d.container);
  if (local) return local;
  const fromImports = defs.filter((d) => !d.container && imported && imported.has(d.file));
  return fromImports.length === 1 ? fromImports[0] : null;
}

// ------------------------------------------------------------------ graph

/** Full graph: nodes and edges (kinds: contains, calls, uses, inherits, imports, reads, writes). */
function fullGraph(state, { variables = true } = {}) {
  const nodes = new Map();
  const edges = new Map();
  const addEdge = (s, t, kind, n = 1) => {
    if (s === t) return;
    const key = `${s}|${t}|${kind}`;
    const e = edges.get(key);
    if (e) e.weight += n;
    else edges.set(key, { source: s, target: t, kind, weight: n });
  };
  for (const [rel, e] of state.files) {
    const fid = `f:${rel}`;
    nodes.set(fid, { id: fid, kind: 'file', label: path.posix.basename(rel), file: rel, lang: e.lang, line: 1, dir: path.posix.dirname(rel), defs: e.defs.length });
    for (const d of e.defs) {
      if (d.kind === 'enumMember' || d.kind === 'namespace' || d.kind === 'event') continue;
      if (VAR_KINDS.has(d.kind) && d.kind !== 'property' && !variables) continue;
      const id = nodeIdOf(d);
      const hist = state.history.get(defKey(rel, d));
      if (!nodes.has(id)) nodes.set(id, { id, kind: d.kind, label: d.name, container: d.container, file: rel, lang: e.lang, line: d.line, dir: path.posix.dirname(rel), signature: d.sig, modifiedAt: hist ? hist.modifiedAt : null, firstSeen: hist ? hist.firstSeen : null });
      // Containment: class -> member, else file -> top-level definition.
      const parent = d.container ? e.defs.find((x) => TYPE_KINDS.has(x.kind) && qualified(x) === d.container) : null;
      addEdge(parent ? nodeIdOf(parent) : fid, id, 'contains');
    }
  }
  const mods = moduleFiles(state);
  for (const [rel, e] of state.files) {
    const fid = `f:${rel}`;
    const ownerNode = (idx) => {
      const owner = idx >= 0 ? e.defs[idx] : null;
      return { owner, from: owner && nodes.has(nodeIdOf(owner)) ? nodeIdOf(owner) : fid };
    };
    for (const [ownerIdx, name, , , kind] of e.calls) {
      const { owner, from } = ownerNode(ownerIdx);
      const fromContainer = owner ? owner.container || '' : '';
      for (const target of resolveCallee(state, name, kind === 'type' || kind === 'new' ? 'type' : 'call', rel, TYPE_KINDS.has(owner && owner.kind) ? qualified(owner) : fromContainer)) {
        const tid = nodeIdOf(target);
        if (nodes.has(tid)) addEdge(from, tid, kind === 'call' ? 'calls' : 'uses');
      }
    }
    for (const [ownerIdx, name] of e.bases) {
      const owner = ownerIdx >= 0 ? e.defs[ownerIdx] : null;
      if (!owner) continue;
      for (const target of resolveCallee(state, name, 'type', rel, '')) addEdge(nodeIdOf(owner), nodeIdOf(target), 'inherits');
    }
    const imported = importedFiles(state, rel, mods);
    for (const [ownerIdx, name, , , mode, flags, count = 1] of e.uses) {
      const { owner, from } = ownerNode(ownerIdx);
      const target = resolveVariable(state, name, flags, rel, owner, imported);
      if (!target) continue;
      const tid = nodeIdOf(target);
      if (!nodes.has(tid) || tid === from) continue;
      if (mode !== 'w') addEdge(from, tid, 'reads', count);
      if (mode !== 'r') addEdge(from, tid, 'writes', count);
    }
  }
  for (const [rel, e] of state.files) {
    for (const [mod] of e.imports || []) {
      const target = mods.get(mod) || mods.get(mod.split('.').slice(0, -1).join('.'));
      if (target && target !== rel) addEdge(`f:${rel}`, `f:${target}`, 'imports');
    }
  }
  return { nodes, edges: [...edges.values()] };
}

/** Graph for the visualizer: whole project (limited), file level, or the neighbourhood of a node. */
function graphView(state, { mode = 'overview', focus, depth = 2, limit = 1500, kinds, variables = true } = {}) {
  const g = fullGraph(state, { variables });
  const degree = new Map();
  for (const e of g.edges) {
    if (e.kind === 'contains') continue;
    degree.set(e.source, (degree.get(e.source) || 0) + e.weight);
    degree.set(e.target, (degree.get(e.target) || 0) + e.weight);
  }
  let nodes;
  let edges;
  if (mode === 'files') {
    const fileOf = (id) => (id.startsWith('f:') ? id : `f:${(g.nodes.get(id) || {}).file}`);
    const agg = new Map();
    for (const e of g.edges) {
      if (e.kind === 'contains') continue;
      const s = fileOf(e.source);
      const t = fileOf(e.target);
      if (s === t) continue;
      const key = `${s}|${t}`;
      const prev = agg.get(key);
      if (prev) prev.weight += e.weight;
      else agg.set(key, { source: s, target: t, kind: e.kind === 'imports' ? 'imports' : 'calls', weight: e.weight });
    }
    nodes = [...g.nodes.values()].filter((n) => n.kind === 'file');
    edges = [...agg.values()];
  } else if (mode === 'focus' && focus && g.nodes.has(focus)) {
    const keep = new Set([focus]);
    let frontier = [focus];
    const adj = new Map();
    for (const e of g.edges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      if (!adj.has(e.target)) adj.set(e.target, []);
      adj.get(e.source).push(e.target);
      adj.get(e.target).push(e.source);
    }
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const id of frontier) for (const nb of adj.get(id) || []) if (!keep.has(nb) && keep.size < limit) {
        keep.add(nb);
        next.push(nb);
      }
      frontier = next;
    }
    nodes = [...keep].map((id) => g.nodes.get(id)).filter(Boolean);
    edges = g.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  } else {
    let all = [...g.nodes.values()];
    if (kinds && kinds.length) all = all.filter((n) => n.kind === 'file' || kinds.includes(n.kind));
    if (all.length > limit) {
      all.sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
      all = all.slice(0, limit);
    }
    const keep = new Set(all.map((n) => n.id));
    nodes = all;
    edges = g.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  }
  for (const n of nodes) n.degree = degree.get(n.id) || 0;
  const recent = [...g.nodes.values()].filter((n) => n.modifiedAt && n.kind !== 'file').sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 30);
  return { nodes, edges, recent, stats: statsOf(state), totalNodes: g.nodes.size, totalEdges: g.edges.length, mode };
}

/** Everything connected to one node: callers/callees, members, variable reads/writes, locals. */
function neighbors(state, id, g = fullGraph(state)) {
  const node = g.nodes.get(id);
  if (!node) return null;
  const out = { node, callers: [], callees: [], members: [], reads: [], writes: [], readers: [], writers: [], locals: [] };
  const get = (nid, e) => ({ ...g.nodes.get(nid), edge: e.kind, weight: e.weight });
  for (const e of g.edges) {
    if (e.target === id) {
      if (e.kind === 'reads') out.readers.push(get(e.source, e));
      else if (e.kind === 'writes') out.writers.push(get(e.source, e));
      else if (e.kind !== 'contains') out.callers.push(get(e.source, e));
    } else if (e.source === id) {
      if (e.kind === 'reads') out.reads.push(get(e.target, e));
      else if (e.kind === 'writes') out.writes.push(get(e.target, e));
      else if (e.kind === 'contains') out.members.push({ ...g.nodes.get(e.target), edge: 'contains' });
      else out.callees.push(get(e.target, e));
    }
  }
  if (id.startsWith('d:')) {
    const entry = state.files.get(node.file);
    const idx = entry ? entry.defs.findIndex((d) => nodeIdOf(d) === id) : -1;
    if (idx >= 0) for (const [owner, name, line, kind, reads, writes] of entry.locals) if (owner === idx) out.locals.push({ name, line, kind, reads, writes });
  }
  return out;
}

// ---------------------------------------------------------------- search

function fuzzyScore(query, name) {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 800 - n.length;
  // CamelHumps: "OrSe" matches "OrderService"
  const humps = name.replace(/[^A-Z0-9]/g, '').toLowerCase();
  if (humps.startsWith(q)) return 600 - n.length;
  const i = n.indexOf(q);
  if (i >= 0) return 400 - i - n.length;
  let qi = 0;
  let score = 0;
  for (let ni = 0; ni < n.length && qi < q.length; ni++) {
    if (n[ni] === q[qi]) {
      score += ni === 0 || /[A-Z_]/.test(name[ni]) ? 8 : 2;
      qi++;
    }
  }
  return qi === q.length ? 100 + score - n.length : -1;
}

/** Definitions matching a fuzzy query (best first); variables only when asked for by kind. */
function workspaceSymbols(state, { query, limit = 100, kinds }) {
  const out = [];
  if (!query) return out;
  for (const [name, defs] of state.defsByName) {
    const s = fuzzyScore(query, name);
    if (s < 0) continue;
    for (const d of defs) {
      if (kinds && !kinds.includes(d.kind)) continue;
      if (!kinds && (d.kind === 'variable' || d.kind === 'enumMember' || d.kind === 'namespace')) continue;
      out.push({ s: s + (TYPE_KINDS.has(d.kind) ? 5 : 0), d });
    }
  }
  out.sort((a, b) => b.s - a.s || a.d.name.length - b.d.name.length);
  return out.slice(0, limit).map((x) => x.d);
}

function findNodes(state, { query, limit = 40 }) {
  const out = [];
  for (const [rel] of state.files) {
    const s = fuzzyScore(query, path.posix.basename(rel));
    if (s >= 0) out.push({ s, n: { id: `f:${rel}`, kind: 'file', label: path.posix.basename(rel), file: rel } });
  }
  for (const d of workspaceSymbols(state, { query, limit: 80, kinds: [...TYPE_KINDS, ...CALLABLE_KINDS, ...VAR_KINDS] })) {
    out.push({ s: fuzzyScore(query, d.name) + 1, n: { id: nodeIdOf(d), kind: d.kind, label: d.name, container: d.container, file: d.file, line: d.line } });
  }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, limit).map((x) => x.n);
}

// ------------------------------------------------------- agent queries

/**
 * Definitions for a symbol reference: a node id, "Name", "Class.Name", "Namespace.Class.Name" or
 * "path/file.py:Name". Exact matches only.
 */
function findDefs(state, ref) {
  if (!ref) return [];
  if (ref.startsWith('d:')) {
    for (const e of state.files.values()) for (const d of e.defs) if (nodeIdOf(d) === ref) return [d];
    return [];
  }
  let file = null;
  let sym = ref;
  const colon = ref.lastIndexOf(':');
  if (colon > 0 && /[./]/.test(ref.slice(0, colon))) {
    file = ref.slice(0, colon).replace(/^\.\//, '');
    sym = ref.slice(colon + 1);
  }
  const parts = sym.split('.');
  const name = parts.pop();
  const container = parts.join('.');
  let defs = (state.defsByName.get(name) || []).filter((d) => d.kind !== 'namespace');
  if (container) defs = defs.filter((d) => d.container === container || (d.container || '').endsWith(`.${container}`) || (d.container || '').split('.').pop() === container);
  if (file) defs = defs.filter((d) => d.file === file || d.file.endsWith(`/${file}`));
  return defs;
}

/** Call sites and variable uses pointing at a definition, with the function they occur in. */
function usagesOf(state, id, g = fullGraph(state)) {
  const node = g.nodes.get(id);
  if (!node) return [];
  const mods = moduleFiles(state);
  const out = [];
  for (const [rel, e] of state.files) {
    const imported = importedFiles(state, rel, mods);
    const where = (idx) => {
      const o = idx >= 0 ? e.defs[idx] : null;
      return o ? qualified(o) : '(module level)';
    };
    if (VAR_KINDS.has(node.kind)) {
      for (const [ownerIdx, name, line, col, mode, flags, count = 1] of e.uses) {
        if (name !== node.label) continue;
        const owner = ownerIdx >= 0 ? e.defs[ownerIdx] : null;
        const t = resolveVariable(state, name, flags, rel, owner, imported);
        if (t && nodeIdOf(t) === id) out.push({ file: rel, line, col, in: where(ownerIdx), kind: mode === 'w' ? 'write' : mode === 'rw' ? 'read+write' : 'read', count });
      }
    } else {
      for (const [ownerIdx, name, line, col, kind] of e.calls) {
        if (name !== node.label) continue;
        const owner = ownerIdx >= 0 ? e.defs[ownerIdx] : null;
        const fromContainer = owner ? owner.container || '' : '';
        const targets = resolveCallee(state, name, kind === 'type' || kind === 'new' ? 'type' : 'call', rel, TYPE_KINDS.has(owner && owner.kind) ? qualified(owner) : fromContainer);
        if (targets.some((t) => nodeIdOf(t) === id)) out.push({ file: rel, line, col, in: where(ownerIdx), kind: kind === 'call' ? 'call' : kind === 'new' ? 'construct' : 'type use' });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** What depends on a definition: transitive callers (and readers/writers for variables). */
function impactOf(state, id, depth = 3, g = fullGraph(state)) {
  const incoming = new Map();
  for (const e of g.edges) {
    if (e.kind === 'contains' || e.kind === 'imports') continue;
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push(e);
  }
  const seen = new Map([[id, 0]]);
  const levels = [];
  let frontier = [id];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    const level = [];
    for (const nid of frontier) {
      for (const e of incoming.get(nid) || []) {
        if (seen.has(e.source)) continue;
        seen.set(e.source, d);
        next.push(e.source);
        level.push({ ...g.nodes.get(e.source), via: e.kind, of: g.nodes.get(nid) ? g.nodes.get(nid).label : nid });
      }
    }
    if (level.length) levels.push({ depth: d, nodes: level });
    frontier = next;
  }
  return levels;
}

/** Shortest chain of calls from one function to another. */
function callPath(state, fromId, toId, maxDepth = 10, g = fullGraph(state)) {
  const adj = new Map();
  for (const e of g.edges) {
    if (e.kind !== 'calls' && e.kind !== 'uses') continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source).push(e.target);
  }
  const prev = new Map([[fromId, null]]);
  let frontier = [fromId];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) || []) {
        if (prev.has(nb)) continue;
        prev.set(nb, id);
        if (nb === toId) {
          const chain = [nb];
          let cur = id;
          while (cur) {
            chain.unshift(cur);
            cur = prev.get(cur);
          }
          return chain.map((x) => g.nodes.get(x));
        }
        next.push(nb);
      }
    }
    frontier = next;
  }
  return null;
}

/** Definitions in a file (with what each reads, writes and calls), plus imports both ways. */
function fileOutline(state, rel, g = fullGraph(state)) {
  const e = state.files.get(rel);
  if (!e) return null;
  const fid = `f:${rel}`;
  const defs = e.defs
    .filter((d) => d.kind !== 'namespace')
    .map((d) => {
      const id = nodeIdOf(d);
      const n = neighbors(state, id, g);
      return { id, name: d.name, kind: d.kind, container: d.container, line: d.line, end: d.end, signature: d.sig, calls: n ? n.callees.filter((x) => x.edge === 'calls').map((x) => qualifiedLabel(x)) : [], reads: n ? n.reads.map(qualifiedLabel) : [], writes: n ? n.writes.map(qualifiedLabel) : [], usedBy: n ? n.callers.length + n.readers.length + n.writers.length : 0 };
    });
  const imports = g.edges.filter((x) => x.kind === 'imports' && x.source === fid).map((x) => x.target.slice(2));
  const importedBy = g.edges.filter((x) => x.kind === 'imports' && x.target === fid).map((x) => x.source.slice(2));
  return { file: rel, lang: e.lang, defs, imports, importedBy };
}

function qualifiedLabel(n) {
  return n ? (n.container ? `${n.container}.${n.label}` : n.label) : '';
}

/** Project summary for agents: sizes, languages, most connected definitions and shared variables. */
function overview(state, g = fullGraph(state)) {
  const deg = new Map();
  const callersOf = new Map();
  const touchers = new Map();
  for (const e of g.edges) {
    if (e.kind === 'contains') continue;
    deg.set(e.source, (deg.get(e.source) || 0) + e.weight);
    deg.set(e.target, (deg.get(e.target) || 0) + e.weight);
    if (e.kind === 'calls') callersOf.set(e.target, (callersOf.get(e.target) || 0) + 1);
    if (e.kind === 'reads' || e.kind === 'writes') touchers.set(e.target, (touchers.get(e.target) || new Set()).add(e.source));
  }
  const nodes = [...g.nodes.values()];
  const top = (filter, score, n = 15) => nodes.filter(filter).map((x) => ({ x, s: score(x) })).filter((y) => y.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map(({ x, s }) => ({ id: x.id, name: qualifiedLabel(x), kind: x.kind, file: x.file, line: x.line, score: s }));
  return {
    root: state.root,
    stats: statsOf(state),
    mostCalled: top((x) => CALLABLE_KINDS.has(x.kind), (x) => callersOf.get(x.id) || 0),
    mostConnectedFiles: top((x) => x.kind === 'file', (x) => deg.get(x.id) || 0, 10),
    sharedVariables: top((x) => VAR_KINDS.has(x.kind), (x) => (touchers.get(x.id) || new Set()).size),
    types: nodes.filter((x) => TYPE_KINDS.has(x.kind)).length,
    functions: nodes.filter((x) => CALLABLE_KINDS.has(x.kind)).length,
    variables: nodes.filter((x) => VAR_KINDS.has(x.kind)).length,
  };
}

module.exports = {
  graphFileName,
  TYPE_KINDS,
  CALLABLE_KINDS,
  VAR_KINDS,
  createState,
  defKey,
  nodeIdOf,
  qualified,
  qualifiedLabel,
  addEntry,
  removeFile,
  serialize,
  deserialize,
  statsOf,
  moduleFiles,
  resolveCallee,
  resolveVariable,
  fullGraph,
  graphView,
  neighbors,
  fuzzyScore,
  workspaceSymbols,
  findNodes,
  findDefs,
  usagesOf,
  impactOf,
  callPath,
  fileOutline,
  overview,
};
