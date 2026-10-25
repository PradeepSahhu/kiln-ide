'use strict';
// Spec: besides the live graph of the working tree, Kiln keeps a knowledge graph of the main branch
// (main or master) that updates itself in the background whenever main changes - a commit, merge,
// pull, or a fetched origin/main - without checking it out. It is read straight from git objects, so
// the working tree (another branch, uncommitted edits) never leaks into it, and only files that
// changed between commits are re-read. Agents can query it with ref "main".
require('../helpers/electron-mock');
// Agent tools find Kiln's app data through KILN_USER_DATA: keep them in the test profile.
process.env.KILN_USER_DATA = process.env.KILN_TEST_USERDATA;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpdir, writeTree, git } = require('../helpers/fixtures');

const APP = path.resolve(__dirname, '../..');
const WASM = path.join(APP, 'node_modules/@vscode/tree-sitter-wasm/wasm');

function repoWithMain(files) {
  const root = tmpdir('kiln-main-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeTree(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

/** Commit to main while the project folder is on another branch (through a separate worktree). */
function commitToMain(root, files, message) {
  const wt = path.join(tmpdir('kiln-wt-'), 'main');
  git(root, 'worktree', 'add', '-q', wt, 'main');
  writeTree(wt, files);
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', message);
  git(root, 'worktree', 'remove', '--force', wt);
  return git(root, 'rev-parse', 'main').trim();
}

const names = (state) => [...state.defsByName.keys()].sort();

test('syncFromGit builds the main graph from git objects and re-reads only what changed', async () => {
  const A = require('../../src/main/services/codeindex/analyzer');
  const G = require('../../src/main/services/codeindex/graph');
  const { syncFromGit, resolveMainRef } = require('../../src/main/services/codeindex/git-sync');
  await A.loadLanguages(WASM);
  const root = repoWithMain({ 'app/a.py': 'def alpha():\n    return 1\n', 'app/b.py': 'def beta():\n    return alpha()\n', 'README.md': '# x\n' });
  // The project folder moves on: another branch with uncommitted work.
  git(root, 'checkout', '-q', '-b', 'feature');
  fs.appendFileSync(path.join(root, 'app/a.py'), '\n\ndef only_on_feature():\n    pass\n');
  writeTree(root, { 'app/c.py': 'def uncommitted():\n    pass\n' });

  const main = await resolveMainRef(root);
  assert.equal(main.branch, 'main');
  assert.equal(main.commit, git(root, 'rev-parse', 'main').trim());

  const state = G.createState(root);
  const first = await syncFromGit(state, { root, commit: main.commit, analyze: A.analyze, langOf: A.langOf });
  assert.deepEqual(names(state), ['alpha', 'beta']);
  assert.equal(state.commit, main.commit);
  assert.equal(first.read, 2);

  const next = commitToMain(root, { 'app/a.py': 'def alpha():\n    return 1\n\n\ndef gamma():\n    return alpha()\n', 'app/d.py': 'def delta():\n    return 4\n' }, 'more on main');
  fs.rmSync(path.join(root, 'app/c.py'));
  const second = await syncFromGit(state, { root, commit: next, analyze: A.analyze, langOf: A.langOf });
  assert.equal(second.read, 2, 'only the changed and added files are read');
  assert.deepEqual(names(state), ['alpha', 'beta', 'delta', 'gamma']);
  const g = G.fullGraph(state);
  assert.ok(g.edges.some((e) => e.kind === 'calls' && e.source.includes('::gamma::') && e.target.includes('::alpha::')));

  // Deleting a file on main removes it from the graph.
  const wt = path.join(tmpdir('kiln-wt-'), 'main');
  git(root, 'worktree', 'add', '-q', wt, 'main');
  git(wt, 'rm', '-q', 'app/d.py');
  git(wt, 'commit', '-q', '-m', 'drop d');
  git(root, 'worktree', 'remove', '--force', wt);
  await syncFromGit(state, { root, commit: git(root, 'rev-parse', 'main').trim(), analyze: A.analyze, langOf: A.langOf });
  assert.ok(!state.files.has('app/d.py'));
  assert.ok(!names(state).includes('delta'));
});

test('a project in a subfolder of the repository gets paths relative to the project', async () => {
  const A = require('../../src/main/services/codeindex/analyzer');
  const G = require('../../src/main/services/codeindex/graph');
  const { syncFromGit, resolveMainRef } = require('../../src/main/services/codeindex/git-sync');
  await A.loadLanguages(WASM);
  const repo = repoWithMain({ 'services/api/handler.py': 'def handle():\n    pass\n', 'other/x.py': 'def outside():\n    pass\n' });
  const project = path.join(repo, 'services/api');
  const main = await resolveMainRef(project);
  const state = G.createState(project);
  await syncFromGit(state, { root: project, commit: main.commit, analyze: A.analyze, langOf: A.langOf });
  assert.deepEqual([...state.files.keys()], ['handler.py']);
  assert.ok(!state.defsByName.has('outside'));
});

test('origin/main is used when it is ahead of the local main (after a fetch)', async () => {
  const { resolveMainRef } = require('../../src/main/services/codeindex/git-sync');
  const upstream = repoWithMain({ 'm.py': 'def m():\n    pass\n' });
  const clone = tmpdir('kiln-clone-');
  execFileSync('git', ['clone', '-q', upstream, clone]);
  const before = await resolveMainRef(clone);
  assert.equal(before.ref, 'main');
  writeTree(upstream, { 'n.py': 'def n():\n    pass\n' });
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-q', '-m', 'upstream change');
  git(clone, 'fetch', '-q', 'origin');
  const after = await resolveMainRef(clone);
  assert.equal(after.ref, 'origin/main', 'the fetched remote main is newer');
  assert.equal(after.commit, git(upstream, 'rev-parse', 'main').trim());
});

test('the main-branch graph service follows main in the background', async (t) => {
  const { BranchGraph } = require('../../src/main/services/codeindex/branch');
  const root = repoWithMain({ 'svc.py': 'def first():\n    pass\n' });
  git(root, 'checkout', '-q', '-b', 'work');
  const events = [];
  const svc = new BranchGraph({ root, send: (ch, p) => events.push({ ch, p }), git: { root } }, { fetchMinutes: 0 });
  t.after(() => svc.dispose());
  await svc.open(root);
  assert.equal(svc.status.state, 'ready');
  assert.equal(svc.status.branch, 'main');
  let g = await svc.call('graph', { mode: 'all' });
  assert.ok(g.nodes.some((n) => n.label === 'first'));

  const next = commitToMain(root, { 'svc.py': 'def first():\n    pass\n\n\ndef second():\n    return first()\n' }, 'add second');
  await svc.onGitChange();
  assert.equal(svc.status.commit, next);
  g = await svc.call('graph', { mode: 'all' });
  assert.ok(g.nodes.some((n) => n.label === 'second'), 'the new commit on main is in the graph');
  assert.ok(events.some((e) => e.ch === 'index:branch' && e.p.commit === next), 'the window is told');
  assert.ok(fs.existsSync(svc.graphFile), 'saved where agents can read it');
});

test('agents query the main branch with ref "main", even when the IDE is closed', async () => {
  const root = repoWithMain({ 'core.py': 'def stable():\n    pass\n' });
  const { indexFolder } = require('../../src/agent-tools/kg-core');
  await indexFolder(root);
  git(root, 'checkout', '-q', '-b', 'topic');
  writeTree(root, { 'core.py': 'def stable():\n    pass\n\n\ndef topic_only():\n    pass\n' });
  commitToMain(root, { 'core.py': 'def stable():\n    pass\n\n\ndef on_main():\n    return stable()\n' }, 'main moves');
  const cli = (args) => JSON.parse(execFileSync(process.execPath, [path.join(APP, 'src/agent-tools/kg-cli.js'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, KILN_USER_DATA: process.env.KILN_TEST_USERDATA } }));
  const onMain = cli(['symbol', 'on_main', '--ref', 'main']);
  assert.equal(onMain.ref, 'main');
  assert.ok(onMain.matches.length === 1 && onMain.matches[0].calls.some((c) => c.name === 'stable'));
  assert.equal(cli(['symbol', 'topic_only', '--ref', 'main']).matches.length, 0, 'branch work is not on main');
  assert.equal(cli(['symbol', 'topic_only']).matches.length, 1, 'the default is the working tree');
});
