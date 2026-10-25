// Editor engine: Monaco models and tabs in one or more editor groups (splits), saving (with Local
// History), live reload of files changed by agents (with change highlighting), Problems markers, git
// gutter, blame, bookmarks and navigation.
//
// Every group (split) has its own Monaco editor and diff editor; models are shared, so an edit, a
// marker or a breakpoint shows in every split that has the file open. The store keeps all tabs in
// editor.tabs (each with its group) and editor.active = the active tab of the focused group.
import { store } from '../lib/store.js';
import { invoke, send } from '../lib/ipc.js';
import { loadMonaco, setMonacoTheme } from '../lib/monaco.js';
import { themeById } from '../lib/themes.js';
import { basename, languageOf, extname, IMAGE_EXT, debounce, relative, uid } from '../lib/util.js';
import { changedRegions, lineEdits } from '../lib/diff.js';
import { leaf, layoutGroups as groupsInLayout, splitLayout, removeFromLayout, resizeLayout, neighborGroup, validLayout } from '../lib/editor-layout.js';
import { toast, confirm } from '../lib/ui.js';

let monaco = null;
let editor = null; // the focused group's editor
const widgets = new Map(); // group id -> { editor, diffEditor, viewStates: Map(path -> view state) }
// Kept while a group's widgets are recreated (its place in the split layout changed).
const groupViewStates = new Map();
const docs = new Map(); // path -> { model, savedAlt, bom, headText, decorations: {} }
const tabsClosed = [];
const back = [];
const forward = [];
let suppressNav = false;
const listeners = new Set();
const LSP_LANGS = new Set(['python', 'csharp']);
export const MAIN_GROUP = 'g1';

export const onEditorEvent = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = (type, data) => listeners.forEach((fn) => fn(type, data));

export const getMonaco = () => monaco;
export const getEditor = () => editor;
export const getDiffEditor = () => (widgets.get(activeGroup()) || {}).diffEditor || null;
export const getDoc = (p) => docs.get(p);
export const openDocs = () => [...docs.keys()];
export const allEditors = () => [...widgets.values()].map((w) => w.editor);

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
    inlineSuggest: { enabled: (settings().ai || {}).inlineCompletion !== false, mode: 'prefix' },
    quickSuggestions: { other: true, comments: false, strings: false },
    occurrencesHighlight: 'singleFile',
    links: true,
    mouseWheelZoom: true,
  };
}

let globalsReady = false;

/** One-time Monaco set-up: cross-file navigation opens our tabs; autosave when the window blurs. */
function initGlobals() {
  if (globalsReady) return;
  globalsReady = true;
  if (monaco.editor.registerEditorOpener) {
    monaco.editor.registerEditorOpener({
      openCodeEditor(_src, resource, sel) {
        const pos = sel && (sel.startLineNumber ? { line: sel.startLineNumber, col: sel.startColumn } : sel.lineNumber ? { line: sel.lineNumber, col: sel.column } : {});
        openFile(resource.fsPath || resource.path, pos || {});
        return true;
      },
    });
  }
  window.addEventListener('blur', () => {
    if (settings().editor && settings().editor.autosave) saveAll({ quiet: true });
  });
}

/** Create the editor widgets of a group (an EditorGroup component mounted). */
export async function attachGroup(gid, container, diffContainer) {
  monaco = await loadMonaco();
  setMonacoTheme(settings().theme || 'rider-dark');
  initGlobals();
  const theme = `kiln-${themeById(settings().theme || 'rider-dark').id}`;
  detachGroup(gid);
  const e = monaco.editor.create(container, { ...editorOptions(), model: null, theme });
  const diffEditor = monaco.editor.createDiffEditor(diffContainer, { ...editorOptions(), readOnly: true, originalEditable: false, renderSideBySide: true, ignoreTrimWhitespace: false, renderOverviewRuler: true, automaticLayout: true, theme });
  if (!groupViewStates.has(gid)) groupViewStates.set(gid, new Map());
  const w = { editor: e, diffEditor, viewStates: groupViewStates.get(gid) };
  widgets.set(gid, w);
  if (gid === activeGroup() || !editor) editor = e;

  // Editor shortcuts (duplicate line, move line, Go to Declaration, ...) are IDE commands bound
  // through the customizable keymap; see main.js and lib/commands.js.
  const focusGroup = () => {
    if (activeGroup() !== gid) setActiveGroup(gid);
  };
  e.onDidFocusEditorWidget(focusGroup);
  e.onDidChangeCursorPosition(
    debounce((ev) => {
      const m = e.getModel();
      if (!m || editor !== e) return;
      const sel = e.getSelection();
      const text = sel && !sel.isEmpty() ? m.getValueInRange(sel) : '';
      store.update('editor', { cursor: { line: ev.position.lineNumber, col: ev.position.column }, selection: text, selectionLines: sel && !sel.isEmpty() ? [sel.startLineNumber, sel.endLineNumber] : null });
    }, 60),
  );
  e.onDidBlurEditorWidget(() => {
    if (settings().editor && settings().editor.autosave) saveAll({ quiet: true });
  });
  // Gutter: a click on a test glyph runs the test; anywhere else in the glyph/decoration margin
  // toggles a breakpoint (handled by the debugger service).
  const T = monaco.editor.MouseTargetType;
  const inGutter = (t) => t.type === T.GUTTER_GLYPH_MARGIN || t.type === T.GUTTER_LINE_DECORATIONS;
  e.onMouseDown((ev) => {
    if (!inGutter(ev.target) || !ev.event.leftButton) return;
    const line = ev.target.position && ev.target.position.lineNumber;
    const m = e.getModel();
    if (!m || !line) return;
    const path = m.uri.fsPath;
    const d = docs.get(path);
    const test = d && d.tests && d.tests.find((t) => t.line === line);
    const el = ev.target.element;
    if (test && el && el.classList && el.classList.contains('test-glyph')) emit('runTest', { file: path, test, x: ev.event.posx, y: ev.event.posy });
    else emit('gutterClick', { file: path, line, alt: ev.event.altKey, shift: ev.event.shiftKey });
  });
  e.onContextMenu((ev) => {
    if (!inGutter(ev.target)) return;
    const line = ev.target.position && ev.target.position.lineNumber;
    const m = e.getModel();
    if (m && line) emit('gutterMenu', { file: m.uri.fsPath, line, x: ev.event.posx, y: ev.event.posy });
  });
  emit('editorCreated', { editor: e, group: gid });
  // Tabs restored before the widget existed (project opened from the Welcome screen, a new split).
  const t = groupActiveTab(gid);
  if (t && t.kind === 'file') showModel(t.path, gid);
  if (blameOn) applyBlameTo(e);
  return { editor: e, diffEditor };
}

/** An EditorGroup unmounted (split closed, project closed): its widgets go, models stay. */
export function detachGroup(gid) {
  const w = widgets.get(gid);
  if (!w) return;
  widgets.delete(gid);
  const cur = w.editor.getModel();
  if (cur) w.viewStates.set(cur.uri.fsPath, w.editor.saveViewState());
  w.editor.dispose();
  const m = w.diffEditor.getModel();
  w.diffEditor.dispose();
  if (m) {
    m.original.dispose();
    m.modified.dispose();
  }
  if (editor === w.editor) editor = widgets.has(activeGroup()) ? widgets.get(activeGroup()).editor : [...widgets.values()].map((x) => x.editor)[0] || null;
}

export function applyEditorSettings() {
  const opts = editorOptions();
  for (const w of widgets.values()) {
    w.editor.updateOptions(opts);
    w.diffEditor.updateOptions({ ...opts, readOnly: true });
  }
}

// ------------------------------------------------------------------ tabs

function tabs() {
  return store.get().editor.tabs;
}

function setTabs(fn) {
  store.update('editor', (e) => ({ ...e, tabs: fn(e.tabs) }));
}

export const groups = () => store.get().editor.groups || [{ id: MAIN_GROUP, active: null }];
export const activeGroup = () => store.get().editor.activeGroup || MAIN_GROUP;
const groupOf = (t) => t.group || MAIN_GROUP;
export const groupTabs = (gid) => tabs().filter((t) => groupOf(t) === gid);

function groupActiveTab(gid) {
  const g = groups().find((x) => x.id === gid);
  return g && g.active ? tabs().find((t) => t.id === g.active) || null : null;
}

/** Tab ids are unique across groups: the main group keeps `file:<path>`, other splits add `@<group>`. */
const fileTabId = (path, gid) => (gid === MAIN_GROUP ? `file:${path}` : `file:${path}@${gid}`);

/** Make `id` the active tab of its group, and that group the focused one. */
function setActive(id) {
  const t = id ? tabs().find((x) => x.id === id) : null;
  const gid = t ? groupOf(t) : activeGroup();
  store.update('editor', (e) => ({ ...e, active: id, activeGroup: gid, groups: (e.groups || groups()).map((g) => (g.id === gid ? { ...g, active: id } : g)) }));
  const w = widgets.get(gid);
  if (w) editor = w.editor;
}

function setGroupActive(gid, id) {
  store.update('editor', (e) => ({ ...e, active: gid === (e.activeGroup || MAIN_GROUP) ? id : e.active, groups: (e.groups || groups()).map((g) => (g.id === gid ? { ...g, active: id } : g)) }));
}

/** Focus a group (click in its editor or tab bar): its active tab becomes editor.active. */
export function setActiveGroup(gid) {
  const g = groups().find((x) => x.id === gid);
  if (!g) return;
  store.update('editor', { activeGroup: gid, active: g.active });
  const w = widgets.get(gid);
  if (w) editor = w.editor;
  const t = groupActiveTab(gid);
  if (t && t.kind === 'file') {
    const d = docs.get(t.path);
    if (d && d.model) store.update('editor', { language: d.model.getLanguageId(), eol: d.eol || 'LF', encoding: d.bom ? 'UTF-8 BOM' : 'UTF-8' });
  }
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
  // Model events, not editor events: a file open in two splits changes once.
  model.onDidChangeContent(() => {
    markDirty(path);
    lspChange(path, model);
    gutterUpdate(path);
  });
  if (LSP_LANGS.has(model.getLanguageId())) send('lsp:didOpen', path, model.getValue());
  applyMarkers(path);
  loadHead(path);
  scanTests(path);
  emit('opened', { path });
  return d;
}

/**
 * Open (or focus) a file in the focused group (or `group`); `preview` reuses the group's single
 * preview tab like Rider's single-click.
 */
export async function openFile(path, { line, col, endLine, endCol, preview = false, focus = true, background = false, group } = {}) {
  if (!path) return null;
  if (!background) pushNav();
  const d = await ensureDoc(path).catch((err) => {
    toast({ kind: 'error', title: `Cannot open ${basename(path)}`, message: err.message });
    return null;
  });
  if (!d) return null;
  if (background) return d;
  const kind = d.kind === 'text' ? 'file' : d.kind === 'image' ? 'image' : 'binary';
  const gid = group && groups().some((g) => g.id === group) ? group : activeGroup();
  const id = fileTabId(path, gid);
  setTabs((list) => {
    if (list.some((t) => t.id === id)) return list.map((t) => (t.id === id && !preview ? { ...t, preview: false } : t));
    const tab = { id, kind, path, title: basename(path), preview, dirty: isDirty(path), group: gid };
    const existingPreview = preview ? list.findIndex((t) => t.preview && !t.dirty && groupOf(t) === gid) : -1;
    if (existingPreview >= 0) {
      const next = list.slice();
      next[existingPreview] = tab;
      return next;
    }
    const g = groups().find((x) => x.id === gid);
    const activeIdx = list.findIndex((t) => g && t.id === g.active);
    const next = list.slice();
    next.splice(activeIdx >= 0 ? activeIdx + 1 : next.length, 0, tab);
    return next;
  });
  setActive(id);
  if (kind === 'file') {
    showModel(path, gid);
    if (line) reveal(line, col || 1, endLine, endCol);
    if (focus) setTimeout(() => editor && editor.focus(), 0);
  }
  addRecentFile(path);
  return d;
}

function showModel(path, gid = activeGroup()) {
  const d = docs.get(path);
  const w = widgets.get(gid);
  if (!d || !d.model || !w) return;
  const e = w.editor;
  const cur = e.getModel();
  if (cur !== d.model) {
    if (cur) w.viewStates.set(cur.uri.fsPath, e.saveViewState());
    e.setModel(d.model);
    const vs = w.viewStates.get(path);
    if (vs) e.restoreViewState(vs);
    if (blameOn) applyBlameTo(e);
  }
  if (gid === activeGroup()) store.update('editor', { language: d.model.getLanguageId(), eol: d.eol || 'LF', encoding: d.bom ? 'UTF-8 BOM' : 'UTF-8' });
}

export function reveal(line, col = 1, endLine, endCol) {
  if (!editor) return;
  const range = new monaco.Range(line, col, endLine || line, endCol || col);
  editor.setSelection(endLine ? range : new monaco.Range(line, col, line, col));
  editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
  const e = editor;
  const ids = e.deltaDecorations([], [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'flash-line' } }]);
  setTimeout(() => !e.getModel() || e.deltaDecorations(ids, []), 1700);
}

export function activate(id) {
  const t = tabs().find((x) => x.id === id);
  if (!t) return;
  pushNav();
  setActive(id);
  if (t.kind === 'file') {
    showModel(t.path, groupOf(t));
    setTimeout(() => editor && editor.focus(), 0);
  }
}

/** Keep a preview tab open (double-click on the tab). */
export function pinTab(id) {
  setTabs((list) => list.map((t) => (t.id === id ? { ...t, preview: false } : t)));
}

/** Pinned tabs stay at the front of their group and are kept by Close Others / Close All. */
export function togglePinned(id, pinned) {
  setTabs((list) => {
    const t = list.find((x) => x.id === id);
    if (!t) return list;
    const next = { ...t, pinned: pinned == null ? !t.pinned : !!pinned, preview: false };
    const rest = list.filter((x) => x.id !== id);
    const same = rest.filter((x) => groupOf(x) === groupOf(t));
    // Pinned: after the last pinned tab of the group. Unpinned: right after the pinned ones.
    const lastPinned = [...same].reverse().find((x) => x.pinned);
    const firstOfGroup = same[0];
    let at = lastPinned ? rest.indexOf(lastPinned) + 1 : firstOfGroup ? rest.indexOf(firstOfGroup) : rest.length;
    if (!next.pinned && !lastPinned && firstOfGroup) at = rest.indexOf(firstOfGroup);
    rest.splice(at, 0, next);
    return rest;
  });
}

export async function closeTab(id, { force = false } = {}) {
  const list = tabs();
  const t = list.find((x) => x.id === id);
  if (!t) return;
  if (t.kind === 'file' && t.dirty && !force && !list.some((x) => x.id !== id && x.path === t.path)) {
    if (settings().editor && settings().editor.autosave) await save(t.path, { quiet: true });
    else {
      const ok = await confirm({ title: 'Save changes?', message: `${t.title} has unsaved changes.`, ok: 'Save', cancel: "Don't Save" });
      if (ok) await save(t.path);
    }
  }
  const gid = groupOf(t);
  const inGroup = groupTabs(gid);
  const idx = inGroup.findIndex((x) => x.id === id);
  const next = list.filter((x) => x.id !== id);
  setTabs(() => next);
  if (t.kind === 'file') tabsClosed.push(t.path);
  const leftInGroup = inGroup.filter((x) => x.id !== id);
  const g = groups().find((x) => x.id === gid);
  if (g && g.active === id) {
    const n = leftInGroup[Math.min(idx, leftInGroup.length - 1)];
    if (n) {
      if (gid === activeGroup()) activate(n.id);
      else {
        setGroupActive(gid, n.id);
        if (n.kind === 'file') showModel(n.path, gid);
      }
    } else {
      setGroupActive(gid, null);
      const w = widgets.get(gid);
      if (w) w.editor.setModel(null);
    }
  }
  // The last tab of a split closes the split.
  if (!leftInGroup.length && groups().length > 1) closeGroup(gid);
  if (t.kind === 'file' && !next.some((x) => x.path === t.path)) disposeDoc(t.path);
}

function disposeDoc(path) {
  const d = docs.get(path);
  if (!d) return;
  emit('closed', { path });
  for (const w of widgets.values()) w.viewStates.delete(path);
  if (d.model) {
    if (LSP_LANGS.has(d.model.getLanguageId())) send('lsp:didClose', path);
    d.model.dispose();
  }
  docs.delete(path);
}

/** Close the tabs of a group (or all groups); pinned tabs stay unless `pinned`. */
export async function closeAll({ except, group, pinned = false } = {}) {
  for (const t of tabs().slice()) {
    if (t.id === except || (group && groupOf(t) !== group) || (t.pinned && !pinned)) continue;
    await closeTab(t.id);
  }
}

export function reopenClosed() {
  const p = tabsClosed.pop();
  if (p) openFile(p);
}

/** Non-file tabs: diff views, graphs, previews (opened in the focused group unless already open). */
export function openSpecial({ id, kind, title, data }) {
  const gid = activeGroup();
  setTabs((list) => (list.some((t) => t.id === id) ? list.map((t) => (t.id === id ? { ...t, data, title } : t)) : [...list, { id, kind, title, data, group: gid }]));
  setActive(id);
}

export function openDiff({ title, original, modified, path, labels, id }) {
  const tabId = id || `diff:${path}:${labels ? labels.join('|') : ''}`;
  openSpecial({ id: tabId, kind: 'diff', title: title || `${basename(path)} (diff)`, data: { original, modified, path, labels } });
}

export function showDiffModels(data, gid = activeGroup()) {
  const w = widgets.get(gid);
  if (!w) return;
  const lang = languageOf(data.path || '');
  const prev = w.diffEditor.getModel();
  w.diffEditor.setModel({ original: monaco.editor.createModel(data.original || '', lang), modified: monaco.editor.createModel(data.modified || '', lang) });
  if (prev) {
    prev.original.dispose();
    prev.modified.dispose();
  }
}

// ------------------------------------------------------------- splits

export const editorLayout = () => store.get().editor.layout || leaf(MAIN_GROUP);

/**
 * Split a group to the right ('row') or down ('column'): a new group opens next to it with the same
 * tab. Returns the new group's id.
 */
export async function splitGroup(dir = 'row', { tabId, move = false } = {}) {
  const from = tabId ? groupOf(tabs().find((t) => t.id === tabId) || {}) : activeGroup();
  const t = tabId ? tabs().find((x) => x.id === tabId) : groupActiveTab(from);
  const gid = uid('g');
  store.update('editor', (e) => ({ ...e, layout: splitLayout(e.layout || leaf(MAIN_GROUP), from, gid, dir), groups: [...(e.groups || groups()), { id: gid, active: null }] }));
  if (t) await placeTab(t, gid, { move });
  else setActiveGroup(gid);
  return gid;
}

/** Copy (or move) a tab into another group. */
async function placeTab(t, gid, { move = false, index } = {}) {
  if (t.kind === 'file' || t.kind === 'image' || t.kind === 'binary') {
    const existing = tabs().find((x) => x.path === t.path && groupOf(x) === gid && x.kind === t.kind);
    if (!existing) {
      const id = t.kind === 'file' ? fileTabId(t.path, gid) : `${t.kind}:${t.path}@${gid}`;
      setTabs((list) => {
        const next = list.slice();
        const tab = { ...t, id, group: gid };
        const inTarget = next.filter((x) => groupOf(x) === gid);
        const at = index != null && inTarget[index] ? next.indexOf(inTarget[index]) : inTarget.length ? next.indexOf(inTarget[inTarget.length - 1]) + 1 : next.length;
        next.splice(at, 0, tab);
        return next;
      });
      setActive(id);
      if (t.kind === 'file') {
        showModel(t.path, gid);
        const src = widgets.get(groupOf(t));
        const dst = widgets.get(gid);
        if (src && dst && src.editor.getModel() === docs.get(t.path).model) dst.editor.restoreViewState(src.editor.saveViewState());
      }
    } else activate(existing.id);
    if (move) await closeTab(t.id, { force: true });
  } else if (move) {
    // Special tabs (diff, graph, merge, ...) exist once: move them.
    setTabs((list) => list.map((x) => (x.id === t.id ? { ...x, group: gid } : x)));
    const from = groupOf(t);
    const left = groupTabs(from);
    const g = groups().find((x) => x.id === from);
    if (g && g.active === t.id) setGroupActive(from, left[0] ? left[0].id : null);
    setActive(t.id);
    if (!left.length && groups().length > 1) closeGroup(from);
  } else activate(t.id);
}

/** Move a tab to another group (drag and drop, Move to Opposite Group). */
export async function moveTab(id, gid, { index } = {}) {
  const t = tabs().find((x) => x.id === id);
  if (!t) return;
  if (groupOf(t) === gid) {
    if (index == null) return activate(id);
    setTabs((list) => {
      const rest = list.filter((x) => x.id !== id);
      const inGroup = rest.filter((x) => groupOf(x) === gid);
      const at = inGroup[index] ? rest.indexOf(inGroup[index]) : inGroup.length ? rest.indexOf(inGroup[inGroup.length - 1]) + 1 : rest.length;
      rest.splice(at, 0, t);
      return rest;
    });
    return activate(id);
  }
  return placeTab(t, gid, { move: true, index });
}

/** The group after this one (or before it, for the last one). */
export function otherGroup(gid = activeGroup()) {
  return neighborGroup(editorLayout(), gid);
}

/** Group ids in layout order (left to right, top to bottom). */
export const layoutGroups = () => groupsInLayout(editorLayout());

export async function moveToOppositeGroup(id = store.get().editor.active) {
  const t = tabs().find((x) => x.id === id);
  if (!t) return;
  const target = otherGroup(groupOf(t));
  if (target) return moveTab(id, target);
  return splitGroup('row', { tabId: id, move: true });
}

export function focusNextGroup() {
  const target = otherGroup();
  if (!target) return;
  setActiveGroup(target);
  const w = widgets.get(target);
  const t = groupActiveTab(target);
  if (w && t && t.kind === 'file') setTimeout(() => w.editor.focus(), 0);
}

/** Close a split: its tabs are dropped (their documents stay open where other splits show them). */
export function closeGroup(gid) {
  if (groups().length < 2) return;
  const dropped = groupTabs(gid);
  store.update('editor', (e) => {
    const gs = (e.groups || []).filter((g) => g.id !== gid);
    const layout = removeFromLayout(e.layout || leaf(MAIN_GROUP), gid) || leaf(gs[0].id);
    const nextActive = e.activeGroup === gid ? groupsInLayout(layout)[0] : e.activeGroup;
    const g = gs.find((x) => x.id === nextActive);
    return { ...e, tabs: e.tabs.filter((t) => groupOf(t) !== gid), groups: gs, layout, activeGroup: nextActive, active: g ? g.active : null };
  });
  groupViewStates.delete(gid);
  for (const t of dropped) if (t.kind === 'file' && !tabs().some((x) => x.path === t.path)) disposeDoc(t.path);
  const w = widgets.get(activeGroup());
  if (w) editor = w.editor;
}

/** Unsplit: every tab goes back into the focused group. */
export async function unsplitAll() {
  const keep = activeGroup();
  for (const gid of layoutGroups()) {
    if (gid === keep) continue;
    for (const t of groupTabs(gid)) await moveTab(t.id, keep);
  }
}

/** Resize the split at `path` (child indexes from the root). */
export function setSplitSizes(path, sizes) {
  store.update('editor', (e) => ({ ...e, layout: resizeLayout(e.layout || leaf(MAIN_GROUP), path, sizes) }));
}

/** Restore splits saved with the project: { layout, groups: [{ id, tabs: [{ path, pinned }], active }] }. */
export async function restoreGroups(saved) {
  if (!saved || !saved.layout || !Array.isArray(saved.groups) || !saved.groups.length) return false;
  const ids = saved.groups.map((g) => g.id);
  if (!ids.includes(MAIN_GROUP) || !validLayout(saved.layout, ids)) return false;
  store.update('editor', (e) => ({ ...e, layout: saved.layout, groups: ids.map((id) => ({ id, active: null })), activeGroup: MAIN_GROUP }));
  for (const g of saved.groups) {
    for (const t of (g.tabs || []).slice(0, 30)) {
      await openFile(t.path, { focus: false, group: g.id }).catch(() => {});
      if (t.pinned) togglePinned(fileTabId(t.path, g.id), true);
    }
    if (g.active) activate(fileTabId(g.active, g.id));
  }
  // Splits whose files are gone close.
  for (const g of groups()) if (!groupTabs(g.id).length && groups().length > 1) closeGroup(g.id);
  return true;
}

/** What restoreGroups needs. */
export function groupsState() {
  return {
    layout: editorLayout(),
    groups: groups().map((g) => {
      const active = tabs().find((t) => t.id === g.active);
      return { id: g.id, tabs: groupTabs(g.id).filter((t) => t.kind === 'file').map((t) => ({ path: t.path, pinned: !!t.pinned })), active: active && active.kind === 'file' ? active.path : null };
    }),
  };
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
  for (const e of allEditors()) if (e.getModel() === d.model) e.revealLineInCenterIfOutsideViewport(regions[0].start, monaco.editor.ScrollType.Smooth);
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
  await Promise.all(allEditors().map((e) => applyBlameTo(e)));
  return blameOn;
}

/** Blame (author and date) in the line numbers of one editor, for the file it shows. */
async function applyBlameTo(e) {
  if (!blameOn) {
    e.updateOptions({ lineNumbers: 'on', lineNumbersMinChars: 5 });
    return;
  }
  const m = e.getModel();
  const d = m && docs.get(m.uri.fsPath);
  if (!d || !d.model) return;
  const path = m.uri.fsPath;
  if (!d.blame) {
    const r = await invoke('git:blame', path, isDirty(path) ? d.model.getValue() : null).catch(() => null);
    d.blame = r;
  }
  const r = d.blame;
  if (!r || !r.lines || e.getModel() !== m) return;
  const byLine = new Map(r.lines.map((l) => [l.line, r.commits[l.sha]]));
  const fmt = (n) => {
    const c = byLine.get(n);
    if (!c) return `${''.padEnd(22)} ${n}`;
    const who = c.sha.startsWith('0000000') ? 'Not committed' : (c.author || '').split(' ')[0];
    const when = c.time ? new Date(c.time).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : '';
    return `${(who.slice(0, 12) + ' ' + when).padEnd(22)} ${n}`;
  };
  e.updateOptions({ lineNumbers: fmt, lineNumbersMinChars: 28 });
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
  store.update('editor', { tabs: [], active: null, cursor: null, selection: '', groups: [{ id: MAIN_GROUP, active: null }], activeGroup: MAIN_GROUP, layout: { type: 'leaf', group: MAIN_GROUP } });
  for (const e of allEditors()) e.setModel(null);
  back.length = 0;
  forward.length = 0;
}

export function relPath(p) {
  const root = store.get().project && store.get().project.root;
  return relative(root, p);
}
