'use strict';
// GitHub connection for git (clone, fetch, pull, push) and the IDE's GitHub features (test the
// connection, list repositories to clone, publish a project). Credentials come from the GitHub CLI
// login (`gh auth git-credential`) or a personal access token in an environment variable, and reach
// git only through the git process environment (GIT_CONFIG_* entries): no config file or remote URL
// is changed and the token value is never written or logged.
const settings = require('../settings');
const { which, run } = require('../util/proc');

const SCOPE = 'credential.https://github.com';
const TOKEN_HELPER = '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$KILN_GITHUB_TOKEN"; }; f';

let ghCache = null;
function resetCache() {
  ghCache = null;
}

function config() {
  const s = settings.get();
  const g = s.github || {};
  return { auth: g.auth || 'auto', tokenVar: (g.tokenVar || (s.build && s.build.githubTokenVar) || 'GITHUB_TOKEN').trim() };
}

function tokenFrom(env) {
  const { tokenVar } = config();
  for (const name of [...new Set([tokenVar, 'GITHUB_TOKEN', 'GH_TOKEN'])]) {
    const v = env[name];
    if (v && v.trim()) return { token: v.trim(), variable: name };
  }
  return null;
}

const shellQuote = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;

// gh lets these override its stored login. "GitHub CLI" means the account logged in with
// `gh auth login`, so gh runs without them (a token variable may belong to another account).
const TOKEN_VARS = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_ENTERPRISE_TOKEN'];
function ghEnv(env) {
  const out = { ...env };
  for (const k of TOKEN_VARS) delete out[k];
  return out;
}

async function ghStatus(ghPath, env = process.env) {
  if (!ghPath) return { installed: false, loggedIn: false, user: null, scopes: [] };
  if (ghCache && ghCache.path === ghPath && Date.now() - ghCache.at < 60000) return ghCache.status;
  const r = await run(ghPath, ['auth', 'status', '--hostname', 'github.com'], { env: ghEnv(env), timeout: 15000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const user = (/Logged in to github\.com (?:account |as )([\w-]+)/.exec(text) || [])[1] || null;
  const scopes = ((/Token scopes:\s*(.*)/.exec(text) || [])[1] || '')
    .split(',')
    .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  const status = { installed: true, path: ghPath, loggedIn: r.code === 0 && !!user, user, scopes };
  ghCache = { at: Date.now(), path: ghPath, status };
  return status;
}

/** 'gh' | 'token' | 'system' | 'none' for the current settings and environment. */
async function effectiveMode(env, ghPath) {
  const { auth } = config();
  if (auth === 'system') return 'system';
  if (auth === 'gh') return ghPath ? 'gh' : 'none';
  if (auth === 'token') return tokenFrom(env) ? 'token' : 'none';
  if (ghPath && (await ghStatus(ghPath, env)).loggedIn) return 'gh';
  return tokenFrom(env) ? 'token' : 'none';
}

/** Environment for a git command that talks to GitHub. */
async function gitEnv(base = process.env, opts = {}) {
  const ghPath = Object.prototype.hasOwnProperty.call(opts, 'ghPath') ? opts.ghPath : which('gh', base);
  const mode = await effectiveMode(base, ghPath);
  const env = { ...base };
  if (mode !== 'gh' && mode !== 'token') return env;
  let n = parseInt(env.GIT_CONFIG_COUNT || '0', 10) || 0;
  const add = (key, value) => {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  };
  add(`${SCOPE}.helper`, ''); // an empty helper resets the list: only Kiln's helper answers for github.com
  if (mode === 'gh') {
    for (const k of TOKEN_VARS) delete env[k];
    add(`${SCOPE}.helper`, `!${shellQuote(ghPath)} auth git-credential`);
  }
  else {
    env.KILN_GITHUB_TOKEN = tokenFrom(base).token;
    add(`${SCOPE}.helper`, TOKEN_HELPER);
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

async function status({ env = process.env, ghPath } = {}) {
  const p = ghPath === undefined ? which('gh', env) : ghPath;
  const gh = await ghStatus(p, env);
  const t = tokenFrom(env);
  return {
    selected: config().auth,
    effective: await effectiveMode(env, p),
    gh,
    token: { found: !!t, variable: t ? t.variable : config().tokenVar },
  };
}

function parseGithubRemote(url) {
  if (!url) return null;
  let m = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (m) return { owner: m[1], repo: m[2], https: true };
  m = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (m) return { owner: m[1], repo: m[2], https: false };
  return null;
}

async function api(token, pathname, init = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, { ...init, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kiln-ide', Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message ? `GitHub: ${body.message}` : `GitHub returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { body, scopes: (res.headers.get('x-oauth-scopes') || '').split(',').map((x) => x.trim()).filter(Boolean) };
}

/** Who are we on GitHub, through the effective connection? */
async function verify({ env = process.env } = {}) {
  const ghPath = which('gh', env);
  resetCache();
  const mode = await effectiveMode(env, ghPath);
  if (mode === 'gh') {
    const r = await run(ghPath, ['api', 'user', '--jq', '.login'], { env: ghEnv(env), timeout: 20000 });
    if (r.code !== 0) return { ok: false, mode, message: (r.stderr || r.stdout).trim() || 'gh could not reach GitHub' };
    const st = await ghStatus(ghPath, env);
    return { ok: true, mode, user: r.stdout.trim(), scopes: st.scopes };
  }
  if (mode === 'token') {
    try {
      const { body, scopes } = await api(tokenFrom(env).token, '/user');
      return { ok: true, mode, user: body.login, scopes };
    } catch (err) {
      return { ok: false, mode, message: err.message };
    }
  }
  if (mode === 'system') return { ok: true, mode, message: 'Using the system git credentials (Keychain / credential manager).' };
  return { ok: false, mode, message: 'Not connected: log in with the GitHub CLI (gh auth login) or set GITHUB_TOKEN.' };
}

async function listRepos({ env = process.env } = {}) {
  const ghPath = which('gh', env);
  const mode = await effectiveMode(env, ghPath);
  if (mode === 'gh') {
    const r = await run(ghPath, ['repo', 'list', '--limit', '200', '--json', 'nameWithOwner,url,isPrivate,description,updatedAt'], { env: ghEnv(env), timeout: 30000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'gh repo list failed');
    return JSON.parse(r.stdout || '[]').map((x) => ({ name: x.nameWithOwner, url: `${x.url}.git`, private: x.isPrivate, description: x.description || '', updatedAt: x.updatedAt }));
  }
  if (mode === 'token') {
    const { body } = await api(tokenFrom(env).token, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
    return body.map((x) => ({ name: x.full_name, url: x.clone_url, private: x.private, description: x.description || '', updatedAt: x.updated_at }));
  }
  throw new Error('Connect to GitHub first (Settings › Version Control).');
}

/** Create a repository on GitHub; returns its https clone URL. */
async function createRepo({ name, isPrivate = true, description = '', env = process.env }) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name || '')) throw new Error('Use letters, digits, ".", "-" or "_" for the repository name.');
  const ghPath = which('gh', env);
  const mode = await effectiveMode(env, ghPath);
  if (mode === 'gh') {
    const args = ['repo', 'create', name, isPrivate ? '--private' : '--public'];
    if (description) args.push('--description', description);
    const r = await run(ghPath, args, { env: ghEnv(env), timeout: 60000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'gh repo create failed');
    const url = (r.stdout.match(/https:\/\/github\.com\/\S+/) || [])[0];
    if (!url) throw new Error('gh did not return the repository URL');
    return `${url.replace(/\.git$/, '')}.git`;
  }
  if (mode === 'token') {
    const { body } = await api(tokenFrom(env).token, '/user/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, private: isPrivate, description }) });
    return body.clone_url;
  }
  throw new Error('Connect to GitHub first: log in with the GitHub CLI (gh auth login) or set GITHUB_TOKEN.');
}

module.exports = { gitEnv, status, verify, listRepos, createRepo, parseGithubRemote, resetCache, tokenFrom };
