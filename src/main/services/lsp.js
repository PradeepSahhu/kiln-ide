'use strict';
// Language servers: pyright (bundled, Python) and csharp-ls (C#, optional), behind a small LSP client.
// Navigation requests try the language server first and fall back to the tree-sitter code index, so
// Go to Definition / Find Usages work instantly even while a server is still loading.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { app } = require('electron');
const settings = require('../settings');
const { which, run } = require('../util/proc');
const { resolveInterpreter } = require('./python-env');
const { APP_ROOT } = require('../protocol');

const PYRIGHT = path.join(APP_ROOT, 'node_modules', 'pyright', 'langserver.index.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const toUri = (file) => pathToFileURL(file).toString();
const toPath = (uri) => {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
};
const LANG_OF = { '.py': 'python', '.pyi': 'python', '.cs': 'csharp' };

class LspClient {
  constructor(opts) {
    this.opts = opts;
    this.name = opts.name;
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.seq = 0;
    this.pending = new Map();
    this.state = 'stopped';
    this.capabilities = {};
    this.ready = null;
  }

  start() {
    const { command, args, cwd, env } = this.opts;
    this.state = 'starting';
    this.proc = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.on('data', (d) => this.opts.onLog && this.opts.onLog(d.toString()));
    this.proc.on('error', (err) => this.fail(err));
    this.proc.on('exit', (code) => {
      this.state = 'stopped';
      for (const p of this.pending.values()) p.reject(new Error(`${this.name} exited (${code})`));
      this.pending.clear();
      if (this.opts.onExit) this.opts.onExit(code);
    });
    this.proc.stdin.on('error', () => {});
    this.ready = this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'Kiln IDE', version: app.getVersion() },
        rootUri: toUri(this.opts.root),
        rootPath: this.opts.root,
        workspaceFolders: [{ uri: toUri(this.opts.root), name: path.basename(this.opts.root) }],
        initializationOptions: this.opts.initializationOptions || {},
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: { configuration: true, workspaceFolders: true, applyEdit: true, workspaceEdit: { documentChanges: true, resourceOperations: ['create', 'rename', 'delete'] }, didChangeConfiguration: { dynamicRegistration: true }, symbol: { dynamicRegistration: false } },
          window: { workDoneProgress: true, showMessage: {} },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false, willSave: false },
            completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] }, insertReplaceSupport: false, labelDetailsSupport: true }, contextSupport: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
            definition: { linkSupport: true },
            typeDefinition: { linkSupport: true },
            implementation: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] } }, resolveSupport: { properties: ['edit'] }, dataSupport: true },
            formatting: {},
            rangeFormatting: {},
            rename: { prepareSupport: true },
            publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] } },
            inlayHint: {},
          },
        },
      },
      120000,
    ).then((res) => {
      this.capabilities = (res && res.capabilities) || {};
      this.notify('initialized', {});
      if (this.opts.settings) this.notify('workspace/didChangeConfiguration', { settings: this.opts.settings() });
      this.state = 'ready';
      return this;
    });
    this.ready.catch((err) => this.fail(err));
    return this.ready;
  }

  fail(err) {
    this.state = 'error';
    this.error = err.message;
    if (this.opts.onError) this.opts.onError(err);
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = +m[1];
      if (this.buf.length < headerEnd + 4 + len) return;
      const body = this.buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(headerEnd + 4 + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'LSP error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      Promise.resolve(this.serverRequest(msg.method, msg.params))
        .then((result) => this.send({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result }))
        .catch((err) => this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } }));
      return;
    }
    if (msg.method && this.opts.onNotification) this.opts.onNotification(msg.method, msg.params);
  }

  serverRequest(method, params) {
    switch (method) {
      case 'workspace/configuration':
        return (params.items || []).map((item) => (this.opts.configuration ? this.opts.configuration(item.section) : null));
      case 'workspace/workspaceFolders':
        return [{ uri: toUri(this.opts.root), name: path.basename(this.opts.root) }];
      case 'workspace/applyEdit':
        return this.opts.onApplyEdit ? this.opts.onApplyEdit(params.edit).then(() => ({ applied: true })) : { applied: false };
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/codeLens/refresh':
      case 'workspace/diagnostic/refresh':
        return null;
      default:
        throw new Error(`Unsupported request ${method}`);
    }
  }

  send(obj) {
    if (!this.proc || !this.proc.stdin.writable) return;
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  request(method, params, timeout = 20000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${this.name}: ${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    try {
      await this.request('shutdown', null, 2000);
      this.notify('exit', null);
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* gone */
      }
    }, 800);
    this.proc = null;
  }
}

// ------------------------------------------------------------- helpers

function normLocations(result) {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list
    .map((l) => {
      const uri = l.targetUri || l.uri;
      const r = l.targetSelectionRange || l.targetRange || l.range;
      if (!uri || !r) return null;
      return { file: toPath(uri), line: r.start.line + 1, col: r.start.character + 1, endLine: r.end.line + 1, endCol: r.end.character + 1 };
    })
    .filter(Boolean);
}

function hoverText(h) {
  if (!h || !h.contents) return '';
  const c = h.contents;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : '```' + (x.language || '') + '\n' + x.value + '\n```')).join('\n\n');
  if (c.kind) return c.value;
  if (c.value) return '```' + (c.language || '') + '\n' + c.value + '\n```';
  return '';
}

/** Highest installed .NET runtime major version, used to pick a compatible csharp-ls. */
async function dotnetRuntimeMajor() {
  const dotnet = settings.get().dotnet.path || which('dotnet');
  if (!dotnet) return 0;
  const r = await run(dotnet, ['--list-runtimes'], { timeout: 20000 });
  let max = 0;
  for (const m of r.stdout.matchAll(/Microsoft\.NETCore\.App (\d+)\./g)) max = Math.max(max, +m[1]);
  return max;
}

function toolsDir() {
  return path.join(app.getPath('userData'), 'tools');
}

function findCsharpLs() {
  const configured = (settings.get().languages || {}).csharpLs;
  if (configured && fs.existsSync(configured)) return configured;
  const exe = process.platform === 'win32' ? 'csharp-ls.exe' : 'csharp-ls';
  for (const p of [path.join(toolsDir(), exe), path.join(require('os').homedir(), '.dotnet', 'tools', exe)]) if (fs.existsSync(p)) return p;
  return which('csharp-ls');
}

// ------------------------------------------------------------- service

class LanguageServices {
  constructor(ctx) {
    this.ctx = ctx;
    this.clients = {};
    this.docs = new Map(); // file -> { lang, version }
    this.status = {};
  }

  langOf(file) {
    return LANG_OF[path.extname(file).toLowerCase()] || null;
  }

  enabled(lang) {
    const cfg = settings.get().languages || {};
    if (lang === 'python') return cfg.pyright !== false;
    if (lang === 'csharp') return cfg.csharpLs !== false && cfg.csharpLsEnabled !== false;
    return false;
  }

  setStatus(lang, state, extra = {}) {
    this.status[lang] = { state, ...extra };
    this.ctx.send('lsp:status', { lang, state, ...extra });
  }

  client(lang) {
    if (!this.ctx.root || !this.enabled(lang)) return null;
    if (this.clients[lang]) return this.clients[lang];
    const env = { ...process.env };
    delete env.CLAUDECODE;
    let opts;
    if (lang === 'python') {
      opts = {
        name: 'pyright',
        command: process.execPath,
        args: [PYRIGHT, '--stdio'],
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        configuration: (section) => this.pyrightConfig(section),
        settings: () => ({ python: this.pyrightConfig('python') }),
      };
    } else {
      const cmd = findCsharpLs();
      if (!cmd) {
        this.setStatus(lang, 'missing', { message: 'C# language server (csharp-ls) is not installed' });
        return null;
      }
      const det = this.ctx.detection;
      const args = [];
      if (det && det.dotnet && det.dotnet.solution) args.push('--solution', det.dotnet.solution);
      opts = { name: 'csharp-ls', command: cmd, args, env: { ...env, DOTNET_NOLOGO: '1', DOTNET_ROLL_FORWARD: 'Major' }, configuration: () => ({}) };
    }
    const client = new LspClient({
      ...opts,
      root: this.ctx.root,
      cwd: this.ctx.root,
      onNotification: (method, params) => this.onNotification(lang, method, params),
      onApplyEdit: (edit) => this.applyEdit(edit),
      onError: (err) => this.setStatus(lang, 'error', { message: err.message }),
      onExit: () => {
        if (this.clients[lang] === client) delete this.clients[lang];
        this.setStatus(lang, 'stopped');
      },
      onLog: () => {},
    });
    this.clients[lang] = client;
    this.setStatus(lang, 'starting', { server: opts.name });
    client
      .start()
      .then(() => {
        this.setStatus(lang, 'ready', { server: opts.name });
        for (const [file, doc] of this.docs) if (doc.lang === lang) client.notify('textDocument/didOpen', { textDocument: { uri: toUri(file), languageId: lang, version: doc.version, text: doc.text } });
      })
      .catch(() => {});
    return client;
  }

  pyrightConfig(section) {
    const interp = this.ctx.root ? resolveInterpreter(this.ctx.root, this.ctx.root) : null;
    const analysis = { typeCheckingMode: (settings.get().languages || {}).pythonTypeChecking || 'basic', diagnosticMode: 'openFilesOnly', autoSearchPaths: true, useLibraryCodeForTypes: true, autoImportCompletions: true };
    if (section === 'python.analysis') return analysis;
    if (section === 'python') return { pythonPath: interp ? interp.python : undefined, analysis };
    if (section === 'pyright') return { disableOrganizeImports: false };
    return {};
  }

  onNotification(lang, method, params) {
    if (method === 'textDocument/publishDiagnostics') {
      const file = toPath(params.uri);
      const diagnostics = (params.diagnostics || []).map((d) => ({
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        endLine: d.range.end.line + 1,
        endCol: d.range.end.character + 1,
        severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : d.severity === 4 ? 'hint' : 'info',
        message: d.message,
        code: d.code != null ? String(typeof d.code === 'object' ? d.code.value : d.code) : '',
        source: d.source || (lang === 'python' ? 'pyright' : 'csharp-ls'),
        tags: d.tags || [],
      }));
      this.ctx.send('lsp:diagnostics', { file, lang, diagnostics });
    } else if (method === '$/progress' && params && params.value) {
      const v = params.value;
      if (v.kind === 'begin' || v.kind === 'report') this.setStatus(lang, 'busy', { message: v.title || v.message || '', percentage: v.percentage });
      else if (v.kind === 'end') this.setStatus(lang, 'ready', { message: '' });
    }
  }

  async applyEdit(edit) {
    // Let the renderer apply edits so open editors (with undo history) stay in sync.
    this.ctx.send('lsp:applyEdit', { edit: this.normEdit(edit) });
  }

  normEdit(edit) {
    const files = {};
    const add = (uri, edits) => {
      const f = toPath(uri);
      files[f] = (files[f] || []).concat(edits.map((e) => ({ line: e.range.start.line + 1, col: e.range.start.character + 1, endLine: e.range.end.line + 1, endCol: e.range.end.character + 1, text: e.newText })));
    };
    if (edit && edit.changes) for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
    if (edit && edit.documentChanges) for (const dc of edit.documentChanges) if (dc.textDocument && dc.edits) add(dc.textDocument.uri, dc.edits);
    return files;
  }

  // ----------------------------------------------------- documents

  didOpen(file, text) {
    const lang = this.langOf(file);
    if (!lang) return;
    this.docs.set(file, { lang, version: 1, text });
    const c = this.client(lang);
    if (c && c.state === 'ready') c.notify('textDocument/didOpen', { textDocument: { uri: toUri(file), languageId: lang, version: 1, text } });
  }

  didChange(file, text) {
    const doc = this.docs.get(file);
    if (!doc) return this.didOpen(file, text);
    doc.version++;
    doc.text = text;
    const c = this.clients[doc.lang];
    if (c && c.state === 'ready') c.notify('textDocument/didChange', { textDocument: { uri: toUri(file), version: doc.version }, contentChanges: [{ text }] });
  }

  didSave(file) {
    const doc = this.docs.get(file);
    const c = doc && this.clients[doc.lang];
    if (c && c.state === 'ready') c.notify('textDocument/didSave', { textDocument: { uri: toUri(file) } });
  }

  didClose(file) {
    const doc = this.docs.get(file);
    if (!doc) return;
    this.docs.delete(file);
    const c = this.clients[doc.lang];
    if (c && c.state === 'ready') c.notify('textDocument/didClose', { textDocument: { uri: toUri(file) } });
  }

  readyClient(file) {
    const lang = this.langOf(file);
    const c = lang && this.clients[lang];
    return c && c.state === 'ready' && this.docs.has(file) ? c : null;
  }

  pos(file, line, col) {
    return { textDocument: { uri: toUri(file) }, position: { line: line - 1, character: col - 1 } };
  }

  // ------------------------------------------------------ requests

  async definition(file, line, col, kind = 'definition') {
    const c = this.readyClient(file);
    if (!c) return null;
    const method = kind === 'implementation' ? 'textDocument/implementation' : kind === 'typeDefinition' ? 'textDocument/typeDefinition' : 'textDocument/definition';
    try {
      return normLocations(await c.request(method, this.pos(file, line, col), 8000));
    } catch {
      return null;
    }
  }

  async references(file, line, col) {
    const c = this.readyClient(file);
    if (!c) return null;
    try {
      return normLocations(await c.request('textDocument/references', { ...this.pos(file, line, col), context: { includeDeclaration: true } }, 20000));
    } catch {
      return null;
    }
  }

  async hover(file, line, col) {
    const c = this.readyClient(file);
    if (!c) return null;
    try {
      return hoverText(await c.request('textDocument/hover', this.pos(file, line, col), 5000));
    } catch {
      return null;
    }
  }

  async completion(file, line, col, triggerCharacter) {
    const c = this.readyClient(file);
    if (!c) return null;
    try {
      const res = await c.request('textDocument/completion', { ...this.pos(file, line, col), context: triggerCharacter ? { triggerKind: 2, triggerCharacter } : { triggerKind: 1 } }, 8000);
      const items = Array.isArray(res) ? res : (res && res.items) || [];
      return { incomplete: !!(res && res.isIncomplete), items: items.slice(0, 400) };
    } catch {
      return null;
    }
  }

  async resolveCompletion(file, item) {
    const c = this.readyClient(file);
    if (!c || !(c.capabilities.completionProvider || {}).resolveProvider) return item;
    try {
      return await c.request('completionItem/resolve', item, 4000);
    } catch {
      return item;
    }
  }

  async signatureHelp(file, line, col) {
    const c = this.readyClient(file);
    if (!c) return null;
    try {
      return await c.request('textDocument/signatureHelp', this.pos(file, line, col), 4000);
    } catch {
      return null;
    }
  }

  async rename(file, line, col, newName) {
    const c = this.readyClient(file);
    if (!c) return null;
    const edit = await c.request('textDocument/rename', { ...this.pos(file, line, col), newName }, 20000);
    return this.normEdit(edit);
  }

  async codeActions(file, range, diagnostics) {
    const c = this.readyClient(file);
    if (!c || !c.capabilities.codeActionProvider) return [];
    try {
      const res = await c.request(
        'textDocument/codeAction',
        {
          textDocument: { uri: toUri(file) },
          range: { start: { line: range.line - 1, character: range.col - 1 }, end: { line: range.endLine - 1, character: range.endCol - 1 } },
          context: { diagnostics: (diagnostics || []).map((d) => ({ range: { start: { line: d.line - 1, character: d.col - 1 }, end: { line: d.endLine - 1, character: d.endCol - 1 } }, message: d.message, severity: d.severity === 'error' ? 1 : 2, code: d.code || undefined, source: d.source })) },
        },
        8000,
      );
      return (res || []).map((a, i) => ({ id: i, title: a.title, kind: a.kind || '', isPreferred: !!a.isPreferred, raw: a }));
    } catch {
      return [];
    }
  }

  async applyCodeAction(file, raw) {
    const c = this.readyClient(file);
    if (!c) return null;
    let action = raw;
    if (!action.edit && !action.command && (c.capabilities.codeActionProvider || {}).resolveProvider) action = await c.request('codeAction/resolve', raw, 8000);
    if (action.edit) return this.normEdit(action.edit);
    const cmd = action.command && typeof action.command === 'object' ? action.command : action.command ? action : null;
    if (cmd && cmd.command) await c.request('workspace/executeCommand', { command: cmd.command, arguments: cmd.arguments || [] }, 20000);
    return {};
  }

  async format(file) {
    const c = this.readyClient(file);
    if (!c || !c.capabilities.documentFormattingProvider) return null;
    const edits = await c.request('textDocument/formatting', { textDocument: { uri: toUri(file) }, options: { tabSize: settings.get().editor.tabSize || 4, insertSpaces: settings.get().editor.insertSpaces !== false } }, 15000);
    return this.normEdit({ changes: { [toUri(file)]: edits || [] } })[file] || [];
  }

  async inlayHints(file, startLine, endLine) {
    const c = this.readyClient(file);
    if (!c || !c.capabilities.inlayHintProvider) return [];
    try {
      const res = await c.request('textDocument/inlayHint', { textDocument: { uri: toUri(file) }, range: { start: { line: startLine - 1, character: 0 }, end: { line: endLine, character: 0 } } }, 5000);
      return (res || []).map((h) => ({ line: h.position.line + 1, col: h.position.character + 1, label: typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join(''), kind: h.kind, paddingLeft: h.paddingLeft, paddingRight: h.paddingRight }));
    } catch {
      return [];
    }
  }

  async installCsharpLs(progress) {
    const dotnet = settings.get().dotnet.path || which('dotnet');
    if (!dotnet) throw new Error('The .NET SDK is required to install csharp-ls.');
    const major = await dotnetRuntimeMajor();
    const version = major >= 10 ? null : major >= 9 ? '0.20.0' : '0.16.0';
    const args = ['tool', 'install', 'csharp-ls', '--tool-path', toolsDir()];
    if (version) args.push('--version', version);
    progress(`dotnet ${args.join(' ')}\n`);
    const r = await run(dotnet, args, { timeout: 300000, env: { ...process.env, DOTNET_NOLOGO: '1' } });
    progress(r.stdout + r.stderr);
    if (r.code !== 0 && !/already installed/i.test(r.stdout + r.stderr)) throw new Error((r.stderr || r.stdout).trim() || 'Installation failed');
    if (this.clients.csharp) await this.clients.csharp.stop();
    delete this.clients.csharp;
    return { path: findCsharpLs(), version: version || 'latest' };
  }

  info() {
    return { status: this.status, csharpLs: findCsharpLs(), pyright: fs.existsSync(PYRIGHT) };
  }

  async restart(lang) {
    if (this.clients[lang]) await this.clients[lang].stop();
    delete this.clients[lang];
    if ([...this.docs.values()].some((d) => d.lang === lang)) this.client(lang);
  }

  dispose() {
    for (const c of Object.values(this.clients)) c.stop();
    this.clients = {};
    this.docs.clear();
  }
}

module.exports = { LanguageServices };
