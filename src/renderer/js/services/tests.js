// Unit tests in the IDE: test projects and their tests, runs (all, some, failed, with coverage),
// results on the editor's gutter icons, Debug Test, and coverage marks in open editors. The Tests
// tool window, the gutter and the Run menu all go through this service.
import { store } from '../lib/store.js';
import { invoke, on } from '../lib/ipc.js';
import { toast, errorToast, showContextMenu } from '../lib/ui.js';
import { basename, relative } from '../lib/util.js';
import * as ed from './editor.js';
import { debugTest as startDebugTest } from './debug.js';
import { openTool } from './layout.js';

const EMPTY = { projects: null, discovered: {}, results: {}, running: null, output: '', coverage: null, showCoverage: true, last: null };
const T = () => store.get().tests || EMPTY;
const setT = (patch) => store.update('tests', (t) => ({ ...(t || EMPTY), ...(typeof patch === 'function' ? patch(t || EMPTY) : patch) }));

/** Test projects; `discoverTests` also lists their tests (for .NET that builds the test project). */
export async function loadProjects({ discoverTests = false } = {}) {
  const projects = await invoke('tests:projects').catch(() => []);
  setT({ projects });
  if (discoverTests) await Promise.all(projects.map((p) => discover(p.id)));
  return projects;
}

export async function discover(projectId) {
  const r = await invoke('tests:discover', projectId).catch((err) => ({ error: err.message, tests: [] }));
  setT((t) => ({ discovered: { ...t.discovered, [projectId]: r } }));
  return r;
}

async function projects() {
  return T().projects || loadProjects();
}

/** The test project a file belongs to: the deepest project folder that contains it. */
export function projectFor(file, kind) {
  const list = (T().projects || []).filter((p) => (!kind || p.kind === kind) && (file === p.dir || file.startsWith(`${p.dir}/`)));
  return list.sort((a, b) => b.dir.length - a.dir.length)[0] || null;
}

/** Test id (as the runner names it) of a test found in an editor. */
export function idOf(p, file, t) {
  if (p.kind === 'python') return `${relative(p.dir, file)}::${t.cls ? `${t.cls}::` : ''}${t.name}`;
  if (p.kind === 'dotnet') return t.fqn;
  return `${file}::${t.name}`;
}

/** Result of a test in a project: by id, or by name for runners that spell ids differently. */
export function resultFor(projectId, test) {
  const map = T().results[projectId];
  if (!map) return null;
  if (map[test.id]) return map[test.id];
  return Object.values(map).find((x) => x.name === test.name || test.id.endsWith(`::${x.name}`) || (x.className && test.id === `${x.className}.${x.method}`)) || null;
}

function statusOf(file, t) {
  const kind = t.kind === 'node' ? 'node' : t.kind;
  const p = projectFor(file, kind);
  if (!p) return null;
  const r = resultFor(p.id, { id: idOf(p, file, t), name: t.kind === 'python' ? t.name : t.name });
  return r && (r.outcome === 'passed' || r.outcome === 'failed') ? r.outcome : null;
}

/**
 * Run tests: all of a project (`filter` empty) or the given ids. `coverage` collects which lines ran.
 * Results of a partial run are merged into the earlier ones.
 */
export async function runTests(projectId, { filter = [], coverage = false, quiet = false } = {}) {
  if (T().running) return null;
  setT({ running: projectId, output: '', last: { projectId, filter, coverage } });
  await ed.saveAll({ quiet: true });
  let r = null;
  try {
    r = await invoke('tests:run', projectId, filter, { coverage });
    const map = {};
    for (const x of r.results) map[x.id] = x;
    setT((t) => ({ results: { ...t.results, [projectId]: { ...(filter.length ? t.results[projectId] || {} : {}), ...map } } }));
    if (coverage) setCoverage(r.coverage ? mergeCoverage(filter.length ? T().coverage : null, r.coverage) : T().coverage);
    if (!quiet) report(r);
  } catch (err) {
    errorToast('Test run failed', err);
  }
  setT({ running: null });
  refreshGlyphs();
  return r;
}

function report(r) {
  const failed = r.results.filter((x) => x.outcome === 'failed').length;
  const passed = r.results.filter((x) => x.outcome === 'passed').length;
  if (r.cancelled) return toast({ title: 'Test run stopped', timeout: 2500 });
  if (!r.results.length) return toast({ kind: 'warning', title: 'No tests ran', message: 'See the output in the Tests tool window.', timeout: 5000 });
  const cov = r.coverage ? ` · ${r.coverage.summary.percent}% of lines covered` : '';
  toast({ kind: failed ? 'error' : 'success', title: failed ? `${failed} test${failed === 1 ? '' : 's'} failed` : `${passed} test${passed === 1 ? '' : 's'} passed`, message: cov.slice(3), timeout: 4000 });
}

export async function runAll({ coverage = false } = {}) {
  const list = await projects();
  if (!list.length) return toast({ title: 'No test projects found', message: 'xUnit / NUnit / MSTest projects, pytest tests and JavaScript tests (node:test, Jest, Vitest, Mocha) are detected.', timeout: 4000 });
  openTool('bottom', 'tests');
  if (coverage) setCoverage(null);
  for (const p of list) {
    const r = await runTests(p.id, { coverage, quiet: list.length > 1 });
    if (r && coverage && r.coverage) setCoverage(mergeCoverage(T().coverage, r.coverage));
  }
  if (list.length > 1) {
    const all = Object.values(T().results).flatMap((m) => Object.values(m));
    report({ results: all, coverage: T().coverage });
  }
  return T().results;
}

export function failedIds() {
  const out = {};
  for (const [pid, map] of Object.entries(T().results)) {
    const ids = Object.values(map).filter((x) => x.outcome === 'failed').map((x) => x.id);
    if (ids.length) out[pid] = ids;
  }
  return out;
}

/** Rerun only the tests that failed in the last runs. */
export async function rerunFailed({ coverage = false } = {}) {
  const failed = failedIds();
  const pids = Object.keys(failed);
  if (!pids.length) return toast({ title: 'No failed tests to rerun', timeout: 2500 });
  openTool('bottom', 'tests');
  for (const pid of pids) await runTests(pid, { filter: failed[pid], coverage });
  return failedIds();
}

/** Run the last run again (same tests, same coverage option). */
export function rerunLast() {
  const l = T().last;
  if (!l) return runAll();
  return runTests(l.projectId, { filter: l.filter, coverage: l.coverage });
}

export function cancel() {
  return invoke('tests:cancel');
}

export async function debugTest(projectId, testId, name) {
  return startDebugTest(projectId, testId, name);
}

// ------------------------------------------------------------- the editor

function locate(file, test) {
  const p = projectFor(file, test.kind);
  if (!p) return null;
  return { p, id: idOf(p, file, test), name: test.title || test.name };
}

/** Run / Debug / Run with Coverage for the test at a gutter icon. */
export async function testAction(file, test, mode) {
  await projects();
  const at = locate(file, test);
  if (!at) return toast({ title: `${basename(file)} is not in a detected test project`, message: 'Kiln runs .NET test projects, pytest tests and JavaScript tests of a package with a test runner.', timeout: 4000 });
  if (mode === 'debug') return debugTest(at.p.id, at.id, at.name);
  openTool('bottom', 'tests');
  return runTests(at.p.id, { filter: [at.id], coverage: mode === 'coverage' });
}

function gutterMenu({ file, test, x, y }) {
  const name = test.title || test.name;
  showContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: x, clientY: y }, [
    { label: `Run '${name}'`, icon: 'play', run: () => testAction(file, test, 'run') },
    { label: `Debug '${name}'`, icon: 'debug', run: () => testAction(file, test, 'debug') },
    { label: `Run '${name}' with Coverage`, icon: 'coverage', run: () => testAction(file, test, 'coverage') },
  ]);
}

/** The test whose gutter icon is on the caret line, or the nearest one above it. */
export function testAtCaret() {
  const file = ed.activeFile();
  const e = ed.getEditor();
  if (!file || !e) return null;
  const line = e.getPosition().lineNumber;
  const list = ed.testsIn(file).filter((t) => t.line <= line);
  return list.length ? { file, test: list[list.length - 1] } : null;
}

export function testAtCaretAction(mode) {
  const at = testAtCaret();
  if (!at) return toast({ title: 'No test at the caret', message: 'Put the caret in a test method or function.', timeout: 2500 });
  return testAction(at.file, at.test, mode);
}

function refreshGlyphs() {
  for (const p of ed.openDocs()) ed.renderTestGlyphs(p);
}

// ------------------------------------------------------------- coverage

function mergeCoverage(a, b) {
  if (!a) return b;
  const files = { ...a.files };
  for (const [f, c] of Object.entries(b.files)) {
    const old = files[f];
    if (!old) {
      files[f] = c;
      continue;
    }
    const covered = new Set([...old.covered, ...c.covered]);
    const uncovered = [...new Set([...old.uncovered, ...c.uncovered])].filter((l) => !covered.has(l));
    files[f] = { covered: [...covered].sort((x, y) => x - y), uncovered: uncovered.sort((x, y) => x - y) };
  }
  let lines = 0;
  let covered = 0;
  for (const f of Object.values(files)) {
    const n = f.covered.length + f.uncovered.length;
    f.percent = n ? Math.round((f.covered.length / n) * 100) : 100;
    lines += n;
    covered += f.covered.length;
  }
  return { files, summary: { lines, covered, percent: lines ? Math.round((covered / lines) * 100) : 100 } };
}

export function setCoverage(coverage) {
  setT({ coverage, showCoverage: true });
  applyCoverage();
}

export function toggleCoverage(show = !T().showCoverage) {
  setT({ showCoverage: show });
  applyCoverage();
}

function applyCoverage() {
  const { coverage, showCoverage } = T();
  for (const p of ed.openDocs()) ed.setCoverage(p, showCoverage && coverage ? coverage.files[p] || null : null);
}

export function initTests() {
  store.set({ tests: { ...EMPTY } });
  ed.setTestStatusProvider(statusOf);
  on('tests:output', ({ text }) => setT((t) => ({ output: (t.output + text).slice(-200000) })));
  ed.onEditorEvent((type, data) => {
    if (type === 'runTest') gutterMenu(data);
    else if (type === 'opened') {
      const { coverage, showCoverage } = T();
      if (coverage && showCoverage && coverage.files[data.path]) ed.setCoverage(data.path, coverage.files[data.path]);
    }
  });
  let root = null;
  store.subscribe((s) => {
    const r = s.project ? s.project.root : null;
    if (r === root) return;
    root = r;
    store.set({ tests: { ...EMPTY } });
    if (r) setTimeout(() => loadProjects().then(refreshGlyphs), 1200);
  });
  on('project:detected', () => {
    if (store.get().project) loadProjects().then(refreshGlyphs);
  });
}
