'use strict';
// IPC surface between the renderer and the main process. Every handler receives the calling
// window's ProjectContext as its first argument.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, ipcMain, dialog, shell, clipboard, BrowserWindow } = require('electron');
const settings = require('./settings');
const keymap = require('./keymap');
const agentIntegration = require('./services/agent-integration');
const { APP_ROOT } = require('./protocol');
const { loadShellEnv } = require('./env');
const { which, run, stream } = require('./util/proc');
const fsSvc = require('./services/fs');
const { searchText, searchTodos } = require('./services/search');
const { analyzeFlow } = require('./services/flow');
const { listAgents, agentById } = require('./services/agents');
const { formatText } = require('./services/format');
const githubAuth = require('./services/github-auth');
const github = require('./services/github');
const { listSkills, createSkill } = require('./services/skills');
const templates = require('./services/templates');
const { resolveInterpreter } = require('./services/python-env');

let toolchainCache = null;

async function toolchain(force) {
  if (toolchainCache && !force && Date.now() - toolchainCache.at < 60000) return toolchainCache.data;
  const tools = {};
  const probe = async (key, cmd, args, parse) => {
    const p = which(cmd);
    if (!p) {
      tools[key] = { found: false };
      return;
    }
    const r = await run(p, args, { timeout: 20000 });
    const out = (r.stdout || r.stderr || '').trim();
    tools[key] = { found: r.code === 0, path: p, version: r.code === 0 ? parse(out) : null, error: r.code === 0 ? null : out.split('\n')[0] };
  };
  await Promise.all([
    probe('dotnet', settings.get().dotnet.path || 'dotnet', ['--version'], (s) => s.split('\n')[0].trim()),
    probe('python', settings.get().python.interpreter || 'python3', ['--version'], (s) => s.replace(/^Python\s*/, '')),
    probe('git', 'git', ['--version'], (s) => s.replace(/^git version\s*/, '')),
    probe('node', 'node', ['--version'], (s) => s.replace(/^v/, '')),
    probe('uv', 'uv', ['--version'], (s) => s.split(/\s+/)[1] || s),
    probe('claudeCli', 'claude', ['--version'], (s) => s.split(/\s+/)[0]),
  ]);
  if (tools.dotnet.found) {
    const r = await run(tools.dotnet.path, ['--list-sdks'], { timeout: 20000 });
    tools.dotnet.sdks = r.stdout.split('\n').filter(Boolean).map((l) => l.split(' ')[0]);
  }
  try {
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8'));
    tools.claudeSdk = { found: true, version: pkg.version, claudeCode: pkg.claudeCodeVersion || null };
  } catch {
    tools.claudeSdk = { found: false };
  }
  toolchainCache = { at: Date.now(), data: tools };
  return tools;
}

function register({ getContext, createWindow, rebuildMenu, broadcast }) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      await loadShellEnv();
      const ctx = getContext(event.sender);
      if (!ctx) throw new Error('Window context not found');
      return fn(ctx, ...args);
    });
  };
  const listen = (channel, fn) => {
    ipcMain.on(channel, (event, ...args) => {
      const ctx = getContext(event.sender);
      if (ctx) fn(ctx, ...args);
    });
  };
  const needRoot = (ctx) => {
    if (!ctx.root) throw new Error('No project is open');
    return ctx.root;
  };

  // ---------------------------------------------------------------- app
  handle('app:info', () => ({ version: app.getVersion(), name: app.getName(), platform: process.platform, arch: process.arch, home: os.homedir(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, argv: process.argv.slice(1) }));
  handle('app:toolchain', (_ctx, force) => toolchain(force));
  handle('app:settings', () => settings.get());
  handle('app:updateSettings', (_ctx, partial) => {
    const s = settings.update(partial || {});
    broadcast('app:settingsChanged', s);
    return s;
  });
  handle('app:keymap', () => keymap.describe(settings.get()));
  handle('app:setKeybinding', (_ctx, id, list) => {
    const overrides = { ...(settings.get().keymap || {}) };
    if (list == null) delete overrides[id];
    else {
      const clean = (Array.isArray(list) ? list : [list]).map(keymap.normalizeAccelerator).filter(Boolean);
      overrides[id] = [...new Set(clean)];
    }
    const s = settings.replace('keymap', overrides);
    rebuildMenu();
    broadcast('app:settingsChanged', s);
    return keymap.describe(s);
  });
  handle('app:setKeymapPreset', (_ctx, preset, { keepOverrides = false } = {}) => {
    settings.replace('keymapPreset', keymap.PRESETS[preset] ? preset : 'rider');
    const s = keepOverrides ? settings.get() : settings.replace('keymap', {});
    rebuildMenu();
    broadcast('app:settingsChanged', s);
    return keymap.describe(s);
  });
  handle('app:resetKeymap', () => {
    const s = settings.replace('keymap', {});
    rebuildMenu();
    broadcast('app:settingsChanged', s);
    return keymap.describe(s);
  });
  // ------------------------------------------------- knowledge graph for agents
  // KILN_AGENT_HOME lets tests use a scratch home folder (and never touch the real Claude config).
  const agentHome = () => process.env.KILN_AGENT_HOME || os.homedir();
  const agentToolsDir = () => path.join(APP_ROOT, 'src', 'agent-tools').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const agentOpts = () => ({ home: agentHome(), node: which('node'), toolsDir: agentToolsDir(), ...(process.env.KILN_AGENT_HOME ? { runClaudeMcpAdd: async () => ({ ok: false, reason: 'test profile' }) } : {}) });
  handle('agents:kgStatus', () => ({ agents: agentIntegration.status({ home: agentHome() }), node: which('node'), cli: path.join(agentToolsDir(), 'kg-cli.js'), mcp: path.join(agentToolsDir(), 'kg-mcp.js'), suppressPrompt: !!process.env.KILN_E2E }));
  handle('agents:kgInstall', async (_ctx, ids) => {
    const o = agentOpts();
    if (!o.node) throw new Error('Node.js was not found on PATH; it runs the knowledge-graph tools for agents.');
    return agentIntegration.install({ ...o, agents: ids });
  });
  handle('agents:kgUninstall', (_ctx, ids) => agentIntegration.uninstall({ ...agentOpts(), agents: ids }));

  // ------------------------------------------------------------ themes
  const cleanTheme = (t) => ({ id: t.id, name: String(t.name || 'Custom Theme').slice(0, 60), type: t.type === 'light' ? 'light' : 'dark', basedOn: t.basedOn || null, base: t.base || {}, editor: t.editor || {}, syntax: t.syntax || {}, terminal: t.terminal && Array.isArray(t.terminal.ansi) ? { ansi: t.terminal.ansi.slice(0, 16) } : undefined });
  handle('app:saveCustomTheme', (_ctx, theme, { activate = false } = {}) => {
    if (!theme || typeof theme.id !== 'string' || !/^custom-[\w-]+$/.test(theme.id)) throw new Error('Invalid theme');
    const list = settings.get().customThemes || [];
    const i = list.findIndex((t) => t.id === theme.id);
    const next = i >= 0 ? list.map((t, j) => (j === i ? cleanTheme(theme) : t)) : [...list, cleanTheme(theme)];
    let s = settings.replace('customThemes', next);
    if (activate) s = settings.update({ theme: theme.id });
    broadcast('app:settingsChanged', s);
    return s;
  });
  handle('app:deleteCustomTheme', (_ctx, id) => {
    const list = settings.get().customThemes || [];
    const gone = list.find((t) => t.id === id);
    let s = settings.replace('customThemes', list.filter((t) => t.id !== id));
    if (s.theme === id) s = settings.update({ theme: (gone && gone.basedOn && !String(gone.basedOn).startsWith('custom-') && gone.basedOn) || 'rider-dark' });
    broadcast('app:settingsChanged', s);
    return s;
  });
  handle('app:exportTheme', async (ctx, name, content) => {
    const file = `${String(name || 'theme').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'theme'}.kiln-theme.json`;
    const r = await dialog.showSaveDialog(ctx.win, { title: 'Export Theme', defaultPath: path.join(os.homedir(), 'Downloads', file), filters: [{ name: 'Kiln theme', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, String(content));
    return r.filePath;
  });
  handle('app:readThemeFile', async (ctx) => {
    const r = await dialog.showOpenDialog(ctx.win, { title: 'Import Theme (Kiln or VS Code .json)', properties: ['openFile'], filters: [{ name: 'Color theme', extensions: ['json', 'jsonc'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    const st = fs.statSync(r.filePaths[0]);
    if (st.size > 4 * 1024 * 1024) throw new Error('The file is too large to be a color theme.');
    return { name: path.basename(r.filePaths[0]), content: fs.readFileSync(r.filePaths[0], 'utf8') };
  });

  handle('app:projectState', (ctx) => (ctx.root ? settings.getProjectState(ctx.root) : {}));
  handle('app:setProjectState', (ctx, partial) => (ctx.root ? settings.setProjectState(ctx.root, partial || {}) : {}));
  handle('app:recent', () => settings.get().recentProjects.filter((p) => fs.existsSync(p.path)));
  handle('app:removeRecent', (_ctx, p) => {
    const r = settings.removeRecent(p);
    rebuildMenu();
    return r;
  });
  handle('app:selectFolder', async (ctx, opts = {}) => {
    const r = await dialog.showOpenDialog(ctx.win, { title: opts.title || 'Open', defaultPath: opts.defaultPath || os.homedir(), buttonLabel: opts.buttonLabel || 'Open', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('app:selectFile', async (ctx, opts = {}) => {
    const r = await dialog.showOpenDialog(ctx.win, { title: opts.title || 'Select file', defaultPath: opts.defaultPath, properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('app:openExternal', (_ctx, url) => {
    if (/^(https?|mailto):/i.test(url)) return shell.openExternal(url);
    return false;
  });
  handle('app:showItemInFolder', (_ctx, p) => shell.showItemInFolder(p));
  handle('app:openPath', (_ctx, p) => shell.openPath(p));
  handle('app:newWindow', (_ctx, p) => {
    createWindow(p || null);
    return true;
  });
  handle('app:clipboard', (_ctx, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });
  handle('app:zoom', (ctx, delta) => {
    const wc = ctx.win.webContents;
    wc.setZoomLevel(delta ? Math.max(-3, Math.min(5, wc.getZoomLevel() + delta)) : 0);
    return wc.getZoomLevel();
  });
  handle('app:devtools', (ctx) => ctx.win.webContents.toggleDevTools());
  handle('app:reload', (ctx) => ctx.win.webContents.reloadIgnoringCache());
  listen('app:closeReady', (ctx) => {
    ctx.closeConfirmed = true;
    if (!ctx.win.isDestroyed()) ctx.win.close();
  });

  // -------------------------------------------------------------- debug
  handle('debug:check', (ctx, cfg) => ctx.debug.check(cfg));
  handle('debug:start', (ctx, cfg, opts) => ctx.debug.start(cfg, opts || {}));
  handle('debug:startFile', (ctx, file, opts) => ctx.debug.startFile(file, opts || {}));
  handle('debug:startTest', (ctx, projectId, testId, opts) => ctx.debug.startTest(projectId, testId, opts || {}));
  handle('debug:restart', (ctx) => ctx.debug.restart());
  handle('debug:stop', (ctx) => ctx.debug.stop());
  handle('debug:continue', (ctx, threadId) => ctx.debug.continue(threadId));
  handle('debug:pause', (ctx, threadId) => ctx.debug.pause(threadId));
  handle('debug:next', (ctx, threadId) => ctx.debug.next(threadId));
  handle('debug:stepIn', (ctx, threadId) => ctx.debug.stepIn(threadId));
  handle('debug:stepOut', (ctx, threadId) => ctx.debug.stepOut(threadId));
  handle('debug:threads', (ctx) => ctx.debug.threads());
  handle('debug:stackTrace', (ctx, threadId) => ctx.debug.stackTrace(threadId));
  handle('debug:scopes', (ctx, frameId) => ctx.debug.scopes(frameId));
  handle('debug:variables', (ctx, ref) => ctx.debug.variables(ref));
  handle('debug:evaluate', (ctx, expression, frameId, context) => ctx.debug.evaluate(expression, frameId, context));
  handle('debug:setVariable', (ctx, ref, name, value) => ctx.debug.setVariable(ref, name, value));
  handle('debug:setBreakpoints', (ctx, file, bps) => ctx.debug.setBreakpoints(file, bps || []));
  handle('debug:setBreakOnExceptions', (ctx, on) => ctx.debug.setBreakOnExceptions(on));
  handle('debug:state', (ctx) => ctx.debug.state());

  // ------------------------------------------------------------ project
  handle('project:open', (ctx, dir) => ctx.open(dir));
  handle('project:close', (ctx) => ctx.close());
  handle('project:detect', (ctx) => ctx.redetect());
  handle('project:interpreter', (ctx, dir) => resolveInterpreter(dir || needRoot(ctx), needRoot(ctx)));

  // ----------------------------------------------------------------- fs
  handle('fs:readDir', (_ctx, dir) => fsSvc.readDir(dir));
  handle('fs:readFile', (_ctx, file) => fsSvc.readFile(file));
  handle('fs:writeFile', (_ctx, file, content, opts) => fsSvc.writeFile(file, content, opts));
  handle('fs:createFile', (_ctx, file, content) => fsSvc.createFile(file, content));
  handle('fs:createDir', (_ctx, dir) => fsSvc.createDir(dir));
  handle('fs:rename', (_ctx, from, to) => fsSvc.rename(from, to));
  handle('fs:trash', (_ctx, target) => fsSvc.trash(target));
  handle('fs:exists', (_ctx, target) => fsSvc.exists(target));
  handle('fs:stat', (_ctx, target) => fsSvc.stat(target));
  handle('fs:listFiles', (ctx) => fsSvc.listFiles(needRoot(ctx), ctx.git.root));

  // ---------------------------------------------------------------- git
  const g = (name, fn) => handle(`git:${name}`, fn);
  g('info', (ctx) => ctx.git.info());
  g('status', (ctx) => ctx.git.status());
  g('branches', (ctx) => ctx.git.branches());
  g('defaultBase', (ctx) => ctx.git.defaultBase());
  g('checkout', (ctx, ref, opts) => ctx.git.checkout(ref, opts));
  g('smartCheckout', (ctx, ref, opts) => ctx.git.smartCheckout(ref, opts));
  g('createBranch', (ctx, name, opts) => ctx.git.createBranch(name, opts));
  g('deleteBranch', (ctx, name, opts) => ctx.git.deleteBranch(name, opts));
  g('restoreBranch', (ctx, name, sha) => ctx.git.restoreBranch(name, sha));
  g('renameBranch', (ctx, a, b) => ctx.git.renameBranch(a, b));
  g('merge', (ctx, ref) => ctx.git.merge(ref));
  g('rebase', (ctx, ref) => ctx.git.rebase(ref));
  g('abort', (ctx) => ctx.git.abort());
  g('conflicts', (ctx) => ctx.git.conflicts());
  g('mergeVersions', (ctx, rel) => ctx.git.mergeVersions(rel));
  g('resolveConflict', (ctx, rel, content) => ctx.git.resolveConflict(rel, content));
  g('acceptSide', (ctx, rel, side) => ctx.git.acceptSide(rel, side));
  g('continueOperation', (ctx) => ctx.git.continueOperation());
  g('fetch', (ctx) => ctx.git.fetch());
  g('pull', (ctx) => ctx.git.pull());
  g('push', (ctx, opts) => ctx.git.push(opts));
  g('remotes', (ctx) => ctx.git.remotes());
  g('log', (ctx, opts) => ctx.git.log(opts));
  g('commitDetails', (ctx, hash) => ctx.git.commitDetails(hash));
  g('lastCommitMessage', (ctx) => ctx.git.lastCommitMessage());
  g('fileHunks', (ctx, rel) => ctx.git.fileHunks(rel));
  g('cherryPick', (ctx, hash) => ctx.git.cherryPick(hash));
  g('revertCommit', (ctx, hash) => ctx.git.revertCommit(hash));
  g('reset', (ctx, hash, mode) => ctx.git.reset(hash, mode));
  g('createTag', (ctx, name, hash, message) => ctx.git.createTag(name, hash, message));
  g('deleteTag', (ctx, name) => ctx.git.deleteTag(name));
  g('rebasePlan', (ctx, hash) => ctx.git.rebasePlan(hash));
  g('interactiveRebase', (ctx, plan) => ctx.git.interactiveRebase(plan));
  g('stage', (ctx, paths) => ctx.git.stage(paths));
  g('unstage', (ctx, paths) => ctx.git.unstage(paths));
  g('rollback', (ctx, files) => ctx.git.rollback(files));
  g('commit', (ctx, opts) => ctx.git.commit(opts));
  g('stashList', (ctx) => ctx.git.stashList());
  g('stashFiles', (ctx, ref) => ctx.git.stashFiles(ref));
  g('stashPush', (ctx, opts) => ctx.git.stashPush(opts));
  g('stashApply', (ctx, ref, opts) => ctx.git.stashApply(ref, opts));
  g('stashDrop', (ctx, ref) => ctx.git.stashDrop(ref));
  g('stashBranch', (ctx, ref, name) => ctx.git.stashBranch(ref, name));
  g('branchChanges', (ctx, opts) => ctx.git.branchChanges(opts));
  g('fileVersions', (ctx, spec) => ctx.git.fileVersions(spec));
  g('init', async (ctx) => {
    const info = await ctx.git.initRepo(needRoot(ctx));
    // Restart the watcher so .git changes are observed.
    await ctx.open(ctx.root);
    return info;
  });
  g('clone', async (ctx, url, parentDir) => {
    const name = (url.split(/[/:]/).pop() || 'repo').replace(/\.git$/, '');
    const target = path.join(parentDir, name);
    if (fs.existsSync(target)) throw new Error(`${target} already exists`);
    const env = await github.gitEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
    const h = stream('git', ['clone', '--progress', url, target], { cwd: parentDir, env, onData: (d) => ctx.send('git:cloneProgress', { text: d }) });
    const code = await h.done;
    if (code !== 0) throw new Error(`git clone failed (exit code ${code})`);
    return target;
  });

  // GitHub connection (gh CLI login or access token) for clone / fetch / pull / push / publish.
  handle('git:githubStatus', () => github.status());
  handle('git:githubVerify', async (ctx) => {
    const r = await github.verify();
    if (r.ok && ctx.root && ctx.git.root) {
      const origin = (await ctx.git.remotes()).find((x) => x.name === 'origin');
      if (origin && github.parseGithubRemote(origin.url)) {
        const ls = await ctx.git.raw(['ls-remote', '--heads', 'origin'], { timeout: 30000 });
        r.remote = { url: origin.url, ok: ls.code === 0, message: ls.code === 0 ? 'origin is reachable' : (ls.stderr || '').trim().split('\n').pop() };
      }
    }
    return r;
  });
  handle('git:githubRepos', () => github.listRepos());
  handle('git:githubPublish', (ctx, opts) => ctx.git.publishToGithub(opts || {}));

  // -------------------------------------------------------------- build
  handle('build:start', (ctx, opts) => {
    needRoot(ctx);
    return ctx.build.start(opts || {});
  });
  handle('build:cancel', (ctx) => ctx.build.cancel());
  handle('build:state', (ctx) => ctx.build.state());
  handle('build:checkFile', (ctx, file) => ctx.build.checkPythonFile(file));

  // ---------------------------------------------------------------- run
  handle('run:configs', (ctx) => (ctx.root ? ctx.runs.configs() : []));
  handle('run:saveCustom', (ctx, list) => ctx.runs.saveCustom(list));
  handle('run:start', (ctx, cfg, size) => ctx.runs.start(cfg, size));
  handle('run:stop', (ctx, id) => ctx.runs.stop(id));
  handle('run:forget', (ctx, id) => ctx.runs.forget(id));
  listen('run:input', (ctx, id, data) => ctx.runs.input(id, data));
  listen('run:resize', (ctx, id, cols, rows) => ctx.runs.resize(id, cols, rows));

  // ----------------------------------------------------------- terminal
  handle('term:create', (ctx, opts) => {
    const o = { ...(opts || {}) };
    if (o.venv === undefined && ctx.root) {
      const interp = resolveInterpreter(ctx.root, ctx.root);
      if (interp && interp.venv) o.venv = interp.venv;
    }
    return ctx.terminals.create(o);
  });
  handle('term:kill', (ctx, id) => ctx.terminals.kill(id));
  listen('term:write', (ctx, id, data) => ctx.terminals.write(id, data));
  listen('term:resize', (ctx, id, cols, rows) => ctx.terminals.resize(id, cols, rows));

  // ------------------------------------------------------------- claude
  handle('claude:probe', (ctx, opts) => ctx.claude.probe(opts || {}));
  handle('claude:send', (ctx, chatId, payload) => {
    needRoot(ctx);
    return ctx.claude.send(chatId, payload);
  });
  handle('claude:respond', (ctx, chatId, requestId, decision) => ctx.claude.respond(chatId, requestId, decision));
  handle('claude:interrupt', (ctx, chatId) => ctx.claude.interrupt(chatId));
  handle('claude:configure', (ctx, chatId, opts) => ctx.claude.configure(chatId, opts || {}));
  handle('claude:close', (ctx, chatId) => ctx.claude.close(chatId));
  handle('claude:resume', (ctx, chatId, sessionId) => ctx.claude.resume(chatId, sessionId));
  handle('claude:sessions', (ctx) => (ctx.root ? ctx.claude.listSessions() : []));
  handle('claude:rewind', (ctx, chatId, uuid, dryRun) => ctx.claude.rewind(chatId, uuid, dryRun));
  handle('claude:contextUsage', (ctx, chatId) => ctx.claude.contextUsage(chatId));

  // ------------------------------------------------------------- skills
  handle('skills:list', async (ctx, opts = {}) => {
    const probe = opts.probe === false ? null : await ctx.claude.probe({ force: !!opts.force });
    return listSkills(ctx.root, probe);
  });
  handle('skills:create', (ctx, opts) => createSkill(needRoot(ctx), opts));

  // ------------------------------------------------------------- search
  handle('search:text', (ctx, opts) => searchText(needRoot(ctx), !!ctx.git.root, opts));

  // ------------------------------------------------------- code index
  // Navigation asks the language server first and falls back to the tree-sitter index.
  handle('code:status', (ctx) => ctx.index.status);
  handle('code:legend', (ctx) => ctx.index.call('legend', {}));
  handle('code:definition', async (ctx, { file, text, line, col, kind }) => {
    const lsp = await ctx.lsp.definition(file, line, col, kind);
    if (lsp && lsp.length) return { source: 'lsp', locations: lsp };
    const r = await ctx.index.call('definitions', { file, text, line, col });
    return { source: 'index', ctx: r.ctx, locations: r.defs.map((d) => ({ file: d.file, line: d.line, col: d.col, endCol: d.endCol, name: d.name, kind: d.kind, container: d.container, signature: d.signature })) };
  });
  handle('code:references', async (ctx, { file, text, line, col }) => {
    const c = await ctx.index.call('context', { file, text, line, col }).catch(() => null);
    const lsp = await ctx.lsp.references(file, line, col);
    if (lsp && lsp.length) {
      const lines = new Map();
      for (const l of lsp) {
        if (!lines.has(l.file)) lines.set(l.file, (fs.existsSync(l.file) ? fs.readFileSync(l.file, 'utf8') : '').split('\n'));
        l.text = (lines.get(l.file)[l.line - 1] || '').slice(0, 300);
        l.rel = ctx.root ? path.relative(ctx.root, l.file) : l.file;
      }
      return { source: 'lsp', name: c ? c.name : '', refs: lsp };
    }
    if (!c) return { source: 'index', name: '', refs: [] };
    const r = await ctx.index.call('references', { name: c.name, file });
    return { source: 'index', name: c.name, refs: r.refs, truncated: r.truncated };
  });
  handle('code:hover', async (ctx, { file, text, line, col }) => {
    const lsp = await ctx.lsp.hover(file, line, col);
    if (lsp) return { source: 'lsp', markdown: lsp };
    const h = await ctx.index.call('hover', { file, text, line, col }).catch(() => null);
    if (!h) return null;
    const lang = file.endsWith('.py') ? 'python' : file.endsWith('.cs') ? 'csharp' : 'typescript';
    return { source: 'index', markdown: '```' + lang + '\n' + (h.def.signature || h.def.name) + '\n```' + (h.doc ? '\n\n' + h.doc : '') + (h.count > 1 ? `\n\n_${h.count} definitions with this name_` : ''), def: h.def };
  });
  handle('code:documentSymbols', (ctx, file, text) => ctx.index.call('documentSymbols', { file, text }));
  handle('code:workspaceSymbols', (ctx, query, kinds) => ctx.index.call('workspaceSymbols', { query, kinds, limit: 80 }));
  handle('code:codeLens', (ctx, file, text) => ctx.index.call('codeLens', { file, text }));
  handle('code:semanticTokens', (ctx, file, text) => ctx.index.call('semanticTokens', { file, text }));
  // source "main": the main-branch graph kept in sync from git (see codeindex/branch.js).
  const graphOf = (ctx, source) => (source === 'main' && ctx.branchGraph.status.state === 'ready' ? ctx.branchGraph : ctx.index);
  handle('code:graph', (ctx, opts = {}) => graphOf(ctx, opts.source).call('graph', opts));
  handle('code:neighbors', (ctx, id, source) => graphOf(ctx, source).call('neighbors', { id }));
  handle('code:findNodes', (ctx, query, source) => graphOf(ctx, source).call('findNodes', { query }));
  handle('code:branchStatus', (ctx) => ctx.branchGraph.status);
  handle('code:branchSync', async (ctx) => {
    await ctx.branchGraph.fetch().catch(() => false);
    await ctx.branchGraph.onGitChange();
    return ctx.branchGraph.status;
  });
  handle('code:indexHas', async (ctx, name) => ((await ctx.index.call('workspaceSymbols', { query: name, limit: 20 })) || []).some((d) => d.name === name));
  handle('code:graphFile', (ctx) => ctx.index.graphFile());
  handle('code:format', async (ctx, file, text) => {
    const lspEdits = await ctx.lsp.format(file).catch(() => null);
    if (lspEdits && lspEdits.length) return { edits: lspEdits, tool: 'language server' };
    return formatText(ctx, file, text);
  });

  // -------------------------------------------------- language servers
  listen('lsp:didOpen', (ctx, file, text) => ctx.lsp.didOpen(file, text));
  listen('lsp:didChange', (ctx, file, text) => ctx.lsp.didChange(file, text));
  listen('lsp:didClose', (ctx, file) => ctx.lsp.didClose(file));
  listen('lsp:didSave', (ctx, file) => ctx.lsp.didSave(file));
  handle('lsp:completion', (ctx, file, line, col, trigger) => ctx.lsp.completion(file, line, col, trigger));
  handle('lsp:resolve', (ctx, file, item) => ctx.lsp.resolveCompletion(file, item));
  handle('lsp:signatureHelp', (ctx, file, line, col) => ctx.lsp.signatureHelp(file, line, col));
  handle('lsp:rename', (ctx, file, line, col, name) => ctx.lsp.rename(file, line, col, name));
  handle('lsp:codeActions', (ctx, file, range, diagnostics) => ctx.lsp.codeActions(file, range, diagnostics));
  handle('lsp:applyCodeAction', (ctx, file, raw) => ctx.lsp.applyCodeAction(file, raw));
  handle('lsp:inlayHints', (ctx, file, a, b) => ctx.lsp.inlayHints(file, a, b));
  handle('lsp:info', (ctx) => ctx.lsp.info());
  handle('lsp:restart', (ctx, lang) => ctx.lsp.restart(lang));
  handle('refactor:available', (ctx, req) => ctx.refactor.available(req));
  handle('refactor:info', (ctx, kind, req) => ctx.refactor.info(kind, req));
  handle('refactor:compute', (ctx, req) => ctx.refactor.compute(req));
  handle('lsp:installCsharp', (ctx) => ctx.lsp.installCsharpLs((text) => ctx.send('templates:progress', { text })));

  // ------------------------------------------------------------- AI
  handle('ai:status', (ctx) => ctx.ai.status());
  handle('ai:inlineCompletion', (ctx, req) => ctx.ai.inlineCompletion(req || {}));
  handle('ai:commitMessage', (ctx, req) => ctx.ai.commitMessage(req || {}));
  handle('ai:review', (ctx, req) => ctx.ai.reviewChanges(req || {}));
  handle('ai:generateDocs', (ctx, req) => ctx.ai.generateDocs(req || {}));
  handle('ai:generateTests', (ctx, req) => ctx.ai.generateTests(req || {}));
  handle('ai:stackContext', (ctx, text) => require('./services/stack-context').stackContext(text, { root: ctx.root }));

  // ------------------------------------------------------- endpoints
  handle('endpoints:list', (ctx) => (ctx.root ? ctx.endpoints.list() : []));
  handle('endpoints:forFile', (ctx, file, text) => (ctx.root ? ctx.endpoints.forFile(file, text) : []));
  handle('endpoints:server', (ctx, endpoint) => {
    const s = ctx.endpoints.server(endpoint);
    const cfg = s ? null : ctx.endpoints.configFor(endpoint);
    return { server: s, config: cfg ? { id: cfg.id, name: cfg.name } : null };
  });
  handle('endpoints:send', (ctx, req) => ctx.endpoints.send(req || {}));

  // ------------------------------------------------ message flow/kafka
  handle('flow:analyze', (ctx) => analyzeFlow(ctx));
  handle('kafka:connect', (ctx, opts) => ctx.kafka.connect(opts));
  handle('kafka:overview', (ctx) => ctx.kafka.overview());
  handle('kafka:peek', (ctx, topic, limit) => ctx.kafka.peek(topic, limit));
  handle('kafka:publish', (ctx, topic, msg) => ctx.kafka.publish(topic, msg));
  handle('kafka:disconnect', (ctx) => ctx.kafka.disconnect());

  // ------------------------------------------------------ local history
  handle('history:snapshot', (ctx, file, content, label) => ctx.history.snapshot(file, content, label));
  handle('history:snapshotDisk', (ctx, file, label) => ctx.history.snapshotDisk(file, label));
  handle('history:list', (ctx, file) => ctx.history.list(file));
  handle('history:read', (ctx, file, id) => ctx.history.read(file, id));
  handle('history:revert', (ctx, file, id) => ctx.history.revert(file, id));
  handle('history:recent', (ctx) => ctx.history.recent());

  // ------------------------------------------------------------ agents
  handle('agents:list', (_ctx, force) => listAgents(force));
  handle('agents:start', (ctx, id, size) => {
    const a = agentById(id);
    if (!a) throw new Error('Unknown agent');
    return ctx.terminals.create({ command: a.command, args: a.args, cwd: ctx.root, ...(size || {}) });
  });

  // ------------------------------------------------------------- tests
  handle('tests:projects', (ctx) => ctx.tests.projects());
  handle('tests:discover', (ctx, id) => ctx.tests.discover(id));
  handle('tests:run', (ctx, id, filter, opts = {}) => ctx.tests.runTests(id, { filter, coverage: !!opts.coverage, onOutput: (text) => ctx.send('tests:output', { id, text }) }));
  handle('tests:scan', (ctx, file, text) => ctx.tests.scanFile(file, text));
  handle('tests:cancel', (ctx) => ctx.tests.cancel());

  // ----------------------------------------------------------- packages
  handle('pkg:nugetSearch', (ctx, q, pre) => ctx.packages.nugetSearch(q, pre));
  handle('pkg:nugetInstalled', (ctx, proj) => ctx.packages.nugetInstalled(proj));
  handle('pkg:nugetOutdated', (ctx, proj) => ctx.packages.nugetOutdated(proj));
  handle('pkg:nugetAdd', (ctx, proj, id, v) => ctx.packages.nugetAdd(proj, id, v));
  handle('pkg:nugetRemove', (ctx, proj, id) => ctx.packages.nugetRemove(proj, id));
  handle('pkg:pyInstalled', (ctx, dir) => ctx.packages.pyInstalled(dir));
  handle('pkg:pyOutdated', (ctx, dir) => ctx.packages.pyOutdated(dir));
  handle('pkg:pyInfo', (ctx, name) => ctx.packages.pyInfo(name));
  handle('pkg:pyInstall', (ctx, dir, spec, opts) => ctx.packages.pyInstall(dir, spec, opts));
  handle('pkg:pyUninstall', (ctx, dir, name) => ctx.packages.pyUninstall(dir, name));

  // ------------------------------------------------- artifacts KB
  handle('kb:list', (ctx) => ctx.artifacts.list());
  handle('kb:read', (ctx, id) => ctx.artifacts.read(id));
  handle('kb:remove', (ctx, id) => ctx.artifacts.remove(id));
  handle('kb:importUrl', (ctx, url) => ctx.artifacts.importUrl(url, (e) => ctx.send('kb:event', { type: 'progress', ...e })));
  handle('kb:importAll', (ctx) => ctx.artifacts.importFromClaude((e) => ctx.send('kb:event', { type: 'progress', ...e })));
  handle('kb:importFiles', (ctx, files) => ctx.artifacts.importFiles(files));
  handle('kb:importProjectDocs', (ctx) => ctx.artifacts.importProjectDocs());
  handle('kb:graph', async (ctx) => {
    let codeNames = null;
    try {
      const g = ctx.root ? await ctx.index.call('graph', { mode: 'all', limit: 20000 }) : null;
      if (g) codeNames = new Set(g.nodes.map((n) => n.label));
    } catch {
      codeNames = null;
    }
    return ctx.artifacts.graph({ codeNames });
  });
  handle('kb:search', (ctx, q) => ctx.artifacts.search(q, 10));
  handle('kb:ask', (ctx, question) => ctx.artifacts.ask(question, (e) => ctx.send('kb:event', { type: 'answer', ...e })));
  handle('kb:check', (ctx, opts) => ctx.artifacts.checkCode(opts, (e) => ctx.send('kb:event', { type: 'check', ...e })));
  handle('kb:selectFiles', async (ctx) => {
    const r = await dialog.showOpenDialog(ctx.win, { title: 'Import documents', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Documents', extensions: ['md', 'markdown', 'html', 'htm', 'txt'] }] });
    return r.canceled ? [] : r.filePaths;
  });

  // ------------------------------------------------------- misc tools
  handle('search:todos', (ctx) => searchTodos(needRoot(ctx), !!ctx.git.root));
  handle('git:blame', (ctx, file, content) => ctx.git.blame(file, content));
  handle('git:headContent', (ctx, file) => ctx.git.headContent(file));
  handle('app:githubToken', () => githubAuth.tokenStatus());

  // ---------------------------------------------------------- templates
  handle('templates:list', async () => templates.list(await toolchain()));
  handle('templates:create', (ctx, opts) => templates.create(opts, (text) => ctx.send('templates:progress', { text })));

  return { toolchain };
}

module.exports = { register, toolchain, BrowserWindow };
