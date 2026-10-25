'use strict';
// Spec: when packages come from GitHub, the token is read from $GITHUB_TOKEN (or $GH_TOKEN) and handed
// to the package manager through environment variables only — never written to project files.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, writeTree } = require('../helpers/fixtures');
const auth = require('../../src/main/services/github-auth');

function withToken(vars, fn) {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const NUGET = `<?xml version="1.0" encoding="utf-8"?>
<configuration><packageSources>
  <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  <add key="github" value="https://nuget.pkg.github.com/acme/index.json" />
</packageSources></configuration>`;

test('GitHub Packages NuGet source gets credentials from GITHUB_TOKEN', () => {
  const root = writeTree(tmpdir(), { 'nuget.config': NUGET });
  withToken({ GITHUB_TOKEN: 'ghp_test123' }, () => {
    const r = auth.dotnetAuth({ PATH: '/bin' }, root);
    assert.equal(r.env.NuGetPackageSourceCredentials_github, 'Username=acme;Password=ghp_test123');
    assert.equal(r.env.PATH, '/bin');
    assert.ok(r.notes.length === 1 && !r.notes[0].includes('ghp_test123'), 'notes never contain the token');
  });
  assert.ok(!fs.readFileSync(path.join(root, 'nuget.config'), 'utf8').includes('ghp_'), 'nuget.config is untouched');
});

test('GH_TOKEN is used when GITHUB_TOKEN is not set', () => {
  const root = writeTree(tmpdir(), { 'nuget.config': NUGET });
  withToken({ GH_TOKEN: 'gho_other' }, () => {
    assert.match(auth.dotnetAuth({}, root).env.NuGetPackageSourceCredentials_github, /gho_other/);
  });
});

test('missing token is reported for GitHub sources', () => {
  const root = writeTree(tmpdir(), { 'nuget.config': NUGET });
  withToken({}, () => {
    const r = auth.dotnetAuth({}, root);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].key, 'github');
  });
});

test('sources that already have credentials are left alone', () => {
  const root = writeTree(tmpdir(), { 'nuget.config': NUGET.replace('</configuration>', '<packageSourceCredentials><github><add key="Username" value="me" /><add key="ClearTextPassword" value="%GITHUB_TOKEN%" /></github></packageSourceCredentials></configuration>') });
  withToken({ GITHUB_TOKEN: 'x' }, () => {
    assert.equal(auth.dotnetAuth({}, root).env.NuGetPackageSourceCredentials_github, undefined);
  });
});

test('npm: token variables referenced by .npmrc are filled from GITHUB_TOKEN', () => {
  const root = writeTree(tmpdir(), { '.npmrc': '@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n', 'package.json': '{}' });
  withToken({ GITHUB_TOKEN: 'ghp_npm' }, () => {
    const r = auth.npmAuth({}, root);
    assert.equal(r.env.NODE_AUTH_TOKEN, 'ghp_npm');
  });
});

test('python: git dependencies on github.com get an auth header via git config env', () => {
  const root = writeTree(tmpdir(), { 'requirements.txt': 'mylib @ git+https://github.com/acme/mylib.git@v1\n' });
  withToken({ GITHUB_TOKEN: 'ghp_py' }, () => {
    const r = auth.pythonAuth({}, [path.join(root, 'requirements.txt')]);
    const n = Number(r.env.GIT_CONFIG_COUNT);
    assert.ok(n >= 1);
    assert.equal(r.env[`GIT_CONFIG_KEY_${n - 1}`], 'http.https://github.com/.extraheader');
    assert.equal(r.env[`GIT_CONFIG_VALUE_${n - 1}`], 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:ghp_py').toString('base64'));
  });
});

test('no GitHub references means no changes', () => {
  const root = writeTree(tmpdir(), { 'requirements.txt': 'requests\n' });
  withToken({ GITHUB_TOKEN: 'ghp_x' }, () => {
    const r = auth.pythonAuth({ A: '1' }, [path.join(root, 'requirements.txt')]);
    assert.deepEqual(r.env, { A: '1' });
  });
});
