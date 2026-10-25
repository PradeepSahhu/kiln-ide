'use strict';
// Line diffs for committing individual changed lines: the hunks between two versions of a file, with
// a stable id per changed line ("d<old line>" for a removed line, "a<new line>" for an added one), and
// the text you get by applying only some of those lines to the old version.

/** Lines with their line terminators, so joining them gives the text back exactly. */
function splitLines(text) {
  return String(text || '').match(/[^\n]*\n|[^\n]+$/g) || [];
}

/**
 * Myers diff of two line arrays: [{ type: 'ctx' | 'del' | 'add', text, oldLine?, newLine? }]
 * (1-based line numbers). Lines compare without their terminators, so a changed line ending does not
 * hide a change elsewhere but a file whose last line lost its newline still shows that line.
 */
function diffLines(a, b) {
  const key = (l) => l.replace(/\r?\n$/, '');
  const A = a.map(key);
  const B = b.map(key);
  const n = A.length;
  const m = B.length;
  const max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  // Walk back through the trace.
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'ctx', text: a[x - 1], oldLine: x, newLine: y });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ type: 'add', text: b[y - 1], newLine: y });
    else ops.push({ type: 'del', text: a[x - 1], oldLine: x });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'ctx', text: a[x - 1], oldLine: x, newLine: y });
    x--;
    y--;
  }
  ops.reverse();
  // Show removed lines before added ones within a change.
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type === 'ctx') continue;
    let j = i;
    while (j < ops.length && ops[j].type !== 'ctx') j++;
    const block = ops.slice(i, j);
    ops.splice(i, block.length, ...block.filter((o) => o.type === 'del'), ...block.filter((o) => o.type === 'add'));
    i = j;
  }
  return ops;
}

const lineId = (op) => (op.type === 'del' ? `d${op.oldLine}` : `a${op.newLine}`);

/** Hunks of changed lines with `context` lines around them: [{ id, oldStart, newStart, lines }]. */
function hunks(oldText, newText, { context = 3 } = {}) {
  const ops = diffLines(splitLines(oldText), splitLines(newText)).map((o) => (o.type === 'ctx' ? o : { ...o, id: lineId(o) }));
  const out = [];
  let cur = null;
  let lastChange = -Infinity;
  ops.forEach((o, i) => {
    if (o.type === 'ctx') return;
    if (cur && i - lastChange <= context * 2 + 1) {
      for (let j = lastChange + 1; j <= i; j++) cur.lines.push(ops[j]);
    } else {
      cur = { lines: [] };
      out.push(cur);
      for (let j = Math.max(0, i - context); j <= i; j++) cur.lines.push(ops[j]);
    }
    lastChange = i;
    cur.end = i;
  });
  for (const h of out) {
    for (let j = h.end + 1; j < Math.min(ops.length, h.end + 1 + context); j++) {
      if (ops[j].type !== 'ctx') break;
      h.lines.push(ops[j]);
    }
    const first = h.lines[0];
    h.oldStart = first.oldLine || (h.lines.find((l) => l.oldLine) || {}).oldLine || 0;
    h.newStart = first.newLine || (h.lines.find((l) => l.newLine) || {}).newLine || 0;
    h.id = `h${h.lines.find((l) => l.type !== 'ctx').id}`;
    h.lines = h.lines.map((l) => ({ type: l.type, id: l.id, text: l.text.replace(/\r?\n$/, ''), oldLine: l.oldLine, newLine: l.newLine }));
    delete h.end;
  }
  return out;
}

/**
 * The old text with only the selected changed lines applied: a selected removed line is removed, a
 * selected added line is added; everything else stays as in the old text.
 */
function applySelection(oldText, newText, selected) {
  const pick = new Set(selected);
  const eol = /\r\n/.test(newText) || (!/\n/.test(newText) && /\r\n/.test(oldText)) ? '\r\n' : '\n';
  let out = '';
  // A line that was last without a newline gets one when another line follows it.
  const add = (text) => {
    if (out && !out.endsWith('\n')) out += eol;
    out += text;
  };
  for (const o of diffLines(splitLines(oldText), splitLines(newText))) {
    if (o.type === 'ctx') add(o.text);
    else if (o.type === 'del') {
      if (!pick.has(lineId(o))) add(o.text);
    } else if (pick.has(lineId(o))) add(o.text);
  }
  return out;
}

module.exports = { splitLines, diffLines, hunks, applySelection };
