'use strict';
// File-system access for the explorer and editor.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { shell } = require('electron');
const { run } = require('../util/proc');

const HIDDEN = new Set(['.git', '.DS_Store', 'Thumbs.db']);
// Shown, but dimmed like Rider's "excluded" folders.
const EXCLUDED = new Set(['node_modules', 'bin', 'obj', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'dist', 'build', '.idea', '.vs', '.next', 'target', 'packages', 'TestResults', '.gradle', 'coverage', 'site-packages', '.eggs']);
const MAX_TEXT_SIZE = 10 * 1024 * 1024;

function collator() {
  return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
}
const cmp = collator();

async function readDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (HIDDEN.has(e.name)) continue;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let symlink = false;
    if (e.isSymbolicLink()) {
      symlink = true;
      try {
        isDir = (await fsp.stat(full)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    out.push({ name: e.name, path: full, dir: isDir, symlink, excluded: isDir && EXCLUDED.has(e.name) });
  }
  out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : cmp.compare(a.name, b.name)));
  return out;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function readFile(file) {
  const st = await fsp.stat(file);
  if (st.isDirectory()) throw new Error('Is a directory');
  const base = { path: file, size: st.size, mtime: st.mtimeMs };
  if (st.size > MAX_TEXT_SIZE) return { ...base, tooLarge: true };
  const buf = await fsp.readFile(file);
  if (looksBinary(buf)) return { ...base, binary: true };
  let bom = false;
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bom = true;
    start = 3;
  }
  const content = buf.subarray(start).toString('utf8');
  const lf = content.indexOf('\n');
  const eol = lf > 0 && content[lf - 1] === '\r' ? 'CRLF' : 'LF';
  return { ...base, content, bom, eol };
}

async function writeFile(file, content, opts = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const body = opts.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]) : content;
  await fsp.writeFile(file, body);
  const st = await fsp.stat(file);
  return { mtime: st.mtimeMs, size: st.size };
}

async function createFile(file, content = '') {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, { flag: 'wx' });
  return file;
}

async function createDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function rename(from, to) {
  if (fs.existsSync(to)) throw new Error(`"${path.basename(to)}" already exists`);
  await fsp.rename(from, to);
  return to;
}

async function trash(target) {
  await shell.trashItem(target);
  return true;
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function stat(target) {
  try {
    const st = await fsp.stat(target);
    return { exists: true, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
  } catch {
    return { exists: false };
  }
}

const WALK_SKIP = new Set([...HIDDEN, 'node_modules', 'bin', 'obj', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.idea', '.vs', '.next', 'target', 'TestResults', '.gradle', 'site-packages', '.eggs']);

/** Relative paths of all project files, for Go to File / Search Everywhere / @-mentions. */
async function listFiles(root, gitRoot) {
  if (gitRoot) {
    const r = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { cwd: root });
    if (r.code === 0) {
      const files = r.stdout.split('\0').filter(Boolean);
      // ls-files is relative to cwd (root) when a pathspec is given.
      return { files: files.slice(0, 200000), truncated: files.length > 200000 };
    }
  }
  const files = [];
  const limit = 50000;
  async function walk(dir, rel) {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= limit) return;
      if (WALK_SKIP.has(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile()) files.push(r);
    }
  }
  await walk(root, '');
  return { files, truncated: files.length >= limit };
}

module.exports = { readDir, readFile, writeFile, createFile, createDir, rename, trash, exists, stat, listFiles, EXCLUDED, WALK_SKIP };
