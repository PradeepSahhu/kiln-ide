'use strict';
// Kiln knowledge graph for AI agents: shared by the CLI (skills) and the MCP server. Finds the graph
// Kiln IDE keeps for the project a command runs in (in Kiln's app data, never in the repository),
// re-reads files changed since the IDE indexed them, and answers structural questions as JSON.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '../..');
const G = require(path.join(APP_ROOT, 'src/main/services/codeindex/graph.js'));

const INDEXABLE = /\.(cs|py|pyi|ts|tsx|mts|cts|js|jsx|mjs|cjs|go|java|rs|c|h|cc|cpp|cxx|hpp|hh|hxx|rb|php|sh|bash)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', 'out', '.venv', 'venv', 'env', '__pycache__', '.next', 'target', 'coverage', '.idea', '.vs', '.mypy_cache', '.pytest_cache', '.tox', '.gradle', 'vendor']);
const MAX_FILE = 1.5 * 1024 * 1024;
const MAX_FILES = 25000;

class KgError extends Error {}

function userDataDir() {
  if (process.env.KILN_USER_DATA) return path.resolve(process.env.KILN_USER_DATA);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Kiln IDE');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Kiln IDE');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Kiln IDE');
}

const graphFileFor = (root) => path.join(userDataDir(), 'knowledge', G.graphFileName(root));

/** The nearest folder at or above `start` that Kiln has indexed. */
function findProject(start) {
  let dir;
  try {
    dir = fs.realpathSync(path.resolve(start));
  } catch {
    return null;
  }
  for (;;) {
    const file = graphFileFor(dir);
    if (fs.existsSync(file)) return { root: dir, file };
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

let analyzer = null;
async function getAnalyzer() {
  if (analyzer) return analyzer;
  const A = require(path.join(APP_ROOT, 'src/main/services/codeindex/analyzer.js'));
  await A.loadLanguages(path.join(APP_ROOT, 'node_modules/@vscode/tree-sitter-wasm/wasm'));
  analyzer = A;
  return A;
}

function projectFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter((f) => f && INDEXABLE.test(f)).slice(0, MAX_FILES);
  } catch {
    const out = [];
    const walk = (dir, rel) => {
      if (out.length >= MAX_FILES) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
        } else if (INDEXABLE.test(e.name)) out.push(rel ? `${rel}/${e.name}` : e.name);
      }
    };
    walk(root, '');
    return out;
  }
}

function analyzeInto(state, A, rel, st) {
  const abs = path.join(state.root, rel);
  if (st.size > MAX_FILE) return false;
  const lang = A.langOf(abs);
  if (!lang) return false;
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    return false;
  }
  const r = A.analyze(lang, src, false);
  G.addEntry(state, rel, { lang, mtime: st.mtimeMs, size: st.size, defs: r.defs, counts: Object.fromEntries(r.counts), calls: r.calls, bases: r.bases, imports: r.imports, uses: r.uses, locals: r.locals }, { trackHistory: false });
  return true;
}

/** Bring the graph up to date with the files on disk. Returns the number of files re-read. */
async function refresh(state, { force = false } = {}) {
  let changed = 0;
  const todo = [];
  for (const [rel, e] of [...state.files]) {
    let st;
    try {
      st = fs.statSync(path.join(state.root, rel));
    } catch {
      G.removeFile(state, rel);
      changed++;
      continue;
    }
    if (force || st.mtimeMs !== e.mtime) todo.push([rel, st]);
  }
  for (const rel of projectFiles(state.root)) {
    if (state.files.has(rel)) continue;
    try {
      todo.push([rel, fs.statSync(path.join(state.root, rel))]);
    } catch {
      /* vanished */
    }
  }
  if (todo.length) {
    const A = await getAnalyzer();
    for (const [rel, st] of todo) if (analyzeInto(state, A, rel, st)) changed++;
  }
  return changed;
}

const cache = new Map(); // root -> { state, checkedAt }

/**
 * Graph of a git ref without checking it out: "main" (the main branch Kiln follows: main/master,
 * or origin's when it is ahead) or any branch, tag or commit. Starts from the graph Kiln saved for
 * that branch and brings it up to date from git objects.
 */
async function loadRef(start, ref, { maxAge = 0 } = {}) {
  const GS = require(path.join(APP_ROOT, 'src/main/services/codeindex/git-sync.js'));
  const found = findProject(start);
  let root;
  try {
    root = found ? found.root : fs.realpathSync(path.resolve(start));
  } catch {
    throw new KgError(`${start} does not exist.`);
  }
  let target;
  if (ref === 'main' || ref === 'master' || ref === 'default') {
    const m = await GS.resolveMainRef(root);
    if (!m) throw new KgError('This folder is not in a git repository with a main or master branch.');
    target = { branch: m.branch, commit: m.commit, ref: m.ref };
  } else {
    let commit = null;
    try {
      commit = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      commit = null;
    }
    if (!commit) throw new KgError(`Unknown git ref "${ref}".`);
    target = { branch: ref, commit, ref };
  }
  const key = `${root}@${target.branch}`;
  const hit = cache.get(key);
  if (hit && hit.state.commit === target.commit && Date.now() - hit.checkedAt <= maxAge) return hit.state;
  const A = await getAnalyzer();
  let state = hit && hit.state;
  if (!state) {
    const file = path.join(userDataDir(), 'knowledge', G.graphFileName(root, target.branch));
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version === A.VERSION) state = G.deserialize(data);
    } catch {
      state = null;
    }
    if (!state) state = G.createState(root);
    state.root = root;
  }
  await GS.syncFromGit(state, { root, commit: target.commit, analyze: A.analyze, langOf: A.langOf });
  state.ref = target.ref;
  state.branch = target.branch;
  cache.set(key, { state, checkedAt: Date.now() });
  return state;
}

/** Load (and refresh) the graph of the project containing `start`. */
async function load(start, { maxAge = 0, ref = null } = {}) {
  if (ref && ref !== 'working-tree' && ref !== 'worktree') return loadRef(start, ref, { maxAge });
  const found = findProject(start);
  if (!found) throw new KgError(`${path.resolve(start)} is not indexed by Kiln IDE. Open the folder in Kiln once, or run the "index" command (kg_index tool) to build its knowledge graph.`);
  const hit = cache.get(found.root);
  if (hit && Date.now() - hit.checkedAt <= maxAge) return hit.state;
  let state = hit && hit.state;
  let force = false;
  if (!state) {
    const data = JSON.parse(fs.readFileSync(found.file, 'utf8'));
    state = G.deserialize(data);
    state.root = found.root;
    const A = await getAnalyzer().catch(() => null);
    force = !!A && data.version !== A.VERSION; // saved by an older Kiln: re-read everything
  }
  await refresh(state, { force });
  cache.set(found.root, { state, checkedAt: Date.now() });
  return state;
}

/** Build the graph for a folder Kiln has not opened yet and save it where Kiln keeps it. */
async function indexFolder(dir) {
  const root = fs.realpathSync(path.resolve(dir));
  const A = await getAnalyzer();
  const state = G.createState(root);
  let n = 0;
  for (const rel of projectFiles(root)) {
    try {
      if (analyzeInto(state, A, rel, fs.statSync(path.join(root, rel)))) n++;
    } catch {
      /* unreadable */
    }
  }
  const file = graphFileFor(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(G.serialize(state, A.VERSION)));
  cache.delete(root);
  return { root, files: n, graph: file, stats: G.statsOf(state) };
}

// ------------------------------------------------------------- answers

const brief = (n) => (n ? { name: n.label || n.name, kind: n.kind, container: n.container || undefined, file: n.file, line: n.line } : null);
const withCount = (n) => ({ ...brief(n), count: n.weight > 1 ? n.weight : undefined });

function resolve(state, ref, filter) {
  let defs = G.findDefs(state, String(ref || '').trim());
  if (filter) defs = defs.filter(filter);
  return defs;
}

function suggestions(state, ref) {
  const q = String(ref || '').split(/[.:/]/).pop();
  return G.workspaceSymbols(state, { query: q, limit: 8, kinds: [...G.TYPE_KINDS, ...G.CALLABLE_KINDS, ...G.VAR_KINDS] }).map((d) => ({ name: d.name, kind: d.kind, container: d.container || undefined, file: d.file, line: d.line }));
}

function details(state, d, g) {
  const id = G.nodeIdOf(d);
  const n = G.neighbors(state, id, g) || { callers: [], callees: [], members: [], reads: [], writes: [], readers: [], writers: [], locals: [] };
  return {
    id,
    name: d.name,
    kind: d.kind,
    container: d.container || undefined,
    file: d.file,
    line: d.line,
    end: d.end,
    signature: d.sig || undefined,
    callers: n.callers.filter((x) => x.edge === 'calls').map(withCount),
    usedBy: n.callers.filter((x) => x.edge !== 'calls').map((x) => ({ ...withCount(x), via: x.edge })),
    calls: n.callees.filter((x) => x.edge === 'calls').map(withCount),
    uses: n.callees.filter((x) => x.edge !== 'calls').map((x) => ({ ...withCount(x), via: x.edge })),
    reads: n.reads.map(withCount),
    writes: n.writes.map(withCount),
    readers: n.readers.map(withCount),
    writers: n.writers.map(withCount),
    members: n.members.map(brief),
    locals: n.locals,
  };
}

const notFound = (state, ref, what = 'symbol') => ({ matches: [], message: `No ${what} named "${ref}" in the knowledge graph.`, suggestions: suggestions(state, ref) });

const queries = {
  overview(state) {
    const o = G.overview(state);
    return { ...o, hint: 'Next: search <text>, symbol <name>, usages <name>, impact <name>, file <path>, variable <name>.' };
  },
  search(state, { query, kind, limit = 20 }) {
    if (!query) throw new KgError('search needs a query.');
    const kinds = kind ? String(kind).split(',') : [...G.TYPE_KINDS, ...G.CALLABLE_KINDS, ...G.VAR_KINDS];
    return { results: G.workspaceSymbols(state, { query, limit: Number(limit) || 20, kinds }).map((d) => ({ name: d.name, kind: d.kind, container: d.container || undefined, file: d.file, line: d.line, signature: d.sig || undefined })) };
  },
  symbol(state, { name }) {
    if (!name) throw new KgError('symbol needs a name (Name, Class.Name or path/file.py:Name).');
    const defs = resolve(state, name);
    if (!defs.length) return notFound(state, name);
    const g = G.fullGraph(state);
    return { matches: defs.slice(0, 10).map((d) => details(state, d, g)) };
  },
  usages(state, { name }) {
    if (!name) throw new KgError('usages needs a name.');
    const defs = resolve(state, name);
    if (!defs.length) return notFound(state, name);
    const g = G.fullGraph(state);
    const out = [];
    for (const d of defs.slice(0, 5)) for (const u of G.usagesOf(state, G.nodeIdOf(d), g)) out.push({ ...u, of: G.qualified(d) });
    return { symbols: defs.slice(0, 5).map((d) => ({ name: d.name, kind: d.kind, file: d.file, line: d.line })), usages: out.slice(0, 500), truncated: out.length > 500 || undefined };
  },
  impact(state, { name, depth = 3 }) {
    if (!name) throw new KgError('impact needs a name.');
    const defs = resolve(state, name);
    if (!defs.length) return notFound(state, name);
    const g = G.fullGraph(state);
    const d = defs[0];
    const levels = G.impactOf(state, G.nodeIdOf(d), Math.min(6, Number(depth) || 3), g).map((l) => ({ depth: l.depth, nodes: l.nodes.map((n) => ({ ...brief(n), via: n.via, of: n.of })) }));
    return { symbol: { name: d.name, kind: d.kind, file: d.file, line: d.line }, levels, total: levels.reduce((a, l) => a + l.nodes.length, 0), others: defs.length > 1 ? defs.slice(1, 6).map((x) => ({ name: x.name, file: x.file, line: x.line })) : undefined };
  },
  path(state, { from, to }) {
    if (!from || !to) throw new KgError('path needs from and to.');
    const a = resolve(state, from, (d) => G.CALLABLE_KINDS.has(d.kind) || G.TYPE_KINDS.has(d.kind));
    const b = resolve(state, to);
    if (!a.length) return notFound(state, from);
    if (!b.length) return notFound(state, to);
    const g = G.fullGraph(state);
    for (const x of a.slice(0, 3)) for (const y of b.slice(0, 3)) {
      const chain = G.callPath(state, G.nodeIdOf(x), G.nodeIdOf(y), 10, g);
      if (chain) return { path: chain.map(brief) };
    }
    return { path: null, message: `No call chain from ${from} to ${to} (within 10 calls).` };
  },
  file(state, { path: rel }) {
    if (!rel) throw new KgError('file needs a path relative to the project.');
    const clean = String(rel).replace(/^\.\//, '').replace(/\\/g, '/');
    const abs = path.isAbsolute(clean) ? path.relative(state.root, clean).split(path.sep).join('/') : clean;
    const o = G.fileOutline(state, abs) || G.fileOutline(state, [...state.files.keys()].find((f) => f.endsWith(`/${abs}`)) || '');
    if (!o) return { file: abs, message: 'Not in the knowledge graph (not a C#, Python, JavaScript or TypeScript file, or outside the project).' };
    return o;
  },
  variable(state, { name }) {
    if (!name) throw new KgError('variable needs a name.');
    const defs = resolve(state, name, (d) => G.VAR_KINDS.has(d.kind));
    if (!defs.length) return notFound(state, name, 'variable, field or property');
    const g = G.fullGraph(state);
    return {
      matches: defs.slice(0, 10).map((d) => {
        const x = details(state, d, g);
        return { name: x.name, kind: x.kind, container: x.container, file: x.file, line: x.line, signature: x.signature, readers: x.readers, writers: x.writers };
      }),
    };
  },
};

/** Run a query for the project containing `cwd` (or `project` if given). */
async function run(command, args = {}, { cwd = process.cwd(), maxAge = 0 } = {}) {
  if (command === 'index') return indexFolder(args.project || cwd);
  const fn = queries[command];
  if (!fn) throw new KgError(`Unknown command "${command}". Commands: overview, search, symbol, usages, impact, path, file, variable, index.`);
  const state = await load(args.project || cwd, { maxAge, ref: args.ref });
  const ref = args.ref && args.ref !== 'working-tree' ? args.ref : 'working-tree';
  return { project: state.root, ref, commit: state.commit || undefined, ...fn(state, args) };
}

module.exports = { run, load, indexFolder, findProject, graphFileFor, userDataDir, KgError, queries };
