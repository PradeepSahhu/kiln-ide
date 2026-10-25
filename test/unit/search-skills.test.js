'use strict';
// Spec: Find in Files works in git repositories and plain folders (literal, regex, case and file
// masks); the Skills list includes project skills and new skills can be scaffolded.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, writeTree, gitRepo } = require('../helpers/fixtures');
const { searchText } = require('../../src/main/services/search');
const { listSkills, createSkill } = require('../../src/main/services/skills');

for (const repo of [true, false]) {
  test(`find in files (${repo ? 'git' : 'plain folder'})`, async () => {
    const files = { 'a.cs': 'class OrderService { void PlaceOrder() {} }\n', 'b.py': 'def place_order():\n    return OrderService()\n', 'notes.md': 'orderservice docs\n' };
    const root = repo ? gitRepo(files) : writeTree(tmpdir(), files);
    const lit = await searchText(root, repo, { query: 'OrderService' });
    assert.equal(lit.total, 3, 'case-insensitive by default');
    const cs = await searchText(root, repo, { query: 'OrderService', caseSensitive: true });
    assert.equal(cs.total, 2);
    const masked = await searchText(root, repo, { query: 'OrderService', include: '*.py' });
    assert.deepEqual(masked.groups.map((g) => g.rel), ['b.py']);
    const re = await searchText(root, repo, { query: 'place_?order', regex: true });
    assert.equal(re.total, 2);
    const m = lit.groups.find((g) => g.rel === 'a.cs').matches[0];
    assert.equal(m.line, 1);
    assert.equal(m.col, 7);
    assert.equal(m.length, 'OrderService'.length);
  });
}

test('project skills are listed and new ones can be created', async () => {
  const root = writeTree(tmpdir(), { '.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploy the service to staging\n---\n# Deploy\n' });
  const res = await listSkills(root, null);
  const s = res.items.find((i) => i.name === 'deploy');
  assert.ok(s);
  assert.equal(s.source, 'project');
  assert.equal(s.kind, 'skill');
  assert.match(s.description, /staging/);
  const file = await createSkill(root, { scope: 'project', name: 'Release Notes', description: 'Write release notes' });
  assert.equal(file, path.join(root, '.claude/skills/release-notes/SKILL.md'));
  assert.match(fs.readFileSync(file, 'utf8'), /^---\nname: release-notes\n/);
  const again = await listSkills(root, null);
  assert.ok(again.items.some((i) => i.name === 'release-notes' && i.source === 'project'));
});
