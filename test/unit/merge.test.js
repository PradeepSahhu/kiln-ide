'use strict';
// Spec: the merge conflict resolver works on the merged text git produces (conflict markers, with the
// common base when available): it lists every conflict with "yours", "base" and "theirs", and builds
// the result from a choice per conflict - yours, theirs, both (either order), base, or edited text -
// keeping the markers of conflicts that are not resolved yet. Line endings are preserved.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/renderer/js/lib/merge.js');

const MERGED = `using System;

class Shop
{
<<<<<<< yours
    const int Tax = 20;
||||||| base
    const int Tax = 10;
=======
    const int Tax = 15;
>>>>>>> theirs
    void Pay() { }
<<<<<<< yours
    void Refund() { }
=======
    void Cancel() { }
    void Audit() { }
>>>>>>> theirs
}
`;

test('conflicts are listed with yours, base and theirs', async () => {
  const { parseConflicts } = await load();
  const segs = parseConflicts(MERGED);
  const conflicts = segs.filter((s) => s.type === 'conflict');
  assert.equal(conflicts.length, 2);
  assert.deepEqual(conflicts[0], { type: 'conflict', index: 0, ours: '    const int Tax = 20;\n', base: '    const int Tax = 10;\n', theirs: '    const int Tax = 15;\n', oursLabel: 'yours', theirsLabel: 'theirs', line: 5 });
  assert.equal(conflicts[1].base, null, 'no base section');
  assert.equal(conflicts[1].theirs, '    void Cancel() { }\n    void Audit() { }\n');
  assert.equal(segs.filter((s) => s.type === 'text').map((s) => s.text).join(''), 'using System;\n\nclass Shop\n{\n    void Pay() { }\n}\n');
});

test('the result follows the choice for each conflict; unresolved ones keep their markers', async () => {
  const { parseConflicts, buildResult, unresolvedCount } = await load();
  const segs = parseConflicts(MERGED);
  const both = buildResult(segs, { 0: 'theirs', 1: 'both' });
  assert.equal(both, 'using System;\n\nclass Shop\n{\n    const int Tax = 15;\n    void Pay() { }\n    void Refund() { }\n    void Cancel() { }\n    void Audit() { }\n}\n');
  assert.equal(unresolvedCount(both), 0);
  assert.match(buildResult(segs, { 1: 'theirsFirst' }), /void Cancel\(\) \{ \}\n    void Audit\(\) \{ \}\n    void Refund/);
  assert.match(buildResult(segs, { 0: 'base', 1: 'ours' }), /Tax = 10;\n    void Pay\(\) \{ \}\n    void Refund\(\) \{ \}\n\}/);
  assert.match(buildResult(segs, { 0: { text: '    const int Tax = 18;\n' }, 1: 'ours' }), /Tax = 18;/);
  const partial = buildResult(segs, { 0: 'ours' });
  assert.equal(unresolvedCount(partial), 1);
  assert.match(partial, /<<<<<<< yours\n    void Refund\(\) \{ \}\n=======\n/);
});

test('CRLF files stay CRLF and a deleted side resolves to nothing', async () => {
  const { parseConflicts, buildResult } = await load();
  const crlf = 'a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\n>>>>>>> feature\r\nb\r\n';
  const segs = parseConflicts(crlf);
  assert.equal(segs.find((s) => s.type === 'conflict').theirs, '');
  assert.equal(buildResult(segs, { 0: 'ours' }), 'a\r\nx\r\nb\r\n');
  assert.equal(buildResult(segs, { 0: 'theirs' }), 'a\r\nb\r\n');
});

test('text without markers has no conflicts', async () => {
  const { parseConflicts, unresolvedCount } = await load();
  assert.deepEqual(parseConflicts('plain\n'), [{ type: 'text', text: 'plain\n' }]);
  assert.equal(unresolvedCount('a = "<<<<<<< not a marker"\n'), 0);
});
