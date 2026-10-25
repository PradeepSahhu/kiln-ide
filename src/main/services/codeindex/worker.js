'use strict';
// Code index + knowledge graph engine (runs in a worker thread).
// One tree-sitter pass per file (analyzer.js) extracts definitions, call sites, inheritance, imports,
// identifier counts and variable usage. On top of that it answers Go to Definition / Find Usages /
// symbols / usage lenses, produces semantic tokens, and builds the project knowledge graph
// (graph.js: files -> types -> functions -> variables, with calls and reads/writes). The index is
// persisted in Kiln's app-data folder (never inside the project), so reopening a project only
// re-parses files that changed, and agents can query it through the knowledge-graph tools.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const A = require('./analyzer');
const G = require('./graph');
const GS = require('./git-sync');
const RS = require('../refactor/syntax-engine');

const { TYPE_KINDS, CALLABLE_KINDS, LENS_KINDS, CS_DECL, CS_CONTAINERS, CS_TYPE_CONTEXT, TS_DECL } = A;
const MAX_FILE = 1.5 * 1024 * 1024;

// ------------------------------------------------------------------ state

const state = Object.assign(G.createState(null), { graphFile: workerData.graphFile, saveTimer: null, loaded: false });
const ready = A.loadLanguages(workerData.wasmDir);

A.setKindResolver((name) => {
  let k = state.kindCache.get(name);
  if (k) return k;
  const defs = state.defsByName.get(name) || [];
  k = { type: null, member: null };
  for (const d of defs) {
    if (TYPE_KINDS.has(d.kind) && !k.type) k.type = d.kind;
    else if (!k.member && (d.kind === 'method' || d.kind === 'function' || d.kind === 'property' || d.kind === 'field' || d.kind === 'enumMember' || d.kind === 'event')) k.member = d.kind;
  }
  state.kindCache.set(name, k);
  return k;
});

const langOf = A.langOf;
const parsers = () => A.getParsers();
const toRel = (abs) => path.relative(state.root, abs).split(path.sep).join('/');
const toAbs = (rel) => path.join(state.root, rel);

function emit(event, data) {
  parentPort.postMessage({ event, ...data });
}

// ------------------------------------------------------------- indexing

function indexFile(abs, opts = {}) {
  const lang = langOf(abs);
  if (!lang) return false;
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    G.removeFile(state, toRel(abs));
    return true;
  }
  if (!st.isFile() || st.size > MAX_FILE) return false;
  const rel = toRel(abs);
  const prev = state.files.get(rel);
  if (prev && prev.mtime === st.mtimeMs && !opts.force) return false;
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    return false;
  }
  const r = A.analyze(lang, src, false);
  G.addEntry(state, rel, { lang, mtime: st.mtimeMs, size: st.size, defs: r.defs, counts: Object.fromEntries(r.counts), calls: r.calls, bases: r.bases, imports: r.imports, uses: r.uses, locals: r.locals }, opts);
  return true;
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, 2000);
}

function save() {
  if (!state.graphFile || !state.root) return;
  try {
    fs.mkdirSync(path.dirname(state.graphFile), { recursive: true });
    const tmp = state.graphFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(G.serialize(state, A.VERSION)));
    fs.renameSync(tmp, state.graphFile);
  } catch (err) {
    emit('log', { message: `Could not save the knowledge graph: ${err.message}` });
  }
}

function loadSaved() {
  try {
    const data = JSON.parse(fs.readFileSync(state.graphFile, 'utf8'));
    if (data.version !== A.VERSION || data.root !== state.root) return null;
    return data;
  } catch {
    return null;
  }
}

function fileTime(rel) {
  try {
    return fs.statSync(toAbs(rel)).mtimeMs;
  } catch {
    return Date.now();
  }
}

async function init({ root, files }) {
  await ready;
  state.root = root;
  state.files.clear();
  state.defsByName.clear();
  state.counts.clear();
  state.kindCache.clear();
  state.history.clear();
  const saved = loadSaved();
  if (saved) for (const [k, v] of Object.entries(saved.history || {})) state.history.set(k, v);
  const wanted = files.filter((f) => langOf(f));
  const started = Date.now();
  let parsed = 0;
  let reused = 0;
  for (let i = 0; i < wanted.length; i++) {
    const rel = wanted[i];
    const prev = saved && saved.files[rel];
    if (prev) {
      try {
        const st = fs.statSync(toAbs(rel));
        if (st.mtimeMs === prev.mtime) {
          G.addEntry(state, rel, { ...prev, defs: prev.defs.map((d) => ({ ...d })) }, { trackHistory: false });
          reused++;
          continue;
        }
      } catch {
        continue;
      }
    }
    if (indexFile(toAbs(rel), { now: saved ? Date.now() : fileTime(rel) })) parsed++;
    if (i % 150 === 0) emit('progress', { done: i, total: wanted.length });
  }
  // History entries for definitions that no longer exist are dropped.
  const live = new Set();
  for (const [rel, e] of state.files) for (const d of e.defs) live.add(G.defKey(rel, d));
  for (const k of [...state.history.keys()]) if (!live.has(k)) state.history.delete(k);
  for (const [rel, e] of state.files) for (const d of e.defs) if (!state.history.has(G.defKey(rel, d))) state.history.set(G.defKey(rel, d), { firstSeen: e.mtime, modifiedAt: e.mtime, hash: d.h });
  state.loaded = true;
  scheduleSave();
  const stats = G.statsOf(state);
  emit('progress', { done: wanted.length, total: wanted.length });
  emit('indexed', { stats: { ...stats, parsed, reused, ms: Date.now() - started } });
  return { ...stats, parsed, reused, ms: Date.now() - started };
}

function update({ files }) {
  if (!state.root) return { changed: [] };
  const changed = [];
  for (const abs of files) {
    if (!abs.startsWith(state.root + path.sep) || !langOf(abs)) continue;
    if (!fs.existsSync(abs)) {
      if (state.files.has(toRel(abs))) {
        G.removeFile(state, toRel(abs));
        changed.push(toRel(abs));
      }
      continue;
    }
    if (indexFile(abs)) changed.push(toRel(abs));
  }
  if (changed.length) {
    scheduleSave();
    emit('changed', { files: changed, stats: G.statsOf(state) });
  }
  return { changed };
}

// --------------------------------------------------------------- queries

function nodeAt(lang, src, line, col) {
  const tree = parsers()[lang].parse(src);
  const pos = { row: line - 1, column: Math.max(0, col - 1) };
  let n = tree.rootNode.descendantForPosition(pos);
  if (n && !A.isIdentType(n.type) && col > 1) {
    const prev = tree.rootNode.descendantForPosition({ row: line - 1, column: col - 2 });
    if (prev && A.isIdentType(prev.type)) n = prev;
  }
  return { tree, node: n };
}

/** What role does the identifier under the cursor play? */
function contextAt({ file, text, line, col }) {
  const lang = langOf(file);
  if (!lang) return null;
  const src = text != null ? text : fs.readFileSync(file, 'utf8');
  const { tree, node } = nodeAt(lang, src, line, col);
  if (!node || !A.isIdentType(node.type)) {
    tree.delete();
    return null;
  }
  const p = node.parent;
  const gp = p && p.parent;
  const pt = p ? p.type : '';
  let role = 'name';
  if ((pt === 'invocation_expression' || pt === 'call' || pt === 'call_expression') && p.childForFieldName('function') && p.childForFieldName('function').id === node.id) role = 'call';
  else if ((pt === 'member_access_expression' || pt === 'attribute' || pt === 'member_expression') && gp && /invocation_expression|call|call_expression/.test(gp.type)) role = 'call';
  else if (pt === 'member_access_expression' || pt === 'attribute' || pt === 'member_expression') role = 'member';
  else if (pt === 'object_creation_expression' || pt === 'new_expression') role = 'new';
  else if (CS_TYPE_CONTEXT.has(pt) || pt === 'generic_name' || pt === 'type' || pt === 'base_list') role = 'type';
  const isDecl = p && (p.childForFieldName('name') || {}).id === node.id && (CS_DECL[pt] || pt === 'class_definition' || pt === 'function_definition' || TS_DECL[pt]);
  let container = '';
  for (let a = p; a; a = a.parent) {
    if (CS_CONTAINERS.has(a.type) || a.type === 'class_definition' || a.type === 'class_declaration') {
      const nm = a.childForFieldName('name');
      if (nm) container = nm.text + (container ? '.' + container : '');
    }
  }
  if (lang === 'csharp') {
    const fsn = tree.rootNode.namedChildren.find((c) => c && c.type === 'file_scoped_namespace_declaration');
    const nm = fsn && fsn.childForFieldName('name');
    if (nm && fsn.startIndex < node.startIndex) container = nm.text + (container ? '.' + container : '');
  }
  const result = { name: node.text, role, isDecl: !!isDecl, container, lang, line: node.startPosition.row + 1, col: node.startPosition.column + 1, endCol: node.endPosition.column + 1 };
  tree.delete();
  return result;
}

function rankDefs(defs, file, ctx) {
  const rel = file ? toRel(file) : '';
  const dir = path.posix.dirname(rel);
  const want = ctx ? ctx.role : 'name';
  const fits = (d) => {
    if (want === 'call') return CALLABLE_KINDS.has(d.kind) || TYPE_KINDS.has(d.kind) || d.kind === 'field' || d.kind === 'property' || d.kind === 'variable';
    if (want === 'new' || want === 'type') return TYPE_KINDS.has(d.kind) || d.kind === 'constructor';
    return true;
  };
  let list = defs.filter(fits);
  if (!list.length) list = defs;
  const score = (d) => {
    let s = 0;
    if (d.file === rel) s += 100;
    if (ctx && ctx.container && d.container && (d.container === ctx.container || d.container.endsWith('.' + ctx.container.split('.').pop()))) s += 50;
    if (path.posix.dirname(d.file) === dir) s += 20;
    if (want === 'new' && d.kind === 'constructor') s += 5;
    if (TYPE_KINDS.has(d.kind) && (want === 'type' || want === 'new')) s += 10;
    return s;
  };
  return list.map((d) => ({ d, s: score(d) })).sort((a, b) => b.s - a.s).map((x) => x.d);
}

function defOut(d) {
  return { name: d.name, kind: d.kind, file: toAbs(d.file), rel: d.file, line: d.line, col: d.col, endCol: d.endCol, start: d.start, end: d.end, container: d.container, signature: d.sig };
}

function definitions(params) {
  const ctx = params.name ? { name: params.name, role: params.role || 'name', container: params.container || '' } : contextAt(params);
  if (!ctx) return { ctx: null, defs: [] };
  const defs = rankDefs(state.defsByName.get(ctx.name) || [], params.file, ctx);
  return { ctx, defs: defs.slice(0, 50).map(defOut) };
}

/** All occurrences of an identifier across the project (name-based, syntax-aware). */
function references({ name, file, includeDecl = true, limit = 2000 }) {
  if (!name) return { refs: [] };
  const out = [];
  const isIdentChar = (c) => /[\p{L}\p{N}_]/u.test(c);
  for (const [rel, e] of state.files) {
    if (!e.counts[name] && !e.defs.some((d) => d.name === name)) continue;
    const abs = toAbs(rel);
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const tree = parsers()[e.lang].parse(src);
    const lineStarts = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
    let idx = src.indexOf(name);
    while (idx !== -1 && out.length < limit) {
      const before = idx > 0 ? src[idx - 1] : '';
      const after = src[idx + name.length] || '';
      if (!isIdentChar(before) && !isIdentChar(after)) {
        const n = tree.rootNode.descendantForIndex(idx, idx + name.length);
        if (n && A.isIdentType(n.type) && n.text === name) {
          const p = n.parent;
          const isDecl = p && (p.childForFieldName('name') || {}).id === n.id && (CS_DECL[p.type] || p.type === 'class_definition' || p.type === 'function_definition' || TS_DECL[p.type] || p.type === 'variable_declarator');
          if (includeDecl || !isDecl) {
            const row = n.startPosition.row;
            const ls = lineStarts[row];
            const le = row + 1 < lineStarts.length ? lineStarts[row + 1] - 1 : src.length;
            const kind = isDecl ? 'declaration' : /invocation_expression|call|call_expression/.test(p ? p.type : '') || (p && p.parent && /invocation_expression|call|call_expression/.test(p.parent.type)) ? 'call' : 'reference';
            out.push({ file: abs, rel, line: row + 1, col: n.startPosition.column + 1, endCol: n.endPosition.column + 1, kind, text: src.slice(ls, le).replace(/\r$/, '').slice(0, 300), container: enclosingName(e, row + 1) });
          }
        }
      }
      idx = src.indexOf(name, idx + name.length);
    }
    tree.delete();
    if (out.length >= limit) break;
  }
  const rel = file ? toRel(file) : '';
  out.sort((a, b) => (a.rel === rel ? -1 : 0) - (b.rel === rel ? -1 : 0) || a.rel.localeCompare(b.rel) || a.line - b.line);
  return { refs: out, truncated: out.length >= limit };
}

function enclosingName(entry, line) {
  let best = null;
  for (const d of entry.defs) if ((CALLABLE_KINDS.has(d.kind) || d.kind === 'property' || TYPE_KINDS.has(d.kind)) && line >= d.start && line <= d.end && (!best || d.end - d.start < best.end - best.start)) best = d;
  return best ? (best.container ? best.container.split('.').pop() + '.' : '') + best.name : '';
}

function documentSymbols({ file, text }) {
  const lang = langOf(file);
  if (!lang) return [];
  let defs;
  if (text != null) defs = A.analyze(lang, text, false).defs;
  else {
    const e = state.files.get(toRel(file));
    defs = e ? e.defs : [];
  }
  return defs.filter((d) => d.kind !== 'variable' || lang !== 'csharp').map((d) => ({ name: d.name, kind: d.kind, line: d.line, col: d.col, endCol: d.endCol, start: d.start, end: d.end, container: d.container, signature: d.sig }));
}

function workspaceSymbols({ query, limit = 100, kinds }) {
  return G.workspaceSymbols(state, { query, limit, kinds }).map(defOut);
}

function codeLens({ file, text }) {
  const lang = langOf(file);
  if (!lang) return [];
  const e = state.files.get(toRel(file));
  const defs = text != null ? A.analyze(lang, text, false).defs : e ? e.defs : [];
  return defs.filter((d) => LENS_KINDS.has(d.kind) || d.kind === 'constructor').map((d) => ({ name: d.name, kind: d.kind, line: d.line, col: d.col, usages: state.counts.get(d.name) || 0 }));
}

function semanticTokens({ file, text }) {
  const lang = langOf(file);
  if (!lang || lang === 'typescript' || lang === 'tsx' || lang === 'javascript') return null;
  const r = A.analyze(lang, text, true);
  // Encode as Monaco expects: [deltaLine, deltaStart, length, type, modifiers]
  const t = r.tokens;
  const order = [];
  for (let i = 0; i < t.length; i += 5) order.push(i);
  order.sort((a, b) => t[a] - t[b] || t[a + 1] - t[b + 1]);
  const data = new Array(t.length);
  let prevLine = 0;
  let prevCol = 0;
  let j = 0;
  for (const i of order) {
    const line = t[i];
    const col = t[i + 1];
    data[j++] = line - prevLine;
    data[j++] = line === prevLine ? col - prevCol : col;
    data[j++] = t[i + 2];
    data[j++] = t[i + 3];
    data[j++] = t[i + 4];
    prevLine = line;
    prevCol = col;
  }
  return { data };
}

function hover(params) {
  const res = definitions(params);
  if (!res.defs.length) return null;
  const d = res.defs[0];
  let doc = '';
  try {
    const lines = fs.readFileSync(d.file, 'utf8').split('\n');
    if (langOf(d.file) === 'csharp') {
      const docLines = [];
      for (let i = d.start - 2; i >= 0 && i > d.start - 40; i--) {
        const l = lines[i].trim();
        if (l.startsWith('///')) docLines.unshift(l.replace(/^\/\/\/\s?/, ''));
        else if (l.startsWith('[') || l === '') continue;
        else break;
      }
      doc = docLines.join('\n').replace(/<\/?(summary|remarks|returns)>/g, '').replace(/<param name="([^"]+)">/g, '\n**$1**: ').replace(/<\/param>/g, '').replace(/<see cref="([^"]+)"\s*\/>/g, '`$1`').replace(/<[^>]+>/g, '').trim();
    } else if (langOf(d.file) === 'python') {
      const body = lines.slice(d.start, Math.min(lines.length, d.start + 40)).join('\n');
      const m = /^\s*(?:[rRuUbB]{0,2})("""|''')([\s\S]*?)\1/.exec(body);
      if (m) doc = m[2].trim();
    }
  } catch {
    /* unreadable */
  }
  return { def: d, doc, count: res.defs.length, ctx: res.ctx };
}

// ------------------------------------------------ main-branch graph (from git)

/** Load a saved branch graph (if it matches) into this worker's state. */
async function gitOpen({ root, graphFile }) {
  await ready;
  state.root = root;
  state.graphFile = graphFile;
  state.files.clear();
  state.defsByName.clear();
  state.counts.clear();
  state.kindCache.clear();
  state.history.clear();
  state.commit = null;
  const saved = loadSaved();
  if (saved) {
    const s = G.deserialize(saved);
    for (const k of ['files', 'defsByName', 'counts', 'history']) state[k] = s[k];
    state.commit = saved.commit || null;
  }
  return { commit: state.commit, files: state.files.size };
}

async function gitSync({ root, commit, ref, branch }) {
  await ready;
  const r = await GS.syncFromGit(state, { root, commit, analyze: A.analyze, langOf });
  state.ref = ref;
  state.branch = branch;
  state.kindCache.clear();
  if (r.read || r.removed || !fs.existsSync(state.graphFile || '')) save();
  return r;
}

// ------------------------------------------------------------ refactoring

/** Syntax-tree refactorings (Safe Delete, Change Signature, ...) with the index for names and usages. */
function refactor(params) {
  const deps = {
    langOf,
    parsers,
    isIdent: A.isIdentType,
    read: (f) => (f === params.file && params.text != null ? params.text : fs.readFileSync(f, 'utf8')),
    exists: (f) => fs.existsSync(f),
    defs: (name) => (state.defsByName.get(name) || []).map(defOut),
    refs: (name) => references({ name, includeDecl: true, limit: 5000 }).refs,
  };
  return RS.run(params.op, deps, params);
}

// ---------------------------------------------------------- knowledge graph

const graph = (opts) => G.graphView(state, opts || {});
const neighbors = ({ id }) => G.neighbors(state, id);
const findNodes = ({ query, limit }) => G.findNodes(state, { query, limit });

// ------------------------------------------------------------- dispatch

const handlers = { refactor, gitOpen, gitSync, init, update, definitions, references, documentSymbols, workspaceSymbols, codeLens, semanticTokens, hover, graph, neighbors, findNodes, context: contextAt, stats: () => G.statsOf(state), legend: () => ({ types: A.TOKEN_TYPES, modifiers: A.TOKEN_MODIFIERS }), save: () => save() };

parentPort.on('message', async (msg) => {
  const fn = handlers[msg.type];
  if (!fn) {
    parentPort.postMessage({ id: msg.id, ok: false, error: `Unknown request ${msg.type}` });
    return;
  }
  try {
    await ready;
    const result = await fn(msg.payload || {});
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: err && err.message ? err.message : String(err) });
  }
});
