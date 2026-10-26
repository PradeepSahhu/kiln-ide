'use strict';
// End-to-end tests: launch the real Kiln IDE (Electron) and drive it like a user.
// Written from the product spec; the UI exposes stable data-testid hooks and a small window.__kiln
// test API (command runner + editor/terminal accessors).
//
//   npm run test:e2e                      full suite
//   KILN_E2E_SKIP_CLAUDE=1 npm run test:e2e   skip the test that sends one small prompt to Claude
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright-core');

const APP = path.resolve(__dirname, '../..');
const has = (cmd) => {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

let app;
let win;
const userData = tmp('kiln-e2e-userdata-');
// Scratch home for agent configuration (Claude Code / Codex): the real ~/.claude is never touched.
const agentHome = tmp('kiln-e2e-home-');
fs.mkdirSync(path.join(agentHome, '.claude'), { recursive: true });
fs.mkdirSync(path.join(agentHome, '.codex'), { recursive: true });
const workspace = tmp('kiln-e2e-ws-');
const shots = path.join(os.tmpdir(), 'kiln-e2e-shots');
// Tools Kiln installs on demand (rope, csharp-ls, debugpy, netcoredbg), kept between test runs.
const toolsDir = path.join(os.tmpdir(), 'kiln-test-tools');
fs.mkdirSync(toolsDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
// Test answers for the AI features (inline completion, docs, tests, review); a kind missing here goes
// to Claude for real (the commit message, in the test that is skipped with KILN_E2E_SKIP_CLAUDE).
const aiStub = path.join(tmp('kiln-e2e-ai-'), 'stub.json');
fs.writeFileSync(aiStub, JSON.stringify({
  inlineCompletion: 'return x * x',
  generateDocs: { code: 'def square(x):\n    """Return x squared."""\n    return x * x' },
  generateTests: { path: 'tests/test_ai_demo.py', content: 'from ai_demo import square\n\n\ndef test_square():\n    assert square(3) == 9\n' },
  review: { summary: 'One possible problem.', findings: [{ file: 'ai_demo.py', line: 3, severity: 'warning', message: 'square() does not check its argument type.', suggestion: 'Accept only numbers.' }] },
}));

async function shot(name) {
  try {
    // Let dialogs finish fading in (finite animations only: spinners run forever).
    await win.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 1500))]));
    // Screenshots go into the README: account emails and GitHub logins are masked.
    const mask = [win.locator('text=/[\\w.+-]+@[\\w-]+(\\.[\\w-]+)*\\.[A-Za-z]{2,}/'), win.locator('text=/(Connected|Logged in) as /')];
    await win.screenshot({ path: path.join(shots, `${name}.png`), mask, maskColor: '#3C3F41' });
  } catch {
    /* window closing */
  }
}
const sel = (id, extra = '') => `[data-testid="${id}"]${extra}`;
const run = (cmd, arg) => win.evaluate(([c, a]) => window.__kiln.run(c, a), [cmd, arg]);
const kiln = (fn, ...args) => win.evaluate(([f, a]) => window.__kiln.test[f](...a), [fn, args]);

async function waitFor(fn, { timeout = 30000, interval = 250, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message} (last: ${last && last.message ? last.message : JSON.stringify(last)})`);
}

async function createProject(templateId, name) {
  await run('project.new');
  await win.waitForSelector(sel('new-project-dialog'));
  await win.click(sel(`template-${templateId}`));
  await win.fill(sel('new-project-name'), name);
  await win.fill(sel('new-project-location'), workspace);
  const started = Date.now();
  await win.click(sel('new-project-create'));
  await win.waitForSelector(sel('ide'), { timeout: 240000 });
  await waitFor(async () => (await win.textContent(sel('project-widget'))).includes(name), { message: `project ${name} open` });
  return { dir: path.join(workspace, name), ms: Date.now() - started };
}

async function waitBuild(status = 'success', timeout = 300000) {
  await waitFor(async () => {
    const s = await win.getAttribute(sel('build-status'), 'data-status');
    if (s === 'failed' && status === 'success') {
      await shot('build-failed');
      throw new Error('build failed: ' + (await win.textContent(sel('build-panel'))).slice(0, 1500));
    }
    return s === status;
  }, { timeout, message: `build ${status}` });
}

/** Run a refactoring command and wait for its dialog to show a preview that can be applied. */
async function refactorDialog(command, { name, state = 'ready' } = {}) {
  await run(command);
  await win.waitForSelector(sel('refactor-dialog'), { timeout: 60000 }).catch(async (err) => {
    const toasts = await win.evaluate(() => window.__kiln.store.get().toasts.map((t) => `${t.title}: ${t.message}`));
    const state = await win.evaluate(() => JSON.stringify({ modals: window.__kiln.store.get().modals.map((m) => m.type), popup: !!window.__kiln.store.get().popup, cursor: window.__kiln.test.cursor(), tab: window.__kiln.store.get().editor.active }));
    toasts.push(state);
    throw new Error(`${command} opened no dialog. Toasts: ${toasts.join(' | ') || 'none'}. ${err.message.split('\n')[0]}`);
  });
  if (name != null) await win.fill(sel('refactor-name'), name);
  await waitFor(async () => (await win.getAttribute(sel('refactor-state'), 'data-state')) === state, { timeout: 180000, message: `${command} preview (${state})` });
}

async function applyRefactoring() {
  await win.click(sel('refactor-apply'));
  await waitFor(async () => !(await win.$(sel('refactor-dialog'))), { timeout: 30000, message: 'refactoring applied' });
}

/** Click a test's gutter icon in the active editor and choose Run / Debug / Run with Coverage. */
async function gutterTest(line, label) {
  const glyph = await waitFor(async () => {
    const y = await kiln('lineY', line);
    if (y == null) return null;
    for (const g of await win.$$('.test-glyph')) {
      const box = await g.boundingBox();
      if (box && y >= box.y - 1 && y <= box.y + box.height + 1) return g;
    }
    return null;
  }, { message: `test icon on line ${line}` });
  await glyph.click();
  await win.click(sel('menu-item', `[data-label^="${label}"]`));
}

/** In the Commit window, tick only `file` (re-applied until the change list stops changing). */
async function commitOnly(file) {
  const rows = () => win.$$eval(sel('change-row'), (els) => els.map((e) => ({ path: e.dataset.path, on: !!(e.querySelector('input[type="checkbox"]') || {}).checked })));
  await waitFor(async () => {
    const list = await rows();
    if (!list.some((r) => r.path === file)) return false;
    const wrong = list.filter((r) => r.on !== (r.path === file));
    for (const r of wrong) await win.locator(sel('change-row', `[data-path="${r.path}"] input[type="checkbox"]`)).setChecked(r.path === file, { timeout: 2000 }).catch(() => {});
    if (wrong.length) return false;
    await new Promise((r) => setTimeout(r, 500));
    const again = await rows();
    return again.length === list.length && again.every((r) => r.on === (r.path === file)) ? true : false;
  }, { timeout: 30000, interval: 300, message: `only ${file} ticked` });
}

const outcome = (name) => win.getAttribute(sel('test-row', `[data-name="${name}"]`), 'data-outcome').catch(() => null);

before(async () => {
  app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, KILN_USER_DATA: userData, KILN_E2E: '1', KILN_AGENT_HOME: agentHome, KILN_TOOLS_DIR: toolsDir, KILN_AI_STUB: aiStub }, timeout: 90000 });
  win = await app.firstWindow();
  win.on('pageerror', (err) => console.error('[renderer error]', err.message));
  await win.waitForSelector(sel('welcome'), { timeout: 60000 });
  // Ghost text from the AI test answers would get in the way elsewhere; its own test turns it on.
  await win.evaluate(() => window.kiln.invoke('app:updateSettings', { ai: { inlineCompletion: false } }));
});

// A dialog left open by an earlier (failed) test would block this one: report it and close it, so
// one failure does not cascade into the tests after it.
beforeEach(async (t) => {
  if (!win) return;
  const open = await win.evaluate(() => (window.__kiln ? window.__kiln.store.get().modals.map((m) => m.type) : [])).catch(() => []);
  if (!open.length) return;
  console.log(`  [open dialogs before "${t.name}": ${open.join(', ')} - closed]`);
  await win.evaluate(() => window.__kiln.closeAllModals()).catch(() => {});
});

after(async () => {
  if (app) await app.close().catch(() => {});
});

test('welcome screen reports the toolchain', async () => {
  await waitFor(async () => (await win.getAttribute(sel('toolchain-git'), 'data-found')) === 'true', { message: 'toolchain probe' });
  assert.equal(await win.getAttribute(sel('toolchain-python'), 'data-found'), String(has('python3')));
  assert.equal(await win.getAttribute(sel('toolchain-dotnet'), 'data-found'), String(has('dotnet')));
  await shot('01-welcome');
});

test('creates a Python project in a virtual environment and builds it on load', { timeout: 400000 }, async () => {
  const { dir, ms } = await createProject('python-app', 'e2e_py');
  console.log(`  python project opened in ${ms} ms`);
  await waitBuild('success');
  assert.ok(fs.existsSync(path.join(dir, '.venv')), '.venv exists');
  await win.waitForSelector(sel('tree-row', '[data-name="main.py"]'));
  await shot('02-python-project');
});

test('editing with a syntax error shows a problem; fixing it clears it', { timeout: 120000 }, async () => {
  await win.dblclick(sel('tree-row', '[data-name="main.py"]'));
  await win.waitForSelector(sel('editor-tab', '[data-name="main.py"][data-active="true"]'));
  const original = await kiln('getActiveContent');
  assert.match(original, /Hello/);
  await kiln('setActiveContent', 'def broken(:\n    pass\n');
  await run('file.save');
  await waitFor(async () => (await win.$$(sel('problem-item'))).length > 0, { message: 'problem listed' });
  assert.match(await win.textContent(sel('problems-panel')), /main\.py/);
  await shot('03-problem');
  await kiln('setActiveContent', original);
  await run('file.save');
  await waitFor(async () => (await win.$$(sel('problem-item', '[data-severity="error"]'))).length === 0, { message: 'problem cleared' });
});

test('the detected run configuration runs the app', { timeout: 120000 }, async () => {
  await waitFor(async () => (await win.textContent(sel('run-config'))).includes('main.py'), { message: 'main.py run configuration selected' });
  await win.click(sel('run-button'));
  await waitFor(async () => /Hello/.test(await kiln('runText')), { message: 'program output' });
  await shot('04-run');
});

test('debugger stops at a breakpoint, shows frames and variables, evaluates, steps and resumes', { timeout: 240000 }, async () => {
  const file = path.join(workspace, 'e2e_py', 'main.py');
  await kiln('openFile', file, 5, 1);
  await kiln('toggleBreakpoint', file, 5);
  await win.waitForSelector('.kiln-bp');
  await win.click(sel('debug-button'));
  await win.waitForSelector(sel('debug-panel'));
  await waitFor(async () => (await win.getAttribute(sel('debug-panel'), 'data-state')) === 'stopped', { timeout: 180000, message: 'paused at the breakpoint' });
  const top = await win.textContent(sel('debug-frame'));
  assert.match(top, /greet/);
  assert.match(top, /main\.py:5/);
  await waitFor(async () => (await win.$$(sel('debug-variable', '[data-name="name"]'))).length > 0, { message: 'locals listed' });
  assert.match(await win.textContent(sel('debug-variable', '[data-name="name"]')), /world/);
  await waitFor(async () => {
    const c = await kiln('cursor');
    return c.file === file && c.line === 5;
  }, { message: 'editor shows the paused line' });
  await win.waitForSelector('.dbg-exec-line');
  await shot('05-debugger');
  await win.fill(sel('debug-eval-input'), 'name.upper()');
  await win.press(sel('debug-eval-input'), 'Enter');
  await waitFor(async () => /WORLD/.test(await win.textContent(sel('debug-eval-result'))), { message: 'evaluation result' });
  await win.click(sel('debug-step-over'));
  await waitFor(async () => (await win.getAttribute(sel('debug-panel'), 'data-state')) === 'stopped' && !/greet/.test(await win.textContent(sel('debug-frame'))), { message: 'stepped back to the caller' });
  await win.click(sel('debug-resume'));
  await waitFor(async () => (await win.getAttribute(sel('debug-panel'), 'data-state')) === 'terminated', { timeout: 60000, message: 'program finished' });
  assert.match(await kiln('debugOutput'), /Hello, world!/);
  await kiln('toggleBreakpoint', file, 5);
});

test('refactor Python: extract method with rope, preview, and safe delete reports usages', { timeout: 400000 }, async () => {
  const file = path.join(workspace, 'e2e_py', 'shop.py');
  const SHOP = 'TAX = 0.2\n\n\ndef total(items, discount):\n    subtotal = sum(items)\n    taxed = subtotal * (1 + TAX)\n    result = taxed - discount\n    return result\n\n\ndef report():\n    return total([1, 2], 1)\n';
  fs.writeFileSync(file, SHOP);
  await waitFor(async () => (await kiln('indexHas', 'report')) === true, { message: 'shop.py indexed' });
  await kiln('openFile', file, 6, 1, 8, 1);
  await refactorDialog('refactor.extractMethod', { name: 'apply_tax' });
  await waitFor(async () => /apply_tax/.test(await win.textContent(sel('refactor-preview'))), { message: 'preview shows the new function' });
  await shot('14-refactor-python-preview');
  assert.equal(fs.readFileSync(file, 'utf8'), SHOP, 'nothing changes before Refactor');
  await applyRefactoring();
  await waitFor(() => /def apply_tax\(subtotal, discount\):/.test(fs.readFileSync(file, 'utf8')), { message: 'extracted function saved' });
  assert.match(await kiln('getActiveContent'), /result = apply_tax\(subtotal, discount\)/);

  await kiln('openFile', file, 4, 6);
  await refactorDialog('refactor.safeDelete', { state: 'blocked' });
  await win.waitForSelector(sel('refactor-usage'));
  assert.match(await win.textContent(sel('refactor-usages')), /total\(\[1, 2\], 1\)/);
  await win.keyboard.press('Escape');
  await waitFor(async () => !(await win.$(sel('refactor-dialog'))), { message: 'dialog closed' });
  assert.match(fs.readFileSync(file, 'utf8'), /def total/, 'nothing deleted');
});

test('terminal runs commands in the project', { timeout: 60000 }, async () => {
  await run('view.terminal');
  await win.waitForSelector(sel('terminal-panel'));
  await waitFor(async () => (await kiln('terminalText')).length > 0, { message: 'shell prompt' });
  await kiln('terminalSend', 'echo kiln-$((40+2))\r');
  await waitFor(async () => (await kiln('terminalText')).includes('kiln-42'), { message: 'terminal output' });
  // The terminal fills its tool window: the panel inside the slot used to collapse to its content, so
  // xterm (which sizes itself to its container) got 0 px and showed nothing although commands ran.
  const size = await win.evaluate(() => {
    const slot = document.querySelector('.tool-window.bottom').getBoundingClientRect().height;
    const screen = document.querySelector('[data-testid="terminal-panel"] .xterm-screen');
    return { slot, screen: screen ? screen.getBoundingClientRect().height : 0 };
  });
  assert.ok(size.screen > 100 && size.screen >= size.slot - 90, `terminal is ${size.screen}px tall in a ${size.slot}px tool window`);
  await shot('05-terminal');
});

test('commit tool window commits the checked files', { timeout: 60000 }, async () => {
  await run('view.commit');
  await win.waitForSelector(sel('commit-panel'));
  await waitFor(async () => (await win.$$(sel('change-row'))).length >= 3, { message: 'changes listed' });
  await win.fill(sel('commit-message'), 'Initial commit from Kiln');
  await win.click(sel('commit-button'));
  await waitFor(async () => (await win.$$(sel('change-row'))).length === 0, { message: 'changes committed' });
  const dir = path.join(workspace, 'e2e_py');
  assert.match(git(dir, 'log', '-1', '--format=%s'), /Initial commit from Kiln/);
});

test('branch popup shows local branches and deletes them with the X icon', { timeout: 90000 }, async () => {
  const dir = path.join(workspace, 'e2e_py');
  git(dir, 'branch', 'feature-merged');
  git(dir, 'checkout', '-q', '-b', 'feature-unmerged');
  fs.writeFileSync(path.join(dir, 'extra.py'), 'X = 1\n');
  git(dir, 'add', 'extra.py');
  git(dir, 'commit', '-q', '-m', 'unmerged work');
  git(dir, 'checkout', '-q', 'main');
  await waitFor(async () => (await win.textContent(sel('branch-widget'))).includes('main'), { message: 'branch widget shows main' });
  await win.click(sel('branch-widget'));
  await win.waitForSelector(sel('branch-popup'));
  await waitFor(async () => (await win.$$(sel('branch-row'))).length >= 3, { message: 'three local branches' });
  assert.equal(await win.$(sel('branch-row', '[data-branch="main"] [data-testid="branch-delete"]')), null, 'current branch has no delete icon');
  await shot('05-branch-popup');
  // Merged branch: one confirmation.
  await win.hover(sel('branch-row', '[data-branch="feature-merged"]'));
  await win.click(sel('branch-row', '[data-branch="feature-merged"] [data-testid="branch-delete"]'));
  await win.click(sel('dialog-confirm'));
  await waitFor(() => !git(dir, 'branch', '--list', 'feature-merged').trim(), { message: 'merged branch deleted' });
  // Unmerged branch: confirmation, then force confirmation.
  if (!(await win.$(sel('branch-popup')))) await win.click(sel('branch-widget'));
  await win.hover(sel('branch-row', '[data-branch="feature-unmerged"]'));
  await win.click(sel('branch-row', '[data-branch="feature-unmerged"] [data-testid="branch-delete"]'));
  await win.click(sel('dialog-confirm'));
  await win.waitForSelector(sel('dialog-confirm', '[data-force="true"]'));
  await win.click(sel('dialog-confirm', '[data-force="true"]'));
  await waitFor(() => !git(dir, 'branch', '--list', 'feature-unmerged').trim(), { message: 'unmerged branch force-deleted' });
  await win.keyboard.press('Escape');
});

test('stash: create, inspect and pop', { timeout: 60000 }, async () => {
  const dir = path.join(workspace, 'e2e_py');
  fs.appendFileSync(path.join(dir, 'main.py'), '\n# stashed change\n');
  await run('view.commit');
  await win.click(sel('stash-tab'));
  await waitFor(async () => !(await win.isDisabled(sel('stash-changes'))), { message: 'stash enabled' });
  await win.click(sel('stash-changes'));
  await win.fill(sel('stash-message'), 'e2e stash');
  await win.click(sel('dialog-confirm'));
  await waitFor(async () => (await win.$$(sel('stash-row'))).length === 1, { message: 'stash listed' });
  assert.ok(!fs.readFileSync(path.join(dir, 'main.py'), 'utf8').includes('stashed change'));
  await win.click(sel('stash-row'));
  await waitFor(async () => (await win.$$(sel('stash-file'))).length >= 1, { message: 'stash files' });
  await win.click(sel('stash-pop'));
  await waitFor(async () => (await win.$$(sel('stash-row'))).length === 0, { message: 'stash popped' });
  assert.ok(fs.readFileSync(path.join(dir, 'main.py'), 'utf8').includes('stashed change'));
});

test('branch changes and diff viewer', { timeout: 60000 }, async () => {
  const dir = path.join(workspace, 'e2e_py');
  git(dir, 'stash', '-u');
  git(dir, 'checkout', '-q', '-b', 'feature-c');
  fs.writeFileSync(path.join(dir, 'feature_c.py'), 'def c():\n    return 3\n');
  git(dir, 'add', 'feature_c.py');
  git(dir, 'commit', '-q', '-m', 'feature c');
  await run('view.commit');
  await win.click(sel('branch-changes-tab'));
  await waitFor(async () => (await win.textContent(sel('branch-changes'))).includes('feature_c.py'), { message: 'branch change listed' });
  await win.dblclick(sel('branch-change-file', '[data-path="feature_c.py"]'));
  await win.waitForSelector(sel('diff-view'));
  await shot('06-diff');
  git(dir, 'checkout', '-q', 'main');
});

test('merge conflicts: the Conflicts dialog, accept a side, resolve per conflict in the merge view, commit the merge', { timeout: 120000 }, async () => {
  const dir = path.join(workspace, 'e2e_py');
  const commitAll = (msg) => {
    git(dir, 'add', 'rates.py', 'notes.txt');
    git(dir, 'commit', '-q', '-m', msg);
  };
  fs.writeFileSync(path.join(dir, 'rates.py'), 'BASE = 1\nRATE = 1\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'note: base\n');
  commitAll('rates');
  git(dir, 'checkout', '-q', '-b', 'feature-rates');
  fs.writeFileSync(path.join(dir, 'rates.py'), 'BASE = 1\nRATE = 2\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'note: theirs\n');
  commitAll('feature rates');
  git(dir, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'rates.py'), 'BASE = 1\nRATE = 3\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'note: ours\n');
  commitAll('main rates');
  assert.throws(() => git(dir, 'merge', '--no-edit', 'feature-rates'), 'the merge stops on conflicts');

  await run('view.commit');
  await win.click(sel('commit-tab'));
  await win.waitForSelector(sel('resolve-conflicts'), { timeout: 30000 });
  await win.click(sel('resolve-conflicts'));
  await win.waitForSelector(sel('conflicts-dialog'));
  await waitFor(async () => (await win.$$(sel('conflict-row'))).length === 2, { message: 'two conflicted files' });
  await shot('17-conflicts');
  await win.click(sel('conflict-row', '[data-path="notes.txt"] [data-testid="conflict-theirs"]'));
  await waitFor(async () => (await win.$$(sel('conflict-row'))).length === 1, { message: 'notes.txt resolved' });
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'note: theirs\n');

  await win.click(sel('conflict-row', '[data-path="rates.py"] [data-testid="conflict-merge"]'));
  await win.waitForSelector(sel('merge-conflict'), { timeout: 30000 });
  assert.match(await win.textContent(sel('merge-conflict')), /RATE = 3[\s\S]*RATE = 1[\s\S]*RATE = 2/, 'yours, base and theirs');
  assert.equal(await win.isDisabled(sel('merge-apply')), true, 'cannot apply with conflicts left');
  await shot('18-merge-view');
  await win.click(sel('merge-accept-both'));
  await waitFor(async () => (await win.getAttribute(sel('merge-view'), 'data-unresolved')) === '0', { message: 'conflict resolved' });
  await win.click(sel('merge-apply'));
  await waitFor(() => fs.readFileSync(path.join(dir, 'rates.py'), 'utf8') === 'BASE = 1\nRATE = 3\nRATE = 2\n', { message: 'result written' });
  await waitFor(() => !/^U|^AA|^DD/m.test(git(dir, 'status', '--porcelain')), { message: 'no unmerged paths' });

  await run('git.resolveConflicts');
  await win.waitForSelector(sel('conflicts-finish'), { timeout: 20000 });
  await win.click(sel('conflicts-finish'));
  await waitFor(() => /Merge branch 'feature-rates'/.test(git(dir, 'log', '-1', '--format=%s')), { message: 'merge committed' });
});

test('tests (pytest): gutter icons run and debug a test, rerun failed, coverage marks the lines that ran', { timeout: 400000 }, async () => {
  const dir = path.join(workspace, 'e2e_py');
  const testFile = path.join(dir, 'tests', 'test_calc.py');
  fs.writeFileSync(path.join(dir, 'calc.py'), 'def add(a, b):\n    return a + b\n\n\ndef unused():\n    return 0\n');
  fs.writeFileSync(testFile, 'from calc import add\n\n\ndef test_add():\n    total = add(1, 2)\n    assert total == 4\n');
  await run('view.tests');
  await win.waitForSelector(sel('test-project', '[data-kind="python"]'), { timeout: 60000 });
  await win.waitForSelector(sel('test-row', '[data-name="test_add"]'), { timeout: 60000 });

  // Gutter icon: Run, and the result shows on the icon and in the Tests window.
  await kiln('openFile', testFile, 4, 1);
  await gutterTest(4, "Run 'test_add'");
  await waitFor(async () => (await outcome('test_add')) === 'failed', { timeout: 120000, message: 'test_add failed' });
  await win.waitForSelector('.test-glyph.failed');
  await shot('19-tests-failed');

  // Fix it; Rerun Failed runs only the failed test.
  fs.writeFileSync(testFile, 'from calc import add\n\n\ndef test_add():\n    total = add(1, 2)\n    assert total == 3\n');
  await win.click(sel('tests-rerun-failed'));
  await waitFor(async () => (await outcome('test_add')) === 'passed', { timeout: 120000, message: 'test_add passes after the fix' });
  assert.equal(await win.isDisabled(sel('tests-rerun-failed')), true, 'no failed tests left');

  // Coverage: unused() never runs.
  await win.click(sel('tests-run-coverage'));
  await win.waitForSelector(sel('coverage-summary'), { timeout: 240000 });
  const calc = path.join(dir, 'calc.py');
  const pct = Number(await win.getAttribute(sel('coverage-row', `[data-path="${calc}"]`), 'data-percent'));
  assert.ok(pct > 0 && pct < 100, `calc.py partly covered (${pct}%)`);
  await kiln('openFile', calc, 1, 1);
  await win.waitForSelector('.cov-hit');
  await win.waitForSelector('.cov-miss');
  await shot('20-coverage');
  await win.click(sel('tests-toggle-coverage'));
  await waitFor(async () => !(await win.$('.cov-miss')), { message: 'coverage hidden' });

  // Debug Test stops at a breakpoint in the test.
  await kiln('openFile', testFile, 5, 1);
  await kiln('toggleBreakpoint', testFile, 5);
  await gutterTest(4, "Debug 'test_add'");
  await waitFor(async () => (await win.getAttribute(sel('debug-panel'), 'data-state').catch(() => null)) === 'stopped', { timeout: 180000, message: 'paused in test_add' });
  assert.match(await win.textContent(sel('debug-frame')), /test_add/);
  await win.click(sel('debug-resume'));
  await waitFor(async () => (await win.getAttribute(sel('debug-panel'), 'data-state')) === 'terminated', { timeout: 60000, message: 'test finished' });
  await kiln('toggleBreakpoint', testFile, 5);
});

test('split editor: split right and down, the same file in both splits, drag tabs between splits, pin, unsplit, restore', { timeout: 180000 }, async () => {
  const dir = path.join(workspace, 'e2e_py');
  const main = path.join(dir, 'main.py');
  const calc = path.join(dir, 'calc.py');
  const groupsCount = async () => (await win.$$(sel('editor-group'))).length;
  const tabIn = (g, name) => sel('editor-tabs', `[data-group="${g}"] [data-testid="editor-tab"][data-name="${name}"]`);
  if (!fs.existsSync(calc)) fs.writeFileSync(calc, 'def add(a, b):\n    return a + b\n');
  await kiln('openFile', calc, 1, 1);
  await kiln('openFile', main, 1, 1);
  await win.click(sel('editor-tab', '[data-name="main.py"]'), { button: 'right' });
  await win.click(sel('menu-item', '[data-label="Split Right"]'));
  await waitFor(async () => (await groupsCount()) === 2, { message: 'two splits' });
  const right = (await win.$$eval(sel('editor-group'), (els) => els.map((e) => e.dataset.group)))[1];
  await win.waitForSelector(tabIn(right, 'main.py'));
  assert.equal(await win.getAttribute(sel('editor-group', `[data-group="${right}"]`), 'data-active'), 'true', 'the new split is focused');

  // One document in both splits: an edit shows in both.
  const original = fs.readFileSync(main, 'utf8');
  await kiln('setActiveContent', original + '# from the right split\n');
  await waitFor(async () => (await kiln('groupTexts')).every((x) => x && x.includes('# from the right split')), { message: 'edit visible in both splits' });
  await kiln('setActiveContent', original);
  await run('file.save');

  // Drag calc.py from the left split onto the right split's tab bar: it moves.
  await win.dragAndDrop(tabIn('g1', 'calc.py'), sel('editor-tabs', `[data-group="${right}"]`));
  await win.waitForSelector(tabIn(right, 'calc.py'));
  await waitFor(async () => !(await win.$(tabIn('g1', 'calc.py'))), { message: 'calc.py left the first split' });
  await shot('22-split-editor');

  // Pinned tabs survive Close All Tabs of their split.
  await win.click(tabIn(right, 'calc.py'), { button: 'right' });
  await win.click(sel('menu-item', '[data-label="Pin Tab"]'));
  await waitFor(async () => (await win.getAttribute(tabIn(right, 'calc.py'), 'data-pinned')) === 'true', { message: 'calc.py pinned' });
  const rightTabs = await win.$$eval(sel('editor-tabs', `[data-group="${right}"] [data-testid="editor-tab"]`), (els) => els.map((e) => e.dataset.name));
  assert.equal(rightTabs[0], 'calc.py', 'pinned tabs come first');
  await win.click(tabIn(right, 'main.py'), { button: 'right' });
  await win.click(sel('menu-item', '[data-label="Close All Tabs"]'));
  await waitFor(async () => !(await win.$(tabIn(right, 'main.py'))), { message: 'unpinned tab closed' });
  assert.ok(await win.$(tabIn(right, 'calc.py')), 'pinned tab kept');

  // Split down: a nested split.
  await run('editor.splitDown');
  await waitFor(async () => (await groupsCount()) === 3 && !!(await win.$(sel('editor-split', '[data-dir="column"]'))), { message: 'split down' });
  await run('editor.unsplit');
  await waitFor(async () => (await groupsCount()) === 2, { message: 'unsplit one' });

  // Splits and pinned tabs come back when the project is opened again.
  await run('project.close');
  await win.waitForSelector(sel('welcome'));
  await run('project.openPath', dir);
  await waitFor(async () => (await groupsCount()) === 2, { timeout: 30000, message: 'splits restored' });
  await waitFor(async () => !!(await win.$(sel('editor-tab', '[data-name="calc.py"][data-pinned="true"]'))), { message: 'pinned tab restored' });

  await run('editor.unsplitAll');
  await waitFor(async () => (await groupsCount()) === 1, { message: 'unsplit all' });
  assert.ok(await win.$(sel('editor-tab', '[data-name="calc.py"]')) && (await win.$(sel('editor-tab', '[data-name="main.py"]'))), 'every tab is in the remaining split');
});

test('git: commit individual lines; log actions - tag, cherry-pick, revert, interactive rebase, reset', { timeout: 240000 }, async () => {
  const dir = path.join(workspace, 'e2e_py');
  const g = (...a) => git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...a);
  const subject = (rev = 'HEAD') => git(dir, 'log', '-1', '--format=%s', rev).trim();
  const logMenu = async (subj, label) => {
    const row = sel('log-row', `[data-subject=${JSON.stringify(subj)}]`);
    await waitFor(async () => !!(await win.$(row)), { timeout: 20000, message: `log shows "${subj}"` });
    await win.click(row, { button: 'right' });
    await win.click(sel('menu-item', `[data-label^="${label}"]`));
  };

  // Commit only one of two changes in a file.
  const file = path.join(dir, 'lines.txt');
  fs.writeFileSync(file, 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
  g('add', 'lines.txt');
  g('commit', '-q', '-m', 'lines');
  fs.writeFileSync(file, 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n');
  await run('view.commit');
  await win.click(sel('commit-tab'));
  await win.waitForSelector(sel('change-row', '[data-path="lines.txt"]'), { timeout: 30000 });
  await win.click(sel('change-row', '[data-path="lines.txt"] [data-testid="change-lines-toggle"]'));
  await waitFor(async () => (await win.$$(sel('change-lines', '[data-path="lines.txt"] [data-testid="hunk"]'))).length === 2, { message: 'two hunks' });
  await win.uncheck(sel('change-lines', '[data-path="lines.txt"] [data-testid="hunk"]:nth-child(1) [data-testid="hunk-check"]'));
  await waitFor(async () => (await win.getAttribute(sel('change-row', '[data-path="lines.txt"]'), 'data-partial')) === 'true', { message: 'lines.txt partly selected' });
  await shot('23-commit-lines');
  const others = await win.$$eval(sel('change-row'), (els) => els.map((e) => e.dataset.path).filter((p) => p !== 'lines.txt'));
  for (const p of others) await win.uncheck(sel('change-row', `[data-path="${p}"] input[type="checkbox"]`));
  await win.fill(sel('commit-message'), 'add eleven only');
  await win.click(sel('commit-button'));
  await waitFor(() => subject() === 'add eleven only', { message: 'line commit' });
  assert.equal(git(dir, 'show', 'HEAD:lines.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n', 'only the second change is committed');
  assert.match(fs.readFileSync(file, 'utf8'), /^ONE\n/, 'the other change is still in the working tree');
  fs.writeFileSync(file, git(dir, 'show', 'HEAD:lines.txt'));

  // Log: New Tag on a commit.
  await run('view.git');
  await win.waitForSelector(sel('git-panel'));
  await logMenu('add eleven only', 'New Tag');
  await win.fill(sel('tag-name'), 'e2e-tag');
  await win.click(sel('dialog-confirm'));
  await waitFor(() => git(dir, 'tag', '-l', 'e2e-tag').trim() === 'e2e-tag', { message: 'tag created' });

  // Cherry-pick a commit from another branch, then revert it.
  g('checkout', '-q', '-b', 'pick-src');
  fs.writeFileSync(path.join(dir, 'picked.txt'), 'picked\n');
  g('add', 'picked.txt');
  g('commit', '-q', '-m', 'commit to pick');
  g('checkout', '-q', 'main');
  await win.click(sel('git-branch-row', '[data-branch="pick-src"]'));
  await logMenu('commit to pick', 'Cherry-Pick');
  await waitFor(() => subject() === 'commit to pick', { message: 'cherry-picked onto main' });
  await win.click(sel('git-branches', ' .list-row:first-child'));
  await logMenu('commit to pick', 'Revert Commit');
  await waitFor(() => subject() === 'Revert "commit to pick"', { message: 'reverted' });
  assert.ok(!fs.existsSync(path.join(dir, 'picked.txt')));

  // Interactive rebase: squash the second commit into the first, drop the third.
  for (const n of ['r1', 'r2', 'r3']) {
    fs.writeFileSync(path.join(dir, `${n}.txt`), `${n}\n`);
    g('add', `${n}.txt`);
    g('commit', '-q', '-m', `rebase ${n}`);
  }
  await logMenu('rebase r1', 'Interactively Rebase from Here');
  await win.waitForSelector(sel('rebase-dialog'));
  assert.deepEqual(await win.$$eval(sel('rebase-row'), (els) => els.map((e) => e.dataset.subject)), ['rebase r1', 'rebase r2', 'rebase r3'], 'oldest first');
  await win.selectOption(sel('rebase-action-1'), 'squash');
  await win.selectOption(sel('rebase-action-2'), 'drop');
  await shot('24-interactive-rebase');
  await win.click(sel('rebase-start'));
  await waitFor(() => /^rebase r1\n\nrebase r2$/.test(git(dir, 'log', '-1', '--format=%B').trim()), { message: 'squashed' });
  assert.ok(fs.existsSync(path.join(dir, 'r2.txt')) && !fs.existsSync(path.join(dir, 'r3.txt')), 'r3 dropped');

  // Reset (mixed) to the revert: the squashed commit's changes stay as local changes.
  const before = git(dir, 'rev-parse', 'HEAD~1').trim();
  await logMenu('Revert "commit to pick"', 'Reset Current Branch to Here');
  await win.waitForSelector(sel('reset-dialog'));
  await win.click(sel('reset-mode-mixed'));
  await win.click(sel('reset-confirm'));
  await waitFor(() => git(dir, 'rev-parse', 'HEAD').trim() === before, { message: 'reset' });
  assert.ok(fs.existsSync(path.join(dir, 'r1.txt')), 'mixed reset keeps the files');
  assert.match(git(dir, 'status', '--porcelain'), /\?\? r1\.txt/);
});

test('AI features: inline completion, Generate Documentation and Tests with a preview, review before commit', { timeout: 240000 }, async () => {
  const dir = path.join(workspace, 'e2e_py');
  const file = path.join(dir, 'ai_demo.py');
  fs.writeFileSync(file, 'def square(x):\n    \n');
  await win.evaluate(() => window.kiln.invoke('app:updateSettings', { ai: { inlineCompletion: true } }));
  await kiln('openFile', file, 2, 5);
  // Inline completion: ghost text at the caret, Tab accepts it.
  await run('ai.completeHere');
  await waitFor(async () => !!(await win.$('.ghost-text-decoration, .ghost-text')), { timeout: 30000, message: 'ghost text' });
  await shot('25-inline-completion');
  await win.keyboard.press('Tab');
  await waitFor(async () => /def square\(x\):\n {4}return x \* x/.test(await kiln('getActiveContent')), { message: 'completion accepted' });
  await run('file.save');
  await win.evaluate(() => window.kiln.invoke('app:updateSettings', { ai: { inlineCompletion: false } }));

  // Generate Documentation: a preview, then the docstring is in the file.
  await kiln('openFile', file, 2, 5);
  await waitFor(async () => (await kiln('indexHas', 'square')) === true, { message: 'ai_demo.py indexed' });
  await run('ai.generateDocs');
  await win.waitForSelector(sel('ai-preview'));
  await waitFor(async () => (await win.getAttribute(sel('ai-preview-state'), 'data-state')) === 'ready', { message: 'docs preview' });
  assert.match(await win.textContent(sel('ai-preview-hunks')), /Return x squared/);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Return x squared/, 'nothing is written before Apply');
  await shot('26-generate-docs');
  await win.click(sel('ai-apply'));
  await waitFor(() => /"{3}Return x squared\."{3}/.test(fs.readFileSync(file, 'utf8')), { message: 'docstring saved' });

  // Generate Tests: a new test file, opened in the editor.
  await kiln('openFile', file, 3, 5);
  await run('ai.generateTests');
  await waitFor(async () => (await win.getAttribute(sel('ai-preview-state'), 'data-state').catch(() => null)) === 'ready', { message: 'tests preview' });
  await win.click(sel('ai-apply'));
  const testFile = path.join(dir, 'tests', 'test_ai_demo.py');
  await waitFor(() => fs.existsSync(testFile) && /def test_square/.test(fs.readFileSync(testFile, 'utf8')), { message: 'test file written' });
  await win.waitForSelector(sel('editor-tab', '[data-name="test_ai_demo.py"]'));

  // Review the changes before committing them, then commit anyway.
  await run('view.commit');
  await win.click(sel('commit-tab'));
  await waitFor(async () => !!(await win.$(sel('change-row', '[data-path="ai_demo.py"]'))), { message: 'ai_demo.py listed' });
  await commitOnly('ai_demo.py');
  await win.fill(sel('commit-message'), 'Add square');
  await win.click(sel('commit-review'));
  await waitFor(async () => (await win.getAttribute(sel('ai-review-state'), 'data-state').catch(() => null)) === 'ready', { message: 'review' });
  assert.match(await win.textContent(sel('ai-finding')), /ai_demo\.py:3.*does not check/);
  await shot('27-review-changes');
  await win.click(sel('ai-review-commit'));
  await waitFor(() => git(dir, 'log', '-1', '--format=%s').trim() === 'Add square', { message: 'committed after the review' });
});

test('AI features with Claude: a commit message written from the diff; Explain Exception sends the trace and the code', { skip: process.env.KILN_E2E_SKIP_CLAUDE === '1', timeout: 240000 }, async () => {
  const dir = path.join(workspace, 'e2e_py');
  fs.appendFileSync(path.join(dir, 'ai_demo.py'), '\n\ndef cube(x):\n    return x * x * x\n');
  await run('view.commit');
  await win.click(sel('commit-tab'));
  await waitFor(async () => !!(await win.$(sel('change-row', '[data-path="ai_demo.py"]'))), { message: 'change listed' });
  await commitOnly('ai_demo.py');
  await win.fill(sel('commit-message'), '');
  await win.click(sel('commit-generate'));
  await waitFor(async () => (await win.inputValue(sel('commit-message'))).trim().length > 5, { timeout: 180000, message: 'commit message from Claude' });
  const msg = await win.inputValue(sel('commit-message'));
  assert.ok(msg.split('\n')[0].length <= 72, `subject line is short: ${msg.split('\n')[0]}`);
  assert.match(msg, /cube/i, `the message is about the change: ${msg}`);
  await shot('28-commit-message');

  const trace = `Traceback (most recent call last):\n  File "${path.join(dir, 'ai_demo.py')}", line 4, in square\n    return x * x\nTypeError: can't multiply sequence by non-int of type 'str'`;
  await kiln('claudeConfigure', { model: 'haiku', permissionMode: 'default' });
  await run('ai.explainException', trace);
  await waitFor(async () => {
    const items = await win.evaluate(() => { const c = window.__kiln.store.get().claude; return (c.chats[c.active] || { items: [] }).items.filter((i) => i.kind === 'user').map((i) => i.text); });
    const last = items[items.length - 1] || '';
    return /Explain this exception/.test(last) && /ai_demo\.py:4/.test(last) && /return x \* x/.test(last);
  }, { message: 'explain prompt with the trace and the code' });
  await win.evaluate(() => window.__kiln.run('claude.newChat'));
});

test('creates a C# console project, builds it, runs it', { skip: !has('dotnet'), timeout: 500000 }, async () => {
  const { dir } = await createProject('dotnet-console', 'E2eCs');
  await waitBuild('success');
  assert.ok(fs.existsSync(path.join(dir, 'E2eCs', 'E2eCs.csproj')));
  await waitFor(async () => (await win.textContent(sel('run-config'))).includes('E2eCs'), { message: 'dotnet run configuration' });
  await win.click(sel('run-button'));
  await waitFor(async () => /Hello/.test(await kiln('runText')), { timeout: 180000, message: 'dotnet output' });
  await shot('07-csharp');
});

test('go to definition and find usages', { skip: !has('dotnet'), timeout: 120000 }, async () => {
  const dir = path.join(workspace, 'E2eCs');
  fs.writeFileSync(path.join(dir, 'E2eCs', 'Calculator.cs'), 'namespace E2eCs;\n\npublic static class Calculator\n{\n    public static int Add(int a, int b) => a + b;\n}\n');
  fs.writeFileSync(path.join(dir, 'E2eCs', 'Program.cs'), 'using E2eCs;\n\nConsole.WriteLine("Hello, World!");\nConsole.WriteLine(Calculator.Add(1, 2));\nConsole.WriteLine(Calculator.Add(3, 4));\n');
  await waitFor(async () => (await kiln('indexHas', 'Add')) === true, { message: 'index picks up the new method' });
  await kiln('openFile', path.join(dir, 'E2eCs', 'Program.cs'), 4, 32);
  await run('navigate.definition');
  await waitFor(async () => {
    const c = await kiln('cursor');
    return c.file.endsWith('Calculator.cs') && c.line === 5;
  }, { message: 'jumped to Calculator.Add' });
  await run('navigate.usages');
  await win.waitForSelector(sel('usages-panel'));
  await waitFor(async () => (await win.$$(sel('usage-row'))).length >= 2, { message: 'usages listed' });
  await shot('08-usages');
});

test('debugs the C# project: breakpoint in a method, locals, stop', { skip: !has('dotnet'), timeout: 300000 }, async () => {
  const calc = path.join(workspace, 'E2eCs', 'E2eCs', 'Calculator.cs');
  await kiln('openFile', calc, 5, 1);
  await kiln('toggleBreakpoint', calc, 5);
  await waitFor(async () => (await win.textContent(sel('run-config'))).includes('E2eCs'), { message: 'dotnet run configuration' });
  await win.click(sel('debug-button'));
  await waitFor(async () => (await win.getAttribute(sel('debug-panel'), 'data-state')) === 'stopped', { timeout: 240000, message: 'paused in Calculator.Add' });
  assert.match(await win.textContent(sel('debug-frame')), /Add/);
  await waitFor(async () => (await win.$$(sel('debug-variable', '[data-name="a"]'))).length > 0, { message: 'C# locals listed' });
  assert.match(await win.textContent(sel('debug-variable', '[data-name="a"]')), /\b1\b/);
  await shot('08b-debug-csharp');
  await win.click(sel('debug-stop'));
  await waitFor(async () => (await win.getAttribute(sel('debug-panel'), 'data-state')) === 'terminated', { timeout: 30000, message: 'debug session stopped' });
  await kiln('toggleBreakpoint', calc, 5);
});

test('refactor C#: change signature updates the calls; Roslyn extract method through csharp-ls', { skip: !has('dotnet'), timeout: 600000 }, async () => {
  const dir = path.join(workspace, 'E2eCs', 'E2eCs');
  const calc = path.join(dir, 'Calculator.cs');
  const program = path.join(dir, 'Program.cs');
  await kiln('openFile', calc, 5, 30);
  await refactorDialog('refactor.changeSignature');
  await win.click(sel('sig-down-0'));
  await waitFor(async () => /Add\(int b, int a\)/.test(await win.textContent(sel('sig-preview'))), { message: 'signature preview' });
  await waitFor(async () => /Program\.cs/.test(await win.textContent(sel('refactor-preview'))), { message: 'calls in Program.cs previewed' });
  await shot('15-refactor-change-signature');
  await applyRefactoring();
  await waitFor(() => /Calculator\.Add\(2, 1\)/.test(fs.readFileSync(program, 'utf8')), { message: 'calls reordered' });
  assert.match(fs.readFileSync(calc, 'utf8'), /Add\(int b, int a\)/);

  // Roslyn, through csharp-ls (installed into the tools folder kept between test runs).
  if (!fs.existsSync(path.join(toolsDir, 'csharp-ls'))) execFileSync('dotnet', ['tool', 'install', 'csharp-ls', '--version', '0.16.0', '--tool-path', toolsDir], { stdio: 'ignore', timeout: 300000 });
  const text = 'namespace E2eCs;\n\npublic static class Calculator\n{\n    public static int Add(int b, int a)\n    {\n        var sum = a + b;\n        return sum * 2;\n    }\n}\n';
  await kiln('openFile', calc, 1, 1);
  await kiln('setActiveContent', text);
  await run('file.save');
  await waitFor(() => fs.readFileSync(calc, 'utf8') === text, { message: 'Calculator.cs saved' });
  await win.evaluate(() => window.kiln.invoke('lsp:restart', 'csharp'));
  await waitFor(async () => ['ready', 'busy'].includes(await kiln('lspState', 'csharp')), { timeout: 240000, message: 'csharp-ls started' });
  const req = { file: calc, text, start: text.indexOf('a + b'), end: text.indexOf('a + b') + 5 };
  await waitFor(async () => (await win.evaluate((r) => window.kiln.invoke('refactor:available', r), req)).items.some((i) => i.kind === 'extractMethod' && i.engine === 'roslyn'), { timeout: 240000, interval: 2000, message: 'Roslyn offers Extract Method' });
  await kiln('openFile', calc, 7, 19, 7, 24);
  await refactorDialog('refactor.extractMethod', { name: 'Sum' });
  assert.equal(await win.getAttribute(sel('refactor-state'), 'data-kind'), 'extractMethod');
  await applyRefactoring();
  await waitFor(() => /var sum = Sum\(b, a\);/.test(fs.readFileSync(calc, 'utf8')) && /private static int Sum\(int b, int a\)\n    \{\n        return a \+ b;/.test(fs.readFileSync(calc, 'utf8')), { message: 'Roslyn extracted Sum' });
  assert.doesNotMatch(fs.readFileSync(calc, 'utf8'), /NewMethod/);
});

test('knowledge graph visualizer shows files and functions', { timeout: 60000 }, async () => {
  await run('view.knowledgeGraph');
  await win.waitForSelector(sel('knowledge-graph'));
  await waitFor(async () => Number(await win.getAttribute(sel('knowledge-graph'), 'data-node-count')) > 0, { message: 'graph nodes' });
  await shot('09-knowledge-graph');
});

test('message flow diagram shows Kafka topics, services and databases', { timeout: 60000 }, async () => {
  const dir = path.join(workspace, 'E2eCs');
  fs.writeFileSync(path.join(dir, 'E2eCs', 'Publisher.cs'), 'using Confluent.Kafka;\npublic class Publisher {\n  IProducer<string,string> _p;\n  public async Task Send() { await _p.ProduceAsync("orders", new Message<string,string>()); _db.Orders.Add(null); await _db.SaveChangesAsync(); }\n}\n');
  fs.mkdirSync(path.join(dir, 'worker'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'worker', 'consumer.py'), 'from kafka import KafkaConsumer\nconsumer = KafkaConsumer("orders")\n');
  await run('view.messageFlow');
  await win.waitForSelector(sel('message-flow'));
  await run('flow.refresh');
  await waitFor(async () => (await win.$$(sel('flow-node'))).length >= 3, { message: 'flow nodes' });
  assert.match(await win.textContent(sel('message-flow')), /orders/);
  await shot('10-message-flow');
});

test('theme can be switched', async () => {
  await run('view.settings');
  await win.waitForSelector(sel('settings-dialog'));
  await win.selectOption(sel('theme-select'), 'dracula');
  await waitFor(async () => (await win.evaluate(() => document.documentElement.dataset.theme)) === 'dracula', { message: 'theme applied' });
  await shot('11-theme');
  await win.selectOption(sel('theme-select'), 'rider-dark');
  await win.keyboard.press('Escape');
});

test('keyboard shortcuts can be customized in the keymap', { timeout: 60000 }, async () => {
  await run('view.settings', 'keymap');
  await win.waitForSelector(sel('keymap-section'));
  await win.fill(sel('keymap-search'), 'Find in Files');
  await win.click(sel('keymap-add', '[data-command="edit.findInFiles"]'));
  await win.waitForSelector(sel('keymap-recorder', '[data-listening="true"]'));
  await win.keyboard.press('Alt+Shift+KeyY');
  await win.click(sel('keymap-save'));
  await waitFor(async () => (await win.textContent(sel('keymap-row', '[data-command="edit.findInFiles"]'))).includes('⌥⇧Y'), { message: 'new shortcut listed' });
  await shot('11b-keymap');
  await win.keyboard.press('Escape');
  await win.waitForSelector(sel('settings-dialog'), { state: 'detached' });
  await win.keyboard.press('Alt+Shift+KeyY');
  await win.waitForSelector(sel('find-in-files'));
  await win.keyboard.press('Escape');
  await run('view.settings', 'keymap');
  await win.click(sel('keymap-reset-all'));
  await win.click(sel('dialog-confirm'));
  await waitFor(async () => !(await win.textContent(sel('keymap-section'))).includes('⌥⇧Y'), { message: 'keymap reset' });
  await win.keyboard.press('Escape');
});

test('a custom theme can be created, edited live, saved and deleted', { timeout: 60000 }, async () => {
  const cssVar = (name) => win.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  await run('view.settings', 'themes');
  await win.waitForSelector(sel('theme-editor'));
  await win.click(sel('theme-new'));
  await waitFor(async () => /^custom-/.test(await win.evaluate(() => document.documentElement.dataset.theme)), { message: 'custom theme active' });
  await win.fill(sel('theme-color-base.editor'), '#102030');
  await win.press(sel('theme-color-base.editor'), 'Enter');
  await waitFor(async () => (await cssVar('--bg-editor')) === '#102030', { message: 'editor background applied live' });
  await win.fill(sel('theme-color-syntax.keyword'), '#ff00aa');
  await win.press(sel('theme-color-syntax.keyword'), 'Enter');
  await waitFor(async () => (await cssVar('--syn-keyword')) === '#ff00aa', { message: 'syntax color applied live' });
  await shot('11c-theme-editor');
  await waitFor(() => {
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    return (saved.customThemes || []).some((t) => t.base && t.base.editor === '#102030' && t.syntax.keyword === '#ff00aa');
  }, { message: 'theme saved to settings' });
  await win.click(sel('theme-delete'));
  await win.click(sel('dialog-confirm'));
  await waitFor(async () => !/^custom-/.test(await win.evaluate(() => document.documentElement.dataset.theme)), { message: 'back to a built-in theme' });
  await win.keyboard.press('Escape');
});

test('search everywhere finds files', async () => {
  await run('navigate.searchEverywhere');
  await win.waitForSelector(sel('search-everywhere'));
  await win.keyboard.type('Program');
  await waitFor(async () => (await win.textContent(sel('search-everywhere'))).includes('Program.cs'), { message: 'search result' });
  await win.keyboard.press('Escape');
});

test('local history keeps versions of edited files', async () => {
  const file = path.join(workspace, 'E2eCs', 'E2eCs', 'Program.cs');
  await kiln('openFile', file, 1, 1);
  await kiln('setActiveContent', (await kiln('getActiveContent')) + '\n// edited\n');
  await run('file.save');
  await run('file.localHistory');
  await win.waitForSelector(sel('local-history'));
  await waitFor(async () => (await win.$$(sel('history-row'))).length >= 1, { message: 'history versions' });
  await win.keyboard.press('Escape');
});

test('skills panel lists Claude skills and the knowledge-graph MCP server', { timeout: 120000 }, async () => {
  await run('view.skills');
  await win.waitForSelector(sel('skills-panel'));
  await waitFor(async () => (await win.$$(sel('skill-item'))).length > 0, { timeout: 80000, message: 'skills listed' });
  await shot('12-skills');
  await win.click(sel('skills-tab-mcp'));
  await waitFor(async () => /connected/.test((await win.textContent(sel('mcp-item', '[data-name="kiln-knowledge-graph"]')).catch(() => '')) || ''), { timeout: 30000, message: 'knowledge-graph MCP server connected' });
});

test('AI agents get the knowledge graph (skill, MCP server, use-first instructions) and it includes variables', { timeout: 120000 }, async () => {
  const dir = path.join(workspace, 'E2eCs');
  fs.writeFileSync(path.join(dir, 'E2eCs', 'Counter.cs'), 'namespace E2eCs;\n\npublic class Counter\n{\n    private int _count;\n\n    public void Inc() => _count++;\n\n    public int Value() => _count;\n}\n');
  await waitFor(async () => (await kiln('indexHas', 'Inc')) === true, { message: 'index picks up Counter' });
  await run('view.settings', 'agents');
  await win.waitForSelector(sel('agents-section'));
  await win.waitForSelector(sel('agent-row', '[data-agent="claude"]'));
  await win.click(sel('agents-install'));
  await waitFor(async () => /Installed/.test(await win.textContent(sel('agent-row', '[data-agent="claude"]'))), { message: 'installed for Claude Code' });
  assert.match(fs.readFileSync(path.join(agentHome, '.claude/skills/kiln-knowledge-graph/SKILL.md'), 'utf8'), /description: Use FIRST/);
  assert.match(fs.readFileSync(path.join(agentHome, '.claude/CLAUDE.md'), 'utf8'), /use the Kiln knowledge graph first/i);
  assert.match(fs.readFileSync(path.join(agentHome, '.codex/config.toml'), 'utf8'), /\[mcp_servers\.kiln-knowledge-graph\]/);
  await shot('12b-agents');
  await win.keyboard.press('Escape');
  // An agent's view of the same graph, through the CLI the skill uses
  const cliOut = (args) => JSON.parse(execFileSync(process.execPath, [path.join(APP, 'src/agent-tools/kg-cli.js'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, KILN_USER_DATA: userData } }));
  await waitFor(() => {
    try {
      return cliOut(['variable', '_count']).matches[0].writers.some((w) => w.name === 'Inc');
    } catch {
      return false;
    }
  }, { message: 'agent CLI sees who writes _count' });
  const sym = cliOut(['symbol', 'Calculator.Add']);
  assert.ok(sym.matches[0].callers.length >= 1, 'Add has callers');
});

test('GitHub connection works through the gh login or an access token', { timeout: 60000 }, async () => {
  let ghLoggedIn = false;
  try {
    execFileSync('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'ignore' });
    ghLoggedIn = true;
  } catch {
    ghLoggedIn = false;
  }
  const tokenSet = !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  await run('view.settings', 'vcs');
  await win.waitForSelector(sel('vcs-section'));
  await waitFor(async () => !/Loading/.test(await win.textContent(sel('github-effective')).catch(() => 'Loading')), { message: 'status loaded' });
  const effective = await win.textContent(sel('github-effective'));
  if (ghLoggedIn) assert.match(effective, /GitHub CLI/);
  else if (tokenSet) assert.match(effective, /access token/);
  await win.click(sel('github-test'));
  await win.waitForSelector(sel('github-result'), { timeout: 40000 });
  const result = await win.textContent(sel('github-result'));
  if (ghLoggedIn || tokenSet) assert.match(result, /Connected as \S+/);
  else assert.match(result, /Not connected/);
  await shot('12c-github');
  await win.keyboard.press('Escape');
});

test('importing a Go / Java / Rust / Ruby / PHP project builds its knowledge graph; the main-branch graph follows main', { timeout: 180000 }, async () => {
  const dir = path.join(workspace, 'polyglot');
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    'cmd/server.go': 'package main\n\nvar requests int\n\nfunc handle() int {\n\trequests++\n\treturn requests\n}\n\nfunc main() { handle() }\n',
    'src/App.java': 'public class App {\n  private int hits;\n  public int hit() { hits += 1; return hits; }\n}\n',
    'src/lib.rs': 'pub fn parse(x: i32) -> i32 { x * 2 }\n',
    'lib/report.rb': 'def summarize(rows)\n  rows.size\nend\n',
    'web/index.php': '<?php\nfunction render($t) { return strtoupper($t); }\n',
    'scripts/run.sh': 'start() {\n  echo up\n}\nstart\n',
    'native/math.cpp': 'int square(int x) { return x * x; }\n',
  };
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'add', '-A');
  git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'initial');
  await run('project.openPath', dir);
  await waitFor(async () => (await win.textContent(sel('project-widget'))).includes('polyglot'), { message: 'polyglot project open' });
  for (const name of ['handle', 'hit', 'parse', 'summarize', 'render', 'start', 'square']) {
    await waitFor(async () => (await kiln('indexHas', name)) === true, { message: `index has ${name}` });
  }
  const knowledge = path.join(userData, 'knowledge');
  await waitFor(() => fs.existsSync(knowledge) && fs.readdirSync(knowledge).some((f) => f.startsWith('polyglot-') && !f.includes('@')), { message: 'graph saved automatically' });
  const cli = (args) => JSON.parse(execFileSync(process.execPath, [path.join(APP, 'src/agent-tools/kg-cli.js'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, KILN_USER_DATA: userData } }));
  assert.ok(cli(['variable', 'requests']).matches[0].writers.some((w) => w.name === 'handle'), 'Go variable writes in the graph');

  // Main-branch graph: on a feature branch, a commit lands on main and the graph follows it.
  await waitFor(async () => (await win.getAttribute(sel('branch-graph-status'), 'data-state').catch(() => null)) === 'ready', { message: 'main-branch graph ready' });
  git(dir, 'checkout', '-q', '-b', 'feature-x');
  const wt = path.join(tmp('kiln-e2e-wt-'), 'main');
  git(dir, 'worktree', 'add', '-q', wt, 'main');
  fs.writeFileSync(path.join(wt, 'cmd', 'metrics.go'), 'package main\n\nfunc mergedOnMain() int { return handle() }\n');
  git(wt, 'add', '-A');
  git(wt, '-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'merged on main');
  const mainSha = git(dir, 'rev-parse', 'main').trim();
  git(dir, 'worktree', 'remove', '--force', wt);
  await waitFor(async () => (await win.getAttribute(sel('branch-graph-status'), 'data-commit')) === mainSha, { timeout: 60000, message: 'main graph synced in the background' });
  await run('view.mainGraph');
  await waitFor(async () => (await win.getAttribute(sel('knowledge-graph', '[data-source="main"]'), 'data-node-count').catch(() => '0')) > 0, { message: 'main graph shown' });
  const onMain = await win.evaluate(async () => (await window.kiln.invoke('code:graph', { mode: 'all', source: 'main' })).nodes.some((n) => n.label === 'mergedOnMain'));
  const inWork = await win.evaluate(async () => (await window.kiln.invoke('code:graph', { mode: 'all' })).nodes.some((n) => n.label === 'mergedOnMain'));
  assert.equal(onMain, true, 'the commit on main is in the main graph');
  assert.equal(inWork, false, 'the working tree (feature-x) does not have it');
  assert.equal(cli(['symbol', 'mergedOnMain', '--ref', 'main']).matches.length, 1, 'agents see it with ref main');
  await shot('12d-main-graph');
});

test('message flow: the real topic, consumer group and database names come from the deployment files', { timeout: 180000 }, async () => {
  const dir = path.join(workspace, 'shop-deploy');
  const files = {
    'orders/package.json': JSON.stringify({ name: 'orders', dependencies: { kafkajs: '^2.2.4' } }),
    'orders/producer.js': "const { Kafka } = require('kafkajs');\nconst producer = new Kafka({ brokers: ['k:9092'] }).producer();\nasync function publish(order) {\n  await producer.send({ topic: process.env.ORDERS_TOPIC || 'orders-local', messages: [{ value: JSON.stringify(order) }] });\n}\nmodule.exports = { publish };\n",
    'billing/requirements.txt': 'kafka-python\nsqlalchemy\npsycopg2-binary\n',
    'billing/worker.py': 'import os\nfrom kafka import KafkaConsumer\n\n\nclass Invoice(Base):\n    __tablename__ = "invoices"\n\n\nconsumer = KafkaConsumer(os.getenv("ORDERS_TOPIC", "orders"), group_id=os.getenv("GROUP_ID", "billing-local"))\nfor msg in consumer:\n    session.add(Invoice(order=msg.value))\n',
    'deploy/prod/orders.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: orders\nspec:\n  template:\n    spec:\n      containers:\n        - name: orders\n          image: registry.example.com/shop/orders:2.0.1\n          envFrom:\n            - configMapRef:\n                name: shop-topics\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shop-topics\ndata:\n  ORDERS_TOPIC: shop.orders.v1\n',
    'deploy/prod/billing.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: billing\nspec:\n  template:\n    spec:\n      containers:\n        - name: billing\n          env:\n            - name: ORDERS_TOPIC\n              value: shop.orders.v1\n            - name: GROUP_ID\n              value: billing-prod\n            - name: DATABASE_URL\n              valueFrom:\n                secretKeyRef:\n                  name: billing-db\n                  key: url\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: billing-db\nstringData:\n  url: postgresql://billing:pw@pg.prod.internal:5432/billing_prod\n',
    'deploy/dev/billing.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: billing\nspec:\n  template:\n    spec:\n      containers:\n        - name: billing\n          env:\n            - name: ORDERS_TOPIC\n              value: shop.orders.v1\n            - name: GROUP_ID\n              value: billing-dev\n            - name: DATABASE_URL\n              value: postgresql://billing:pw@localhost:5432/billing_dev\n',
    'deploy/kafka/topics.yaml': 'apiVersion: kafka.strimzi.io/v1beta2\nkind: KafkaTopic\nmetadata:\n  name: shop.orders.v1\nspec:\n  partitions: 12\n  replicas: 3\n---\napiVersion: kafka.strimzi.io/v1beta2\nkind: KafkaTopic\nmetadata:\n  name: shop.refunds.v1\nspec:\n  partitions: 3\n',
  };
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  await run('project.openPath', dir);
  await waitFor(async () => (await win.textContent(sel('project-widget'))).includes('shop-deploy'), { message: 'project open' });
  await run('view.messageFlow');
  await win.waitForSelector(sel('message-flow'));
  await run('flow.refresh');
  const node = (label) => sel('flow-node', `[data-label="${label}"]`);
  await waitFor(async () => !!(await win.$(node('shop.orders.v1'))) && !!(await win.$(node('billing_prod'))), { timeout: 60000, message: 'real topic and database names' });
  const topicLabels = await win.$$eval(sel('flow-node', '[data-type="topic"]'), (els) => els.map((e) => e.dataset.label));
  assert.deepEqual(topicLabels, ['shop.orders.v1'], 'the deployed topic, not the defaults in the code (orders-local, orders)');
  assert.ok((await win.$$eval('.flow-edge-label', (els) => els.map((e) => e.textContent))).includes('group billing-prod'), 'the production consumer group');
  // Nodes may sit under the toolbar after the graph is fitted to the canvas: click the node itself.
  await win.locator(node('shop.orders.v1')).dispatchEvent('click');
  await win.waitForSelector(sel('flow-topic-sources'));
  assert.match(await win.textContent(sel('flow-topic-sources')), /production[\s\S]*shop\.orders\.v1[\s\S]*prod\/orders\.yaml/);
  assert.match(await win.textContent(sel('flow-topic-declared')), /12 partitions · 3 replicas/);
  assert.match(await win.textContent(sel('flow-group-sources')), /billing-prod[\s\S]*billing-dev/);
  await shot('32-message-flow-deployment');
  // The database column may be drawn beyond the visible canvas: click the node itself.
  await win.locator(node('billing_prod')).dispatchEvent('click');
  await win.waitForSelector(sel('flow-db-sources-variants'));
  assert.match(await win.textContent(sel('flow-db-sources-variants')), /production\s*billing_prod[\s\S]*development\s*billing_dev/);
  assert.doesNotMatch(await win.textContent(sel('message-flow')), /billing:pw/, 'no credentials are shown');
  await win.click(sel('message-flow'), { position: { x: 30, y: 300 } });
  await waitFor(async () => /shop\.refunds\.v1/.test(await win.textContent(sel('flow-unused-topics')).catch(() => '')), { message: 'declared topics no code uses' });
});

test('creates a JavaScript project and runs it', { timeout: 300000 }, async () => {
  const { dir } = await createProject('node-app', 'e2e-node');
  await waitBuild('success');
  assert.ok(fs.existsSync(path.join(dir, 'package.json')));
  await waitFor(async () => /start/.test(await win.textContent(sel('run-config'))), { message: 'npm start configuration' });
  await win.click(sel('run-button'));
  await waitFor(async () => /Hello/.test(await kiln('runText')), { message: 'node output' });
});

test('refactor JavaScript: Refactor This lists what applies; introduce variable and change signature', { timeout: 300000 }, async () => {
  const dir = path.join(workspace, 'e2e-node');
  const file = path.join(dir, 'price.js');
  fs.writeFileSync(file, "'use strict';\n\nfunction total(items, discount) {\n  const subtotal = items.reduce((s, i) => s + i, 0);\n  return subtotal * 1.2 - discount;\n}\n\nconsole.log(total([1, 2], 1));\n\nmodule.exports = { total };\n");
  await waitFor(async () => (await kiln('indexHas', 'total')) === true, { message: 'price.js indexed' });
  await kiln('openFile', file, 5, 10, 5, 24);
  await refactorDialog('refactor.introduceVariable', { name: 'gross' });
  await applyRefactoring();
  await waitFor(() => /const gross = subtotal \* 1\.2;\n  return gross - discount;/.test(fs.readFileSync(file, 'utf8')), { message: 'variable introduced' });

  await kiln('openFile', file, 3, 11);
  await run('refactor.this');
  await win.waitForSelector(sel('refactor-this'));
  const labels = await win.$$eval(sel('popup-item'), (els) => els.map((e) => e.getAttribute('data-label')));
  for (const l of ['Rename…', 'Change Signature…', 'Safe Delete…']) assert.ok(labels.includes(l), `Refactor This offers ${l} (got ${labels.join(', ')})`);
  await shot('16-refactor-this');
  await win.click(sel('popup-item', '[data-label="Change Signature…"]'));
  await win.waitForSelector(sel('signature-editor'));
  await win.click(sel('sig-add'));
  await win.fill(sel('sig-name-2'), 'currency');
  await win.fill(sel('sig-value-2'), "'EUR'");
  await waitFor(async () => (await win.getAttribute(sel('refactor-state'), 'data-state')) === 'ready' && /currency/.test(await win.textContent(sel('refactor-preview'))), { message: 'preview with the new parameter' });
  await applyRefactoring();
  await waitFor(() => /function total\(items, discount, currency\)/.test(fs.readFileSync(file, 'utf8')) && /total\(\[1, 2\], 1, 'EUR'\)/.test(fs.readFileSync(file, 'utf8')), { message: 'signature and call updated' });
});

test('tests (node:test): gutter icons, results, coverage and Debug Test in JavaScript', { timeout: 300000 }, async () => {
  const dir = path.join(workspace, 'e2e-node');
  const testFile = path.join(dir, 'test', 'price.test.js');
  fs.writeFileSync(path.join(dir, 'tax.js'), "'use strict';\n\nfunction withTax(x) {\n  if (x < 0) {\n    throw new Error('negative');\n  }\n  return x * 1.2;\n}\n\nmodule.exports = { withTax };\n");
  fs.writeFileSync(testFile, "'use strict';\nconst { describe, test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { withTax } = require('../tax');\n\ndescribe('price', () => {\n  test('adds tax', () => {\n    const v = withTax(10);\n    assert.equal(v, 12);\n  });\n});\n");
  await run('view.tests');
  await win.waitForSelector(sel('test-project', '[data-kind="node"]'), { timeout: 60000 });
  await kiln('openFile', testFile, 7, 1);
  await gutterTest(7, "Run 'adds tax'");
  await waitFor(async () => (await outcome('price adds tax')) === 'passed', { timeout: 120000, message: 'price adds tax passed' });
  await win.waitForSelector('.test-glyph.passed');

  await win.click(sel('tests-run-coverage'));
  await waitFor(async () => !!(await win.$(sel('coverage-row', `[data-path="${path.join(dir, 'tax.js')}"]`))), { timeout: 120000, message: 'tax.js coverage' });
  await kiln('openFile', path.join(dir, 'tax.js'), 1, 1);
  await win.waitForSelector('.cov-miss');

  await kiln('openFile', testFile, 8, 1);
  await kiln('toggleBreakpoint', testFile, 8);
  await gutterTest(7, "Debug 'adds tax'");
  await waitFor(async () => (await win.getAttribute(sel('debug-panel'), 'data-state').catch(() => null)) === 'stopped', { timeout: 120000, message: 'paused in the JavaScript test' });
  assert.match(await win.textContent(sel('debug-frame')), /price\.test\.js:8/);
  await win.click(sel('debug-resume'));
  await waitFor(async () => (await win.getAttribute(sel('debug-panel'), 'data-state')) === 'terminated', { timeout: 60000, message: 'test finished' });
  await kiln('toggleBreakpoint', testFile, 8);
});

test('Claude edits a file and the IDE shows it live', { skip: process.env.KILN_E2E_SKIP_CLAUDE === '1', timeout: 240000 }, async () => {
  const dir = path.join(workspace, 'e2e-node');
  await run('view.claude');
  await win.waitForSelector(sel('claude-panel'));
  await kiln('claudeConfigure', { model: 'haiku', permissionMode: 'acceptEdits' });
  await win.fill(sel('claude-input'), 'Create a file named claude_e2e.txt in the project root containing exactly the text: hello from claude. Do nothing else.');
  await win.click(sel('claude-send'));
  await waitFor(() => fs.existsSync(path.join(dir, 'claude_e2e.txt')), { timeout: 200000, message: 'file written by Claude' });
  assert.match(fs.readFileSync(path.join(dir, 'claude_e2e.txt'), 'utf8'), /hello from claude/);
  await waitFor(async () => (await win.$$(sel('tool-card'))).length > 0, { message: 'tool call shown in chat' });
  await win.waitForSelector(sel('editor-tab', '[data-name="claude_e2e.txt"]'), { timeout: 30000 });
  await shot('13-claude');
});

test('tests (.NET xUnit): Debug Test attaches to the test host and stops in the test; coverage from coverlet', { skip: !has('dotnet'), timeout: 900000 }, async () => {
  const { dir } = await createProject('dotnet-classlib-tests', 'E2eLib');
  await waitBuild('success');
  const find = (d, name) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory() && !/^(bin|obj|\.git)$/.test(e.name)) {
        const f = find(p, name);
        if (f) return f;
      }
    }
    return null;
  };
  const testFile = find(dir, 'CalculatorTests.cs');
  fs.writeFileSync(testFile, 'namespace E2eLib.Tests;\n\npublic class CalculatorTests\n{\n    [Fact]\n    public void Add_ReturnsSum()\n    {\n        var sum = Calculator.Add(2, 3);\n        Assert.Equal(5, sum);\n    }\n}\n');
  await run('view.tests');
  await win.waitForSelector(sel('test-project', '[data-kind="dotnet"]'), { timeout: 60000 });
  await kiln('openFile', testFile, 8, 1);
  await kiln('toggleBreakpoint', testFile, 8);
  await gutterTest(6, "Debug 'Add_ReturnsSum'");
  await waitFor(async () => (await win.getAttribute(sel('debug-panel'), 'data-state').catch(() => null)) === 'stopped', { timeout: 400000, message: 'paused in the xUnit test' });
  assert.match(await win.textContent(sel('debug-frame')), /Add_ReturnsSum/);
  await shot('21-debug-dotnet-test');
  await win.click(sel('debug-resume'));
  await waitFor(async () => (await win.getAttribute(sel('debug-panel'), 'data-state')) === 'terminated', { timeout: 120000, message: 'test host finished' });
  await kiln('toggleBreakpoint', testFile, 8);

  await run('view.tests');
  await win.click(sel('tests-run-coverage'));
  const calc = find(dir, 'Calculator.cs');
  await waitFor(async () => Number(await win.getAttribute(sel('coverage-row', `[data-path="${calc}"]`), 'data-percent').catch(() => -1)) === 100, { timeout: 400000, message: 'Calculator.cs covered (coverlet)' });
  await waitFor(async () => (await outcome('E2eLib.Tests.CalculatorTests.Add_ReturnsSum')) === 'passed', { message: 'xUnit test passed' });
});

/** Click the Send button (code lens) above an endpoint (`code`: a line of it, scrolled into view). */
async function sendLens(label, code) {
  // Code lenses outside the visible lines are not shown; a reload of the file (written by the test)
  // scrolls to the change, so reveal the endpoint until its button shows.
  const lens = win.locator(`.codelens-decoration a:has-text("${label}")`).locator('visible=true').first();
  await waitFor(async () => {
    await kiln('revealText', code);
    return lens.isVisible();
  }, { timeout: 60000, interval: 500, message: `the ${label} button` });
  await lens.click();
  await win.waitForSelector(sel('endpoint-dialog'));
}
const status = () => win.getAttribute(sel('endpoint-response'), 'data-status');

test('endpoints (FastAPI): Send above each endpoint calls the running app, which reads and writes its database', { timeout: 600000 }, async () => {
  const { dir } = await createProject('python-fastapi', 'e2e_api');
  await waitBuild('success');
  const main = path.join(dir, 'main.py');
  fs.writeFileSync(main, `"""Notes API."""
import os
import sqlite3

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="notes")
# The database the app is configured with; a local SQLite file when none is.
DB = os.environ.get("NOTES_DB", "notes.db")


def db():
    con = sqlite3.connect(DB)
    con.execute("create table if not exists notes (id integer primary key, text text not null)")
    return con


class Note(BaseModel):
    text: str


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/notes")
def create_note(note: Note):
    with db() as con:
        cur = con.execute("insert into notes (text) values (?)", (note.text,))
        return {"id": cur.lastrowid, "text": note.text}


@app.get("/notes/{note_id}")
def read_note(note_id: int):
    with db() as con:
        row = con.execute("select id, text from notes where id = ?", (note_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Note not found")
    return {"id": row[0], "text": row[1]}
`);
  await kiln('openFile', main, 1, 1);
  // POST: the app is not running yet - Send starts it, then calls the endpoint.
  await sendLens('Send POST /notes', '@app.post("/notes")');
  await waitFor(async () => /starts/.test(await win.textContent(sel('endpoint-target'))), { message: 'the dialog says the app will be started' });
  assert.match(await win.inputValue(sel('endpoint-body')), /"text": "string"/, 'example body from the model');
  await win.fill(sel('endpoint-body'), '{"text": "hello from kiln"}');
  await win.click(sel('endpoint-send'));
  await waitFor(async () => (await status()) === '200', { timeout: 180000, message: 'POST /notes answered' });
  assert.match(await win.textContent(sel('endpoint-response-body')), /"id": 1[\s\S]*hello from kiln/);
  await shot('29-endpoint-post');
  const rows = execFileSync('python3', ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("select text from notes").fetchall())', path.join(dir, 'notes.db')], { encoding: 'utf8' });
  assert.match(rows, /hello from kiln/, 'the row is in the database');
  await win.keyboard.press('Escape');

  // GET with a path parameter, on the app that is now running.
  await sendLens('Send GET /notes/{note_id}', '@app.get("/notes/{note_id}")');
  await waitFor(async () => /Sends to http/.test(await win.textContent(sel('endpoint-target'))), { message: 'the running app is found' });
  await win.fill(sel('endpoint-param-note_id'), '1');
  await win.click(sel('endpoint-send'));
  await waitFor(async () => (await status()) === '200', { timeout: 30000, message: 'GET /notes/1' });
  assert.match(await win.textContent(sel('endpoint-response-body')), /hello from kiln/);
  await win.fill(sel('endpoint-param-note_id'), '999');
  await win.click(sel('endpoint-send'));
  await waitFor(async () => (await status()) === '404', { timeout: 30000, message: 'GET /notes/999 is a 404' });
  await win.keyboard.press('Escape');

  await run('view.endpoints');
  await waitFor(async () => (await win.$$(sel('endpoint-row'))).length >= 3, { message: 'Endpoints tool window' });
  assert.deepEqual(await win.$$eval(sel('endpoint-row'), (els) => els.map((e) => `${e.dataset.method} ${e.dataset.path}`)), ['GET /health', 'POST /notes', 'GET /notes/{note_id}']);
  await shot('30-endpoints');
  await run('run.stop');
});

test('endpoints (Express): Send starts npm start and calls the route with its path parameter', { timeout: 400000 }, async () => {
  const { dir } = await createProject('node-express', 'e2e-express');
  await waitBuild('success');
  const server = path.join(dir, 'server.js');
  await kiln('openFile', server, 1, 1);
  await sendLens('Send GET /hello/:name', "app.get('/hello/:name'");
  await win.fill(sel('endpoint-param-name'), 'kiln');
  await win.click(sel('endpoint-send'));
  await waitFor(async () => (await status()) === '200', { timeout: 120000, message: 'GET /hello/kiln' });
  assert.match(await win.textContent(sel('endpoint-response-body')), /Hello, kiln!/);
  await win.keyboard.press('Escape');
  await run('run.stop');
});

test('endpoints (ASP.NET Core): Send starts dotnet run and calls the minimal API', { skip: !has('dotnet'), timeout: 600000 }, async () => {
  const { dir } = await createProject('dotnet-webapi', 'E2eApi');
  await waitBuild('success');
  const program = (function find(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === 'Program.cs') return p;
      if (e.isDirectory() && !/^(bin|obj|\.git)$/.test(e.name)) {
        const f = find(p);
        if (f) return f;
      }
    }
    return null;
  })(dir);
  await kiln('openFile', program, 1, 1);
  await sendLens('Send GET /weatherforecast', 'app.MapGet("/weatherforecast"');
  await win.click(sel('endpoint-send'));
  await waitFor(async () => (await status()) === '200', { timeout: 300000, message: 'GET /weatherforecast' });
  assert.match(await win.textContent(sel('endpoint-response-body')), /temperatureC/);
  await shot('31-endpoint-aspnet');
  await win.keyboard.press('Escape');
  await run('run.stop');
});
