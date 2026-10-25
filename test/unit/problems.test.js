'use strict';
// Spec: compiler/tool output lines become Problems with file, line, column, severity and code.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMsbuild, parseTsc, parsePipCheck } = require('../../src/main/services/problems');

test('MSBuild error with location and project', () => {
  const p = parseMsbuild('/repo/src/App/Program.cs(10,13): error CS0103: The name \'foo\' does not exist in the current context [/repo/src/App/App.csproj]', '/repo');
  assert.equal(p.file, '/repo/src/App/Program.cs');
  assert.equal(p.line, 10);
  assert.equal(p.col, 13);
  assert.equal(p.severity, 'error');
  assert.equal(p.code, 'CS0103');
  assert.match(p.message, /does not exist/);
  assert.equal(p.project, '/repo/src/App/App.csproj');
});

test('MSBuild warning and relative paths', () => {
  const p = parseMsbuild('Program.cs(5,9): warning CS8321: The local function \'Bar\' is declared but never used [/repo/App.csproj]', '/repo');
  assert.equal(p.severity, 'warning');
  assert.equal(p.file, '/repo/Program.cs');
});

test('NuGet errors without a source location', () => {
  const p = parseMsbuild('/repo/App.csproj : error NU1101: Unable to find package Foo. No packages exist with this id in source(s): nuget.org', '/repo');
  assert.equal(p.code, 'NU1101');
  assert.equal(p.severity, 'error');
  assert.equal(p.source, 'nuget');
});

test('non-diagnostic lines are ignored', () => {
  assert.equal(parseMsbuild('  Determining projects to restore...', '/repo'), null);
  assert.equal(parseMsbuild('Build succeeded.', '/repo'), null);
});

test('TypeScript diagnostics in both formats', () => {
  const a = parseTsc('src/index.ts(3,7): error TS2322: Type \'string\' is not assignable to type \'number\'.', '/p');
  assert.equal(a.file, '/p/src/index.ts');
  assert.equal(a.line, 3);
  assert.equal(a.code, 'TS2322');
  const b = parseTsc('src/index.ts:4:1 - error TS1005: \';\' expected.', '/p');
  assert.equal(b.line, 4);
});

test('pip check conflicts become warnings', () => {
  const p = parsePipCheck('langchain 0.1.0 has requirement pydantic<2, but you have pydantic 2.5.0.', '/p/requirements.txt');
  assert.equal(p.severity, 'warning');
  assert.equal(p.file, '/p/requirements.txt');
  assert.equal(parsePipCheck('No broken requirements found.', null), null);
});
