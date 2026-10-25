// Debugger in the renderer: breakpoints (gutter clicks, conditions, logpoints; saved per project and
// kept on their lines while editing), session state from 'debug:event', the execution line and inline
// values in the editor, evaluate-on-hover while paused, watches, and the step/resume commands.
import { store } from '../lib/store.js';
import { invoke, on } from '../lib/ipc.js';
import { toast, errorToast, prompt, showContextMenu } from '../lib/ui.js';
import { debounce, basename, relative } from '../lib/util.js';
import * as ed from './editor.js';
import { openTool } from './layout.js';

const OUTPUT_LIMIT = 4000;
const bpDecorations = new Map(); // path -> decoration ids, aligned with store.breakpoints[path]
const execDecorations = new Map(); // path -> ids
const inlineDecorations = new Map(); // path -> ids
const contentHooks = new Map(); // path -> disposable
let hint = { path: null, ids: [] };
let tempBreakpoint = null; // run to cursor
let hoverRegistered = false;
let currentEditor = null;

const ACTIVE = new Set(['starting', 'running', 'stopped']);
const CALLABLE = new Set(['method', 'function', 'constructor', 'property', 'localFunction', 'lambda', 'accessor', 'event']);
export const isActive = (state = store.get().debug.state) => ACTIVE.has(state);

function fresh() {
  return { state: null, sessionId: null, name: '', kind: '', configId: null, threads: [], threadId: null, frames: [], frameIndex: 0, reason: '', text: '', output: [], evalResult: null, stopSeq: 0, exitCode: null };
}

const dbg = () => store.get().debug;
const setDbg = (patch) => store.update('debug', patch);
const opts = () => store.get().debugOptions;

// ------------------------------------------------------------- breakpoints

export function breakpointsIn(file) {
  return (store.get().breakpoints || {})[file] || [];
}

function bpClass(b) {
  const muted = opts().muted;
  let c = 'kiln-bp';
  if (b.logMessage) c += ' log';
  else if (b.condition) c += ' cond';
  if (b.enabled === false || muted) c += ' disabled';
  else if (b.verified === false && isActive()) c += ' unverified';
  return c;
}

function bpHover(b) {
  if (b.logMessage) return `Logpoint: \`${b.logMessage}\``;
  const parts = ['Line breakpoint'];
  if (b.condition) parts.push(`when \`${b.condition}\``);
  if (b.enabled === false) parts.push('(disabled)');
  else if (b.verified === false && isActive()) parts.push('(not yet bound)');
  return parts.join(' ');
}

export function renderBreakpoints(file) {
  const d = ed.getDoc(file);
  const monaco = ed.getMonaco();
  if (!d || !d.model || d.model.isDisposed() || !monaco) return;
  const list = breakpointsIn(file);
  const muted = opts().muted;
  const lines = d.model.getLineCount();
  const decs = list.filter((b) => b.line <= lines).map((b) => ({
    range: new monaco.Range(b.line, 1, b.line, 1),
    options: {
      glyphMarginClassName: bpClass(b),
      glyphMargin: ed.lane('Left'),
      glyphMarginHoverMessage: { value: bpHover(b) },
      className: b.enabled !== false && !muted ? 'kiln-bp-line' : undefined,
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }));
  bpDecorations.set(file, d.model.deltaDecorations(bpDecorations.get(file) || [], decs));
  hookContent(file, d.model);
}

function renderAllBreakpoints() {
  for (const p of ed.openDocs()) renderBreakpoints(p);
}

function hookContent(file, model) {
  if (contentHooks.has(file)) return;
  contentHooks.set(file, model.onDidChangeContent(() => trackLines(file, model)));
}

/** Breakpoint decorations move with edits; mirror their lines into the store. */
function trackLines(file, model) {
  const ids = bpDecorations.get(file) || [];
  const list = breakpointsIn(file);
  if (!ids.length || ids.length !== list.length || model.isDisposed()) return;
  let changed = false;
  const seen = new Set();
  const next = [];
  list.forEach((b, i) => {
    const r = model.getDecorationRange(ids[i]);
    const line = r ? r.startLineNumber : b.line;
    if (line !== b.line) changed = true;
    if (seen.has(line)) {
      changed = true;
      return;
    }
    seen.add(line);
    next.push({ ...b, line });
  });
  if (!changed) return;
  const all = { ...store.get().breakpoints };
  if (next.length) all[file] = next;
  else delete all[file];
  store.set({ breakpoints: all });
  if (next.length !== list.length) renderBreakpoints(file);
  persist();
  syncSoon(file);
}

function setFileBreakpoints(file, list) {
  const all = { ...store.get().breakpoints };
  if (list.length) all[file] = list.slice().sort((a, b) => a.line - b.line);
  else delete all[file];
  store.set({ breakpoints: all });
  renderBreakpoints(file);
  persist();
  sync(file);
}

export function toggleBreakpoint(file, line, extra = {}) {
  if (!file || !line) return;
  const list = breakpointsIn(file);
  if (list.some((b) => b.line === line)) setFileBreakpoints(file, list.filter((b) => b.line !== line));
  else setFileBreakpoints(file, [...list, { line, enabled: true, condition: extra.condition || '', logMessage: extra.logMessage || '' }]);
}

export function updateBreakpoint(file, line, patch) {
  setFileBreakpoints(file, breakpointsIn(file).map((b) => (b.line === line ? { ...b, ...patch } : b)));
}

export function removeBreakpoint(file, line) {
  setFileBreakpoints(file, breakpointsIn(file).filter((b) => b.line !== line));
}

export function removeAllBreakpoints() {
  for (const f of Object.keys(store.get().breakpoints || {})) setFileBreakpoints(f, []);
}

export async function editBreakpoint(file, line) {
  let b = breakpointsIn(file).find((x) => x.line === line);
  if (!b) {
    toggleBreakpoint(file, line);
    b = breakpointsIn(file).find((x) => x.line === line);
  }
  const v = await prompt({ title: `Breakpoint at ${basename(file)}:${line}`, label: 'Condition (stop only when this expression is true; empty for always):', value: b.condition || '', placeholder: 'order.total > 100', ok: 'Save', testid: 'breakpoint-condition' });
  if (v == null) return;
  updateBreakpoint(file, line, { condition: String(typeof v === 'string' ? v : v.value).trim() });
}

export async function addLogpoint(file, line) {
  const b = breakpointsIn(file).find((x) => x.line === line);
  const v = await prompt({ title: `Logpoint at ${basename(file)}:${line}`, label: 'Message to log instead of stopping. Use {expression} to include values:', value: (b && b.logMessage) || '', placeholder: 'total is {total}', ok: 'Save' });
  if (v == null) return;
  const msg = String(typeof v === 'string' ? v : v.value).trim();
  if (b) updateBreakpoint(file, line, { logMessage: msg });
  else toggleBreakpoint(file, line, { logMessage: msg });
}

const persist = debounce(() => {
  if (!store.get().project) return;
  const clean = {};
  for (const [f, list] of Object.entries(store.get().breakpoints || {})) clean[f] = list.map(({ line, enabled, condition, logMessage }) => ({ line, enabled: enabled !== false, condition: condition || '', logMessage: logMessage || '' }));
  invoke('app:setProjectState', { breakpoints: clean, debugWatches: store.get().debugWatches, debugOptions: opts() }).catch(() => {});
}, 400);

function activeFor(file) {
  if (opts().muted) return [];
  return breakpointsIn(file)
    .filter((b) => b.enabled !== false)
    .map(({ line, condition, logMessage }) => ({ line, condition: condition || undefined, logMessage: logMessage || undefined }));
}

function activeMap() {
  const out = {};
  for (const f of Object.keys(store.get().breakpoints || {})) {
    const l = activeFor(f);
    if (l.length) out[f] = l;
  }
  if (tempBreakpoint) out[tempBreakpoint.file] = [...(out[tempBreakpoint.file] || []).filter((b) => b.line !== tempBreakpoint.line), { line: tempBreakpoint.line }];
  return out;
}

async function sync(file) {
  if (!isActive()) return;
  let bps = activeFor(file);
  if (tempBreakpoint && tempBreakpoint.file === file && !bps.some((b) => b.line === tempBreakpoint.line)) bps = [...bps, { line: tempBreakpoint.line }];
  try {
    const res = await invoke('debug:setBreakpoints', file, bps);
    applyVerified(file, res);
  } catch {
    /* session ended */
  }
}

const syncTimers = new Map();
function syncSoon(file) {
  clearTimeout(syncTimers.get(file));
  syncTimers.set(file, setTimeout(() => sync(file), 500));
}

function applyVerified(file, results) {
  if (!Array.isArray(results)) return;
  let list = breakpointsIn(file);
  let changed = false;
  for (const r of results) {
    const want = r.requestedLine || r.line;
    const i = list.findIndex((b) => b.line === want);
    if (i < 0) continue;
    const next = { ...list[i], verified: r.verified };
    // The runtime may bind the breakpoint to the next line with code.
    if (r.verified && r.line && r.line !== want && !list.some((b) => b.line === r.line)) next.line = r.line;
    if (next.verified !== list[i].verified || next.line !== list[i].line) {
      list = list.map((b, j) => (j === i ? next : b));
      changed = true;
    }
  }
  if (!changed) return;
  store.set({ breakpoints: { ...store.get().breakpoints, [file]: list.sort((a, b) => a.line - b.line) } });
  renderBreakpoints(file);
}

function clearVerified() {
  const all = {};
  for (const [f, list] of Object.entries(store.get().breakpoints || {})) all[f] = list.map(({ verified, ...b }) => b);
  store.set({ breakpoints: all });
  renderAllBreakpoints();
}

export function setMuted(muted) {
  store.set({ debugOptions: { ...opts(), muted } });
  renderAllBreakpoints();
  persist();
  if (isActive()) for (const f of new Set([...Object.keys(store.get().breakpoints || {})])) sync(f);
}

export async function setBreakOnExceptions(on) {
  store.set({ debugOptions: { ...opts(), breakOnExceptions: on } });
  persist();
  if (isActive()) await invoke('debug:setBreakOnExceptions', on).catch(() => {});
}

// ------------------------------------------------------------ editor marks

function clearMap(map, path) {
  const paths = path ? [path] : [...map.keys()];
  for (const p of paths) {
    const d = ed.getDoc(p);
    if (d && d.model && !d.model.isDisposed()) d.model.deltaDecorations(map.get(p) || [], []);
    map.delete(p);
  }
}

function clearExecution() {
  clearMap(execDecorations);
  clearMap(inlineDecorations);
}

function renderExecution() {
  clearExecution();
  const s = dbg();
  if (s.state !== 'stopped') return;
  const monaco = ed.getMonaco();
  const top = s.frames[0];
  const sel = s.frames[s.frameIndex];
  for (const [f, cls] of [[top, 'top'], [sel !== top ? sel : null, 'frame']]) {
    if (!f || !f.file || !monaco) continue;
    const d = ed.getDoc(f.file);
    if (!d || !d.model || d.model.isDisposed() || f.line > d.model.getLineCount()) continue;
    // One glyph per lane is drawn, so on a breakpoint line the pointer glyph also draws the dot.
    const onBp = breakpointsIn(f.file).some((b) => b.line === f.line && b.enabled !== false) && !opts().muted;
    const ids = d.model.deltaDecorations(execDecorations.get(f.file) || [], [
      { range: new monaco.Range(f.line, 1, f.line, 1), options: { isWholeLine: true, className: `dbg-exec-line ${cls}`, glyphMarginClassName: `dbg-exec-glyph ${cls}${onBp ? ' on-bp' : ''}`, glyphMargin: ed.lane('Left'), zIndex: 100, overviewRuler: { color: '#E8C46A', position: monaco.editor.OverviewRulerLane.Full } } },
    ]);
    execDecorations.set(f.file, ids);
  }
}

/** Show local values at the end of the lines that use them, above the paused line (like Rider). */
async function renderInlineValues() {
  const s = dbg();
  const frame = s.frames[s.frameIndex];
  if (s.state !== 'stopped' || !frame || !frame.file) return;
  const seq = s.stopSeq;
  let vars = [];
  try {
    const scopes = await invoke('debug:scopes', frame.id);
    const local = scopes.find((x) => !x.expensive);
    if (local) vars = await invoke('debug:variables', local.variablesReference);
  } catch {
    return;
  }
  if (dbg().stopSeq !== seq || dbg().frames[dbg().frameIndex] !== frame) return;
  const d = ed.getDoc(frame.file);
  const monaco = ed.getMonaco();
  if (!d || !d.model || d.model.isDisposed() || !monaco) return;
  // Only lines of the paused function (from the code index), not neighbouring functions.
  let from = Math.max(1, frame.line - 40);
  try {
    const syms = await invoke('code:documentSymbols', frame.file, d.model.getValue());
    const enclosing = syms.filter((x) => CALLABLE.has(x.kind) && x.start <= frame.line && x.end >= frame.line);
    if (enclosing.length) from = Math.max(...enclosing.map((x) => x.start));
  } catch {
    /* index not ready: use the window above the line */
  }
  if (dbg().stopSeq !== seq) return;
  const values = new Map();
  for (const v of vars) if (/^[A-Za-z_$][\w$]*$/.test(v.name) && !/^(special|function) variables$/i.test(v.name) && v.type !== 'function') values.set(v.name, v.value.length > 48 ? `${v.value.slice(0, 47)}…` : v.value);
  if (!values.size) return;
  const decs = [];
  for (let ln = from; ln <= Math.min(frame.line, d.model.getLineCount()); ln++) {
    const text = d.model.getLineContent(ln);
    const names = [];
    for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) if (values.has(m[0]) && !names.includes(m[0])) names.push(m[0]);
    if (!names.length) continue;
    const content = `   ${names.slice(0, 4).map((n) => `${n}: ${values.get(n)}`).join('   ')}`;
    decs.push({ range: new monaco.Range(ln, d.model.getLineMaxColumn(ln), ln, d.model.getLineMaxColumn(ln)), options: { after: { content, inlineClassName: 'dbg-inline-value' }, showIfCollapsed: true } });
  }
  inlineDecorations.set(frame.file, d.model.deltaDecorations(inlineDecorations.get(frame.file) || [], decs));
}

/** Breakpoint hint on hover over the gutter. */
function hookEditor(editor) {
  currentEditor = editor;
  const monaco = ed.getMonaco();
  const T = monaco.editor.MouseTargetType;
  editor.onMouseMove((e) => {
    const m = editor.getModel();
    const inGutter = e.target.type === T.GUTTER_GLYPH_MARGIN || e.target.type === T.GUTTER_LINE_DECORATIONS;
    const line = inGutter && e.target.position ? e.target.position.lineNumber : null;
    const path = m ? m.uri.fsPath : null;
    if (hint.path && (hint.path !== path || !line || hint.line !== line)) {
      const d = ed.getDoc(hint.path);
      if (d && d.model && !d.model.isDisposed()) d.model.deltaDecorations(hint.ids, []);
      hint = { path: null, ids: [] };
    }
    if (!line || !m || hint.line === line && hint.path === path) return;
    if (breakpointsIn(path).some((b) => b.line === line)) return;
    hint = { path, line, ids: m.deltaDecorations([], [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'kiln-bp hint', glyphMargin: ed.lane('Left') } }]) };
  });
  editor.onMouseLeave(() => {
    if (!hint.path) return;
    const d = ed.getDoc(hint.path);
    if (d && d.model && !d.model.isDisposed()) d.model.deltaDecorations(hint.ids, []);
    hint = { path: null, ids: [] };
  });
  registerHover(monaco);
}

/** Expression under the mouse: a word plus any a.b.c member chain to its left. */
function expressionAt(model, pos) {
  const word = model.getWordAtPosition(pos);
  if (!word) return null;
  const line = model.getLineContent(pos.lineNumber);
  let start = word.startColumn - 1;
  while (start > 1 && line[start - 1] === '.') {
    const left = /([A-Za-z_$][\w$]*)$/.exec(line.slice(0, start - 1));
    if (!left) break;
    start = start - 1 - left[1].length;
  }
  const expr = line.slice(start, word.endColumn - 1);
  return { expr, range: { startLineNumber: pos.lineNumber, startColumn: start + 1, endLineNumber: pos.lineNumber, endColumn: word.endColumn } };
}

const KEYWORDS = new Set(['def', 'class', 'return', 'if', 'else', 'elif', 'for', 'while', 'import', 'from', 'as', 'in', 'not', 'and', 'or', 'is', 'None', 'True', 'False', 'public', 'private', 'protected', 'internal', 'static', 'void', 'var', 'new', 'using', 'namespace', 'const', 'let', 'function', 'async', 'await', 'int', 'string', 'bool', 'true', 'false', 'null', 'this', 'self', 'try', 'catch', 'finally', 'with', 'pass', 'lambda', 'yield']);

function registerHover(monaco) {
  if (hoverRegistered) return;
  hoverRegistered = true;
  monaco.languages.registerHoverProvider('*', {
    provideHover: async (model, pos) => {
      const s = dbg();
      if (s.state !== 'stopped') return null;
      const frame = s.frames[s.frameIndex];
      if (!frame) return null;
      const at = expressionAt(model, pos);
      if (!at || KEYWORDS.has(at.expr)) return null;
      try {
        const r = await invoke('debug:evaluate', at.expr, frame.id, 'hover');
        return { range: at.range, contents: [{ value: `\`\`\`\n${at.expr} = ${r.result}\n\`\`\`` }, ...(r.type ? [{ value: `*${r.type}*` }] : [])] };
      } catch {
        return null;
      }
    },
  });
}

// ---------------------------------------------------------------- session

function onEvent(e) {
  const s = dbg();
  if (e.type === 'state' && e.state === 'starting') {
    clearExecution();
    clearVerified();
    store.set({ debug: { ...fresh(), state: 'starting', sessionId: e.sessionId, name: e.name, kind: e.kind, configId: e.configId, output: [] } });
    openTool('bottom', 'debug');
    return;
  }
  if (e.sessionId && s.sessionId && e.sessionId !== s.sessionId) return;
  switch (e.type) {
    case 'state':
      setDbg({ state: e.state === 'running' && s.state === 'stopped' ? 'stopped' : e.state });
      break;
    case 'output':
      appendOutput(e.category, e.text);
      break;
    case 'stopped': {
      const frames = e.frames || [];
      let idx = frames.findIndex((f) => f.file && f.presentationHint !== 'subtle');
      if (idx < 0) idx = 0;
      if (tempBreakpoint) {
        const t = tempBreakpoint;
        tempBreakpoint = null;
        sync(t.file);
      }
      setDbg({ state: 'stopped', threads: e.threads || [], threadId: e.threadId, frames, frameIndex: idx, reason: e.reason, text: e.text || '', stopSeq: s.stopSeq + 1 });
      openTool('bottom', 'debug');
      revealFrame(idx);
      if (e.reason === 'exception' && e.text) appendOutput('stderr', `${e.text}\n`);
      break;
    }
    case 'continued':
      if (s.state === 'stopped' || s.state === 'starting') {
        setDbg({ state: 'running', frames: [], frameIndex: 0, reason: '' });
        clearExecution();
      }
      break;
    case 'breakpoint':
      if (e.file) applyVerified(e.file, [{ line: e.line, requestedLine: e.line, verified: e.verified }]);
      break;
    case 'terminated':
      tempBreakpoint = null;
      setDbg({ state: 'terminated', frames: [], threads: [], frameIndex: 0, exitCode: e.exitCode });
      appendOutput('system', `\nProcess finished${e.exitCode != null ? ` with exit code ${e.exitCode}` : ''}\n`);
      clearExecution();
      renderAllBreakpoints();
      break;
    default:
      break;
  }
}

let pendingOut = [];
const flushOutput = debounce(() => {
  const add = pendingOut;
  pendingOut = [];
  setDbg({ output: [...dbg().output, ...add].slice(-OUTPUT_LIMIT) });
}, 30);

export function appendOutput(category, text) {
  if (!text) return;
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  pendingOut.push({ category, text: clean });
  flushOutput();
}

export async function revealFrame(index) {
  const s = dbg();
  const f = s.frames[index];
  setDbg({ frameIndex: index });
  if (f && f.file) await ed.openFile(f.file, { line: f.line, col: f.col || 1, focus: false });
  renderExecution();
  renderInlineValues();
}

export async function selectThread(threadId) {
  try {
    const frames = await invoke('debug:stackTrace', threadId);
    const idx = Math.max(0, frames.findIndex((f) => f.file && f.presentationHint !== 'subtle'));
    setDbg({ threadId, frames, frameIndex: idx, stopSeq: dbg().stopSeq + 1 });
    revealFrame(idx);
  } catch (err) {
    errorToast('Cannot switch thread', err);
  }
}

// --------------------------------------------------------------- commands

export async function startDebug(cfg) {
  const s = store.get();
  const config = cfg || s.runs.configs.find((c) => c.id === s.runs.selected);
  if (!config) {
    const file = ed.activeFile();
    if (file) return debugFile(file);
    toast({ title: 'Nothing to debug', message: 'Select a run configuration or open a Python or JavaScript file.' });
    return null;
  }
  await ed.saveAll({ quiet: true });
  try {
    return await invoke('debug:start', config.id, { breakpoints: activeMap(), breakOnExceptions: opts().breakOnExceptions });
  } catch (err) {
    errorToast(`Cannot debug '${config.name}'`, err);
    return null;
  }
}

export async function debugFile(file) {
  await ed.saveAll({ quiet: true });
  try {
    return await invoke('debug:startFile', file, { breakpoints: activeMap(), breakOnExceptions: opts().breakOnExceptions });
  } catch (err) {
    errorToast(`Cannot debug ${basename(file)}`, err);
    return null;
  }
}

/** Debug one test (gutter icon, Tests tool window). */
export async function debugTest(projectId, testId, name) {
  await ed.saveAll({ quiet: true });
  try {
    return await invoke('debug:startTest', projectId, testId, { name, breakpoints: activeMap(), breakOnExceptions: opts().breakOnExceptions });
  } catch (err) {
    errorToast(`Cannot debug '${name || testId}'`, err);
    return null;
  }
}

export function canDebugConfig(cfg) {
  if (!cfg) return false;
  if (cfg.custom) return /^(python|python3|node|dotnet|npm|pnpm|yarn)\b/.test((cfg.commandLine || '').trim());
  if (cfg.python) return !/pytest/.test(cfg.detail || '');
  if (cfg.command === 'dotnet') return (cfg.args || [])[0] === 'run';
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(cfg.command)) return /^\s*(\w+=\S+\s+)*(node|nodemon)\s/.test(cfg.detail || '');
  return false;
}

const call = (channel, ...args) => invoke(channel, ...args).catch((err) => errorToast('Debugger', err));

export function resume() {
  const s = dbg();
  if (s.state === 'stopped') return call('debug:continue', s.threadId);
  return undefined;
}

export function pause() {
  const s = dbg();
  if (s.state === 'running') return call('debug:pause', s.threadId);
  return undefined;
}

export function stepOver() {
  const s = dbg();
  if (s.state === 'stopped') return call('debug:next', s.threadId);
  return undefined;
}

export function stepInto() {
  const s = dbg();
  if (s.state === 'stopped') return call('debug:stepIn', s.threadId);
  return undefined;
}

export function stepOut() {
  const s = dbg();
  if (s.state === 'stopped') return call('debug:stepOut', s.threadId);
  return undefined;
}

export function stopDebug() {
  if (isActive()) return call('debug:stop');
  return undefined;
}

export async function restartDebug() {
  if (!dbg().state) return startDebug();
  return call('debug:restart');
}

/** Run to cursor: a one-shot breakpoint on the caret line, then resume. */
export async function runToCursor() {
  const file = ed.activeFile();
  const e = ed.getEditor();
  if (!file || !e || dbg().state !== 'stopped') return;
  tempBreakpoint = { file, line: e.getPosition().lineNumber };
  await sync(file);
  resume();
}

export async function evaluate(expression, context = 'watch') {
  const s = dbg();
  const frame = s.frames[s.frameIndex];
  if (!isActive()) throw new Error('No debug session is running.');
  return invoke('debug:evaluate', expression, frame ? frame.id : undefined, context);
}

export async function evaluateToConsole(expression) {
  appendOutput('input', `> ${expression}\n`);
  try {
    const r = await evaluate(expression, 'repl');
    appendOutput('result', `${r.result}\n`);
  } catch (err) {
    appendOutput('stderr', `${err.message}\n`);
  }
}

export function addWatch(expression) {
  const e = String(expression || '').trim();
  if (!e) return;
  const list = store.get().debugWatches || [];
  if (!list.includes(e)) store.set({ debugWatches: [...list, e] });
  persist();
}

export function removeWatch(expression) {
  store.set({ debugWatches: (store.get().debugWatches || []).filter((x) => x !== expression) });
  persist();
}

export function gutterMenu({ file, line, x, y }) {
  const b = breakpointsIn(file).find((x2) => x2.line === line);
  const items = b
    ? [
        { label: 'Edit Condition…', icon: 'edit', run: () => editBreakpoint(file, line) },
        { label: b.logMessage ? 'Edit Log Message…' : 'Turn into Logpoint…', icon: 'terminal', run: () => addLogpoint(file, line) },
        { label: b.enabled === false ? 'Enable Breakpoint' : 'Disable Breakpoint', run: () => updateBreakpoint(file, line, { enabled: b.enabled === false }) },
        { label: 'Remove Breakpoint', icon: 'trash', run: () => removeBreakpoint(file, line) },
      ]
    : [
        { label: 'Add Breakpoint', icon: 'breakpoint', run: () => toggleBreakpoint(file, line) },
        { label: 'Add Conditional Breakpoint…', icon: 'edit', run: () => editBreakpoint(file, line) },
        { label: 'Add Logpoint…', icon: 'terminal', run: () => addLogpoint(file, line) },
      ];
  if (dbg().state === 'stopped') items.push({ separator: true }, { label: 'Run to This Line', icon: 'runToCursor', run: () => { const ed2 = ed.getEditor(); if (ed2) ed2.setPosition({ lineNumber: line, column: 1 }); runToCursor(); } });
  showContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: x, clientY: y }, items);
}

export function allBreakpoints() {
  const root = store.get().project ? store.get().project.root : '';
  const out = [];
  for (const [file, list] of Object.entries(store.get().breakpoints || {})) for (const b of list) out.push({ ...b, file, rel: relative(root, file) });
  return out.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
}

export function debugOutputText() {
  return dbg().output.map((o) => o.text).join('');
}

// ------------------------------------------------------------------- init

export function initDebug() {
  store.set({ debug: fresh(), breakpoints: {}, debugWatches: [], debugOptions: { muted: false, breakOnExceptions: true } });
  on('debug:event', onEvent);
  let root = null;
  store.subscribe((s) => {
    const r = s.project ? s.project.root : null;
    if (r === root) return;
    root = r;
    clearExecution();
    for (const disp of contentHooks.values()) disp.dispose();
    contentHooks.clear();
    bpDecorations.clear();
    const st = (s.project && s.project.state) || {};
    store.set({ debug: fresh(), breakpoints: st.breakpoints || {}, debugWatches: st.debugWatches || [], debugOptions: { muted: false, breakOnExceptions: true, ...(st.debugOptions || {}) } });
  });
  ed.onEditorEvent((type, data) => {
    if (type === 'opened') {
      renderBreakpoints(data.path);
      const s = dbg();
      if (s.state === 'stopped' && s.frames.some((f) => f.file === data.path)) renderExecution();
    } else if (type === 'closed') {
      const disp = contentHooks.get(data.path);
      if (disp) disp.dispose();
      contentHooks.delete(data.path);
      bpDecorations.delete(data.path);
      execDecorations.delete(data.path);
      inlineDecorations.delete(data.path);
    } else if (type === 'gutterClick') {
      toggleBreakpoint(data.file, data.line);
    } else if (type === 'gutterMenu') {
      gutterMenu(data);
    } else if (type === 'editorCreated') {
      hookEditor(data.editor);
    }
  });
}

export { currentEditor };
