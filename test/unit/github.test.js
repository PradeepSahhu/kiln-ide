'use strict';
// Spec: Kiln connects to GitHub repositories (clone, fetch, pull, push, publish) through the GitHub
// CLI login (gh auth git-credential) or a personal access token from an environment variable
// (GITHUB_TOKEN / GH_TOKEN or a chosen variable). Credentials reach git only through the process
// environment of the git command: no git config file or remote URL is changed and the token is never
// printed. "Automatic" prefers a logged-in gh, then the token, then the system's git credentials.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpdir, writeTree } = require('../helpers/fixtures');
const settings = require('../../src/main/settings');
const gh = require('../../src/main/services/github');

/** What git would send to github.com with this environment. */
function credentialFor(env, host = 'github.com') {
  let out = '';
  try {
    out = execFileSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=${host}\n\n`, encoding: 'utf8', env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return {}; // no credentials available for this host
  }
  const map = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
  }
  return map;
}

function fakeGh(loggedIn = true) {
  const dir = tmpdir('kiln-fake-gh-');
  const script = `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  ${loggedIn ? 'echo "github.com"; echo "  ✓ Logged in to github.com account octo-kiln (keyring)"; echo "  - Token scopes: \'gist\', \'read:org\', \'repo\', \'workflow\'"; exit 0' : 'echo "You are not logged into any GitHub hosts." >&2; exit 1'}
fi
if [ "$1" = "auth" ] && [ "$2" = "git-credential" ]; then
  if [ "$3" = "get" ]; then cat >/dev/null; echo "protocol=https"; echo "host=github.com"; echo "username=octo-kiln"; echo "password=gho_fake_cli_token"; fi
  exit 0
fi
exit 1
`;
  writeTree(dir, { gh: script });
  fs.chmodSync(path.join(dir, 'gh'), 0o755);
  return path.join(dir, 'gh');
}

const baseEnv = () => {
  const env = { ...process.env, HOME: tmpdir('kiln-home-'), XDG_CONFIG_HOME: tmpdir('kiln-xdg-'), GIT_CONFIG_NOSYSTEM: '1' };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GIT_CONFIG_COUNT;
  return env;
};

test('token mode: git gets the token from the environment for github.com only', async () => {
  settings.update({ github: { auth: 'token', tokenVar: 'MY_GH_PAT' } });
  const env = { ...baseEnv(), MY_GH_PAT: 'ghp_from_env_123' };
  const gitEnv = await gh.gitEnv(env, { ghPath: null });
  const cred = credentialFor(gitEnv);
  assert.equal(cred.password, 'ghp_from_env_123');
  assert.equal(cred.username, 'x-access-token');
  for (const [k, v] of Object.entries(gitEnv)) if (/^GIT_CONFIG_(KEY|VALUE)_/.test(k)) assert.ok(!String(v).includes('ghp_from_env_123'), `token value not in ${k}`);
  // other hosts are untouched
  const other = credentialFor(gitEnv, 'gitlab.example.com');
  assert.notEqual(other.password, 'ghp_from_env_123');
});

test('gh mode: git uses the GitHub CLI login', async () => {
  settings.update({ github: { auth: 'gh' } });
  const ghPath = fakeGh(true);
  const gitEnv = await gh.gitEnv(baseEnv(), { ghPath });
  const cred = credentialFor(gitEnv);
  assert.equal(cred.password, 'gho_fake_cli_token');
  assert.equal(cred.username, 'octo-kiln');
});

test('automatic mode prefers a logged-in gh, then a token, then system credentials', async () => {
  settings.update({ github: { auth: 'auto', tokenVar: 'GITHUB_TOKEN' } });
  const env = { ...baseEnv(), GITHUB_TOKEN: 'ghp_auto_token' };
  gh.resetCache();
  assert.equal(credentialFor(await gh.gitEnv(env, { ghPath: fakeGh(true) })).password, 'gho_fake_cli_token');
  gh.resetCache();
  assert.equal(credentialFor(await gh.gitEnv(env, { ghPath: fakeGh(false) })).password, 'ghp_auto_token');
  gh.resetCache();
  const none = await gh.gitEnv(baseEnv(), { ghPath: null });
  assert.equal(none.GIT_CONFIG_COUNT, undefined, 'nothing injected when there is neither gh nor a token');
});

test('system mode leaves git alone; existing GIT_CONFIG_* entries are preserved', async () => {
  settings.update({ github: { auth: 'system' } });
  const env = { ...baseEnv(), GITHUB_TOKEN: 'ghp_x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Someone' };
  const out = await gh.gitEnv(env, { ghPath: fakeGh(true) });
  assert.equal(out.GIT_CONFIG_COUNT, '1');
  settings.update({ github: { auth: 'token', tokenVar: 'GITHUB_TOKEN' } });
  const out2 = await gh.gitEnv(env, { ghPath: null });
  assert.equal(out2.GIT_CONFIG_KEY_0, 'user.name');
  assert.ok(Number(out2.GIT_CONFIG_COUNT) > 1);
});

test('status reports the gh account and scopes and where the token comes from (never its value)', async () => {
  settings.update({ github: { auth: 'auto', tokenVar: 'GITHUB_TOKEN' } });
  gh.resetCache();
  const st = await gh.status({ env: { ...baseEnv(), GITHUB_TOKEN: 'ghp_secret_value' }, ghPath: fakeGh(true) });
  assert.equal(st.gh.installed, true);
  assert.equal(st.gh.loggedIn, true);
  assert.equal(st.gh.user, 'octo-kiln');
  assert.ok(st.gh.scopes.includes('repo'));
  assert.equal(st.token.found, true);
  assert.equal(st.token.variable, 'GITHUB_TOKEN');
  assert.equal(st.effective, 'gh');
  assert.ok(!JSON.stringify(st).includes('ghp_secret_value'), 'the token value is never reported');
});

test('github remotes are recognized in https and ssh form', () => {
  assert.deepEqual(gh.parseGithubRemote('https://github.com/PradeepSahuu/kiln-ide.git'), { owner: 'PradeepSahuu', repo: 'kiln-ide', https: true });
  assert.deepEqual(gh.parseGithubRemote('git@github.com:octo/app'), { owner: 'octo', repo: 'app', https: false });
  assert.equal(gh.parseGithubRemote('https://gitlab.com/a/b.git'), null);
});

test('gh mode uses the account logged in with gh, even when a token variable for another account is set', async () => {
  settings.update({ github: { auth: 'gh' } });
  const dir = tmpdir('kiln-fake-gh2-');
  // Like the real gh: an environment token takes precedence over the stored login.
  writeTree(dir, {
    gh: `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -n "$GITHUB_TOKEN$GH_TOKEN" ]; then echo "  ✓ Logged in to github.com account token-owner (GITHUB_TOKEN)"; else echo "  ✓ Logged in to github.com account stored-user (keyring)"; fi
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "git-credential" ]; then
  cat >/dev/null
  if [ -n "$GITHUB_TOKEN$GH_TOKEN" ]; then echo "username=token-owner"; echo "password=env-token"; else echo "username=stored-user"; echo "password=keyring-token"; fi
  exit 0
fi
exit 1
`,
  });
  fs.chmodSync(path.join(dir, 'gh'), 0o755);
  const env = { ...baseEnv(), GITHUB_TOKEN: 'ghp_other_account_token' };
  gh.resetCache();
  const st = await gh.status({ env, ghPath: path.join(dir, 'gh') });
  assert.equal(st.gh.user, 'stored-user', 'status shows the gh login, not the token owner');
  const cred = credentialFor(await gh.gitEnv(env, { ghPath: path.join(dir, 'gh') }));
  assert.equal(cred.username, 'stored-user');
  assert.equal(cred.password, 'keyring-token');
  // Automatic mode also prefers the gh login over the token variable.
  settings.update({ github: { auth: 'auto' } });
  gh.resetCache();
  assert.equal(credentialFor(await gh.gitEnv(env, { ghPath: path.join(dir, 'gh') })).username, 'stored-user');
});
