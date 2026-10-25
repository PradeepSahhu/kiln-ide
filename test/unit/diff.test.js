'use strict';
// Spec: the line diff drives the git change gutter, the highlighting of agent edits and reloading files
// changed on disk. Regions use 1-based line numbers of the new text; reloads apply minimal line edits so
// breakpoints, bookmarks and the cursor on untouched lines stay where they are.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/renderer/js/lib/diff.js');

test('changed regions use 1-based line numbers of the new text', async () => {
  const { changedRegions } = await load();
  assert.deepEqual(changedRegions('a\nb\nc', 'a\nX\nc\nY'), [{ type: 'modified', start: 2, end: 2 }, { type: 'added', start: 4, end: 4 }]);
  assert.deepEqual(changedRegions('p\nq\nr\ns\nt', 'p\nQ\nr\ns\nT\nU'), [{ type: 'modified', start: 2, end: 2 }, { type: 'modified', start: 5, end: 6 }]);
  assert.deepEqual(changedRegions('one\ntwo\nthree', 'one\ntwo\nNEW\nthree'), [{ type: 'added', start: 3, end: 3 }]);
  assert.deepEqual(changedRegions('a\nb\nc\nd', 'a\nc\nd'), [{ type: 'deleted', start: 2, end: 2 }]);
  assert.deepEqual(changedRegions('same\n', 'same\n'), []);
});

test('lineEdits produces minimal replacements that rebuild the new text', async () => {
  const { lineEdits, applyLineEdits } = await load();
  const cases = [
    ['one\ntwo\nthree', 'one\ntwo\nNEW\nthree'],
    ['a\nb\nc', 'a\nX\nc\nY'],
    ['p\nq\nr\ns\nt', 'p\nQ\nr\ns\nT\nU'],
    ['keep\ndrop1\ndrop2\nkeep2\n', 'keep\nkeep2\n'],
    ['x\n', 'y\nx\n'],
    ['', 'new file\n'],
    ['gone\n', ''],
  ];
  for (const [a, b] of cases) {
    const al = a.split('\n');
    const bl = b.split('\n');
    const edits = lineEdits(al, bl);
    assert.deepEqual(applyLineEdits(al, edits), bl, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
  // An insertion touches nothing else.
  assert.deepEqual(lineEdits(['one', 'two', 'three'], ['one', 'two', 'NEW', 'three']), [{ start: 3, deleteCount: 0, lines: ['NEW'] }]);
  // Two separate changes stay two small edits.
  assert.deepEqual(lineEdits(['p', 'q', 'r', 's', 't'], ['p', 'Q', 'r', 's', 'T']), [{ start: 2, deleteCount: 1, lines: ['Q'] }, { start: 5, deleteCount: 1, lines: ['T'] }]);
});
