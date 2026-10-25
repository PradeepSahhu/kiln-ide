// Git state and actions for the toolbar widget, Commit and Git tool windows.
import { store } from '../lib/store.js';
import { invoke, on } from '../lib/ipc.js';
import { toast, confirm, prompt, errorToast } from '../lib/ui.js';
import { debounce } from '../lib/util.js';
import * as ed from './editor.js';

const isRepo = () => !!(store.get().project && store.get().project.git && store.get().project.git.isRepo);

export async function refreshStatus() {
  if (!isRepo()) return;
  const status = await invoke('git:status').catch(() => null);
  if (status) store.update('git', { status });
}

export async function refreshBranches() {
  if (!isRepo()) return;
  const branches = await invoke('git:branches').catch(() => null);
  if (branches) store.update('git', { branches });
}

export async function refreshStashes() {
  if (!isRepo()) return;
  const stashes = await invoke('git:stashList').catch(() => []);
  store.update('git', { stashes });
}

export async function refreshAll() {
  if (!isRepo()) return;
  await Promise.all([refreshStatus(), refreshBranches(), refreshStashes()]);
  store.update('git', { tick: Date.now() });
}

export const refreshSoon = debounce(() => {
  refreshAll();
  ed.refreshHeads();
}, 250);

export function initGit() {
  on('git:changed', refreshSoon);
  on('git:console', (entry) => store.update('git', (g) => ({ ...g, console: [...g.console.slice(-300), entry] })));
}

export async function checkout(name, { remote = false } = {}) {
  await ed.saveAll({ quiet: true });
  const r = await invoke('git:checkout', name, { remote });
  if (r.ok) {
    toast({ title: `Checked out ${remote ? name.replace(/^[^/]+\//, '') : name}`, timeout: 2500 });
  } else if (r.canSmartCheckout) {
    const ok = await confirm({ title: 'Git Checkout Problem', message: 'Your local changes would be overwritten by checkout.', detail: r.error, ok: 'Smart Checkout', cancel: 'Cancel', extra: 'Smart Checkout stashes your changes, checks out the branch and re-applies them.' });
    if (ok) {
      const s = await invoke('git:smartCheckout', name, { remote });
      if (!s.ok) errorToast('Smart checkout failed', new Error(s.error));
      else if (s.warning) toast({ kind: 'warning', title: 'Checked out with conflicts', message: s.warning, timeout: 0 });
      else toast({ title: `Checked out ${name}`, timeout: 2500 });
    }
  } else {
    errorToast(`Checkout of ${name} failed`, new Error(r.error));
  }
  await refreshAll();
}

/** Delete a local branch; unmerged branches need a second, explicit confirmation. */
export async function deleteBranch(name) {
  const ok = await confirm({ title: 'Delete Branch', message: `Delete branch '${name}'?`, ok: 'Delete', danger: true });
  if (!ok) return false;
  let r = await invoke('git:deleteBranch', name, {});
  if (!r.ok && r.needsForce) {
    const force = await confirm({ title: 'Branch Is Not Fully Merged', message: `Branch '${name}' is not fully merged into the current branch.\n${r.unmergedCommits} commit(s) would no longer be reachable from any branch.`, ok: 'Delete Anyway', danger: true, force: true });
    if (!force) return false;
    r = await invoke('git:deleteBranch', name, { force: true });
  }
  if (r.ok) {
    toast({ title: `Deleted branch ${name}`, actions: [{ label: 'Restore', run: async () => { await invoke('git:restoreBranch', name, r.sha); await refreshBranches(); toast({ title: `Restored ${name}`, timeout: 2500 }); } }] });
  } else errorToast(`Could not delete ${name}`, new Error(r.error));
  await refreshBranches();
  return r.ok;
}

export async function newBranch(from) {
  const name = await prompt({ title: 'Create New Branch', label: `New branch name${from ? ` (from ${from})` : ''}:`, placeholder: 'feature/my-change', ok: 'Create', checkbox: { label: 'Checkout branch', value: true } });
  if (!name) return;
  const value = typeof name === 'string' ? name : name.value;
  const doCheckout = typeof name === 'string' ? true : name.checked;
  const r = await invoke('git:createBranch', value.trim(), { from, checkout: doCheckout });
  if (!r.ok) errorToast('Could not create the branch', new Error(r.error));
  await refreshAll();
}

export async function renameBranch(oldName) {
  const name = await prompt({ title: 'Rename Branch', label: `New name for '${oldName}':`, value: oldName, ok: 'Rename' });
  if (!name || name === oldName) return;
  const r = await invoke('git:renameBranch', oldName, name);
  if (!r.ok) errorToast('Rename failed', new Error(r.error));
  await refreshBranches();
}

export async function mergeInto(name) {
  await ed.saveAll({ quiet: true });
  const r = await invoke('git:merge', name);
  if (r.ok) toast({ kind: 'success', title: `Merged ${name}`, message: r.output.split('\n').slice(-2).join('\n') });
  else toast({ kind: 'error', title: `Merge of ${name} needs attention`, message: r.error, timeout: 0 });
  await refreshAll();
}

export async function rebaseOnto(name) {
  await ed.saveAll({ quiet: true });
  const r = await invoke('git:rebase', name);
  if (r.ok) toast({ kind: 'success', title: `Rebased onto ${name}` });
  else toast({ kind: 'error', title: 'Rebase needs attention', message: r.error, timeout: 0 });
  await refreshAll();
}

export async function fetch() {
  const r = await invoke('git:fetch');
  toast(r.ok ? { title: 'Fetched', message: r.output || 'Up to date', timeout: 3000 } : { kind: 'error', title: 'Fetch failed', message: r.error });
  await refreshAll();
}

export async function pull() {
  await ed.saveAll({ quiet: true });
  const r = await invoke('git:pull');
  toast(r.ok ? { kind: 'success', title: 'Project updated', message: r.output.split('\n').slice(-3).join('\n'), timeout: 4000 } : { kind: 'error', title: 'Update failed', message: r.error, timeout: 0 });
  await refreshAll();
}

export async function push() {
  const st = store.get().git.status;
  const ok = await confirm({ title: 'Push Commits', message: `Push ${st && st.branch.head ? `'${st.branch.head}'` : 'the current branch'}${st && st.branch.upstream ? ` to ${st.branch.upstream}` : ' and set its upstream'}?`, ok: 'Push' });
  if (!ok) return;
  const r = await invoke('git:push', {});
  toast(r.ok ? { kind: 'success', title: 'Pushed', message: r.output.split('\n').slice(-2).join('\n'), timeout: 4000 } : { kind: 'error', title: 'Push failed', message: r.error, timeout: 0 });
  await refreshAll();
}

export async function stashChanges() {
  const r = await prompt({ title: 'Stash Changes', label: 'Message:', placeholder: 'WIP', ok: 'Create Stash', checkbox: { label: 'Include untracked files', value: true }, testid: 'stash-message' });
  if (r == null) return false;
  await ed.saveAll({ quiet: true });
  const message = typeof r === 'string' ? r : r.value;
  const includeUntracked = typeof r === 'string' ? true : r.checked;
  const res = await invoke('git:stashPush', { message, includeUntracked });
  if (!res.ok) errorToast('Stash failed', new Error(res.error));
  await refreshAll();
  return res.ok;
}

export async function initRepo() {
  await invoke('git:init');
  const info = await invoke('git:info');
  store.update('project', { git: info });
  await refreshAll();
  toast({ title: 'Git repository created' });
}
