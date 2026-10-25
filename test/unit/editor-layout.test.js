'use strict';
// Spec: the editor can be split right or down any number of times. Splitting next to a group of a
// split in the same direction adds a sibling; otherwise the group becomes a new split. Closing a split
// collapses its parent, sizes stay fractions of 1, and saved layouts are only restored when they are
// well formed over exactly the saved groups.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/renderer/js/lib/editor-layout.js');

test('split right, then right again, then down', async () => {
  const L = await load();
  let t = L.leaf('g1');
  t = L.splitLayout(t, 'g1', 'g2', 'row');
  assert.deepEqual(t, { type: 'split', dir: 'row', children: [L.leaf('g1'), L.leaf('g2')], sizes: [0.5, 0.5] });
  t = L.splitLayout(t, 'g1', 'g3', 'row');
  assert.deepEqual(L.layoutGroups(t), ['g1', 'g3', 'g2'], 'a row split next to g1 joins the row');
  assert.ok(t.sizes.every((x) => Math.abs(x - 1 / 3) < 1e-9));
  t = L.splitLayout(t, 'g2', 'g4', 'column');
  assert.equal(t.children[2].type, 'split');
  assert.equal(t.children[2].dir, 'column');
  assert.deepEqual(L.layoutGroups(t), ['g1', 'g3', 'g2', 'g4']);
  assert.equal(L.neighborGroup(t, 'g4'), 'g2');
  assert.equal(L.neighborGroup(t, 'g1'), 'g3');
  assert.equal(L.neighborGroup(L.leaf('g1'), 'g1'), null);
});

test('closing a split collapses its parent and renormalizes sizes', async () => {
  const L = await load();
  let t = L.splitLayout(L.splitLayout(L.leaf('g1'), 'g1', 'g2', 'row'), 'g2', 'g3', 'column');
  t = L.resizeLayout(t, [], [0.7, 0.3]);
  assert.deepEqual(t.sizes, [0.7, 0.3]);
  const r = L.removeFromLayout(t, 'g3');
  assert.deepEqual(r, { type: 'split', dir: 'row', children: [L.leaf('g1'), L.leaf('g2')], sizes: [0.7, 0.3] });
  assert.deepEqual(L.removeFromLayout(r, 'g1'), L.leaf('g2'));
  assert.equal(L.removeFromLayout(L.leaf('g1'), 'g1'), null);
  const three = L.splitLayout(L.splitLayout(L.leaf('a'), 'a', 'b', 'row'), 'b', 'c', 'row');
  const two = L.removeFromLayout(L.resizeLayout(three, [], [0.5, 0.25, 0.25]), 'a');
  assert.deepEqual(two.sizes, [0.5, 0.5]);
});

test('saved layouts are checked before they are restored', async () => {
  const L = await load();
  const t = L.splitLayout(L.leaf('g1'), 'g1', 'g2', 'row');
  assert.equal(L.validLayout(t, ['g1', 'g2']), true);
  assert.equal(L.validLayout(t, ['g1']), false, 'groups missing from the saved list');
  assert.equal(L.validLayout(t, ['g1', 'g2', 'g3']), false, 'saved groups missing from the layout');
  assert.equal(L.validLayout({ type: 'split', dir: 'row', children: [L.leaf('g1')], sizes: [1] }, ['g1']), false);
  assert.equal(L.validLayout({ type: 'split', dir: 'diagonal', children: [L.leaf('g1'), L.leaf('g2')], sizes: [0.5, 0.5] }, ['g1', 'g2']), false);
  assert.equal(L.validLayout({ type: 'split', dir: 'row', children: [L.leaf('g1'), L.leaf('g1')], sizes: [0.5, 0.5] }, ['g1']), false);
  assert.equal(L.validLayout(null, []), false);
});
