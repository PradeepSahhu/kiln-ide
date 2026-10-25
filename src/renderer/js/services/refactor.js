// Refactor This and the individual refactoring commands: collect what applies at the caret or
// selection (main process: refactor:available), ask for names / signatures / targets in a dialog that
// previews every change, then apply the result to the editors (one undo step per file, Local History
// kept) and to files that are not open.
import { store } from '../lib/store.js';
import { invoke } from '../lib/ipc.js';
import { run, SHORTCUTS } from '../lib/commands.js';
import { openModal, openPopup, toast, errorToast } from '../lib/ui.js';
import { basename } from '../lib/util.js';
import * as ed from './editor.js';

// Command ids of the refactorings that have one.
export const KIND_COMMAND = {
  rename: 'refactor.rename',
  changeSignature: 'refactor.changeSignature',
  extractMethod: 'refactor.extractMethod',
  introduceVariable: 'refactor.introduceVariable',
  introduceConstant: 'refactor.introduceConstant',
  introduceField: 'refactor.introduceField',
  introduceParameter: 'refactor.introduceParameter',
  inline: 'refactor.inline',
  move: 'refactor.move',
  safeDelete: 'refactor.safeDelete',
  pullMembersUp: 'refactor.pullMembersUp',
};
const NAMES = {
  changeSignature: 'Change Signature',
  extractMethod: 'Extract Method',
  introduceVariable: 'Introduce Variable',
  introduceConstant: 'Introduce Constant',
  introduceField: 'Introduce Field',
  introduceParameter: 'Introduce Parameter',
  inline: 'Inline',
  move: 'Move',
  safeDelete: 'Safe Delete',
  pullMembersUp: 'Pull Members Up',
};
// When the exact refactoring is not offered, a close one is (⌥⌘V at module level is a constant).
const FALLBACK = { introduceVariable: ['introduceConstant'], introduceConstant: ['introduceVariable'], introduceField: ['introduceConstant'] };

/** Where the refactoring applies: the active file, its text and the selection as UTF-16 offsets. */
function caret() {
  const editor = ed.getEditor();
  const file = ed.activeFile();
  const model = editor && editor.getModel();
  if (!file || !model) return null;
  const sel = editor.getSelection();
  const a = model.getOffsetAt(sel.getStartPosition());
  const b = model.getOffsetAt(sel.getEndPosition());
  return { file, text: model.getValue(), start: Math.min(a, b), end: Math.max(a, b) };
}

async function available() {
  const req = caret();
  if (!req) {
    toast({ title: 'Open a file and put the caret on the code to refactor', timeout: 2500 });
    return null;
  }
  // Engines that read the project from disk (rope, the index) need it saved.
  await ed.saveAll({ quiet: true });
  try {
    const res = await invoke('refactor:available', req);
    return { req, ...res };
  } catch (err) {
    errorToast('Refactoring is not available', err);
    return null;
  }
}

/** Refactor This (⌃T): every refactoring that applies here, in Rider's order. */
export async function refactorThis() {
  const a = await available();
  if (!a) return;
  if (!a.items.length) {
    toast({ title: 'No refactorings here', message: a.notes && a.notes[0], timeout: 4000 });
    return;
  }
  const seen = new Set();
  const items = [];
  for (const it of a.items) {
    // One entry per kind (the dialog offers the variants, e.g. the scope of Extract Method)...
    if (it.kind !== 'other' && it.kind !== 'move' && seen.has(it.kind)) continue;
    seen.add(it.kind);
    items.push({ label: it.title, shortcut: SHORTCUTS[KIND_COMMAND[it.kind]] || '', run: () => start(it, a) });
  }
  if (a.notes && a.notes.length) items.push({ separator: true }, ...a.notes.map((n) => ({ label: n, icon: 'info', run: () => run('view.settings', 'languages') })));
  openPopup({ type: 'list', title: 'Refactor This', testid: 'refactor-this', items });
}

/** One refactoring by kind (its own shortcut). */
export async function refactorKind(kind) {
  const a = await available();
  if (!a) return;
  const pick = [kind, ...(FALLBACK[kind] || [])].map((k) => a.items.filter((x) => x.kind === k)).find((l) => l.length);
  if (!pick) {
    toast({ title: `${NAMES[kind] || kind} is not available here`, message: (a.notes && a.notes[0]) || '', timeout: 3500 });
    return;
  }
  start(pick[0], a);
}

function start(item, a) {
  if (item.kind === 'rename') return run('refactor.rename');
  const variants = a.items.filter((x) => x.kind === item.kind && (item.kind !== 'move' || x.id === item.id) && item.kind !== 'other');
  return openModal('refactor', { item, variants: variants.length ? variants : [item], req: a.req, lang: a.lang });
}

/** Apply a computed refactoring; returns the number of files changed. */
export async function applyRefactoring(result) {
  const files = result.files || [];
  for (const f of files) {
    if (ed.replaceContent(f.path, f.after)) await ed.save(f.path, { quiet: true });
    else {
      if (!f.created) await invoke('history:snapshotDisk', f.path, 'Before refactoring').catch(() => {});
      await invoke('fs:writeFile', f.path, f.after);
    }
  }
  const sel = result.select;
  if (sel && sel.file) {
    await ed.openFile(sel.file);
    ed.selectOffsets(sel.file, sel.start, sel.end);
  } else {
    const created = files.find((f) => f.created);
    if (created) await ed.openFile(created.path, { focus: false });
  }
  if (files.length > 1) toast({ kind: 'success', title: `Refactored ${files.length} files`, message: files.map((f) => basename(f.path)).join(', '), timeout: 3500 });
  store.set({ lastRefactoring: { at: Date.now(), files: files.map((f) => f.path) } });
  return files.length;
}
