'use strict';
// Package management: NuGet for .NET projects and pip/uv for Python environments.
const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const settings = require('../settings');
const { which, run } = require('../util/proc');
const { resolveInterpreter, pythonEnv } = require('./python-env');
const { dotnetAuth } = require('./github-auth');

async function getJson(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'Kiln-IDE' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

class PackageService {
  constructor(ctx) {
    this.ctx = ctx;
  }

  dotnet() {
    const d = settings.get().dotnet.path || which('dotnet');
    if (!d) throw new Error('The .NET SDK was not found.');
    return d;
  }

  dotnetEnv(dir) {
    return dotnetAuth({ ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_UI_LANGUAGE: 'en' }, dir).env;
  }

  // ------------------------------------------------------------ NuGet

  async nugetSearch(query, prerelease = false) {
    const data = await getJson(`https://azuresearch-usnc.nuget.org/query?q=${encodeURIComponent(query)}&take=30&prerelease=${prerelease}&semVerLevel=2.0.0`);
    return (data.data || []).map((p) => ({ id: p.id, version: p.version, description: (p.description || '').slice(0, 300), downloads: p.totalDownloads, verified: !!p.verified, authors: (p.authors || []).join(', '), versions: (p.versions || []).map((v) => v.version).slice(-15).reverse() }));
  }

  async nugetInstalled(projectPath) {
    const r = await run(this.dotnet(), ['list', projectPath, 'package', '--format', 'json'], { cwd: path.dirname(projectPath), env: this.dotnetEnv(path.dirname(projectPath)), timeout: 120000 });
    try {
      const data = JSON.parse(r.stdout);
      const list = [];
      for (const p of data.projects || []) for (const fw of p.frameworks || []) for (const pkg of fw.topLevelPackages || []) list.push({ id: pkg.id, requested: pkg.requestedVersion, resolved: pkg.resolvedVersion, framework: fw.framework });
      return { packages: list };
    } catch {
      // Older SDKs: fall back to the PackageReference list from the project file.
      const proj = ((this.ctx.detection && this.ctx.detection.dotnet && this.ctx.detection.dotnet.projects) || []).find((p) => p.path === projectPath);
      return { packages: proj ? proj.packages.map((p) => ({ id: p.name, requested: p.version, resolved: p.version })) : [], warning: (r.stderr || '').trim().split('\n')[0] };
    }
  }

  async nugetOutdated(projectPath) {
    const r = await run(this.dotnet(), ['list', projectPath, 'package', '--outdated', '--format', 'json'], { cwd: path.dirname(projectPath), env: this.dotnetEnv(path.dirname(projectPath)), timeout: 180000 });
    try {
      const data = JSON.parse(r.stdout);
      const map = {};
      for (const p of data.projects || []) for (const fw of p.frameworks || []) for (const pkg of fw.topLevelPackages || []) map[pkg.id] = pkg.latestVersion;
      return map;
    } catch {
      return {};
    }
  }

  async nugetAdd(projectPath, id, version) {
    const args = ['add', projectPath, 'package', id];
    if (version) args.push('--version', version);
    const r = await run(this.dotnet(), args, { cwd: path.dirname(projectPath), env: this.dotnetEnv(path.dirname(projectPath)), timeout: 300000 });
    if (r.code !== 0) throw new Error((r.stdout + '\n' + r.stderr).trim().split('\n').filter((l) => /error/i.test(l)).join('\n') || 'dotnet add package failed');
    return { ok: true, output: r.stdout };
  }

  async nugetRemove(projectPath, id) {
    const r = await run(this.dotnet(), ['remove', projectPath, 'package', id], { cwd: path.dirname(projectPath), timeout: 120000 });
    if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim());
    return { ok: true };
  }

  // ----------------------------------------------------------- Python

  interp(dir) {
    const root = dir || this.ctx.root;
    const i = this.ctx.build.interpreters.get(root) || resolveInterpreter(root, this.ctx.root);
    if (!i) throw new Error('No Python interpreter found.');
    return i;
  }

  pip(i, args) {
    const uv = settings.get().build.preferUv ? which('uv') : null;
    if (uv) return { cmd: uv, args: ['pip', ...args, '--python', i.python] };
    return { cmd: i.python, args: ['-m', 'pip', ...args, '--disable-pip-version-check'] };
  }

  async pyInstalled(dir) {
    const i = this.interp(dir);
    const { cmd, args } = this.pip(i, ['list', '--format', 'json']);
    const r = await run(cmd, args, { cwd: dir || this.ctx.root, env: pythonEnv(i), timeout: 60000 });
    try {
      return { interpreter: i, packages: JSON.parse(r.stdout).map((p) => ({ name: p.name, version: p.version })) };
    } catch {
      return { interpreter: i, packages: [], error: (r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') };
    }
  }

  async pyOutdated(dir) {
    const i = this.interp(dir);
    const { cmd, args } = this.pip(i, ['list', '--outdated', '--format', 'json']);
    const r = await run(cmd, args, { cwd: dir || this.ctx.root, env: pythonEnv(i), timeout: 120000 });
    try {
      return Object.fromEntries(JSON.parse(r.stdout).map((p) => [p.name, p.latest_version]));
    } catch {
      return {};
    }
  }

  async pyInfo(name) {
    const data = await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    const info = data.info || {};
    return { name: info.name, version: info.version, summary: info.summary, homepage: info.home_page || (info.project_urls || {}).Homepage || null, license: info.license, requiresPython: info.requires_python, versions: Object.keys(data.releases || {}).reverse().slice(0, 20) };
  }

  async pyInstall(dir, spec, { addToRequirements = true } = {}) {
    const i = this.interp(dir);
    if (i.source === 'system') throw new Error('Create a virtual environment first (Build creates .venv automatically when enabled).');
    const { cmd, args } = this.pip(i, ['install', spec]);
    const r = await run(cmd, args, { cwd: dir || this.ctx.root, env: pythonEnv(i), timeout: 600000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n'));
    if (addToRequirements) {
      const req = path.join(dir || this.ctx.root, 'requirements.txt');
      if (fs.existsSync(req)) {
        const text = fs.readFileSync(req, 'utf8');
        const name = spec.split(/[=<>!~ \[]/)[0].toLowerCase();
        if (!text.split(/\r?\n/).some((l) => l.trim().toLowerCase().split(/[=<>!~ \[]/)[0] === name)) fs.appendFileSync(req, (text.endsWith('\n') || !text ? '' : '\n') + spec + '\n');
      }
    }
    return { ok: true, output: (r.stdout + r.stderr).trim().split('\n').slice(-3).join('\n') };
  }

  async pyUninstall(dir, name) {
    const i = this.interp(dir);
    const uv = settings.get().build.preferUv ? which('uv') : null;
    const r = uv ? await run(uv, ['pip', 'uninstall', name, '--python', i.python], { env: pythonEnv(i), timeout: 120000 }) : await run(i.python, ['-m', 'pip', 'uninstall', '-y', name], { env: pythonEnv(i), timeout: 120000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    return { ok: true };
  }
}

module.exports = { PackageService };
