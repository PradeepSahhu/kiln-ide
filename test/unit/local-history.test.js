'use strict';
// Spec: Local History keeps versions of files (before saves and before external/agent edits) in the
// app-data folder, lists them newest first, and can revert a file to any version.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, writeTree, fakeContext } = require('../helpers/fixtures');
const { LocalHistory } = require('../../src/main/services/local-history');

test('snapshots, listing, reading and reverting', async () => {
  const root = writeTree(tmpdir(), { 'a.py': 'v1\n' });
  const h = new LocalHistory(fakeContext(root));
  const file = path.join(root, 'a.py');
  await h.snapshot(file, 'v1\n', 'Before save');
  await h.snapshot(file, 'v1\n', 'Before save');
  await new Promise((r) => setTimeout(r, 5));
  await h.snapshot(file, 'v2\n', 'Before Claude edit');
  const list = await h.list(file);
  assert.equal(list.length, 2, 'identical consecutive snapshots are stored once');
  assert.equal(list[0].label, 'Before Claude edit');
  assert.equal(await h.read(file, list[1].id), 'v1\n');
  fs.writeFileSync(file, 'v3\n');
  await h.revert(file, list[1].id);
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1\n');
  const after = await h.list(file);
  assert.equal(after[0].label, 'Before revert', 'revert can itself be undone');
  const recent = await h.recent();
  assert.ok(recent.length >= 3);
  assert.ok(!fs.readdirSync(root).some((f) => f !== 'a.py'), 'history lives outside the project');
});
