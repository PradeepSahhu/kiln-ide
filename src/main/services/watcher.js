'use strict';
// Watches the project (and its .git directory) and reports batched changes to the renderer:
//   fs:changed  -> explorer refresh, reload of clean editors
//   git:changed -> status/branches/stash refresh
const fs = require('fs');
const path = require('path');

// Churn inside these folders never matters to the explorer or to git status.
const NOISY = /(^|[\\/])(node_modules|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|obj|bin|\.idea|\.vs|\.next|TestResults)([\\/]|$)/;
const GIT_SIGNAL = /^(HEAD|index|ORIG_HEAD|MERGE_HEAD|REBASE_HEAD|FETCH_HEAD|packed-refs|refs[\\/].*|logs[\\/]HEAD|logs[\\/]refs[\\/]stash|rebase-merge.*|rebase-apply.*)$/;

class Watcher {
  constructor({ root, gitDir, onFsChange, onGitChange }) {
    this.root = root;
    this.gitDir = gitDir;
    this.onFsChange = onFsChange;
    this.onGitChange = onGitChange;
    this.pending = new Set();
    this.overflow = false;
    this.gitPending = false;
    this.fsTimer = null;
    this.gitTimer = null;
    this.watchers = [];
  }

  start() {
    this.watch(this.root, (rel) => this.onProjectEvent(rel));
    const gitInside = this.gitDir && (this.gitDir === path.join(this.root, '.git') || this.gitDir.startsWith(this.root + path.sep));
    if (this.gitDir && !gitInside) this.watch(this.gitDir, (rel) => this.onGitEvent(rel));
  }

  watch(dir, handler) {
    try {
      const w = fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (filename) handler(filename.toString());
      });
      w.on('error', (err) => console.warn('[watcher]', dir, err.message));
      this.watchers.push(w);
    } catch (err) {
      console.warn('[watcher] cannot watch', dir, err.message);
    }
  }

  onProjectEvent(rel) {
    if (rel === '.git' || rel.startsWith('.git' + path.sep)) {
      this.onGitEvent(rel.slice(5));
      return;
    }
    if (NOISY.test(rel)) return;
    if (this.pending.size > 2000) this.overflow = true;
    else this.pending.add(path.join(this.root, rel));
    this.scheduleFs();
    this.scheduleGit();
  }

  onGitEvent(rel) {
    if (!rel || rel.endsWith('.lock') || rel.startsWith('objects')) return;
    if (!GIT_SIGNAL.test(rel)) return;
    this.scheduleGit();
  }

  scheduleFs() {
    clearTimeout(this.fsTimer);
    this.fsTimer = setTimeout(() => {
      const paths = [...this.pending];
      const overflow = this.overflow;
      this.pending.clear();
      this.overflow = false;
      this.onFsChange({ paths, overflow });
    }, 180);
  }

  scheduleGit() {
    clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(() => this.onGitChange(), 400);
  }

  stop() {
    clearTimeout(this.fsTimer);
    clearTimeout(this.gitTimer);
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers = [];
  }
}

module.exports = { Watcher };
