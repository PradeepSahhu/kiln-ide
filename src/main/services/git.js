'use strict';
// Git integration built on the git CLI: status, branches (with delete/restore), log, commit,
// stash, and diff content for working tree / staged / commit / stash / branch-range views.
const fs = require('fs');
const path = require('path');
const { run } = require('../util/proc');
const github = require('./github');

const US = '\x1f'; // unit separator between fields
const RS = '\x1e'; // record separator between entries

// Commands that change repository state are echoed to the Git console tool window.
const NETWORK = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'submodule']);
const LOGGED = new Set(['checkout', 'switch', 'branch', 'commit', 'stash', 'merge', 'rebase', 'fetch', 'pull', 'push', 'add', 'restore', 'reset', 'init', 'clone', 'rm', 'cherry-pick', 'revert', 'tag']);

function kindOf(x, y) {
  if (x === 'A') return 'added';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C') return 'copied';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

function parseNameStatus(out) {
  const t = out.split('\0');
  const files = [];
  for (let i = 0; i < t.length; i++) {
    const code = t[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const origPath = t[++i];
      const p = t[++i];
      files.push({ path: p, origPath, kind: letter === 'R' ? 'renamed' : 'copied' });
    } else {
      const p = t[++i];
      const kind = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'U' ? 'conflict' : 'modified';
      files.push({ path: p, kind });
    }
  }
  return files;
}

function parseNumstat(out) {
  const map = new Map();
  const t = out.split('\0');
  for (let i = 0; i < t.length; i++) {
    const rec = t[i];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(rec);
    if (!m) continue;
    let p = m[3];
    if (p === '') {
      i++; // old path
      p = t[++i];
    }
    map.set(p, { added: m[1] === '-' ? null : +m[1], deleted: m[2] === '-' ? null : +m[2], binary: m[1] === '-' });
  }
  return map;
}

function parseTrack(track) {
  const ahead = /ahead (\d+)/.exec(track || '');
  const behind = /behind (\d+)/.exec(track || '');
  return { ahead: ahead ? +ahead[1] : 0, behind: behind ? +behind[1] : 0, gone: /gone/.test(track || '') };
}

class GitService {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.gitDir = null;
  }

  env() {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'en_US.UTF-8', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' };
  }

  async raw(args, { cwd = this.root, input, encoding, timeout, quiet = false } = {}) {
    const full = ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args];
    const sub0 = args.find((a) => !a.startsWith('-'));
    // Commands that talk to a remote get the GitHub connection (gh login or token).
    const env = NETWORK.has(sub0) ? await github.gitEnv(this.env()) : this.env();
    const res = await run('git', full, { cwd, input, encoding, timeout, env });
    const sub = args.find((a) => !a.startsWith('-'));
    if (!quiet && (LOGGED.has(sub) || (res.code !== 0 && sub !== 'show' && sub !== 'rev-parse' && sub !== 'show-ref'))) {
      this.ctx.send('git:console', {
        at: Date.now(),
        cmd: 'git ' + args.join(' '),
        code: res.code,
        output: encoding === 'buffer' ? '' : ((res.stdout || '') + (res.stderr || '')).slice(0, 20000),
      });
    }
    return res;
  }

  async ok(args, opts) {
    const r = await this.raw(args, opts);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout || '').trim() || `git ${args[0]} failed`;
      const err = new Error(msg);
      err.gitCode = r.code;
      throw err;
    }
    return r.stdout;
  }

  async init(projectRoot) {
    this.root = null;
    this.gitDir = null;
    const r = await run('git', ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd: projectRoot, env: this.env() });
    if (r.code === 0) {
      const [top, gitDir] = r.stdout.trim().split('\n');
      this.root = fs.realpathSync(top);
      this.gitDir = gitDir;
    }
    return this.info();
  }

  info() {
    return { isRepo: !!this.root, root: this.root, gitDir: this.gitDir };
  }

  require() {
    if (!this.root) throw new Error('This project is not a Git repository.');
  }

  /** Repo-relative path from an absolute path. */
  rel(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  async version() {
    const r = await run('git', ['--version'], { env: this.env() });
    return r.code === 0 ? r.stdout.trim().replace(/^git version\s*/, '') : null;
  }

  async initRepo(dir) {
    await this.ok(['init'], { cwd: dir });
    return this.init(dir);
  }

  // ---------------------------------------------------------------- status

  async status() {
    if (!this.root) return { isRepo: false };
    const r = await this.raw(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    if (r.code !== 0) return { isRepo: true, error: r.stderr.trim(), files: [], branch: {} };
    const tokens = r.stdout.split('\0');
    const branch = { head: null, oid: null, upstream: null, ahead: 0, behind: 0, detached: false };
    const files = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t) continue;
      if (t.startsWith('# ')) {
        const [, key, ...rest] = t.split(' ');
        const val = rest.join(' ');
        if (key === 'branch.oid') branch.oid = val === '(initial)' ? null : val;
        else if (key === 'branch.head') {
          branch.detached = val === '(detached)';
          branch.head = branch.detached ? null : val;
        } else if (key === 'branch.upstream') branch.upstream = val;
        else if (key === 'branch.ab') {
          const m = /\+(\d+) -(\d+)/.exec(val);
          if (m) {
            branch.ahead = +m[1];
            branch.behind = +m[2];
          }
        }
        continue;
      }
      const type = t[0];
      if (type === '1' || type === '2') {
        const parts = t.split(' ');
        const xy = parts[1];
        const x = xy[0];
        const y = xy[1];
        const p = parts.slice(type === '1' ? 8 : 9).join(' ');
        const origPath = type === '2' ? tokens[++i] : undefined;
        files.push({ path: p, origPath, x, y, kind: kindOf(x, y), staged: x !== '.', unstaged: y !== '.' });
      } else if (type === 'u') {
        const parts = t.split(' ');
        files.push({ path: parts.slice(10).join(' '), x: parts[1][0], y: parts[1][1], kind: 'conflict', staged: false, unstaged: true });
      } else if (type === '?') {
        files.push({ path: t.slice(2), x: '?', y: '?', kind: 'untracked', untracked: true, staged: false, unstaged: true });
      }
    }
    if (branch.detached && branch.oid) branch.short = branch.oid.slice(0, 8);
    const state = this.repoState();
    return { isRepo: true, root: this.root, branch, files, ...state };
  }

  repoState() {
    const exists = (f) => fs.existsSync(path.join(this.gitDir, f));
    return {
      merging: exists('MERGE_HEAD'),
      rebasing: exists('rebase-merge') || exists('rebase-apply'),
      cherryPicking: exists('CHERRY_PICK_HEAD'),
      reverting: exists('REVERT_HEAD'),
    };
  }

  // -------------------------------------------------------------- branches

  async branches() {
    this.require();
    const fmt = ['%(HEAD)', '%(refname)', '%(refname:short)', '%(objectname:short)', '%(objectname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(subject)', '%(authorname)'].join('%1f');
    const out = await this.ok(['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads', 'refs/remotes']);
    const local = [];
    const remote = [];
    let current = null;
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [head, ref, short, sha, fullSha, upstream, track, date, subject, author] = line.split(US);
      if (ref.startsWith('refs/remotes/')) {
        if (ref.endsWith('/HEAD')) continue;
        remote.push({ name: short, ref, sha, fullSha, date: +date * 1000, subject, author, remote: short.split('/')[0] });
      } else {
        const b = { name: short, ref, sha, fullSha, upstream: upstream || null, ...parseTrack(track), date: +date * 1000, subject, author, current: head === '*' };
        if (b.current) current = b.name;
        local.push(b);
      }
    }
    if (!current) {
      const st = await this.status();
      if (st.branch && st.branch.detached) current = null;
      else if (st.branch && st.branch.head && !local.some((b) => b.name === st.branch.head)) {
        // Fresh repository: HEAD points at an unborn branch.
        local.unshift({ name: st.branch.head, current: true, unborn: true, sha: '', date: Date.now(), subject: 'No commits yet' });
        current = st.branch.head;
      }
    }
    return { current, local, remote };
  }

  async defaultBase() {
    this.require();
    const r = await this.raw(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    const candidates = [];
    if (r.code === 0 && r.stdout.trim()) candidates.push(r.stdout.trim());
    for (const n of ['main', 'master', 'develop', 'dev', 'trunk']) candidates.push(n, `origin/${n}`);
    const st = await this.status();
    const head = st.branch && st.branch.head;
    for (const c of candidates) {
      if (c === head) continue;
      const ok = await this.raw(['rev-parse', '--verify', '-q', c + '^{commit}']);
      if (ok.code === 0) return c;
    }
    if (st.branch && st.branch.upstream) return st.branch.upstream;
    return null;
  }

  async checkout(ref, { remote = false } = {}) {
    this.require();
    let args;
    if (remote) {
      const local = ref.replace(/^[^/]+\//, '');
      const exists = await this.raw(['show-ref', '--verify', '-q', `refs/heads/${local}`]);
      args = exists.code === 0 ? ['checkout', local] : ['checkout', '-b', local, '--track', ref];
    } else {
      args = ['checkout', ref];
    }
    const r = await this.raw(args);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim();
      return { ok: false, error: msg, canSmartCheckout: /would be overwritten|commit your changes or stash them/i.test(msg) };
    }
    return { ok: true };
  }

  /** Rider's "Smart Checkout": stash local changes, check out, then re-apply them. */
  async smartCheckout(ref, opts = {}) {
    this.require();
    const stash = await this.raw(['stash', 'push', '--include-untracked', '-m', `Kiln smart checkout to ${ref}`]);
    if (stash.code !== 0) return { ok: false, error: stash.stderr.trim() };
    const co = await this.checkout(ref, opts);
    if (!co.ok) {
      await this.raw(['stash', 'pop']);
      return co;
    }
    const pop = await this.raw(['stash', 'pop']);
    if (pop.code !== 0) return { ok: true, warning: 'Your changes were stashed but re-applying them caused conflicts. Resolve them, then drop the stash.\n' + (pop.stderr || pop.stdout).trim() };
    return { ok: true };
  }

  async createBranch(name, { from, checkout = true } = {}) {
    this.require();
    const args = checkout ? ['checkout', '-b', name] : ['branch', name];
    if (from) args.push(from);
    const r = await this.raw(args);
    if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() };
    return { ok: true };
  }

  async deleteBranch(name, { force = false } = {}) {
    this.require();
    const sha = (await this.raw(['rev-parse', '--verify', '-q', `refs/heads/${name}`])).stdout.trim();
    const r = await this.raw(['branch', force ? '-D' : '-d', name]);
    if (r.code === 0) return { ok: true, sha };
    const msg = (r.stderr || r.stdout).trim();
    if (/not fully merged/i.test(msg)) {
      const unmerged = await this.raw(['rev-list', '--count', `HEAD..${name}`]);
      return { ok: false, needsForce: true, sha, unmergedCommits: +unmerged.stdout.trim() || 0, error: msg };
    }
    return { ok: false, error: msg };
  }

  async restoreBranch(name, sha) {
    this.require();
    await this.ok(['branch', name, sha]);
    return { ok: true };
  }

  async renameBranch(oldName, newName) {
    this.require();
    const r = await this.raw(['branch', '-m', oldName, newName]);
    return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() };
  }

  async merge(ref) {
    this.require();
    const r = await this.raw(['merge', '--no-edit', ref]);
    return r.code === 0 ? { ok: true, output: r.stdout.trim() } : { ok: false, error: (r.stdout + '\n' + r.stderr).trim() };
  }

  async rebase(ref) {
    this.require();
    const r = await this.raw(['rebase', ref]);
    return r.code === 0 ? { ok: true, output: r.stdout.trim() } : { ok: false, error: (r.stdout + '\n' + r.stderr).trim() };
  }

  async abort() {
    this.require();
    const st = this.repoState();
    const args = st.merging ? ['merge', '--abort'] : st.rebasing ? ['rebase', '--abort'] : st.cherryPicking ? ['cherry-pick', '--abort'] : st.reverting ? ['revert', '--abort'] : null;
    if (!args) return { ok: true };
    const r = await this.raw(args);
    return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() };
  }

  /** Create a GitHub repository for this project, add it as origin and push the current branch. */
  async publishToGithub({ name, isPrivate = true, description = '' }) {
    this.require();
    const remotes = await this.remotes();
    if (remotes.some((r) => r.name === 'origin')) throw new Error('This repository already has an "origin" remote.');
    const st = await this.status();
    const url = await github.createRepo({ name, isPrivate, description, env: this.env() });
    await this.ok(['remote', 'add', 'origin', url]);
    if (st.branch.oid && st.branch.oid !== '(initial)' && st.branch.head) {
      const r = await this.raw(['push', '-u', 'origin', st.branch.head], { timeout: 180000 });
      if (r.code !== 0) return { ok: false, url, error: r.stderr.trim() };
    }
    return { ok: true, url };
  }

  async remotes() {
    if (!this.root) return [];
    const r = await this.raw(['remote', '-v']);
    const seen = new Map();
    for (const line of r.stdout.split('\n')) {
      const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(line);
      if (m && !seen.has(m[1])) seen.set(m[1], { name: m[1], url: m[2] });
    }
    return [...seen.values()];
  }

  async fetch() {
    this.require();
    const r = await this.raw(['fetch', '--all', '--prune'], { timeout: 120000 });
    return r.code === 0 ? { ok: true, output: (r.stdout + r.stderr).trim() } : { ok: false, error: r.stderr.trim() };
  }

  async pull() {
    this.require();
    const r = await this.raw(['pull', '--no-edit'], { timeout: 180000 });
    return r.code === 0 ? { ok: true, output: (r.stdout + r.stderr).trim() } : { ok: false, error: (r.stdout + '\n' + r.stderr).trim() };
  }

  async push({ force = false } = {}) {
    this.require();
    const st = await this.status();
    if (!st.branch.head) return { ok: false, error: 'Cannot push a detached HEAD.' };
    let args = ['push'];
    if (!st.branch.upstream) {
      const remotes = await this.remotes();
      if (!remotes.length) return { ok: false, error: 'No remote is configured for this repository.' };
      const remote = remotes.find((r) => r.name === 'origin') || remotes[0];
      args = ['push', '-u', remote.name, st.branch.head];
    }
    if (force) args.push('--force-with-lease');
    const r = await this.raw(args, { timeout: 180000 });
    return r.code === 0 ? { ok: true, output: (r.stdout + r.stderr).trim() } : { ok: false, error: r.stderr.trim() };
  }

  // ------------------------------------------------------------------- log

  async log({ ref, all = false, limit = 400, skip = 0, range, grep, file } = {}) {
    this.require();
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f') + '%x1e';
    const args = ['log', `--format=${fmt}`, `-n${limit}`, `--skip=${skip}`, '--date-order'];
    if (grep) args.push(`--grep=${grep}`, '-i');
    if (all) args.push('--all');
    else if (range) args.push(range);
    else args.push(ref || 'HEAD');
    if (file) args.push('--', file);
    const r = await this.raw(args);
    if (r.code !== 0) return [];
    return r.stdout
      .split(RS)
      .map((s) => s.replace(/^\n/, ''))
      .filter(Boolean)
      .map((rec) => {
        const [hash, parents, author, email, at, refs, subject] = rec.split(US);
        return {
          hash,
          short: hash.slice(0, 8),
          parents: parents ? parents.split(' ') : [],
          author,
          email,
          date: +at * 1000,
          refs: refs ? refs.split(', ').filter(Boolean) : [],
          subject,
        };
      });
  }

  async commitDetails(hash) {
    this.require();
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%D', '%B'].join('%x1f');
    const out = await this.ok(['show', '-s', `--format=${fmt}`, hash]);
    const [full, parents, author, email, at, committer, ct, refs, body] = out.split(US);
    const parentList = parents ? parents.split(' ').filter(Boolean) : [];
    const diffArgs = parentList.length ? ['diff-tree', '-r', '-M', '--name-status', '-z', parentList[0], full] : ['diff-tree', '-r', '-M', '--root', '--name-status', '-z', '--no-commit-id', full];
    const files = parseNameStatus(await this.ok(diffArgs));
    const numArgs = parentList.length ? ['diff', '--numstat', '-z', '-M', parentList[0], full] : ['diff-tree', '-r', '--root', '--numstat', '-z', '--no-commit-id', full];
    const stats = parseNumstat((await this.raw(numArgs)).stdout);
    for (const f of files) Object.assign(f, stats.get(f.path) || {});
    return {
      hash: full,
      parents: parentList,
      author,
      email,
      date: +at * 1000,
      committer,
      commitDate: +ct * 1000,
      refs: refs ? refs.split(', ').filter(Boolean) : [],
      message: (body || '').trim(),
      files,
    };
  }

  async lastCommitMessage() {
    if (!this.root) return '';
    const r = await this.raw(['log', '-1', '--format=%B']);
    return r.code === 0 ? r.stdout.trim() : '';
  }

  // ------------------------------------------------------- staging/commit

  async stage(paths) {
    this.require();
    if (!paths.length) return { ok: true };
    await this.ok(['add', '-A', '--', ...paths]);
    return { ok: true };
  }

  async unstage(paths) {
    this.require();
    if (!paths.length) return { ok: true };
    const hasHead = (await this.raw(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    if (hasHead) await this.ok(['reset', '-q', 'HEAD', '--', ...paths]);
    else await this.ok(['rm', '-q', '--cached', '-r', '--', ...paths]);
    return { ok: true };
  }

  /** Rider's "Rollback": discard local changes of the given files (untracked files go to the Trash). */
  async rollback(files) {
    this.require();
    const { shell } = require('electron');
    const tracked = [];
    for (const f of files) {
      if (f.kind === 'untracked' || (f.kind === 'added' && f.x === 'A')) {
        if (f.kind === 'added') await this.raw(['rm', '-q', '--cached', '--', f.path]);
        const abs = path.join(this.root, f.path);
        if (fs.existsSync(abs)) await shell.trashItem(abs);
      } else {
        tracked.push(f.path);
        if (f.origPath) tracked.push(f.origPath);
      }
    }
    if (tracked.length) {
      const hasHead = (await this.raw(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
      if (hasHead) await this.ok(['checkout', 'HEAD', '--', ...tracked]);
    }
    return { ok: true };
  }

  /**
   * Commit the selected files (Rider's change-list model: every checked file is committed with its
   * working-tree content, regardless of what is staged). Unchecked files stay as local changes.
   */
  async commit({ message, files, amend = false }) {
    this.require();
    if (!message || !message.trim()) return { ok: false, error: 'Commit message is empty.' };
    const untracked = files.filter((f) => f.kind === 'untracked').map((f) => f.path);
    if (untracked.length) await this.ok(['add', '--', ...untracked]);
    const paths = [];
    for (const f of files) {
      paths.push(f.path);
      if (f.origPath) paths.push(f.origPath);
    }
    const args = ['commit', '-F', '-'];
    if (amend) args.push('--amend');
    if (paths.length) args.push('--only', '--', ...paths);
    const r = await this.raw(args, { input: message });
    if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() };
    const hash = (await this.raw(['rev-parse', '--short', 'HEAD'])).stdout.trim();
    return { ok: true, hash, output: r.stdout.trim() };
  }

  // ----------------------------------------------------------------- stash

  async stashList() {
    if (!this.root) return [];
    const r = await this.raw(['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%ct']);
    if (r.code !== 0) return [];
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, hash, subject, ct] = line.split(US);
        const m = /^(?:WIP )?[Oo]n ([^:]+): (.*)$/.exec(subject || '');
        return { ref, hash, subject, branch: m ? m[1] : null, message: m ? m[2] : subject, date: +ct * 1000 };
      });
  }

  async stashFiles(ref) {
    this.require();
    const r = await this.raw(['stash', 'show', '--name-status', '-z', '--include-untracked', ref]);
    let files = r.code === 0 ? parseNameStatus(r.stdout) : parseNameStatus(await this.ok(['diff', '--name-status', '-z', '-M', `${ref}^1`, ref]));
    const untracked = new Set();
    if ((await this.raw(['rev-parse', '-q', '--verify', `${ref}^3`])).code === 0) {
      const t = await this.raw(['ls-tree', '-r', '--name-only', '-z', `${ref}^3`]);
      for (const p of t.stdout.split('\0').filter(Boolean)) untracked.add(p);
    }
    files = files.map((f) => (untracked.has(f.path) ? { ...f, kind: 'untracked', untracked: true } : f));
    for (const p of untracked) if (!files.some((f) => f.path === p)) files.push({ path: p, kind: 'untracked', untracked: true });
    return files;
  }

  async stashPush({ message, includeUntracked = true, keepIndex = false, paths } = {}) {
    this.require();
    const args = ['stash', 'push'];
    if (includeUntracked) args.push('--include-untracked');
    if (keepIndex) args.push('--keep-index');
    if (message) args.push('-m', message);
    if (paths && paths.length) args.push('--', ...paths);
    const r = await this.raw(args);
    if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() };
    if (/No local changes to save/i.test(r.stdout)) return { ok: false, error: 'No local changes to stash.' };
    return { ok: true };
  }

  async stashApply(ref, { pop = false, index = false } = {}) {
    this.require();
    const args = ['stash', pop ? 'pop' : 'apply'];
    if (index) args.push('--index');
    args.push(ref);
    const r = await this.raw(args);
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.stdout + '\n' + r.stderr).trim() };
  }

  async stashDrop(ref) {
    this.require();
    const r = await this.raw(['stash', 'drop', ref]);
    return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() };
  }

  async stashBranch(ref, name) {
    this.require();
    const r = await this.raw(['stash', 'branch', name, ref]);
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.stdout + '\n' + r.stderr).trim() };
  }

  // ------------------------------------------------------------- blame

  /** Line-by-line authorship; `content` blames the editor buffer instead of the saved file. */
  async blame(abs, content) {
    this.require();
    const rel = this.rel(abs);
    const args = ['blame', '--porcelain'];
    if (content != null) args.push('--contents', '-');
    args.push('--', rel);
    const r = await this.raw(args, { input: content != null ? content : undefined });
    if (r.code !== 0) return { lines: [], error: r.stderr.trim() };
    const commits = {};
    const lines = [];
    let cur = null;
    for (const line of r.stdout.split('\n')) {
      const head = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
      if (head) {
        cur = { sha: head[1], line: +head[3] };
        if (!commits[cur.sha]) commits[cur.sha] = { sha: cur.sha };
        continue;
      }
      if (!cur) continue;
      if (line.startsWith('\t')) {
        lines.push({ line: cur.line, sha: cur.sha });
        continue;
      }
      const sp = line.indexOf(' ');
      const key = sp > 0 ? line.slice(0, sp) : line;
      const val = sp > 0 ? line.slice(sp + 1) : '';
      const c = commits[cur.sha];
      if (key === 'author') c.author = val;
      else if (key === 'author-time') c.time = +val * 1000;
      else if (key === 'summary') c.summary = val;
    }
    return { lines, commits };
  }

  async headContent(abs) {
    if (!this.root) return null;
    const r = await this.show('HEAD', this.rel(abs));
    return r.missing || r.binary ? null : r.text;
  }

  // --------------------------------------------------- branch range changes

  /** Everything the current branch changed relative to `base` (commits + aggregated file diff). */
  async branchChanges({ base, includeWorking = true } = {}) {
    this.require();
    if (!base) base = await this.defaultBase();
    if (!base) return { base: null, commits: [], files: [], error: 'No base branch found to compare with.' };
    const mb = await this.raw(['merge-base', base, 'HEAD']);
    if (mb.code !== 0) return { base, commits: [], files: [], error: `No common ancestor between ${base} and HEAD.` };
    const mergeBase = mb.stdout.trim();
    const commits = await this.log({ range: `${mergeBase}..HEAD`, limit: 1000 });
    const target = includeWorking ? [mergeBase] : [mergeBase, 'HEAD'];
    const files = parseNameStatus(await this.ok(['diff', '--name-status', '-z', '-M', ...target]));
    const stats = parseNumstat((await this.raw(['diff', '--numstat', '-z', '-M', ...target])).stdout);
    for (const f of files) Object.assign(f, stats.get(f.path) || {});
    if (includeWorking) {
      const st = await this.status();
      for (const f of st.files || []) {
        if (f.kind === 'untracked' && !files.some((x) => x.path === f.path)) files.push({ path: f.path, kind: 'added', untracked: true });
      }
    }
    const ahead = +(await this.raw(['rev-list', '--count', `${base}..HEAD`])).stdout.trim() || 0;
    const behind = +(await this.raw(['rev-list', '--count', `HEAD..${base}`])).stdout.trim() || 0;
    return { base, mergeBase, includeWorking, commits, files, ahead, behind };
  }

  // ------------------------------------------------------- diff contents

  async show(rev, rel) {
    const r = await this.raw(['show', `${rev}:${rel}`], { encoding: 'buffer' });
    if (r.code !== 0) return { text: '', missing: true };
    const buf = r.stdout;
    for (let i = 0; i < Math.min(buf.length, 8000); i++) if (buf[i] === 0) return { text: '', binary: true };
    return { text: buf.toString('utf8') };
  }

  async working(rel) {
    const abs = path.join(this.root, rel);
    try {
      const buf = await fs.promises.readFile(abs);
      for (let i = 0; i < Math.min(buf.length, 8000); i++) if (buf[i] === 0) return { text: '', binary: true };
      return { text: buf.toString('utf8') };
    } catch {
      return { text: '', missing: true };
    }
  }

  /**
   * Both sides of a diff. `kind` selects what is compared:
   *   working  HEAD -> working tree       staged  HEAD -> index
   *   commit   ref^ -> ref                stash   ref^1 -> ref (untracked: nothing -> ref^3)
   *   range    base -> HEAD or working tree
   */
  async fileVersions({ kind, path: rel, origPath, ref, base, includeWorking, untracked, parent }) {
    this.require();
    const from = origPath || rel;
    let original = { text: '' };
    let modified = { text: '' };
    let labels = ['', ''];
    switch (kind) {
      case 'working': {
        const hasHead = (await this.raw(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
        original = hasHead ? await this.show('HEAD', from) : { text: '' };
        modified = await this.working(rel);
        labels = ['HEAD', 'Working tree'];
        break;
      }
      case 'staged':
        original = await this.show('HEAD', from);
        modified = await this.show('', rel);
        labels = ['HEAD', 'Staged'];
        break;
      case 'commit': {
        const p = parent || `${ref}^`;
        const hasParent = (await this.raw(['rev-parse', '--verify', '-q', p])).code === 0;
        original = hasParent ? await this.show(p, from) : { text: '' };
        modified = await this.show(ref, rel);
        labels = [hasParent ? p.slice(0, 10) : 'Empty', ref.slice(0, 10)];
        break;
      }
      case 'stash':
        if (untracked) {
          modified = await this.show(`${ref}^3`, rel);
          labels = ['Not tracked', `${ref} (untracked)`];
        } else {
          original = await this.show(`${ref}^1`, from);
          modified = await this.show(ref, rel);
          labels = ['Base', ref];
        }
        break;
      case 'range':
        original = await this.show(base, from);
        modified = includeWorking ? await this.working(rel) : await this.show('HEAD', rel);
        labels = [base.slice(0, 12), includeWorking ? 'Working tree' : 'HEAD'];
        break;
      default:
        throw new Error('Unknown diff kind: ' + kind);
    }
    return {
      original: original.text,
      modified: modified.text,
      binary: !!(original.binary || modified.binary),
      labels,
    };
  }
}

module.exports = { GitService, parseNameStatus };
