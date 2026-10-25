'use strict';
// Main-process side of the code index / knowledge graph: owns the worker thread and forwards requests.
const path = require('path');
const { Worker } = require('worker_threads');
const { app } = require('electron');
const { APP_ROOT } = require('../../protocol');
const { graphFileName } = require('./graph');

const WASM_DIR = path.join(APP_ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const INDEXABLE = /\.(cs|py|pyi|ts|tsx|mts|cts|js|jsx|mjs|cjs|go|java|rs|c|h|cc|cpp|cxx|hpp|hh|hxx|rb|php|sh|bash)$/i;

function graphFileFor(root) {
  return path.join(app.getPath('userData'), 'knowledge', graphFileName(root));
}

class CodeIndex {
  constructor(ctx) {
    this.ctx = ctx;
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    this.status = { state: 'idle' };
    this.root = null;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const w = new Worker(path.join(__dirname, 'worker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`), { workerData: { wasmDir: WASM_DIR, graphFile: this.root ? graphFileFor(this.root) : null } });
    this.worker = w;
    // Every handler checks it still belongs to the current worker: after a project switch the previous
    // worker saves and exits in the background and must not touch the new one's state.
    w.on('message', (msg) => {
      if (msg.event) {
        if (this.worker !== w) return;
        if (msg.event === 'progress') this.setStatus({ state: msg.done >= msg.total ? 'ready' : 'indexing', done: msg.done, total: msg.total });
        else if (msg.event === 'indexed') this.setStatus({ state: 'ready', ...msg.stats });
        else if (msg.event === 'changed') this.ctx.send('index:changed', { files: msg.files, stats: msg.stats });
        else if (msg.event === 'log') console.warn('[index]', msg.message);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p || p.worker !== w) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
    w.on('error', (err) => {
      console.error('[index] worker error', err);
      if (this.worker === w) this.setStatus({ state: 'error', error: err.message });
    });
    w.on('exit', () => {
      for (const [id, p] of this.pending) {
        if (p.worker !== w) continue;
        this.pending.delete(id);
        p.reject(new Error('Index worker stopped'));
      }
      if (this.worker === w) this.worker = null;
    });
    return w;
  }

  setStatus(s) {
    this.status = s;
    this.ctx.send('index:status', s);
  }

  call(type, payload) {
    const w = this.ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker: w });
      w.postMessage({ id, type, payload });
    });
  }

  async open(root, files) {
    this.dispose();
    this.root = root;
    this.setStatus({ state: 'indexing', done: 0, total: files.length });
    return this.call('init', { root, files });
  }

  onFsChange(paths) {
    if (!this.worker || !this.root) return;
    const files = paths.filter((p) => INDEXABLE.test(p));
    if (files.length) this.call('update', { files }).catch(() => {});
  }

  graphFile() {
    return this.root ? graphFileFor(this.root) : null;
  }

  dispose() {
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      w.postMessage({ id: 0, type: 'save' });
      setTimeout(() => w.terminate(), 300).unref();
    }
    this.root = null;
  }
}

module.exports = { CodeIndex, INDEXABLE, graphFileFor };
