// Git state and actions for the toolbar widget, Commit and Git tool windows.
import { store } from '../lib/store.js';
import { checkConflicts } from './conflicts.js';
import { invoke, on } from '../lib/ipc.js';
import { toast, confirm, prompt, errorToast, openModal } from '../lib/ui.js';
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
      else if (s.warning) {
        toast({ kind: 'warning', title: 'Checked out with conflicts', message: s.warning, timeout: 0 });
        setTimeout(() => checkConflicts(), 500);
      }
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
  if (!r.ok) await checkConflicts();
}

export async function rebaseOnto(name) {
  await ed.saveAll({ quiet: true });
  const r = await invoke('git:rebase', name);
  if (r.ok) toast({ kind: 'success', title: `Rebased onto ${name}` });
  else toast({ kind: 'error', title: 'Rebase needs attention', message: r.error, timeout: 0 });
  await refreshAll();
  if (!r.ok) await checkConflicts();
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
  if (!r.ok) await checkConflicts();
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

// ------------------------------------------------------------ log actions

/** Run an operation that may stop on conflicts (cherry-pick, revert, rebase): report and show them. */
async function operation(title, promise, done) {
  await ed.saveAll({ quiet: true });
  const r = await promise;
  if (r.ok) toast({ kind: 'success', title: done, timeout: 3500 });
  else if (r.conflicts) toast({ kind: 'warning', title: `${title} stopped on conflicts`, message: 'Resolve them, then continue.', timeout: 6000 });
  else errorToast(`${title} failed`, new Error(r.error));
  await refreshAll();
  if (!r.ok && r.conflicts) await checkConflicts();
  return r;
}

const short = (c) => `${c.hash.slice(0, 8)} ${c.subject ? `"${c.subject.length > 50 ? `${c.subject.slice(0, 50)}…` : c.subject}"` : ''}`.trim();

export function cherryPick(c) {
  return operation('Cherry-pick', invoke('git:cherryPick', c.hash), `Cherry-picked ${short(c)}`);
}

export async function revertCommit(c) {
  return operation('Revert', invoke('git:revertCommit', c.hash), `Reverted ${short(c)}`);
}

export async function resetTo(c) {
  const mode = await openModal('gitReset', { commit: c, branch: (store.get().git.status || {}).branch ? store.get().git.status.branch.head : null });
  if (!mode) return null;
  await ed.saveAll({ quiet: true });
  const r = await invoke('git:reset', c.hash, mode);
  if (r.ok) toast({ kind: 'success', title: `Reset to ${c.hash.slice(0, 8)} (${mode})`, timeout: 3500 });
  else errorToast('Reset failed', new Error(r.error));
  await refreshAll();
  ed.refreshHeads();
  return r;
}

export async function newBranchAt(c) {
  return newBranch(c.hash);
}

export async function newTag(c) {
  const r = await prompt({ title: 'Create Tag', label: `Tag name (on ${c.hash.slice(0, 8)}):`, placeholder: 'v1.0.0', ok: 'Create', testid: 'tag-name', checkbox: { label: 'Annotated, with the commit subject as its message', value: false } });
  if (!r) return null;
  const name = (typeof r === 'string' ? r : r.value).trim();
  if (!name) return null;
  const res = await invoke('git:createTag', name, c.hash, typeof r === 'object' && r.checked ? c.subject || name : '');
  if (res.ok) toast({ title: `Created tag ${name}`, timeout: 2500 });
  else errorToast('Could not create the tag', new Error(res.error));
  await refreshAll();
  return res;
}

export async function deleteTag(name) {
  if (!(await confirm({ title: 'Delete Tag', message: `Delete tag '${name}'?`, ok: 'Delete', danger: true }))) return null;
  const r = await invoke('git:deleteTag', name);
  if (!r.ok) errorToast('Could not delete the tag', new Error(r.error));
  await refreshAll();
  return r;
}

export async function interactiveRebase(c) {
  const plan = await invoke('git:rebasePlan', c.hash).catch((err) => ({ error: err.message }));
  if (plan.error) return errorToast('Cannot rebase from here', new Error(plan.error));
  if (!plan.commits.length) return toast({ title: 'Nothing to rebase', message: 'There are no commits after this one on the current branch.', timeout: 3000 });
  if (plan.merges) return toast({ kind: 'warning', title: 'Merge commits in the range', message: 'Interactive rebase from here would flatten merge commits; choose a commit after the last merge.', timeout: 6000 });
  const steps = await openModal('interactiveRebase', { plan, from: c });
  if (!steps) return null;
  return operation('Rebase', invoke('git:interactiveRebase', { base: plan.base, root: plan.root, steps }), 'Rebased');
}
