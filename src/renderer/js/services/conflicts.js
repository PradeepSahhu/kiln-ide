// Merge conflicts: the Conflicts dialog (every conflicted file: accept yours / theirs or merge), the
// merge view per file, and finishing the merge, rebase or cherry-pick once everything is resolved.
import { store } from '../lib/store.js';
import { invoke } from '../lib/ipc.js';
import { openModal, toast, dismissToast, errorToast } from '../lib/ui.js';
import { basename } from '../lib/util.js';
import * as ed from './editor.js';
import { refreshAll } from './git.js';

// The "all resolved" toast stays until the operation is finished (or conflicts come back).
let doneToast = null;
store.subscribe((s) => {
  const st = s.git.status;
  if (doneToast && st && !st.merging && !st.rebasing && !st.cherryPicking && !st.reverting) {
    dismissToast(doneToast);
    doneToast = null;
  }
});

const VERB = { merge: 'Commit Merge', rebase: 'Continue Rebase', 'cherry-pick': 'Continue Cherry-Pick', revert: 'Continue Revert' };

/** Open the merge view for one conflicted file (repository-relative path). */
export function openMerge(rel) {
  ed.openSpecial({ id: `merge:${rel}`, kind: 'merge', title: `Merge ${basename(rel)}`, data: { path: rel } });
}

export function showConflicts() {
  return openModal('conflicts');
}

/** If an operation left conflicts, show them (called after merge, rebase, pull, stash pop, ...). */
export async function checkConflicts() {
  const list = await invoke('git:conflicts').catch(() => []);
  if (list.length) showConflicts();
  return list.length;
}

/** After resolving a file: refresh, and offer to finish the operation when nothing is left. */
export async function afterResolve() {
  await refreshAll();
  const left = await invoke('git:conflicts').catch(() => []);
  if (left.length) return left.length;
  // Fresh state: the operation may already have been finished while this was waiting.
  const st = (await invoke('git:status').catch(() => null)) || {};
  const op = st.merging ? 'merge' : st.rebasing ? 'rebase' : st.cherryPicking ? 'cherry-pick' : st.reverting ? 'revert' : null;
  if (doneToast) dismissToast(doneToast);
  if (op) doneToast = toast({ kind: 'success', title: 'All conflicts are resolved', message: `${VERB[op]} to finish.`, timeout: 0, actions: [{ label: VERB[op], run: () => finishOperation() }] });
  else toast({ kind: 'success', title: 'All conflicts are resolved', timeout: 3000 });
  return 0;
}

export async function finishOperation() {
  if (doneToast) dismissToast(doneToast);
  doneToast = null;
  const r = await invoke('git:continueOperation');
  if (r.ok) toast({ kind: 'success', title: 'Done', message: (r.output || '').split('\n').slice(-2).join('\n'), timeout: 3500 });
  else errorToast('Could not continue', new Error(r.error));
  await refreshAll();
  if (!r.ok) await checkConflicts();
}
