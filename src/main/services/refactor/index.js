'use strict';
// Refactor This: which refactorings apply at the caret / selection, and their changes, from four
// engines - the TypeScript language service (JS/TS), rope (Python), Roslyn through csharp-ls (C#) and
// Kiln's syntax-tree engine (Safe Delete, Change Signature, Pull Members Up, Introduce Constant, and
// C# without a language server). Every result is { files: [{ path, before, after, created }], ... }:
// nothing is written here; the window previews the changes and applies them to its editors.
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const settings = require('../../settings');
const { resolveInterpreter } = require('../python-env');
const { ensureRope, ropeRefactor } = require('./py-engine');
const { classifyRoslyn, applyLspEdits, renameGenerated } = require('./roslyn');

const LANG = { '.cs': 'csharp', '.py': 'python', '.pyi': 'python', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js' };
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// Rider's names, in Refactor This order.
const TITLES = {
  rename: 'Rename…',
  changeSignature: 'Change Signature…',
  extractMethod: 'Extract Method…',
  introduceVariable: 'Introduce Variable…',
  introduceConstant: 'Introduce Constant…',
  introduceField: 'Introduce Field…',
  introduceParameter: 'Introduce Parameter…',
  inline: 'Inline…',
  move: 'Move…',
  safeDelete: 'Safe Delete…',
  pullMembersUp: 'Pull Members Up…',
};
const ORDER = Object.keys(TITLES);

function lineCol(text, off) {
  let line = 1;
  let ls = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < off; i = text.indexOf('\n', i + 1)) {
    line++;
    ls = i + 1;
  }
  return { line, col: off - ls + 1 };
}

class RefactorService {
  constructor(ctx) {
    this.ctx = ctx;
    this.ts = null;
    this.tsRoot = null;
    this.pending = new Map();
    this.seq = 0;
    this.roslyn = new Map(); // id -> raw code action of the last listing
  }

  // ------------------------------------------------------------ TypeScript

  tsCall(type, payload) {
    if (!this.ts) {
      const w = new Worker(unpacked(path.join(__dirname, 'ts-worker.js')));
      this.ts = w;
      w.on('message', (m) => {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error));
      });
      w.on('exit', () => {
        for (const [id, p] of this.pending) if (p.w === w) {
          this.pending.delete(id);
          p.reject(new Error('The TypeScript service stopped'));
        }
        if (this.ts === w) {
          this.ts = null;
          this.tsRoot = null;
        }
      });
    }
    const w = this.ts;
    const send = (t, pl) =>
      new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.pending.set(id, { resolve, reject, w });
        w.postMessage({ id, type: t, payload: pl });
      });
    const ready = this.tsRoot === this.ctx.root ? Promise.resolve() : send('open', { root: this.ctx.root, format: this.format() }).then(() => (this.tsRoot = this.ctx.root));
    return ready.then(() => send(type, payload));
  }

  format() {
    const e = settings.get().editor || {};
    return { tabSize: e.tabSize || 4, insertSpaces: e.insertSpaces !== false };
  }

  /** Files were created, deleted or renamed: the TypeScript service rescans the project. */
  onFsChange() {
    if (this.ts && this.tsRoot) this.tsCall('refresh', {}).catch(() => {});
  }

  // --------------------------------------------------------------- listing

  syntax(op, req) {
    return this.ctx.index.call('refactor', { op, ...req });
  }

  csharpReady(file) {
    return !!this.ctx.lsp.readyClient(file);
  }

  /** Refactorings that apply at { file, text, start, end } (UTF-16 offsets), in Rider's order. */
  async available(req) {
    const lang = LANG[path.extname(req.file).toLowerCase()];
    if (!lang) return { items: [], notes: ['Refactorings are available for C#, Python, JavaScript and TypeScript.'] };
    const c = await this.syntax('context', req).catch(() => null);
    const items = [];
    const notes = [];
    const add = (kind, id, extra = {}) => items.push({ id, kind, title: extra.title || TITLES[kind] || kind, ...extra });
    if (c && c.symbol) add('rename', 'rename', { command: 'refactor.rename' });

    if (lang === 'js') {
      const ts = await this.tsCall('refactors', req).catch(() => []);
      for (const it of ts) add(it.kind, it.id, { title: it.kind === 'other' || it.kind === 'move' || it.kind === 'extractType' || items.some((x) => x.kind === it.kind) ? it.title : TITLES[it.kind], detail: it.title, needs: it.needs, defaultName: it.defaultName, engine: 'typescript' });
    } else if (lang === 'python') {
      if (c && req.end > req.start) add('extractMethod', 'rope|extract_method', { needs: 'name', defaultName: 'new_function', engine: 'rope' });
      if (c && c.expression && req.end > req.start) add('introduceVariable', 'rope|extract_variable', { needs: 'name', defaultName: 'value', engine: 'rope' });
      if (c && c.expression) add('introduceConstant', 'syntax|introduceConstant', { needs: 'name', defaultName: 'VALUE' });
      if (c && c.local && c.inFunction) add('introduceField', 'rope|introduce_field', { engine: 'rope' });
      if (c && c.symbol && c.inFunction && !c.local && !c.parameter && !c.declaration) add('introduceParameter', 'rope|introduce_parameter', { needs: 'name', defaultName: (c.symbol || 'value').toLowerCase(), engine: 'rope' });
      if (c && (c.local || c.parameter || c.callable)) add('inline', 'rope|inline', { engine: 'rope' });
      if (c && c.topLevel && (c.callable || c.typeDecl)) add('move', 'rope|move', { needs: 'targetFile', engine: 'rope', title: 'Move to Module…' });
    } else {
      const ready = this.csharpReady(req.file);
      if (ready) {
        const a = lineCol(req.text, req.start);
        const b = lineCol(req.text, req.end);
        const actions = await this.ctx.lsp.codeActions(req.file, { line: a.line, col: a.col, endLine: b.line, endCol: b.col }, []).catch(() => []);
        this.roslyn.clear();
        actions.forEach((act, i) => {
          if (act.kind && /^quickfix/.test(act.kind)) return;
          const info = classifyRoslyn(act.title);
          if (!info) return;
          const id = `roslyn|${i}`;
          this.roslyn.set(id, { raw: act.raw, file: req.file, info });
          add(info.kind, id, { title: info.kind === 'other' || items.some((x) => x.kind === info.kind) ? info.title : TITLES[info.kind], detail: info.title, needs: info.needs, defaultName: info.defaultName, engine: 'roslyn' });
        });
      } else {
        notes.push('Install the C# language server (Settings › Languages) for Extract Method, Introduce Field / Parameter and more C# refactorings.');
      }
      const has = (k) => items.some((x) => x.kind === k);
      if (c && c.expression && !has('introduceVariable') && req.end > req.start) add('introduceVariable', 'syntax|introduceVariable', { needs: 'name', defaultName: 'value' });
      if (c && c.constantExpression && !has('introduceConstant')) add('introduceConstant', 'syntax|introduceConstant', { needs: 'name', defaultName: 'Value' });
      if (c && c.local && !has('inline')) add('inline', 'syntax|inlineVariable');
      if (c && c.typeDecl && c.topLevel && !has('move')) add('move', 'syntax|moveTypeToFile', { title: 'Move Type to File' });
    }
    if (c && c.callable) add('changeSignature', 'syntax|changeSignature', { needs: 'signature' });
    if (c && c.symbol) add('safeDelete', 'syntax|safeDelete', { needs: 'confirm' });
    if (c && c.member && !items.some((x) => x.kind === 'pullMembersUp')) add('pullMembersUp', 'syntax|pullMembersUp', { needs: 'members' });
    items.sort((x, y) => (ORDER.indexOf(x.kind) < 0 ? 99 : ORDER.indexOf(x.kind)) - (ORDER.indexOf(y.kind) < 0 ? 99 : ORDER.indexOf(y.kind)));
    return { items, notes, lang };
  }

  /** Extra information a dialog needs before it can run: a signature, members to pull up, ... */
  info(kind, req) {
    if (kind === 'signature') return this.syntax('signatureInfo', req);
    if (kind === 'members') return this.syntax('pullUpInfo', req);
    throw new Error(`Unknown refactoring information: ${kind}`);
  }

  // ----------------------------------------------------------- computing

  /** The changes of one refactoring: { files, select, warnings, usages, blocked }. */
  async compute(req) {
    const [engine, op] = String(req.id).split('|');
    if (engine === 'ts') return this.tsCall('edits', req);
    if (engine === 'syntax') return this.syntax(op, { ...req, ...(req.input || {}) });
    if (engine === 'rope') {
      const interp = resolveInterpreter(path.dirname(req.file), this.ctx.root);
      if (!interp) throw new Error('No Python interpreter found for this project.');
      const rope = await ensureRope(interp.python, (t) => this.ctx.send('refactor:progress', { text: t }));
      const out = await ropeRefactor({ ...rope, root: this.ctx.root, op, file: req.file, start: req.start, end: req.end, name: req.name, dest: req.targetFile });
      return { files: out.files, select: out.select };
    }
    if (engine === 'roslyn') return this.roslynEdits(req);
    throw new Error(`Unknown refactoring: ${req.id}`);
  }

  async roslynEdits(req) {
    const entry = this.roslyn.get(req.id);
    if (!entry) throw new Error('The refactoring is no longer available; run Refactor This again.');
    const edit = await this.ctx.lsp.applyCodeAction(entry.file, entry.raw);
    const files = [];
    let select = null;
    for (const [file, edits] of Object.entries(edit || {})) {
      const exists = fs.existsSync(file);
      const before = file === req.file ? req.text : exists ? fs.readFileSync(file, 'utf8') : '';
      let after = applyLspEdits(before, edits);
      if (entry.info.needs === 'name' && file === req.file) {
        const r = renameGenerated(before, after, req.name);
        after = r.text;
        if (r.start >= 0) select = { file, start: r.start, end: r.end };
      }
      files.push({ path: file, before, after, created: !exists });
    }
    if (!files.some((f) => f.before !== f.after)) throw new Error('Roslyn did not return any change for this refactoring.');
    return { files, select };
  }

  dispose() {
    if (this.ts) this.ts.terminate();
    this.ts = null;
    this.tsRoot = null;
    this.roslyn.clear();
  }
}

module.exports = { RefactorService, TITLES };
