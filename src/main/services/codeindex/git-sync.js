'use strict';
// Knowledge graph of a git commit without checking it out: lists files with `git ls-tree`, reads
// them with `git cat-file --batch`, and on later commits re-reads only what `git diff` reports as
// changed. Used for the main-branch graph (IDE and agent tools).
const { spawn, execFile } = require('child_process');
const G = require('./graph');

const MAX_FILE = 1.5 * 1024 * 1024;
const GIT_ENV = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' });

function git(cwd, args, { encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding, maxBuffer: 512 * 1024 * 1024, env: GIT_ENV() }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
  });
}

const tryGit = (cwd, args) =>
  git(cwd, args)
    .then((s) => s.trim())
    .catch(() => null);

/** Repository top level and the project's path inside it ('' or 'services/api/'). */
async function repoInfo(dir) {
  const top = await tryGit(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const prefix = (await tryGit(dir, ['rev-parse', '--show-prefix'])) || '';
  return { top, prefix };
}

/**
 * The main branch to follow: the remote's default branch if known, else main or master. When both the
 * local branch and origin's exist and origin is ahead (after a fetch), origin's commit is used.
 */
async function resolveMainRef(dir) {
  const info = await repoInfo(dir);
  if (!info) return null;
  const candidates = [];
  const originHead = await tryGit(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead && originHead.startsWith('origin/')) candidates.push(originHead.slice('origin/'.length));
  for (const b of ['main', 'master']) if (!candidates.includes(b)) candidates.push(b);
  for (const branch of candidates) {
    const local = await tryGit(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    const remote = await tryGit(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`]);
    if (!local && !remote) continue;
    let ref = local ? branch : `origin/${branch}`;
    let commit = local || remote;
    if (local && remote && local !== remote) {
      const behind = await git(dir, ['merge-base', '--is-ancestor', local, remote]).then(() => true).catch(() => false);
      if (behind) {
        ref = `origin/${branch}`;
        commit = remote;
      }
    }
    return { branch, ref, commit, top: info.top, prefix: info.prefix };
  }
  return null;
}

/** Contents of `commit:path` for each path, read through one `git cat-file --batch` process. */
function readBlobs(cwd, commit, paths) {
  return new Promise((resolve, reject) => {
    const out = new Map();
    if (!paths.length) {
      resolve(out);
      return;
    }
    const p = spawn('git', ['cat-file', '--batch'], { cwd, env: GIT_ENV(), stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = Buffer.alloc(0);
    let idx = 0;
    let need = null;
    let type = null;
    p.stdout.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      for (;;) {
        if (need === null) {
          const nl = buf.indexOf(10);
          if (nl < 0) break;
          const line = buf.subarray(0, nl).toString('utf8');
          buf = buf.subarray(nl + 1);
          const m = /^(\S+) (\S+) (\d+)$/.exec(line);
          if (!m) {
            idx++; // "<object> missing"
            continue;
          }
          type = m[2];
          need = Number(m[3]);
        }
        if (buf.length < need + 1) break;
        if (type === 'blob') out.set(paths[idx], Buffer.from(buf.subarray(0, need)));
        buf = buf.subarray(need + 1);
        idx++;
        need = null;
      }
    });
    p.on('error', reject);
    p.on('close', () => resolve(out));
    p.stdin.on('error', () => {});
    p.stdin.end(`${paths.map((x) => `${commit}:${x}`).join('\n')}\n`);
  });
}

/**
 * Bring `state` to `commit`: full build the first time (or when the previous commit is gone),
 * otherwise re-read only files changed between the commits. Paths are relative to `root` (which may
 * be a folder inside the repository).
 */
async function syncFromGit(state, { root, commit, analyze, langOf }) {
  const info = await repoInfo(root);
  if (!info) throw new Error(`${root} is not inside a git repository`);
  const { top, prefix } = info;
  if (state.commit === commit) return { read: 0, removed: 0, commit, files: state.files.size };
  const pathspec = prefix ? ['--', prefix] : [];
  const strip = (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : prefix ? null : p);
  const incremental = !!state.commit && (await git(top, ['cat-file', '-e', `${state.commit}^{commit}`]).then(() => true).catch(() => false));
  const toRead = [];
  const removed = [];
  if (incremental) {
    const parts = (await git(top, ['diff', '--name-status', '-z', '--no-renames', state.commit, commit, ...pathspec])).split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const rel = strip(parts[i + 1]);
      if (!rel) continue;
      if (parts[i].startsWith('D')) removed.push(rel);
      else if (langOf(rel)) toRead.push(rel);
      else if (state.files.has(rel)) removed.push(rel);
    }
  } else {
    for (const rel of [...state.files.keys()]) G.removeFile(state, rel);
    for (const p of (await git(top, ['ls-tree', '-r', '-z', '--name-only', commit, ...pathspec])).split('\0')) {
      const rel = p && strip(p);
      if (rel && langOf(rel)) toRead.push(rel);
    }
  }
  for (const rel of removed) G.removeFile(state, rel);
  const blobs = await readBlobs(top, commit, toRead.map((rel) => prefix + rel));
  let read = 0;
  const now = Date.now();
  for (const rel of toRead) {
    const b = blobs.get(prefix + rel);
    if (!b) {
      G.removeFile(state, rel);
      continue;
    }
    if (b.length > MAX_FILE) continue;
    const lang = langOf(rel);
    const r = analyze(lang, b.toString('utf8'), false);
    G.addEntry(state, rel, { lang, mtime: 0, size: b.length, defs: r.defs, counts: Object.fromEntries(r.counts), calls: r.calls, bases: r.bases, imports: r.imports, uses: r.uses, locals: r.locals }, { trackHistory: true, now });
    read++;
  }
  state.commit = commit;
  return { read, removed: removed.length, commit, files: state.files.size };
}

/** Subject, author and date of a commit, for the status bar. */
async function commitInfo(dir, commit) {
  const out = await tryGit(dir, ['log', '-1', '--format=%h%x1f%s%x1f%an%x1f%ct', commit]);
  if (!out) return {};
  const [short, subject, author, ct] = out.split('\x1f');
  return { short, subject, author, date: Number(ct) * 1000 };
}

module.exports = { resolveMainRef, syncFromGit, readBlobs, commitInfo, repoInfo };
