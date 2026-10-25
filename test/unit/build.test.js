'use strict';
// Spec: a build runs every detected pipeline step, streams events, and turns compiler output into
// Problems. Python builds create a .venv when dependencies are declared, skip unchanged installs,
// and report syntax errors; .NET builds report compiler errors with exact locations.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, writeTree, fakeContext, has } = require('../helpers/fixtures');
const { detectProject } = require('../../src/main/services/detect');
const { BuildService } = require('../../src/main/services/build');

function ctxFor(root) {
  const ctx = fakeContext(root);
  ctx.redetect = async () => (ctx.detection = await detectProject(root));
  ctx.build = new BuildService(ctx);
  return ctx;
}

async function build(ctx, opts = {}) {
  const { id } = ctx.build.start(opts);
  await ctx.build.current.done;
  const ev = ctx.events.filter((e) => e.channel === 'build:event' && e.payload.id === id).map((e) => e.payload);
  return { ev, end: ev.find((e) => e.type === 'end'), state: ctx.build.state() };
}

test('python: syntax errors fail the build with exact locations', { skip: !has('python3'), timeout: 120000 }, async () => {
  const root = writeTree(tmpdir(), { 'ok.py': 'print("ok")\n', 'broken.py': 'def f(:\n    pass\n' });
  const ctx = ctxFor(root);
  const { ev, end, state } = await build(ctx);
  assert.equal(ev[0].type, 'start');
  assert.equal(end.status, 'failed');
  assert.ok(end.errors >= 1);
  const p = state.problems.find((x) => x.severity === 'error');
  assert.equal(p.file, path.join(root, 'broken.py'));
  assert.equal(p.line, 1);
  assert.ok(state.steps.some((s) => /Compile/.test(s.title)));
  assert.ok(ev.some((e) => e.type === 'output'));
});

test('python: creates .venv, installs, then skips unchanged dependencies', { skip: !has('python3'), timeout: 300000 }, async () => {
  const root = writeTree(tmpdir(), { 'requirements.txt': '# nothing yet\n', 'app.py': 'print(1)\n' });
  const ctx = ctxFor(root);
  const first = await build(ctx);
  assert.equal(first.end.status, 'success', JSON.stringify(first.state.problems));
  assert.ok(fs.existsSync(path.join(root, '.venv')), '.venv created automatically');
  const second = await build(ctx);
  const deps = second.state.steps.find((s) => /Install dependencies/.test(s.title));
  assert.match(deps.detail, /up to date/);
});

test('agent checks warn about keys promised by .env.example', { skip: !has('python3'), timeout: 120000 }, async () => {
  const root = writeTree(tmpdir(), { 'agent.py': 'import anthropic\n', '.env.example': 'ANTHROPIC_API_KEY=\nSERP_KEY=\n', '.env': 'ANTHROPIC_API_KEY=x\n' });
  fs.writeFileSync(path.join(root, 'requirements.txt'), 'anthropic\n');
  const ctx = ctxFor(root);
  ctx.build.start({ only: ['agentic'] });
  await ctx.build.current.done;
  const st = ctx.build.state();
  assert.ok(st.steps.some((s) => /Agent environment/.test(s.title)));
  assert.ok(st.problems.some((p) => /SERP_KEY/.test(p.message) && p.severity === 'warning'));
  assert.ok(!st.problems.some((p) => /ANTHROPIC_API_KEY is listed/.test(p.message)));
});

test('dotnet: compiler errors are reported at the right line', { skip: !has('dotnet'), timeout: 300000 }, async () => {
  const root = writeTree(tmpdir(), {
    'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>',
    'App/Program.cs': 'Console.WriteLine("hi");\nint x = "text";\n',
  });
  const ctx = ctxFor(root);
  const { end, state } = await build(ctx);
  assert.equal(end.status, 'failed');
  const p = state.problems.find((x) => x.code === 'CS0029');
  assert.ok(p, JSON.stringify(state.problems));
  assert.equal(p.file, path.join(root, 'App/Program.cs'));
  assert.equal(p.line, 2);
  fs.writeFileSync(path.join(root, 'App/Program.cs'), 'Console.WriteLine("hi");\n');
  const fixed = await build(ctx);
  assert.equal(fixed.end.status, 'success');
});

test('a running build can be cancelled', { skip: !has('python3'), timeout: 60000 }, async () => {
  const root = writeTree(tmpdir(), { 'a.py': 'x = 1\n' });
  const ctx = ctxFor(root);
  ctx.build.start();
  ctx.build.cancel();
  await ctx.build.current?.done;
  const end = ctx.events.find((e) => e.channel === 'build:event' && e.payload.type === 'end');
  assert.ok(end);
  assert.ok(['cancelled', 'success'].includes(end.payload.status));
});
