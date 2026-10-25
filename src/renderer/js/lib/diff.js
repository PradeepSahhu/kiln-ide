// Line diff (Myers, O(ND)) used for the git change gutter and for highlighting edits made by agents.

/** Returns the edit script between line arrays a and b as [{op: '='|'-'|'+', aLine, bLine}]. */
function myers(a, b, maxD = 4000) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = false;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) x = v[max + k + 1];
      else x = v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) return null;
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vd[max + k - 1] < vd[max + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[max + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: '=', aLine: x, bLine: y });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: '+', bLine: y, aLine: x });
      else ops.push({ op: '-', aLine: x, bLine: y });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/**
 * Changed regions of `b` relative to `a`, ready for gutter decorations:
 * [{ type: 'added'|'modified'|'deleted', start, end }] with 1-based line numbers in b.
 */
export function changedRegions(aText, bText) {
  const a = aText.split('\n');
  const b = bText.split('\n');
  // Trim the common prefix/suffix first: keeps the common case (small edits) very fast.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (!am.length && !bm.length) return [];
  if (!am.length) return [{ type: 'added', start: pre + 1, end: pre + bm.length }];
  if (!bm.length) return [{ type: 'deleted', start: pre + 1, end: pre + 1 }];
  const ops = am.length + bm.length > 30000 ? null : myers(am, bm);
  if (!ops) return [{ type: 'modified', start: pre + 1, end: pre + bm.length }];
  const regions = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === '=') {
      i++;
      continue;
    }
    let dels = 0;
    let adds = 0;
    let firstB = null;
    let lastB = null;
    let anchorB = ops[i].bLine;
    while (i < ops.length && ops[i].op !== '=') {
      if (ops[i].op === '-') dels++;
      else {
        adds++;
        const line = ops[i].bLine; // 1-based within the trimmed middle
        if (firstB == null) firstB = line;
        lastB = line;
      }
      i++;
    }
    if (adds && dels) regions.push({ type: 'modified', start: pre + firstB, end: pre + lastB });
    else if (adds) regions.push({ type: 'added', start: pre + firstB, end: pre + lastB });
    else regions.push({ type: 'deleted', start: pre + anchorB + 1, end: pre + anchorB + 1 });
  }
  return regions;
}

/**
 * Minimal line replacements turning `a` into `b` (arrays of lines), as
 * [{ start (1-based line of a), deleteCount, lines }] in ascending order.
 */
export function lineEdits(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (!am.length && !bm.length) return [];
  const ops = !am.length || !bm.length || am.length + bm.length > 30000 ? null : myers(am, bm);
  if (!ops) return [{ start: pre + 1, deleteCount: am.length, lines: bm }];
  const edits = [];
  let aPos = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === '=') {
      aPos = ops[i].aLine;
      i++;
      continue;
    }
    const start = aPos;
    let deleteCount = 0;
    const lines = [];
    while (i < ops.length && ops[i].op !== '=') {
      if (ops[i].op === '-') {
        deleteCount++;
        aPos = ops[i].aLine;
      } else lines.push(bm[ops[i].bLine - 1]);
      i++;
    }
    edits.push({ start: pre + start + 1, deleteCount, lines });
  }
  return edits;
}

/** Apply lineEdits() output to an array of lines (used by tests and as a reference). */
export function applyLineEdits(a, edits) {
  const out = a.slice();
  for (let k = edits.length - 1; k >= 0; k--) out.splice(edits[k].start - 1, edits[k].deleteCount, ...edits[k].lines);
  return out;
}
