// Conflict markers in merged text (git merge-file --diff3 / the working file during a merge, rebase or
// cherry-pick): the conflicts with yours / base / theirs, and the result of choosing per conflict.

const START = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: .*)?$/;
const MID = /^={7}$/;
const END = /^>{7}(?: (.*))?$/;

/** Lines with their line endings kept. */
function lines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}
const bare = (l) => l.replace(/\r?\n$/, '');

/**
 * [{ type: 'text', text } | { type: 'conflict', index, ours, base, theirs, oursLabel, theirsLabel, line }]
 * `base` is null when the markers have no common-ancestor section; `line` is the 1-based line of <<<<<<<.
 */
export function parseConflicts(text) {
  const out = [];
  let buf = '';
  let cur = null;
  let part = null;
  let index = 0;
  let lineNo = 0;
  const flush = () => {
    if (buf) out.push({ type: 'text', text: buf });
    buf = '';
  };
  for (const l of lines(text)) {
    lineNo++;
    const b = bare(l);
    if (!cur) {
      const m = START.exec(b);
      if (m) {
        flush();
        cur = { type: 'conflict', index: index++, ours: '', base: null, theirs: '', oursLabel: m[1] || '', theirsLabel: '', line: lineNo };
        part = 'ours';
      } else buf += l;
      continue;
    }
    if (part === 'ours' && BASE.test(b)) {
      cur.base = '';
      part = 'base';
    } else if ((part === 'ours' || part === 'base') && MID.test(b)) part = 'theirs';
    else if (part === 'theirs' && END.test(b)) {
      cur.theirsLabel = END.exec(b)[1] || '';
      out.push(cur);
      cur = null;
      part = null;
    } else cur[part] += l;
  }
  if (cur) {
    // An unterminated block is not a conflict: keep it as text.
    buf += `<<<<<<< ${cur.oursLabel}\n${cur.ours}${cur.base != null ? `||||||| base\n${cur.base}` : ''}${part === 'theirs' ? `=======\n${cur.theirs}` : ''}`;
  }
  flush();
  return out;
}

/** Text of a conflict for a choice: 'ours' | 'theirs' | 'both' | 'theirsFirst' | 'base' | { text }. */
export function resolveConflict(c, choice) {
  if (choice && typeof choice === 'object') return choice.text;
  switch (choice) {
    case 'ours':
      return c.ours;
    case 'theirs':
      return c.theirs;
    case 'both':
      return c.ours + c.theirs;
    case 'theirsFirst':
      return c.theirs + c.ours;
    case 'base':
      return c.base || '';
    default:
      return null;
  }
}

/** The merged text with the given choices; conflicts without a choice keep their markers. */
export function buildResult(segments, choices = {}) {
  const eolOf = (s) => (/\r\n/.test(s) ? '\r\n' : '\n');
  let out = '';
  for (const s of segments) {
    if (s.type === 'text') {
      out += s.text;
      continue;
    }
    const resolved = resolveConflict(s, choices[s.index]);
    if (resolved != null) {
      out += resolved;
      continue;
    }
    const eol = eolOf(s.ours + s.theirs + (s.base || ''));
    out += `<<<<<<< ${s.oursLabel}`.trimEnd() + eol + s.ours;
    if (s.base != null) out += `||||||| base${eol}${s.base}`;
    out += `=======${eol}${s.theirs}` + `>>>>>>> ${s.theirsLabel}`.trimEnd() + eol;
  }
  return out;
}

/** Number of complete conflict blocks still in a text. */
export function unresolvedCount(text) {
  return parseConflicts(text).filter((s) => s.type === 'conflict').length;
}
