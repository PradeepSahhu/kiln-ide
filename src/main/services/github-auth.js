'use strict';
// GitHub token support for package restores. When a project pulls packages from GitHub
// (GitHub Packages NuGet/npm feeds, or private git+https://github.com/... dependencies), the
// token is read from the environment ($GITHUB_TOKEN, then $GH_TOKEN, or the variable chosen in
// Settings > Build) and handed to the package manager through environment variables only.
// The token is never written into project files or echoed to the Build output.
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('../settings');

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function githubToken() {
  const cfg = settings.get().build;
  if (cfg.useGithubToken === false) return null;
  const preferred = (cfg.githubTokenVar || 'GITHUB_TOKEN').trim();
  for (const name of [...new Set([preferred, 'GITHUB_TOKEN', 'GH_TOKEN'])]) {
    const value = process.env[name];
    if (value && value.trim()) return { token: value.trim(), variable: name };
  }
  return null;
}

function tokenStatus() {
  const t = githubToken();
  const cfg = settings.get().build;
  return { enabled: cfg.useGithubToken !== false, found: !!t, variable: t ? t.variable : (cfg.githubTokenVar || 'GITHUB_TOKEN') };
}

function githubUser(url) {
  return process.env.GITHUB_ACTOR || process.env.GITHUB_USERNAME || process.env.GITHUB_USER || (/nuget\.pkg\.github\.com\/([^/]+)/i.exec(url || '') || [])[1] || 'kiln';
}

// ------------------------------------------------------------------- NuGet

function nugetConfigFiles(startDir) {
  const seen = new Set();
  const files = [];
  const add = (f) => {
    if (!fs.existsSync(f)) return;
    let real = f;
    try {
      real = fs.realpathSync(f);
    } catch {
      /* keep as is */
    }
    const key = real.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      files.push(real);
    }
  };
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of ['nuget.config', 'NuGet.config', 'NuGet.Config']) add(path.join(dir, name));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  add(process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'NuGet', 'NuGet.Config') : path.join(os.homedir(), '.nuget', 'NuGet', 'NuGet.Config'));
  return files;
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : null;
}

/** GitHub Packages NuGet sources that have no credentials configured anywhere. */
function githubNugetSources(startDir) {
  const sources = new Map();
  const credentialed = new Set();
  for (const file of nugetConfigFiles(startDir)) {
    const text = read(file);
    const ps = /<packageSources>([\s\S]*?)<\/packageSources>/i.exec(text);
    if (ps) {
      for (const m of ps[1].matchAll(/<add\b[^>]*>/gi)) {
        const key = attr(m[0], 'key');
        const value = attr(m[0], 'value');
        if (key && value && /nuget\.pkg\.github\.com/i.test(value) && !sources.has(key)) sources.set(key, { key, url: value, file });
      }
    }
    const creds = /<packageSourceCredentials>([\s\S]*?)<\/packageSourceCredentials>/i.exec(text);
    if (creds) for (const m of creds[1].matchAll(/<([^\s>/!?]+)>/g)) credentialed.add(m[1].replace(/_x0020_/g, ' '));
  }
  return [...sources.values()].filter((s) => !credentialed.has(s.key));
}

/** Environment for dotnet build/restore/run/test. */
function dotnetAuth(baseEnv, startDir) {
  const sources = githubNugetSources(startDir);
  if (!sources.length) return { env: baseEnv, notes: [], missing: [] };
  const tok = githubToken();
  if (!tok) return { env: baseEnv, notes: [], missing: sources.map((s) => ({ ...s, kind: 'nuget' })) };
  const env = { ...baseEnv };
  for (const s of sources) env[`NuGetPackageSourceCredentials_${s.key}`] = `Username=${githubUser(s.url)};Password=${tok.token}`;
  return { env, notes: sources.map((s) => `GitHub Packages NuGet source "${s.key}": using the token from $${tok.variable}`), missing: [] };
}

// --------------------------------------------------------------------- npm

let layeredNpmrc = null;

/** Environment for npm/pnpm/yarn installs in `dir`. */
function npmAuth(baseEnv, dir) {
  const projectRc = path.join(dir, '.npmrc');
  const userRc = path.join(os.homedir(), '.npmrc');
  const text = [read(projectRc), read(userRc)].join('\n');
  const pkgText = read(path.join(dir, 'package.json'));
  const usesPackages = /npm\.pkg\.github\.com/i.test(text);
  const usesGitDeps = /"(github:|git\+https:\/\/github\.com|https:\/\/github\.com\/[^"]+\.git)/i.test(pkgText);
  if (!usesPackages && !usesGitDeps) return { env: baseEnv, notes: [], missing: [] };
  const tok = githubToken();
  if (!tok) return { env: baseEnv, notes: [], missing: usesPackages ? [{ kind: 'npm', key: '.npmrc', url: 'https://npm.pkg.github.com', file: fs.existsSync(projectRc) ? projectRc : userRc }] : [] };
  let env = { ...baseEnv };
  const notes = [];
  if (usesPackages) {
    for (const m of text.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) if (/TOKEN/i.test(m[1]) && !env[m[1]]) env[m[1]] = tok.token;
    if (!/\/\/npm\.pkg\.github\.com\/:_authToken\s*=/.test(text)) {
      // Layer an auth line over the user's npmrc. The file only references ${KILN_GITHUB_TOKEN}.
      if (!layeredNpmrc) layeredNpmrc = path.join(os.tmpdir(), `kiln-npmrc-${process.pid}`);
      fs.writeFileSync(layeredNpmrc, `${read(userRc)}\n//npm.pkg.github.com/:_authToken=\${KILN_GITHUB_TOKEN}\n`, { mode: 0o600 });
      env.npm_config_userconfig = layeredNpmrc;
      env.KILN_GITHUB_TOKEN = tok.token;
    }
    notes.push(`GitHub Packages npm registry: using the token from $${tok.variable}`);
  }
  if (usesGitDeps) {
    env = gitAuthEnv(env, tok);
    notes.push(`GitHub git dependencies: using the token from $${tok.variable}`);
  }
  return { env, notes, missing: [] };
}

// --------------------------------------------------------------------- git

/** Adds an HTTP auth header for github.com to git child processes (as actions/checkout does). */
function gitAuthEnv(baseEnv, tok = githubToken()) {
  if (!tok) return baseEnv;
  const env = { ...baseEnv };
  const n = parseInt(env.GIT_CONFIG_COUNT || '0', 10) || 0;
  env[`GIT_CONFIG_KEY_${n}`] = 'http.https://github.com/.extraheader';
  env[`GIT_CONFIG_VALUE_${n}`] = 'AUTHORIZATION: basic ' + Buffer.from(`x-access-token:${tok.token}`).toString('base64');
  env.GIT_CONFIG_COUNT = String(n + 1);
  return env;
}

/** Environment for pip/uv/poetry/pipenv when the manifests reference GitHub repositories. */
function pythonAuth(baseEnv, manifestFiles) {
  const text = manifestFiles.map(read).join('\n');
  if (!/github\.com[/:]/i.test(text)) return { env: baseEnv, notes: [], missing: [] };
  const tok = githubToken();
  if (!tok) return { env: baseEnv, notes: [], missing: [] };
  return { env: gitAuthEnv(baseEnv, tok), notes: [`GitHub dependencies: using the token from $${tok.variable}`], missing: [] };
}

function cleanup() {
  if (layeredNpmrc) {
    try {
      fs.unlinkSync(layeredNpmrc);
    } catch {
      /* already gone */
    }
  }
}

module.exports = { githubToken, tokenStatus, dotnetAuth, npmAuth, pythonAuth, gitAuthEnv, githubNugetSources, cleanup };
