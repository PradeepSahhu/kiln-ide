'use strict';
// End-to-end tests: launch the real Kiln IDE (Electron) and drive it like a user.
// Written from the product spec; the UI exposes stable data-testid hooks and a small window.__kiln
// test API (command runner + editor/terminal accessors).
//
//   npm run test:e2e                      full suite
//   KILN_E2E_SKIP_CLAUDE=1 npm run test:e2e   skip the test that sends one small prompt to Claude
const { test, before, after } = require('node:test');
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
fs.mkdirSync(shots, { recursive: true });

async function shot(name) {
  try {
    await win.screenshot({ path: path.join(shots, `${name}.png`) });
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

before(async () => {
  app = await electron.launch({ args: [APP], cwd: APP, env: { ...process.env, KILN_USER_DATA: userData, KILN_E2E: '1', KILN_AGENT_HOME: agentHome }, timeout: 90000 });
  win = await app.firstWindow();
  win.on('pageerror', (err) => console.error('[renderer error]', err.message));
  await win.waitForSelector(sel('welcome'), { timeout: 60000 });
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

test('terminal runs commands in the project', { timeout: 60000 }, async () => {
  await run('view.terminal');
  await win.waitForSelector(sel('terminal-panel'));
  await waitFor(async () => (await kiln('terminalText')).length > 0, { message: 'shell prompt' });
  await kiln('terminalSend', 'echo kiln-$((40+2))\r');
  await waitFor(async () => (await kiln('terminalText')).includes('kiln-42'), { message: 'terminal output' });
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
  await win.waitForSelector(sel('keymap-recorder'));
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

test('creates a JavaScript project and runs it', { timeout: 300000 }, async () => {
  const { dir } = await createProject('node-app', 'e2e-node');
  await waitBuild('success');
  assert.ok(fs.existsSync(path.join(dir, 'package.json')));
  await waitFor(async () => /start/.test(await win.textContent(sel('run-config'))), { message: 'npm start configuration' });
  await win.click(sel('run-button'));
  await waitFor(async () => /Hello/.test(await kiln('runText')), { message: 'node output' });
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
