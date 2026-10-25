'use strict';
// Main-branch knowledge graph: a second index worker that keeps a graph of main (or master) built
// straight from git objects, and follows it in the background - commits, merges and pulls on main,
// and origin/main after the periodic background fetch - while the working tree is on any branch.
// Saved next to the working-tree graph (as <project>-<id>@main.json) so agents can query it too.
const path = require('path');
const { Worker } = require('worker_threads');
const { app } = require('electron');
const settings = require('../../settings');
const { APP_ROOT } = require('../../protocol');
const { graphFileName } = require('./graph');
const { resolveMainRef, commitInfo } = require('./git-sync');
const A_VERSION = require('./analyzer').VERSION;

const WASM_DIR = path.join(APP_ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

class BranchGraph {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    this.root = null;
    this.status = { state: 'idle' };
    this.fetchTimer = null;
    this.syncing = null;
    this.again = false;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const w = new Worker(path.join(__dirname, 'worker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`), { workerData: { wasmDir: WASM_DIR, graphFile: null } });
    this.worker = w;
    w.on('message', (msg) => {
      if (msg.event) return;
      const p = this.pending.get(msg.id);
      if (!p || p.worker !== w) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
    w.on('error', (err) => this.worker === w && this.setStatus({ ...this.status, state: 'error', error: err.message }));
    w.on('exit', () => {
      for (const [id, p] of this.pending) {
        if (p.worker !== w) continue;
        this.pending.delete(id);
        p.reject(new Error('Branch graph worker stopped'));
      }
      if (this.worker === w) this.worker = null;
    });
    return w;
  }

  call(type, payload) {
    const w = this.ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker: w });
      w.postMessage({ id, type, payload });
    });
  }

  setStatus(s) {
    this.status = s;
    if (this.ctx.send) this.ctx.send('index:branch', s);
  }

  knowledgeDir() {
    return path.join(app.getPath('userData'), 'knowledge');
  }

  async open(root) {
    this.dispose();
    this.root = root;
    const main = await resolveMainRef(root);
    if (!main || this.root !== root) {
      if (this.root === root) this.setStatus({ state: 'none' });
      return;
    }
    this.branch = main.branch;
    this.graphFile = path.join(this.knowledgeDir(), graphFileName(root, main.branch));
    this.setStatus({ state: 'syncing', branch: main.branch, ref: main.ref, commit: main.commit });
    await this.call('gitOpen', { root, graphFile: this.graphFile, version: A_VERSION });
    await this.sync(main);
    this.scheduleFetch();
  }

  async sync(main) {
    const started = Date.now();
    const r = await this.call('gitSync', { root: this.root, commit: main.commit, ref: main.ref, branch: main.branch });
    const info = await commitInfo(this.root, main.commit);
    this.setStatus({ state: 'ready', branch: main.branch, ref: main.ref, commit: main.commit, ...info, files: r.files, read: r.read, ms: Date.now() - started, syncedAt: Date.now(), fetchedAt: this.fetchedAt || null });
  }

  /** Called when anything under .git changes (debounced by the watcher): follow main if it moved. */
  onGitChange() {
    if (!this.root || this.status.state === 'none' || this.status.state === 'idle') return Promise.resolve();
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.again = false;
        const main = await resolveMainRef(this.root);
        if (!main) continue;
        if (main.branch !== this.branch) {
          await this.open(this.root);
          return;
        }
        if (main.commit !== this.status.commit) {
          this.setStatus({ ...this.status, state: 'syncing', ref: main.ref, commit: main.commit });
          await this.sync(main);
        }
      } while (this.again);
    })()
      .catch((err) => this.setStatus({ ...this.status, state: 'error', error: err.message }))
      .finally(() => {
        this.syncing = null;
      });
    return this.syncing;
  }

  scheduleFetch() {
    clearInterval(this.fetchTimer);
    const minutes = this.opts.fetchMinutes != null ? this.opts.fetchMinutes : ((settings.get().knowledgeGraph || {}).fetchMinutes ?? 10);
    if (!minutes || !this.ctx.git || !this.ctx.git.raw) return;
    this.fetchTimer = setInterval(() => this.fetch().catch(() => {}), minutes * 60000);
    this.fetchTimer.unref();
  }

  /** Background fetch of origin's main so the graph follows merged pull requests too. */
  async fetch() {
    if (!this.root || !this.branch || !this.ctx.git || !this.ctx.git.remotes) return false;
    const remotes = await this.ctx.git.remotes();
    if (!remotes.some((r) => r.name === 'origin')) return false;
    const r = await this.ctx.git.raw(['fetch', '--quiet', '--no-tags', 'origin', this.branch], { timeout: 120000, quiet: true });
    this.fetchedAt = Date.now();
    await this.onGitChange();
    return r.code === 0;
  }

  dispose() {
    clearInterval(this.fetchTimer);
    this.fetchTimer = null;
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      w.postMessage({ id: 0, type: 'save' });
      setTimeout(() => w.terminate(), 300).unref();
    }
    this.root = null;
    this.status = { state: 'idle' };
  }
}

module.exports = { BranchGraph };
