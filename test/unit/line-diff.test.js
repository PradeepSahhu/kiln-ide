'use strict';
// Spec: committing individual changed lines. The changes between the committed and the working
// version of a file are hunks of removed and added lines, each with a stable id; applying a selection
// of them to the committed version gives exactly the text to commit (all lines = the working version,
// none = the committed version), keeping line endings.
const test = require('node:test');
const assert = require('node:assert/strict');
const { diffLines, splitLines, hunks, applySelection } = require('../../src/main/services/line-diff');

const OLD = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\n';
const NEW = 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\nnew last\n';

test('hunks list removed and added lines with ids and context', () => {
  const h = hunks(OLD, NEW);
  assert.equal(h.length, 2, 'two changes far apart are two hunks');
  assert.deepEqual(h[0].lines.filter((l) => l.type !== 'ctx').map((l) => [l.type, l.id, l.text]), [['del', 'd2', 'b'], ['add', 'a2', 'B']]);
  assert.equal(h[0].lines[0].text, 'a', 'context before');
  assert.deepEqual(h[1].lines.filter((l) => l.type !== 'ctx').map((l) => l.id), ['a15']);
  assert.equal(h[1].newStart, 12);
  assert.deepEqual(hunks('same\n', 'same\n'), []);
});

test('applying a selection of lines', () => {
  const ids = hunks(OLD, NEW).flatMap((h) => h.lines.filter((l) => l.id).map((l) => l.id));
  assert.equal(applySelection(OLD, NEW, ids), NEW, 'every line = the working version');
  assert.equal(applySelection(OLD, NEW, []), OLD, 'no line = the committed version');
  assert.equal(applySelection(OLD, NEW, ['a15']), OLD + 'new last\n', 'only the added last line');
  assert.equal(applySelection(OLD, NEW, ['d2']), OLD.replace('b\n', ''), 'only removing b');
  assert.equal(applySelection(OLD, NEW, ['d2', 'a2']), OLD.replace('b\n', 'B\n'));
});

test('line endings and missing final newlines are kept', () => {
  assert.equal(applySelection('x\r\ny\r\n', 'x\r\nY\r\nz\r\n', ['a3']), 'x\r\ny\r\nz\r\n');
  assert.equal(applySelection('a', 'a\nb\n', ['a2']), 'a\nb\n', 'a last line without newline gets one before an added line');
  assert.equal(applySelection('', 'one\ntwo\n', ['a2']), 'two\n', 'new file, second line only');
  assert.equal(applySelection('one\ntwo\n', '', ['d1']), 'two\n', 'deleted file, first line only');
  assert.deepEqual(splitLines('a\nb'), ['a\n', 'b']);
});

test('the diff is minimal on larger inputs', () => {
  const a = Array.from({ length: 2000 }, (_, i) => `line ${i}\n`);
  const b = a.slice();
  b.splice(500, 1, 'changed\n');
  b.splice(1500, 0, 'inserted\n');
  const ops = diffLines(a, b);
  assert.equal(ops.filter((o) => o.type !== 'ctx').length, 3);
  assert.equal(applySelection(a.join(''), b.join(''), ['a1501']), a.slice(0, 1500).join('') + 'inserted\n' + a.slice(1500).join(''));
});
