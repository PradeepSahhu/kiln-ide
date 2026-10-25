// Editor engine: Monaco models and tabs, saving (with Local History), live reload of files changed by
// agents (with change highlighting), Problems markers, git gutter, blame, bookmarks and navigation.
import { store } from '../lib/store.js';
import { invoke, send } from '../lib/ipc.js';
import { loadMonaco, setMonacoTheme } from '../lib/monaco.js';
import { themeById } from '../lib/themes.js';
import { basename, languageOf, extname, IMAGE_EXT, debounce, relative } from '../lib/util.js';
import { changedRegions, lineEdits } from '../lib/diff.js';
import { toast, confirm } from '../lib/ui.js';

let monaco = null;
let editor = null;
let diffEditor = null;
const docs = new Map(); // path -> { model, savedAlt, bom, headText, decorations: {} , viewState }
const tabsClosed = [];
const back = [];
const forward = [];
let suppressNav = false;
const listeners = new Set();
const LSP_LANGS = new Set(['python', 'csharp']);

export const onEditorEvent = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = (type, data) => listeners.forEach((fn) => fn(type, data));

export const getMonaco = () => monaco;
export const getEditor = () => editor;
export const getDiffEditor = () => diffEditor;
export const getDoc = (p) => docs.get(p);
export const openDocs = () => [...docs.keys()];

function settings() {
  return store.get().settings || {};
}

export function editorOptions() {
  const e = settings().editor || {};
  const langs = settings().languages || {};
  return {
    fontFamily: e.fontFamily || "'JetBrains Mono', Menlo, monospace",
    fontSize: e.fontSize || 13,
    lineHeight: e.lineHeight || 20,
    fontLigatures: e.ligatures !== false,
    minimap: { enabled: e.minimap !== false, renderCharacters: false, scale: 1, maxColumn: 100 },
    wordWrap: e.wordWrap || 'off',
    tabSize: e.tabSize || 4,
    insertSpaces: e.insertSpaces !== false,
    renderWhitespace: e.renderWhitespace || 'selection',
    stickyScroll: { enabled: e.stickyScroll !== false },
    'semanticHighlighting.enabled': langs.semanticHighlighting !== false,
    codeLens: langs.codeLens !== false,
    inlayHints: { enabled: langs.inlayHints !== false ? 'on' : 'off' },
    glyphMargin: true,
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    cursorBlinking: 'smooth',
    scrollBeyondLastLine: false,
    renderLineHighlight: 'all',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    automaticLayout: true,
    fixedOverflowWidgets: true,
    padding: { top: 6 },
    'bracketPairColorization.independentColorPoolPerBracketType': true,
    suggest: { preview: true, showStatusBar: true },
    quickSuggestions: { other: true, comments: false, strings: false },
    occurrencesHighlight: 'singleFile',
    links: true,
    mouseWheelZoom: true,
  };
}

let openerRegistered = false;
let blurHooked = false;

export async function initEditor(container, diffContainer) {
  monaco = await loadMonaco();
  setMonacoTheme(settings().theme || 'rider-dark');
  const theme = `kiln-${themeById(settings().theme || 'rider-dark').id}`;
  // The frame remounts when a project is closed and another one opened: replace the old widgets.
  if (editor) editor.dispose();
  if (diffEditor) diffEditor.dispose();
  editor = monaco.editor.create(container, { ...editorOptions(), model: null, theme });
  diffEditor = monaco.editor.createDiffEditor(diffContainer, { ...editorOptions(), readOnly: true, originalEditable: false, renderSideBySide: true, ignoreTrimWhitespace: false, renderOverviewRuler: true, automaticLayout: true, theme });

  // Editor shortcuts (duplicate line, move line, Go to Declaration, ...) are IDE commands bound
  // through the customizable keymap; see main.js and lib/commands.js.

  // Cross-file navigation from Cmd+click / peek views opens our tabs.
  if (monaco.editor.registerEditorOpener && !openerRegistered) {
    openerRegistered = true;
    monaco.editor.registerEditorOpener({
      openCodeEditor(_src, resource, sel) {
        const pos = sel && (sel.startLineNumber ? { line: sel.startLineNumber, col: sel.startColumn } : sel.lineNumber ? { line: sel.lineNumber, col: sel.column } : {});
        openFile(resource.fsPath || resource.path, pos || {});
        return true;
      },
    });
  }

  editor.onDidChangeCursorPosition(
    debounce((e) => {
      const m = editor.getModel();
      if (!m) return;
      const sel = editor.getSelection();
      const text = sel && !sel.isEmpty() ? m.getValueInRange(sel) : '';
      store.update('editor', { cursor: { line: e.position.lineNumber, col: e.position.column }, selection: text, selectionLines: sel && !sel.isEmpty() ? [sel.startLineNumber, sel.endLineNumber] : null });
    }, 60),
  );
  editor.onDidChangeModelContent(() => {
    const m = editor.getModel();
    if (!m) return;
    const path = m.uri.fsPath;
    markDirty(path);
    lspChange(path, m);
    gutterUpdate(path);
  });
  editor.onDidBlurEditorWidget(() => {
    if (settings().editor && settings().editor.autosave) saveAll({ quiet: true });
  });
  // Gutter: a click on a test glyph runs the test; anywhere else in the glyph/decoration margin
  // toggles a breakpoint (handled by the debugger service).
  const T = monaco.editor.MouseTargetType;
  const inGutter = (t) => t.type === T.GUTTER_GLYPH_MARGIN || t.type === T.GUTTER_LINE_DECORATIONS;
  editor.onMouseDown((e) => {
    if (!inGutter(e.target) || !e.event.leftButton) return;
    const line = e.target.position && e.target.position.lineNumber;
    const m = editor.getModel();
    if (!m || !line) return;
    const path = m.uri.fsPath;
    const d = docs.get(path);
    const test = d && d.tests && d.tests.find((t) => t.line === line);
    const el = e.target.element;
    if (test && el && el.classList && el.classList.contains('test-glyph')) emit('runTest', { file: path, test, x: e.event.posx, y: e.event.posy });
    else emit('gutterClick', { file: path, line, alt: e.event.altKey, shift: e.event.shiftKey });
  });
  editor.onContextMenu((e) => {
    if (!inGutter(e.target)) return;
    const line = e.target.position && e.target.position.lineNumber;
    const m = editor.getModel();
    if (m && line) emit('gutterMenu', { file: m.uri.fsPath, line, x: e.event.posx, y: e.event.posy });
  });
  emit('editorCreated', { editor });
  if (!blurHooked) {
    blurHooked = true;
    window.addEventListener('blur', () => {
      if (settings().editor && settings().editor.autosave) saveAll({ quiet: true });
    });
  }
  // Tabs restored before the widget existed (project opened from the Welcome screen).
  const t = activeTab();
  if (t && t.kind === 'file') showModel(t.path);
  return { editor, diffEditor };
}

/** Called when the editor area unmounts (project closed): models stay, widgets go. */
export function detachEditor() {
  if (editor) editor.dispose();
  if (diffEditor) {
    const m = diffEditor.getModel();
    diffEditor.dispose();
    if (m) {
      m.original.dispose();
      m.modified.dispose();
    }
  }
  editor = null;
  diffEditor = null;
}

export function applyEditorSettings() {
  if (!editor) return;
  const opts = editorOptions();
  editor.updateOptions(opts);
  diffEditor.updateOptions({ ...opts, readOnly: true });
}

// ------------------------------------------------------------------ tabs

function tabs() {
  return store.get().editor.tabs;
}

function setTabs(fn) {
  store.update('editor', (e) => ({ ...e, tabs: fn(e.tabs) }));
}

function setActive(id) {
  store.update('editor', { active: id });
}

export function activeTab() {
  const e = store.get().editor;
  return e.tabs.find((t) => t.id === e.active) || null;
}

export function activeFile() {
  const t = activeTab();
  return t && t.kind === 'file' ? t.path : null;
}

function pushNav() {
  if (suppressNav || !editor) return;
  const t = activeTab();
  if (!t || t.kind !== 'file') return;
  const p = editor.getPosition();
  back.push({ path: t.path, line: p ? p.lineNumber : 1, col: p ? p.column : 1 });
  if (back.length > 100) back.shift();
  forward.length = 0;
}

export async function navigateBack() {
  const loc = back.pop();
  if (!loc) return;
  const t = activeTab();
  if (t && t.kind === 'file' && editor) {
    const p = editor.getPosition();
    forward.push({ path: t.path, line: p.lineNumber, col: p.column });
  }
  suppressNav = true;
  await openFile(loc.path, { line: loc.line, col: loc.col });
  suppressNav = false;
}

export async function navigateForward() {
  const loc = forward.pop();
  if (!loc) return;
  suppressNav = true;
  await openFile(loc.path, { line: loc.line, col: loc.col });
  suppressNav = false;
}

async function ensureDoc(path) {
  let d = docs.get(path);
  if (d) return d;
  const ext = extname(path);
  if (IMAGE_EXT.has(ext) && ext !== '.svg') {
    d = { kind: 'image' };
    docs.set(path, d);
    return d;
  }
  const r = await invoke('fs:readFile', path);
  if (r.binary || r.tooLarge) {
    d = { kind: r.binary ? 'binary' : 'large', size: r.size };
    docs.set(path, d);
    return d;
  }
  if (!monaco) monaco = await loadMonaco();
  const uri = monaco.Uri.file(path);
  let model = monaco.editor.getModel(uri);
  if (!model) model = monaco.editor.createModel(r.content, languageOf(path), uri);
  if (r.eol === 'CRLF') model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
  d = { kind: 'text', model, savedAlt: model.getAlternativeVersionId(), bom: r.bom, eol: r.eol, mtime: r.mtime, decorations: {}, headText: undefined };
  docs.set(path, d);
  if (LSP_LANGS.has(model.getLanguageId())) send('lsp:didOpen', path, model.getValue());
  applyMarkers(path);
  loadHead(path);
  scanTests(path);
  emit('opened', { path });
  return d;
}

/** Open (or focus) a file; `preview` reuses the single preview tab like Rider's single-click. */
export async function openFile(path, { line, col, endLine, endCol, preview = false, focus = true, background = false } = {}) {
  if (!path) return null;
  if (!background) pushNav();
  const d = await ensureDoc(path).catch((err) => {
    toast({ kind: 'error', title: `Cannot open ${basename(path)}`, message: err.message });
    return null;
  });
  if (!d) return null;
  if (background) return d;
  const kind = d.kind === 'text' ? 'file' : d.kind === 'image' ? 'image' : 'binary';
  const id = `file:${path}`;
  setTabs((list) => {
    if (list.some((t) => t.id === id)) return list.map((t) => (t.id === id && !preview ? { ...t, preview: false } : t));
    const tab = { id, kind, path, title: basename(path), preview, dirty: false };
    const existingPreview = preview ? list.findIndex((t) => t.preview && !t.dirty) : -1;
    if (existingPreview >= 0) {
      const next = list.slice();
      next[existingPreview] = tab;
      return next;
    }
    const activeIdx = list.findIndex((t) => t.id === store.get().editor.active);
    const next = list.slice();
    next.splice(activeIdx >= 0 ? activeIdx + 1 : next.length, 0, tab);
    return next;
  });
  setActive(id);
  if (kind === 'file') {
    showModel(path);
    if (line) reveal(line, col || 1, endLine, endCol);
    if (focus) setTimeout(() => editor && editor.focus(), 0);
  }
  addRecentFile(path);
  return d;
}

function showModel(path) {
  const d = docs.get(path);
  if (!d || !d.model || !editor) return;
  const cur = editor.getModel();
  if (cur === d.model) return;
  if (cur) {
    const cd = docs.get(cur.uri.fsPath);
    if (cd) cd.viewState = editor.saveViewState();
  }
  editor.setModel(d.model);
  if (d.viewState) editor.restoreViewState(d.viewState);
  applyBlame(path);
  store.update('editor', { language: d.model.getLanguageId(), eol: d.eol || 'LF', encoding: d.bom ? 'UTF-8 BOM' : 'UTF-8' });
}

export function reveal(line, col = 1, endLine, endCol) {
  if (!editor) return;
  const range = new monaco.Range(line, col, endLine || line, endCol || col);
  editor.setSelection(endLine ? range : new monaco.Range(line, col, line, col));
  editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
  const ids = editor.deltaDecorations([], [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'flash-line' } }]);
  setTimeout(() => editor && editor.deltaDecorations(ids, []), 1700);
}

export function activate(id) {
  const t = tabs().find((x) => x.id === id);
  if (!t) return;
  pushNav();
  setActive(id);
  if (t.kind === 'file') {
    showModel(t.path);
    setTimeout(() => editor && editor.focus(), 0);
  }
}

export function pinTab(id) {
  setTabs((list) => list.map((t) => (t.id === id ? { ...t, preview: false } : t)));
}

export async function closeTab(id, { force = false } = {}) {
  const list = tabs();
  const t = list.find((x) => x.id === id);
  if (!t) return;
  if (t.kind === 'file' && t.dirty && !force) {
    if (settings().editor && settings().editor.autosave) await save(t.path, { quiet: true });
    else {
      const ok = await confirm({ title: 'Save changes?', message: `${t.title} has unsaved changes.`, ok: 'Save', cancel: "Don't Save" });
      if (ok) await save(t.path);
    }
  }
  const idx = list.findIndex((x) => x.id === id);
  const next = list.filter((x) => x.id !== id);
  setTabs(() => next);
  if (t.kind === 'file') tabsClosed.push(t.path);
  if (store.get().editor.active === id) {
    const n = next[Math.min(idx, next.length - 1)];
    if (n) activate(n.id);
    else {
      setActive(null);
      if (editor) editor.setModel(null);
    }
  }
  if (t.kind === 'file' && !next.some((x) => x.path === t.path)) disposeDoc(t.path);
}

function disposeDoc(path) {
  const d = docs.get(path);
  if (!d) return;
  emit('closed', { path });
  if (d.model) {
    if (LSP_LANGS.has(d.model.getLanguageId())) send('lsp:didClose', path);
    d.model.dispose();
  }
  docs.delete(path);
}

export async function closeAll({ except } = {}) {
  for (const t of tabs().slice()) if (t.id !== except) await closeTab(t.id);
}

export function reopenClosed() {
  const p = tabsClosed.pop();
  if (p) openFile(p);
}

/** Non-file tabs: diff views, graphs, previews. */
export function openSpecial({ id, kind, title, data }) {
  setTabs((list) => (list.some((t) => t.id === id) ? list.map((t) => (t.id === id ? { ...t, data, title } : t)) : [...list, { id, kind, title, data }]));
  setActive(id);
}

export function openDiff({ title, original, modified, path, labels, id }) {
  const tabId = id || `diff:${path}:${labels ? labels.join('|') : ''}`;
  openSpecial({ id: tabId, kind: 'diff', title: title || `${basename(path)} (diff)`, data: { original, modified, path, labels } });
}

export function showDiffModels(data) {
  if (!diffEditor) return;
  const lang = languageOf(data.path || '');
  const prev = diffEditor.getModel();
  diffEditor.setModel({ original: monaco.editor.createModel(data.original || '', lang), modified: monaco.editor.createModel(data.modified || '', lang) });
  if (prev) {
    prev.original.dispose();
    prev.modified.dispose();
  }
}

// ---------------------------------------------------------------- dirty/save

function markDirty(path) {
  const d = docs.get(path);
  if (!d || !d.model) return;
  const dirty = d.model.getAlternativeVersionId() !== d.savedAlt;
  const t = tabs().find((x) => x.path === path && x.kind === 'file');
  if (t && t.dirty !== dirty) setTabs((list) => list.map((x) => (x.path === path && x.kind === 'file' ? { ...x, dirty, preview: dirty ? false : x.preview } : x)));
}

export function isDirty(path) {
  const d = docs.get(path);
  return !!(d && d.model && d.model.getAlternativeVersionId() !== d.savedAlt);
}

export async function save(path = activeFile(), { quiet = false } = {}) {
  const d = path && docs.get(path);
  if (!d || !d.model) return false;
  if (!isDirty(path)) {
    emit('saved', { path, content: d.model.getValue(), unchanged: true });
    return true;
  }
  const content = d.model.getValue();
  try {
    await invoke('history:snapshotDisk', path, 'Before save');
    d.selfWriteAt = Date.now();
    d.lastWritten = content;
    const r = await invoke('fs:writeFile', path, content, { bom: d.bom });
    d.mtime = r.mtime;
    d.savedAlt = d.model.getAlternativeVersionId();
    markDirty(path);
    if (LSP_LANGS.has(d.model.getLanguageId())) send('lsp:didSave', path);
    emit('saved', { path, content });
    return true;
  } catch (err) {
    if (!quiet) toast({ kind: 'error', title: `Could not save ${basename(path)}`, message: err.message });
    return false;
  }
}

export async function saveAll(opts = {}) {
  for (const p of docs.keys()) if (isDirty(p)) await save(p, opts);
}

export function setContent(path, text) {
  const d = docs.get(path);
  if (!d || !d.model) return;
  d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text }], () => null);
}

/** Apply LSP-style edits ({line,col,endLine,endCol,text}) to a document, opening it if needed. */
export async function applyEdits(path, edits) {
  const d = await ensureDoc(path);
  if (!d || !d.model) return;
  const ops = edits.map((e) => ({ range: new monaco.Range(e.line, e.col, e.endLine, e.endCol), text: e.text }));
  d.model.pushEditOperations([], ops, () => null);
  markDirty(path);
}

export async function applyWorkspaceEdit(files, { saveAfter = true } = {}) {
  const paths = Object.keys(files || {});
  for (const p of paths) await applyEdits(p, files[p]);
  if (saveAfter) for (const p of paths) await save(p, { quiet: true });
  return paths.length;
}

// ------------------------------------------------------------ external edits

/** Called for watcher events: reload clean editors and highlight what changed (agents editing live). */
export async function onFsChanged(paths, { follow = false } = {}) {
  for (const path of paths) {
    const d = docs.get(path);
    if (!d || !d.model) {
      if (follow && !/\/(node_modules|\.git|obj|bin|\.venv|__pycache__)\//.test(path)) {
        const st = await invoke('fs:stat', path).catch(() => null);
        if (st && st.exists && !st.dir) {
          const opened = await openFile(path, { preview: true, focus: false });
          if (opened && opened.model) flashAll(path);
        }
      }
      continue;
    }
    if (d.selfWriteAt && Date.now() - d.selfWriteAt < 1500) continue;
    let r;
    try {
      r = await invoke('fs:readFile', path);
    } catch {
      continue; // deleted
    }
    if (r.binary || r.tooLarge || r.content == null) continue;
    const current = d.model.getValue();
    if (r.content === current || r.content === d.lastWritten) continue;
    if (isDirty(path)) {
      toast({ kind: 'warning', title: `${basename(path)} changed on disk`, message: 'The file was modified outside the editor while you have unsaved changes.', actions: [{ label: 'Load disk version', run: () => replaceFromDisk(path, r.content, current) }, { label: 'Keep mine', run: () => {} }], timeout: 0 });
      continue;
    }
    replaceFromDisk(path, r.content, current);
    if (follow) {
      const t = tabs().find((x) => x.path === path);
      if (!t || store.get().editor.active !== t.id) await openFile(path, { preview: true, focus: false });
    }
  }
}

/** Monaco edit operations that only touch changed lines, so decorations elsewhere keep their place. */
function minimalOperations(model, content) {
  const eol = model.getEOL();
  const n = model.getLineCount();
  const edits = lineEdits(model.getLinesContent(), content.split(/\r\n|\r|\n/));
  if (edits.length > 200) return [{ range: model.getFullModelRange(), text: content }];
  const end = (line) => model.getLineMaxColumn(line);
  return edits.map(({ start, deleteCount, lines }) => {
    const last = start + deleteCount; // first old line after the replaced block
    if (last <= n) return { range: new monaco.Range(start, 1, last, 1), text: lines.map((l) => l + eol).join('') };
    // The block runs to the end of the file: anchor on the end of the previous line.
    if (start > 1) return { range: new monaco.Range(start - 1, end(start - 1), n, end(n)), text: lines.map((l) => eol + l).join('') };
    return { range: model.getFullModelRange(), text: lines.join(eol) };
  });
}

/**
 * Replace a document's text as one undoable step (refactorings): only changed lines are touched and
 * Local History keeps the previous version. Returns false when the file is not open.
 */
export function replaceContent(path, content, label = 'Before refactoring') {
  const d = docs.get(path);
  if (!d || !d.model) return false;
  const previous = d.model.getValue();
  if (previous === content) return true;
  invoke('history:snapshot', path, previous, label).catch(() => {});
  d.model.pushStackElement();
  d.model.pushEditOperations([], minimalOperations(d.model, content), () => null);
  d.model.pushStackElement();
  markDirty(path);
  return true;
}

/** Select a range given as UTF-16 offsets into the document (after a refactoring). */
export function selectOffsets(path, start, end) {
  const d = docs.get(path);
  if (!d || !d.model || !editor || editor.getModel() !== d.model) return;
  const a = d.model.getPositionAt(start);
  const b = d.model.getPositionAt(end);
  reveal(a.lineNumber, a.column, b.lineNumber, b.column);
}

function replaceFromDisk(path, content, previous) {
  const d = docs.get(path);
  if (!d || !d.model) return;
  invoke('history:snapshot', path, previous, 'Before external change').catch(() => {});
  d.model.pushEditOperations([], minimalOperations(d.model, content), () => null);
  d.savedAlt = d.model.getAlternativeVersionId();
  markDirty(path);
  highlightChanges(path, previous, content);
  emit('reloaded', { path });
}

function highlightChanges(path, before, after) {
  const d = docs.get(path);
  if (!d || !d.model) return;
  const regions = changedRegions(before, after).filter((r) => r.type !== 'deleted');
  if (!regions.length) return;
  const decs = regions.map((r) => ({ range: new monaco.Range(r.start, 1, r.end, 1), options: { isWholeLine: true, className: 'ai-change-line', linesDecorationsClassName: 'ai-change-glyph', overviewRuler: { color: '#5FB865', position: monaco.editor.OverviewRulerLane.Left } } }));
  d.decorations.ai = d.model.deltaDecorations(d.decorations.ai || [], decs);
  if (editor && editor.getModel() === d.model) editor.revealLineInCenterIfOutsideViewport(regions[0].start, monaco.editor.ScrollType.Smooth);
  clearTimeout(d.aiTimer);
  d.aiTimer = setTimeout(() => {
    if (d.model && !d.model.isDisposed()) d.decorations.ai = d.model.deltaDecorations(d.decorations.ai || [], []);
  }, 8000);
}

function flashAll(path) {
  const d = docs.get(path);
  if (!d || !d.model) return;
  highlightChanges(path, '', d.model.getValue());
}

// --------------------------------------------------------------- markers

const SEV = () => ({ error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info, hint: monaco.MarkerSeverity.Hint });

export function applyMarkers(path) {
  const d = docs.get(path);
  if (!d || !d.model || !monaco) return;
  const p = store.get().problems;
  const sev = SEV();
  const toMarker = (x) => ({
    severity: sev[x.severity] || sev.info,
    message: x.message,
    code: x.code || undefined,
    source: x.source,
    startLineNumber: x.line || 1,
    startColumn: x.col || 1,
    endLineNumber: x.endLine || x.line || 1,
    endColumn: x.endCol && (x.endLine || x.line) ? x.endCol : x.col ? Math.max(x.col + 1, (d.model.getLineMaxColumn(Math.min(x.line || 1, d.model.getLineCount())) || 2)) : 1000,
    tags: x.tags && x.tags.includes(1) ? [monaco.MarkerTag.Unnecessary] : x.code === 'UnusedImport' || x.code === 'UnusedVariable' ? [monaco.MarkerTag.Unnecessary] : undefined,
  });
  const live = p.live[path];
  const liveSources = new Set((live || []).map((x) => x.source));
  // Live checks of a saved file replace build results from the same tool.
  const build = p.build.filter((x) => x.file === path && !(live && (liveSources.has(x.source) || (x.source === 'imports' && liveSources.has('python')))));
  monaco.editor.setModelMarkers(d.model, 'kiln-build', build.map(toMarker));
  monaco.editor.setModelMarkers(d.model, 'kiln-live', (live || []).map(toMarker));
}

export function applyAllMarkers() {
  for (const p of docs.keys()) applyMarkers(p);
}

// ------------------------------------------------------------ git gutter

async function loadHead(path) {
  const d = docs.get(path);
  if (!d || !d.model) return;
  try {
    d.headText = store.get().project && store.get().project.git && store.get().project.git.isRepo ? await invoke('git:headContent', path) : null;
  } catch {
    d.headText = null;
  }
  gutterUpdateNow(path);
}

export function refreshHeads() {
  for (const p of docs.keys()) loadHead(p);
}

const gutterTimers = new Map();
function gutterUpdate(path) {
  clearTimeout(gutterTimers.get(path));
  gutterTimers.set(path, setTimeout(() => gutterUpdateNow(path), 250));
}

function gutterUpdateNow(path) {
  const d = docs.get(path);
  if (!d || !d.model || d.model.isDisposed()) return;
  const isRepo = store.get().project && store.get().project.git && store.get().project.git.isRepo;
  let regions = [];
  if (isRepo) regions = d.headText == null ? [{ type: 'added', start: 1, end: d.model.getLineCount() }] : changedRegions(d.headText, d.model.getValue());
  const decs = regions.map((r) => ({ range: new monaco.Range(r.start, 1, r.end, 1), options: { isWholeLine: true, linesDecorationsClassName: `git-gutter-${r.type}`, overviewRuler: { color: r.type === 'added' ? '#73BD79' : r.type === 'modified' ? '#6C9FE8' : '#D9706B', position: monaco.editor.OverviewRulerLane.Left } } }));
  d.decorations.git = d.model.deltaDecorations(d.decorations.git || [], decs);
}

// ------------------------------------------------------------------- blame

let blameOn = false;
export async function toggleBlame() {
  blameOn = !blameOn;
  const path = activeFile();
  if (path) await applyBlame(path);
  return blameOn;
}

async function applyBlame(path) {
  if (!editor) return;
  if (!blameOn) {
    editor.updateOptions({ lineNumbers: 'on', lineNumbersMinChars: 5 });
    return;
  }
  const d = docs.get(path);
  if (!d || !d.model) return;
  if (!d.blame) {
    const r = await invoke('git:blame', path, isDirty(path) ? d.model.getValue() : null).catch(() => null);
    d.blame = r;
  }
  const r = d.blame;
  if (!r || !r.lines) return;
  const byLine = new Map(r.lines.map((l) => [l.line, r.commits[l.sha]]));
  const fmt = (n) => {
    const c = byLine.get(n);
    if (!c) return `${''.padEnd(22)} ${n}`;
    const who = c.sha.startsWith('0000000') ? 'Not committed' : (c.author || '').split(' ')[0];
    const when = c.time ? new Date(c.time).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : '';
    return `${(who.slice(0, 12) + ' ' + when).padEnd(22)} ${n}`;
  };
  editor.updateOptions({ lineNumbers: fmt, lineNumbersMinChars: 28 });
}

export function invalidateBlame(path) {
  const d = docs.get(path);
  if (d) d.blame = null;
}

// --------------------------------------------------------------- bookmarks

export function toggleBookmark() {
  const path = activeFile();
  if (!path || !editor) return;
  const line = editor.getPosition().lineNumber;
  const p = store.get().project;
  if (!p) return;
  const bm = { ...(p.state && p.state.bookmarks) };
  const list = new Set(bm[path] || []);
  if (list.has(line)) list.delete(line);
  else list.add(line);
  bm[path] = [...list].sort((a, b) => a - b);
  store.update('project', { state: { ...(p.state || {}), bookmarks: bm } });
  invoke('app:setProjectState', { bookmarks: bm }).catch(() => {});
  renderBookmarks(path);
}

export function renderBookmarks(path) {
  const d = docs.get(path);
  if (!d || !d.model) return;
  const p = store.get().project;
  const lines = (p && p.state && p.state.bookmarks && p.state.bookmarks[path]) || [];
  d.decorations.bm = d.model.deltaDecorations(d.decorations.bm || [], lines.map((l) => ({ range: new monaco.Range(l, 1, l, 1), options: { glyphMarginClassName: 'bookmark-glyph', glyphMarginHoverMessage: { value: 'Bookmark' }, glyphMargin: lane('Right') } })));
}

/** Glyph margin lane option (Monaco >= 0.45); breakpoints and the execution pointer use the left lane. */
export function lane(name) {
  const L = monaco && monaco.editor.GlyphMarginLane;
  return L ? { position: L[name] } : undefined;
}

// ------------------------------------------------------------ test glyphs

// JavaScript / TypeScript test files (the main process finds test() / it() inside describe()).
const JS_TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)(?:test|tests|__tests__)\/.+\.[cm]?[jt]sx?)$/;
let testStatusOf = () => null;

/** The tests service tells the editor each test's last result ('passed' | 'failed' | null). */
export function setTestStatusProvider(fn) {
  testStatusOf = fn;
}

export const testsIn = (path) => {
  const d = docs.get(path);
  return (d && d.tests) || [];
};

async function scanTests(path) {
  const d = docs.get(path);
  if (!d || !d.model) return;
  const lang = d.model.getLanguageId();
  const lines = d.model.getLinesContent();
  let tests = [];
  if (lang === 'csharp') {
    let cls = '';
    let ns = '';
    let attr = false;
    lines.forEach((l, i) => {
      const n = /^\s*namespace\s+([\w.]+)/.exec(l);
      if (n) ns = n[1];
      const c = /\bclass\s+(\w+)/.exec(l);
      if (c) cls = c[1];
      if (/\[(Fact|Theory|Test|TestMethod|TestCase|DataTestMethod)\b/.test(l)) attr = true;
      const m = /\b(?:public|internal)\s+(?:async\s+)?(?:Task|void|ValueTask)\s+(\w+)\s*\(/.exec(l);
      if (m && attr) {
        tests.push({ line: i + 1, name: m[1], fqn: [ns, cls, m[1]].filter(Boolean).join('.'), kind: 'dotnet' });
        attr = false;
      }
    });
  } else if (lang === 'python' && /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(path)) {
    let cls = null;
    lines.forEach((l, i) => {
      const c = /^class\s+(Test\w*)/.exec(l);
      if (c) cls = c[1];
      else if (/^\S/.test(l) && !/^class/.test(l)) cls = null;
      const m = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(l);
      if (m) tests.push({ line: i + 1, name: m[2], cls: m[1] ? cls : null, kind: 'python' });
    });
  } else if (/^(javascript|typescript)$/.test(lang) && JS_TEST_FILE.test(relPath(path))) {
    const version = d.model.getVersionId();
    const found = await invoke('tests:scan', path, d.model.getValue()).catch(() => []);
    if (d.model.isDisposed() || d.model.getVersionId() !== version) return;
    tests = found.map((t) => ({ line: t.line, name: t.name, title: t.title, kind: 'node' }));
  }
  d.tests = tests;
  renderTestGlyphs(path);
}

export function renderTestGlyphs(path) {
  const d = docs.get(path);
  if (!d || !d.model || d.model.isDisposed() || !d.tests) return;
  d.decorations.tests = d.model.deltaDecorations(
    d.decorations.tests || [],
    d.tests.map((t) => {
      const status = testStatusOf(path, t);
      return { range: new monaco.Range(t.line, 1, t.line, 1), options: { glyphMarginClassName: `test-glyph${status ? ` ${status}` : ''}`, glyphMarginHoverMessage: { value: `Run / Debug ${t.title || t.name}${status ? ` (last run: ${status})` : ''}` }, glyphMargin: lane('Right') } };
    }),
  );
}

export function rescanTests(path) {
  scanTests(path);
}

// --------------------------------------------------------------- coverage

/** Covered / uncovered line marks from the last run with coverage ({ covered, uncovered } or null). */
export function setCoverage(path, cov) {
  const d = docs.get(path);
  if (!d || !d.model || d.model.isDisposed()) return;
  const n = d.model.getLineCount();
  const mark = (line, hit) => ({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: hit ? 'cov-hit-line' : 'cov-miss-line', linesDecorationsClassName: hit ? 'cov-hit' : 'cov-miss', overviewRuler: { color: hit ? '#5FB86555' : '#D9706B99', position: monaco.editor.OverviewRulerLane.Right } } });
  const decs = cov ? [...cov.covered.filter((l) => l <= n).map((l) => mark(l, true)), ...cov.uncovered.filter((l) => l <= n).map((l) => mark(l, false))] : [];
  d.decorations.cov = d.model.deltaDecorations(d.decorations.cov || [], decs);
}

// --------------------------------------------------------------- LSP sync

const lspTimers = new Map();
function lspChange(path, model) {
  if (!LSP_LANGS.has(model.getLanguageId())) return;
  clearTimeout(lspTimers.get(path));
  lspTimers.set(path, setTimeout(() => !model.isDisposed() && send('lsp:didChange', path, model.getValue()), 150));
}

// -------------------------------------------------------------- recents

function addRecentFile(path) {
  const p = store.get().project;
  if (!p) return;
  const list = [path, ...((p.recentFiles || []).filter((x) => x !== path))].slice(0, 40);
  store.update('project', { recentFiles: list });
}

export function resetEditor() {
  for (const p of [...docs.keys()]) disposeDoc(p);
  store.update('editor', { tabs: [], active: null, cursor: null, selection: '' });
  if (editor) editor.setModel(null);
  back.length = 0;
  forward.length = 0;
}

export function relPath(p) {
  const root = store.get().project && store.get().project.root;
  return relative(root, p);
}
