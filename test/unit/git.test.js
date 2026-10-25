'use strict';
// Spec: Git integration — status, local branches (with safe delete / force delete / restore),
// committing only the checked files, stashes (including untracked files), changes of the current
// branch against a base branch, diff contents and Rider-style smart checkout.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { gitRepo, git, fakeContext } = require('../helpers/fixtures');
const { GitService } = require('../../src/main/services/git');

async function open(files) {
  const root = gitRepo(files);
  const svc = new GitService(fakeContext(root));
  await svc.init(root);
  return { root, svc };
}

test('reports repository info and file status', async () => {
  const { root, svc } = await open({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  assert.equal(svc.info().isRepo, true);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a2\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'n\n');
  fs.unlinkSync(path.join(root, 'b.txt'));
  const st = await svc.status();
  assert.equal(st.branch.head, 'main');
  const byPath = Object.fromEntries(st.files.map((f) => [f.path, f.kind]));
  assert.equal(byPath['a.txt'], 'modified');
  assert.equal(byPath['new.txt'], 'untracked');
  assert.equal(byPath['b.txt'], 'deleted');
});

test('lists local branches with the current one marked', async () => {
  const { root, svc } = await open();
  git(root, 'branch', 'feature/login');
  git(root, 'branch', 'bugfix/crash');
  const b = await svc.branches();
  assert.equal(b.current, 'main');
  assert.deepEqual(b.local.map((x) => x.name).sort(), ['bugfix/crash', 'feature/login', 'main']);
  assert.equal(b.local.find((x) => x.name === 'main').current, true);
});

test('deleting a merged branch succeeds and it can be restored', async () => {
  const { root, svc } = await open();
  git(root, 'branch', 'done');
  const r = await svc.deleteBranch('done');
  assert.equal(r.ok, true);
  assert.ok(r.sha, 'returns the sha so the branch can be restored');
  assert.ok(!(await svc.branches()).local.some((x) => x.name === 'done'));
  await svc.restoreBranch('done', r.sha);
  assert.ok((await svc.branches()).local.some((x) => x.name === 'done'));
});

test('an unmerged branch needs a force delete', async () => {
  const { root, svc } = await open();
  git(root, 'checkout', '-q', '-b', 'wip');
  fs.writeFileSync(path.join(root, 'w.txt'), 'w\n');
  git(root, 'add', 'w.txt');
  git(root, 'commit', '-q', '-m', 'wip');
  git(root, 'checkout', '-q', 'main');
  const first = await svc.deleteBranch('wip');
  assert.equal(first.ok, false);
  assert.equal(first.needsForce, true);
  assert.equal(first.unmergedCommits, 1);
  const forced = await svc.deleteBranch('wip', { force: true });
  assert.equal(forced.ok, true);
});

test('the current branch cannot be deleted', async () => {
  const { svc } = await open();
  const r = await svc.deleteBranch('main');
  assert.equal(r.ok, false);
});

test('commit includes only the selected files', async () => {
  const { root, svc } = await open({ 'a.txt': '1\n', 'b.txt': '1\n' });
  fs.writeFileSync(path.join(root, 'a.txt'), '2\n');
  fs.writeFileSync(path.join(root, 'b.txt'), '2\n');
  fs.writeFileSync(path.join(root, 'c.txt'), 'new\n');
  const st = await svc.status();
  const pick = st.files.filter((f) => f.path === 'a.txt' || f.path === 'c.txt');
  const r = await svc.commit({ message: 'Update a, add c', files: pick });
  assert.equal(r.ok, true);
  const after = await svc.status();
  assert.deepEqual(after.files.map((f) => f.path), ['b.txt']);
  assert.match(git(root, 'log', '-1', '--format=%s'), /Update a, add c/);
});

test('empty commit messages are rejected', async () => {
  const { root, svc } = await open();
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  const r = await svc.commit({ message: '  ', files: (await svc.status()).files });
  assert.equal(r.ok, false);
});

test('stash push, list, files (with untracked), apply and drop', async () => {
  const { root, svc } = await open({ 'a.txt': '1\n' });
  fs.writeFileSync(path.join(root, 'a.txt'), '2\n');
  fs.writeFileSync(path.join(root, 'u.txt'), 'u\n');
  assert.equal((await svc.stashPush({ message: 'my work', includeUntracked: true })).ok, true);
  assert.equal((await svc.status()).files.length, 0, 'working tree is clean after stashing');
  const list = await svc.stashList();
  assert.equal(list.length, 1);
  assert.equal(list[0].message, 'my work');
  assert.equal(list[0].branch, 'main');
  const files = await svc.stashFiles(list[0].ref);
  assert.deepEqual(files.map((f) => `${f.path}:${f.kind}`).sort(), ['a.txt:modified', 'u.txt:untracked']);
  const diff = await svc.fileVersions({ kind: 'stash', path: 'a.txt', ref: list[0].ref });
  assert.equal(diff.original, '1\n');
  assert.equal(diff.modified, '2\n');
  assert.equal((await svc.stashApply(list[0].ref)).ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), '2\n');
  assert.equal((await svc.stashDrop(list[0].ref)).ok, true);
  assert.equal((await svc.stashList()).length, 0);
});

test('branch changes compare the current branch with its base', async () => {
  const { root, svc } = await open({ 'base.txt': 'b\n' });
  git(root, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(root, 'feat.txt'), 'f\n');
  git(root, 'add', 'feat.txt');
  git(root, 'commit', '-q', '-m', 'add feature');
  fs.writeFileSync(path.join(root, 'base.txt'), 'b2\n');
  const committed = await svc.branchChanges({ base: 'main', includeWorking: false });
  assert.equal(committed.commits.length, 1);
  assert.deepEqual(committed.files.map((f) => f.path), ['feat.txt']);
  const withWorking = await svc.branchChanges({ base: 'main', includeWorking: true });
  assert.deepEqual(withWorking.files.map((f) => f.path).sort(), ['base.txt', 'feat.txt']);
  assert.equal(await svc.defaultBase(), 'main');
});

test('file versions for working tree and commits', async () => {
  const { root, svc } = await open({ 'f.txt': 'one\n' });
  fs.writeFileSync(path.join(root, 'f.txt'), 'two\n');
  const w = await svc.fileVersions({ kind: 'working', path: 'f.txt' });
  assert.equal(w.original, 'one\n');
  assert.equal(w.modified, 'two\n');
  git(root, 'commit', '-q', '-am', 'second');
  const hash = git(root, 'rev-parse', 'HEAD').trim();
  const c = await svc.fileVersions({ kind: 'commit', path: 'f.txt', ref: hash });
  assert.equal(c.original, 'one\n');
  assert.equal(c.modified, 'two\n');
  const log = await svc.log({ limit: 10 });
  assert.equal(log.length, 2);
  assert.equal(log[0].subject, 'second');
  const details = await svc.commitDetails(hash);
  assert.deepEqual(details.files.map((f) => f.path), ['f.txt']);
});

test('checkout with conflicting local changes offers smart checkout', async () => {
  const { root, svc } = await open({ 'f.txt': 'main\n' });
  git(root, 'checkout', '-q', '-b', 'other');
  fs.writeFileSync(path.join(root, 'f.txt'), 'other\n');
  git(root, 'commit', '-q', '-am', 'other change');
  git(root, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'x\n');
  fs.writeFileSync(path.join(root, 'f.txt'), 'local edit\n');
  const r = await svc.checkout('other');
  assert.equal(r.ok, false);
  assert.equal(r.canSmartCheckout, true);
  const smart = await svc.smartCheckout('other');
  assert.equal(smart.ok, true);
  assert.equal((await svc.status()).branch.head, 'other');
});
