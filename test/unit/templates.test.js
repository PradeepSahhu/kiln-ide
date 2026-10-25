'use strict';
// Spec: New Project creates ready-to-build projects: Python (inside its own .venv), C#/.NET
// (solution + project), JavaScript/TypeScript (package.json + entry point) and agent starters.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpdir, has } = require('../helpers/fixtures');
const templates = require('../../src/main/services/templates');

const toolchain = { python: { found: has('python3'), path: 'python3' }, dotnet: { found: has('dotnet') }, node: { found: true }, git: { found: has('git') }, uv: { found: has('uv') } };
const noop = () => {};

test('lists Python, C# and JavaScript templates with availability', () => {
  const list = templates.list(toolchain);
  const ids = list.map((t) => t.id);
  for (const id of ['python-app', 'python-fastapi', 'python-agent-sdk', 'python-agent-api', 'dotnet-console', 'dotnet-classlib-tests', 'dotnet-webapi', 'dotnet-agent', 'node-app', 'node-ts', 'node-express', 'react-vite', 'node-agent-sdk']) assert.ok(ids.includes(id), `has ${id}`);
  const langs = new Set(list.map((t) => t.lang));
  assert.ok(langs.has('python') && langs.has('csharp') && (langs.has('javascript') || langs.has('typescript')));
  const offline = templates.list({ ...toolchain, dotnet: { found: false } });
  assert.equal(offline.find((t) => t.id === 'dotnet-console').available, false);
  assert.ok(offline.find((t) => t.id === 'dotnet-console').reason);
});

test('rejects invalid names and existing folders', async () => {
  const loc = tmpdir();
  await assert.rejects(() => templates.create({ templateId: 'node-app', name: 'bad name/..', location: loc }, noop));
  fs.mkdirSync(path.join(loc, 'taken'));
  fs.writeFileSync(path.join(loc, 'taken', 'x.txt'), 'x');
  await assert.rejects(() => templates.create({ templateId: 'node-app', name: 'taken', location: loc }, noop));
});

test('Python application is created inside its own virtual environment', { skip: !toolchain.python.found, timeout: 180000 }, async () => {
  const loc = tmpdir();
  const dir = await templates.create({ templateId: 'python-app', name: 'hello_py', location: loc, gitInit: true }, noop);
  assert.equal(dir, path.join(loc, 'hello_py'));
  for (const f of ['main.py', 'requirements.txt', 'tests/test_main.py', 'README.md', '.gitignore']) assert.ok(fs.existsSync(path.join(dir, f)), `${f} exists`);
  const py = path.join(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  assert.ok(fs.existsSync(py), '.venv was created');
  assert.match(execFileSync(py, ['main.py'], { cwd: dir, encoding: 'utf8' }), /Hello/);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\.venv/);
  assert.ok(fs.existsSync(path.join(dir, '.git')), 'git repository initialised');
});

test('Python agent templates compile and declare their SDKs', { skip: !toolchain.python.found, timeout: 180000 }, async () => {
  for (const [id, pkg] of [['python-agent-sdk', 'claude-agent-sdk'], ['python-agent-api', 'anthropic']]) {
    const dir = await templates.create({ templateId: id, name: `agent_${id.split('-').pop()}`, location: tmpdir(), venv: false }, noop);
    assert.match(fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8'), new RegExp(pkg));
    assert.match(fs.readFileSync(path.join(dir, '.env.example'), 'utf8'), /ANTHROPIC_API_KEY/);
    execFileSync('python3', ['-m', 'py_compile', path.join(dir, 'agent.py')]);
  }
});

test('JavaScript Node.js app runs', async () => {
  const dir = await templates.create({ templateId: 'node-app', name: 'hello-node', location: tmpdir() }, noop);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'hello-node');
  assert.ok(pkg.scripts.start);
  assert.match(execFileSync(process.execPath, [path.join(dir, pkg.main || 'index.js')], { cwd: dir, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }), /Hello/);
});

test('TypeScript and React templates have the expected structure', async () => {
  const ts = await templates.create({ templateId: 'node-ts', name: 'hello-ts', location: tmpdir() }, noop);
  assert.ok(fs.existsSync(path.join(ts, 'tsconfig.json')));
  assert.ok(fs.existsSync(path.join(ts, 'src/index.ts')));
  assert.ok(JSON.parse(fs.readFileSync(path.join(ts, 'package.json'), 'utf8')).devDependencies.typescript);
  const react = await templates.create({ templateId: 'react-vite', name: 'hello-react', location: tmpdir() }, noop);
  assert.ok(fs.existsSync(path.join(react, 'index.html')));
  assert.ok(fs.existsSync(path.join(react, 'src/main.jsx')));
  assert.ok(JSON.parse(fs.readFileSync(path.join(react, 'package.json'), 'utf8')).devDependencies.vite);
});

test('C# console solution builds', { skip: !toolchain.dotnet.found, timeout: 300000 }, async () => {
  const dir = await templates.create({ templateId: 'dotnet-console', name: 'HelloCs', location: tmpdir() }, noop);
  assert.ok(fs.existsSync(path.join(dir, 'HelloCs.sln')) || fs.existsSync(path.join(dir, 'HelloCs.slnx')));
  assert.ok(fs.existsSync(path.join(dir, 'HelloCs', 'HelloCs.csproj')));
  const out = execFileSync('dotnet', ['run', '--project', path.join(dir, 'HelloCs')], { cwd: dir, encoding: 'utf8', env: { ...process.env, DOTNET_NOLOGO: '1' } });
  assert.match(out, /Hello/);
});
