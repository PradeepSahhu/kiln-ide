'use strict';
// Find in Files: `git grep` for repositories (fast, respects .gitignore, includes untracked files),
// with a plain Node.js walk as the fallback for folders that are not under Git.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { run } = require('../util/proc');
const { WALK_SKIP } = require('./fs');

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegex({ query, regex, caseSensitive, wholeWord }) {
  let src = regex ? query : escapeRe(query);
  if (wholeWord) src = `\\b(?:${src})\\b`;
  return new RegExp(src, caseSensitive ? 'g' : 'gi');
}

function globToRe(glob) {
  const g = glob.trim();
  if (!g) return null;
  const src = g
    .split('*')
    .map((part) => part.split('?').map(escapeRe).join('.'))
    .join('.*');
  return new RegExp(`(^|/)${src}$`, 'i');
}

function addMatch(groups, file, rel, line, text, re) {
  let g = groups.get(file);
  if (!g) {
    g = { file, rel, matches: [] };
    groups.set(file, g);
  }
  re.lastIndex = 0;
  const m = re.exec(text);
  const col = m ? m.index + 1 : 1;
  const length = m ? Math.max(m[0].length, 1) : 0;
  g.matches.push({ line, col, length, text: text.length > 400 ? text.slice(0, 400) : text });
}

async function gitGrep(root, opts, re, limit) {
  const args = ['-c', 'core.quotepath=off', 'grep', '-n', '-I', '--column', '--no-color', '--untracked', '-z'];
  if (!opts.caseSensitive) args.push('-i');
  if (opts.wholeWord) args.push('-w');
  args.push(opts.regex ? '-E' : '-F', '-e', opts.query, '--');
  const masks = (opts.include || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (masks.length) args.push(...masks.map((m) => `:(glob)**/${m}`));
  else args.push('.');
  const r = await run('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  if (r.code > 1) return null; // 1 = no matches
  const groups = new Map();
  let count = 0;
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const [rel, ln, , ...rest] = line.split('\0');
    if (!rel || !ln) continue;
    addMatch(groups, path.join(root, rel), rel, +ln, rest.join('\0'), re);
    if (++count >= limit) break;
  }
  return { groups: [...groups.values()], truncated: count >= limit };
}

async function walkGrep(root, opts, re, limit) {
  const masks = (opts.include || '').split(',').map(globToRe).filter(Boolean);
  const groups = new Map();
  let count = 0;
  let files = 0;
  async function walk(dir, relDir) {
    if (count >= limit || files > 30000) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= limit) return;
      if (WALK_SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (masks.length && !masks.some((m) => m.test(rel))) continue;
      files++;
      let buf;
      try {
        const st = await fsp.stat(full);
        if (st.size > 2 * 1024 * 1024) continue;
        buf = await fsp.readFile(full);
      } catch {
        continue;
      }
      if (buf.subarray(0, 8000).includes(0)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && count < limit; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          addMatch(groups, full, rel, i + 1, lines[i], re);
          count++;
        }
      }
    }
  }
  await walk(root, '');
  return { groups: [...groups.values()], truncated: count >= limit };
}

async function searchText(root, isRepo, opts) {
  if (!opts || !opts.query) return { groups: [], truncated: false, total: 0 };
  let re;
  try {
    re = buildRegex(opts);
  } catch (err) {
    return { groups: [], truncated: false, total: 0, error: `Invalid regular expression: ${err.message}` };
  }
  const limit = opts.limit || 3000;
  let result = isRepo ? await gitGrep(root, opts, re, limit) : null;
  if (!result) result = await walkGrep(root, opts, re, limit);
  result.total = result.groups.reduce((n, g) => n + g.matches.length, 0);
  return result;
}

const TODO_TAGS = 'TODO|FIXME|HACK|XXX|BUG';
const COMMENT_BEFORE = /(\/\/|#|\/\*|^\s*\*|<!--|--|')\s*.*$/;

/** TODO/FIXME/HACK comments across the project. */
async function searchTodos(root, isRepo) {
  const res = await searchText(root, isRepo, { query: TODO_TAGS, regex: true, wholeWord: true, caseSensitive: true, limit: 3000 });
  const items = [];
  for (const g of res.groups) {
    if (/(^|\/)(node_modules|\.venv|venv|bin|obj|dist|build)\//.test(g.rel)) continue;
    for (const m of g.matches) {
      const before = m.text.slice(0, m.col - 1);
      if (!COMMENT_BEFORE.test(before)) continue;
      const tag = m.text.slice(m.col - 1).match(new RegExp(`^(${TODO_TAGS})`));
      items.push({ file: g.file, rel: g.rel, line: m.line, col: m.col, tag: tag ? tag[1] : 'TODO', text: m.text.slice(m.col - 1).replace(/\*\/\s*$|-->\s*$/, '').trim().slice(0, 200) });
    }
  }
  return items;
}

module.exports = { searchText, searchTodos };
