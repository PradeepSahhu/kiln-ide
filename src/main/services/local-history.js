'use strict';
// Local History (like JetBrains IDEs): snapshots of a file taken before every save from the IDE and
// before changes made outside the editor (Claude, other agents, git). Stored in Kiln's app-data
// folder, never inside the project, so nothing here can end up in a commit.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const MAX_PER_FILE = 60;
const MAX_AGE = 21 * 24 * 3600 * 1000;
const MAX_SIZE = 2 * 1024 * 1024;

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

class LocalHistory {
  constructor(ctx) {
    this.ctx = ctx;
    this.queue = Promise.resolve();
  }

  base() {
    return path.join(app.getPath('userData'), 'local-history', sha(this.ctx.root || 'none').slice(0, 16));
  }

  fileDir(file) {
    return path.join(this.base(), sha(path.relative(this.ctx.root, file)).slice(0, 20));
  }

  async readIndex(dir) {
    try {
      return JSON.parse(await fsp.readFile(path.join(dir, 'index.json'), 'utf8'));
    } catch {
      return { file: null, entries: [] };
    }
  }

  /** Store `content` as a version of `file` (skipped when identical to the latest version). */
  snapshot(file, content, label) {
    if (!this.ctx.root || content == null || content.length > MAX_SIZE) return Promise.resolve(null);
    const task = this.queue.then(async () => {
      const dir = this.fileDir(file);
      await fsp.mkdir(dir, { recursive: true });
      const index = await this.readIndex(dir);
      const digest = sha(content);
      if (index.entries.length && index.entries[0].digest === digest) return null;
      const at = Date.now();
      const id = `${at}`;
      await fsp.writeFile(path.join(dir, id + '.txt'), content);
      index.file = path.relative(this.ctx.root, file);
      index.entries.unshift({ id, at, label: label || 'Snapshot', size: content.length, digest });
      const keep = [];
      for (const e of index.entries) {
        if (keep.length < MAX_PER_FILE && at - e.at < MAX_AGE) keep.push(e);
        else fsp.unlink(path.join(dir, e.id + '.txt')).catch(() => {});
      }
      index.entries = keep;
      await fsp.writeFile(path.join(dir, 'index.json'), JSON.stringify(index));
      await this.journal({ at, rel: index.file, label: label || 'Snapshot', id });
      return { id, at };
    });
    this.queue = task.catch(() => null);
    return task;
  }

  async journal(entry) {
    const f = path.join(this.base(), 'journal.json');
    let list = [];
    try {
      list = JSON.parse(await fsp.readFile(f, 'utf8'));
    } catch {
      list = [];
    }
    list.unshift(entry);
    await fsp.writeFile(f, JSON.stringify(list.slice(0, 800)));
  }

  /** Snapshot the current disk content of a file before it gets overwritten. */
  async snapshotDisk(file, label) {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile() || st.size > MAX_SIZE) return null;
      return this.snapshot(file, await fsp.readFile(file, 'utf8'), label);
    } catch {
      return null;
    }
  }

  async list(file) {
    const index = await this.readIndex(this.fileDir(file));
    return index.entries.map(({ digest, ...e }) => e);
  }

  async read(file, id) {
    return fsp.readFile(path.join(this.fileDir(file), `${id}.txt`), 'utf8');
  }

  async recent(limit = 200) {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.base(), 'journal.json'), 'utf8')).slice(0, limit);
    } catch {
      return [];
    }
  }

  /** Restore a version; the current content is snapshotted first so the revert can be undone. */
  async revert(file, id) {
    const content = await this.read(file, id);
    await this.snapshotDisk(file, 'Before revert');
    await fsp.writeFile(file, content);
    return { ok: true };
  }
}

module.exports = { LocalHistory };
