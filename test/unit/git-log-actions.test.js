'use strict';
// Spec: actions on commits in the Git log - cherry-pick, revert, reset (soft / mixed / hard / keep),
// branch and tag from a commit, interactive rebase (reorder, reword, squash, fixup, drop) - and
// committing individual changed lines of a file, leaving the other changes in the working tree.
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
const commit = (root, file, content, msg) => {
  fs.writeFileSync(path.join(root, file), content);
  git(root, 'add', file);
  git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', msg);
  return git(root, 'rev-parse', 'HEAD').trim();
};
const subjects = (root, n = 10) => git(root, 'log', `-${n}`, '--format=%s').trim().split('\n');

test('cherry-pick and revert a commit', async () => {
  const { root, svc } = await open({ 'a.txt': 'a\n' });
  git(root, 'checkout', '-q', '-b', 'feature');
  const picked = commit(root, 'f.txt', 'feature\n', 'feature work');
  git(root, 'checkout', '-q', 'main');
  const r = await svc.cherryPick(picked);
  assert.equal(r.ok, true, r.error);
  assert.equal(subjects(root)[0], 'feature work');
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'feature\n');
  const head = git(root, 'rev-parse', 'HEAD').trim();
  assert.equal((await svc.revertCommit(head)).ok, true);
  assert.match(subjects(root)[0], /^Revert "feature work"/);
  assert.ok(!fs.existsSync(path.join(root, 'f.txt')));
});

test('a cherry-pick that conflicts stops in the cherry-pick state', async () => {
  const { root, svc } = await open({ 'a.txt': 'base\n' });
  git(root, 'checkout', '-q', '-b', 'feature');
  const theirs = commit(root, 'a.txt', 'theirs\n', 'theirs');
  git(root, 'checkout', '-q', 'main');
  commit(root, 'a.txt', 'ours\n', 'ours');
  const r = await svc.cherryPick(theirs);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts, true);
  assert.deepEqual((await svc.conflicts()).map((c) => c.path), ['a.txt']);
  assert.equal((await svc.abort()).ok, true);
});

test('reset soft keeps the changes staged, mixed unstaged, hard discards them; keep refuses to lose local edits', async () => {
  const { root, svc } = await open({ 'a.txt': 'one\n' });
  const first = git(root, 'rev-parse', 'HEAD').trim();
  commit(root, 'a.txt', 'two\n', 'second');
  assert.equal((await svc.reset(first, 'soft')).ok, true);
  assert.equal(git(root, 'status', '--porcelain').trim(), 'M  a.txt');
  git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'second again');
  assert.equal((await svc.reset(first, 'mixed')).ok, true);
  assert.equal(git(root, 'status', '--porcelain').trim(), 'M a.txt');
  assert.equal((await svc.reset(first, 'hard')).ok, true);
  assert.equal(git(root, 'status', '--porcelain').trim(), '');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\n');
  const second = commit(root, 'a.txt', 'two\n', 'second');
  fs.writeFileSync(path.join(root, 'a.txt'), 'local edit\n');
  const keep = await svc.reset(first, 'keep');
  assert.equal(keep.ok, false, 'keep stops instead of overwriting a local change');
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), second);
  await assert.rejects(() => svc.reset(first, 'everything'), /Unknown reset mode/);
});

test('branch and tag from a commit', async () => {
  const { root, svc } = await open({ 'a.txt': 'one\n' });
  const first = git(root, 'rev-parse', 'HEAD').trim();
  commit(root, 'a.txt', 'two\n', 'second');
  assert.equal((await svc.createBranch('from-first', { from: first, checkout: false })).ok, true);
  assert.equal(git(root, 'rev-parse', 'from-first').trim(), first);
  assert.equal((await svc.createTag('v1.0', first)).ok, true);
  assert.equal((await svc.createTag('v1.1', 'HEAD', 'Release 1.1')).ok, true);
  assert.equal(git(root, 'rev-list', '-n1', 'v1.0').trim(), first);
  assert.equal(git(root, 'cat-file', '-t', 'v1.1').trim(), 'tag', 'annotated');
  assert.equal(git(root, 'tag', '-l', '--format=%(contents:subject)', 'v1.1').trim(), 'Release 1.1');
  assert.equal((await svc.createTag('v1.0', first)).ok, false, 'an existing tag is not replaced');
  assert.equal((await svc.deleteTag('v1.0')).ok, true);
});

test('interactive rebase: reorder, reword, squash, fixup and drop', async () => {
  const { root, svc } = await open({ 'a.txt': 'a\n' });
  const base = git(root, 'rev-parse', 'HEAD').trim();
  const c1 = commit(root, 'one.txt', '1\n', 'one');
  const c2 = commit(root, 'two.txt', '2\n', 'two');
  const c3 = commit(root, 'three.txt', '3\n', 'three');
  const c4 = commit(root, 'four.txt', '4\n', 'four');
  const c5 = commit(root, 'five.txt', '5\n', 'five');
  const plan = await svc.rebasePlan(c1);
  assert.equal(plan.base, base);
  assert.deepEqual(plan.commits.map((c) => c.subject), ['one', 'two', 'three', 'four', 'five'], 'oldest first, from the chosen commit');
  fs.writeFileSync(path.join(root, 'a.txt'), 'local change\n');
  const r = await svc.interactiveRebase({
    base: plan.base,
    steps: [
      { hash: c3, action: 'reword', message: 'three, reworded' },
      { hash: c1, action: 'pick' },
      { hash: c2, action: 'squash' },
      { hash: c4, action: 'fixup' },
      { hash: c5, action: 'drop' },
    ],
  });
  assert.equal(r.ok, true, r.error);
  const log = git(root, 'log', '--format=%B%x00', `${base}..HEAD`).split('\0').map((s) => s.trim()).filter(Boolean);
  assert.equal(log.length, 2);
  assert.match(log[0], /^one\n\ntwo$/, 'squash keeps both messages; fixup drops its own');
  assert.equal(log[1], 'three, reworded');
  assert.ok(fs.existsSync(path.join(root, 'four.txt')) && !fs.existsSync(path.join(root, 'five.txt')), 'fixup kept the change, drop removed it');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'local change\n', 'local changes are stashed and re-applied');
  assert.equal((await svc.interactiveRebase({ base, steps: [{ hash: c1, action: 'squash' }] })).ok, false);
});

test('commit individual lines: only the selected changes are committed, the rest stay local', async () => {
  const { root, svc } = await open({ 'app.txt': 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', 'other.txt': 'x\n' });
  fs.writeFileSync(path.join(root, 'app.txt'), 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'x2\n');
  fs.writeFileSync(path.join(root, 'staged-elsewhere.txt'), 's\n');
  git(root, 'add', 'staged-elsewhere.txt');
  const h = await svc.fileHunks('app.txt');
  assert.deepEqual(h.hunks.map((x) => x.lines.filter((l) => l.id).map((l) => l.id)), [['d2', 'a2'], ['a11']]);
  const r = await svc.commit({ message: 'only the last line', files: [{ path: 'app.txt', kind: 'modified' }, { path: 'other.txt', kind: 'modified' }], lines: { 'app.txt': { ids: ['a11'], hash: h.hash } } });
  assert.equal(r.ok, true, r.error);
  assert.equal(git(root, 'show', 'HEAD:app.txt'), 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n', 'committed: the added line only');
  assert.equal(git(root, 'show', 'HEAD:other.txt'), 'x2\n', 'whole files are committed whole');
  assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\n', 'the working tree is untouched');
  const st = Object.fromEntries((await svc.status()).files.map((f) => [f.path, f.x + f.y]));
  assert.equal(st['app.txt'], '.M', 'the uncommitted line is a local change');
  assert.equal(st['staged-elsewhere.txt'], 'A.', 'other staged files are not committed and stay staged');
  assert.equal(st['other.txt'], undefined);
  // A selection made on an older version of the file is refused.
  const stale = await svc.commit({ message: 'stale', files: [{ path: 'app.txt', kind: 'modified' }], lines: { 'app.txt': { ids: ['a2'], hash: 'not-this-version' } } });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /changed since/);
  // A new file: commit its first line only.
  fs.writeFileSync(path.join(root, 'new.txt'), 'first\nsecond\n');
  const nh = await svc.fileHunks('new.txt');
  assert.equal((await svc.commit({ message: 'new file, first line', files: [{ path: 'new.txt', kind: 'untracked' }], lines: { 'new.txt': { ids: ['a1'], hash: nh.hash } } })).ok, true);
  assert.equal(git(root, 'show', 'HEAD:new.txt'), 'first\n');
});
