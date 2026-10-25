'use strict';
// Build orchestration. A build is a list of steps run in order:
//   detect -> .NET (dotnet build) -> Python (interpreter, venv, deps, compile check, pip check)
//   -> Node (install, build/tsc) -> agent environment & config checks.
// Steps, output and problems stream to the renderer as `build:event` messages.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');
const settings = require('../settings');
const { which, run, stream, isWin } = require('../util/proc');
const { parseMsbuild, parseTsc, parsePipCheck, LineSplitter, problemKey, stripAnsi } = require('./problems');
const { parseDotEnv } = require('./detect');
const { resolveInterpreter, recordInterpreter, pythonVersion, pythonEnv, venvPython } = require('./python-env');
const { APP_ROOT } = require('../protocol');
const githubAuth = require('./github-auth');

const PYCHECK = path.join(APP_ROOT, 'resources', 'pycheck.py').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);

class BuildRun {
  constructor(service, id, { mode, reason, only }) {
    this.service = service;
    this.ctx = service.ctx;
    this.id = id;
    this.mode = mode;
    this.reason = reason;
    this.only = only || null;
    this.steps = [];
    this.problems = [];
    this.problemKeys = new Set();
    this.cancelled = false;
    this.proc = null;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.status = 'running';
    this.outBuf = new Map();
    this.outTimer = null;
    this.outputs = new Map(); // stepId -> text (capped), for snapshots
  }

  rel(p) {
    return p ? path.relative(this.ctx.root, p) || '.' : '';
  }

  emit(type, payload = {}) {
    this.ctx.send('build:event', { id: this.id, type, ...payload });
  }

  step(title, group = 'general', detail = '') {
    const s = { id: `${this.id}.${this.steps.length + 1}`, title, group, detail, status: 'running', startedAt: Date.now(), endedAt: null, errors: 0, warnings: 0 };
    this.steps.push(s);
    this.emit('step', { step: s });
    return s;
  }

  finish(s, status, detail) {
    if (this.cancelled && status !== 'skipped') status = 'cancelled';
    s.status = status;
    if (detail != null) s.detail = detail;
    s.endedAt = Date.now();
    this.flushOutput();
    this.emit('step', { step: s });
  }

  out(s, text) {
    if (!text) return;
    const prev = this.outputs.get(s.id) || '';
    if (prev.length < 4 * 1024 * 1024) this.outputs.set(s.id, prev + text);
    this.outBuf.set(s.id, (this.outBuf.get(s.id) || '') + text);
    if (!this.outTimer) this.outTimer = setTimeout(() => this.flushOutput(), 40);
  }

  flushOutput() {
    clearTimeout(this.outTimer);
    this.outTimer = null;
    for (const [stepId, text] of this.outBuf) this.emit('output', { stepId, text });
    this.outBuf.clear();
  }

  addProblems(step, list) {
    const fresh = [];
    for (const p of list) {
      if (!p) continue;
      const key = problemKey(p);
      if (this.problemKeys.has(key)) continue;
      this.problemKeys.add(key);
      const prob = { ...p, id: `${this.id}:${this.problems.length}`, stepId: step ? step.id : null };
      this.problems.push(prob);
      fresh.push(prob);
      if (step) {
        if (p.severity === 'error') step.errors++;
        else if (p.severity === 'warning') step.warnings++;
      }
    }
    if (fresh.length) this.emit('problems', { problems: fresh });
    return fresh;
  }

  async exec(s, cmd, args, { cwd, env, onLine, echo = true, raw = true } = {}) {
    if (this.cancelled) return -2;
    if (echo) this.out(s, `\x1b[90m${cwd ? this.rel(cwd) + ' ' : ''}$ ${[path.basename(cmd), ...args].map(quote).join(' ')}\x1b[0m\n`);
    const splitter = onLine ? new LineSplitter(onLine) : null;
    const handle = stream(cmd, args, {
      cwd,
      env: env || process.env,
      onData: (chunk) => {
        if (raw) this.out(s, chunk);
        if (splitter) splitter.push(chunk);
      },
    });
    this.proc = handle;
    const code = await handle.done;
    if (splitter) splitter.flush();
    this.proc = null;
    return this.cancelled ? -2 : code;
  }

  cancel() {
    this.cancelled = true;
    if (this.proc) this.proc.kill();
  }

  /** Report GitHub-token use (never the token itself) and sources that need one but have none. */
  authNotes(step, auth) {
    for (const n of auth.notes || []) this.out(step, `\x1b[90m🔑 ${n}\x1b[0m\n`);
    for (const m of auth.missing || []) {
      this.addProblems(step, [{ severity: 'warning', file: m.file || null, line: 1, message: `${m.kind === 'npm' ? 'GitHub Packages npm registry' : `GitHub Packages source "${m.key}"`} needs a token: set GITHUB_TOKEN (or GH_TOKEN) in your environment, or choose another variable in Settings > Build.`, source: 'github' }]);
    }
  }

  wants(kind) {
    return !this.only || this.only.includes(kind);
  }

  snapshot() {
    return {
      id: this.id,
      mode: this.mode,
      reason: this.reason,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      steps: this.steps,
      problems: this.problems,
      outputs: Object.fromEntries(this.outputs),
    };
  }

  // ------------------------------------------------------------- pipeline

  async execute() {
    this.emit('start', { mode: this.mode, reason: this.reason, at: this.startedAt, only: this.only });
    try {
      const sd = this.step('Detect project', 'general');
      const det = await this.ctx.redetect();
      this.out(sd, `Project: ${det.name}\nRoot: ${det.root}\nDetected: ${det.summary}\n`);
      if (det.agentic && det.agentic.frameworks.length) this.out(sd, `Agent frameworks: ${det.agentic.frameworks.map((f) => `${f.name} (${f.langs.join('/')})`).join(', ')}\n`);
      this.finish(sd, 'success', det.summary);

      if (!det.dotnet && !det.python && !det.node) {
        const s = this.step('Nothing to build', 'general');
        this.out(s, 'No .NET solution/project, Python sources or package.json were found in this folder.\n');
        this.finish(s, 'skipped', 'No buildable project found');
      }
      if (det.dotnet && this.wants('dotnet') && !this.cancelled) await this.dotnet(det);
      if (det.python && this.wants('python')) {
        for (const root of det.python.roots) {
          if (this.cancelled) break;
          await this.python(det, root);
        }
      }
      if (det.node && this.wants('node')) {
        const mode = settings.get().build.nodeBuild;
        for (const root of det.node.roots) {
          if (this.cancelled) break;
          const include = mode === 'always' || (mode === 'auto' && (root.agentic || (!det.dotnet && !det.python)));
          if (include) await this.node(det, root);
        }
      }
      if (det.agentic && settings.get().build.agentChecks && this.wants('agentic') && !this.cancelled) await this.agentic(det);
    } catch (err) {
      const s = this.step('Internal error', 'general');
      this.out(s, String(err.stack || err) + '\n');
      this.addProblems(s, [{ severity: 'error', message: `Build crashed: ${err.message}`, source: 'kiln' }]);
      this.finish(s, 'error');
    }
    this.flushOutput();
    this.endedAt = Date.now();
    const errors = this.problems.filter((p) => p.severity === 'error').length;
    const warnings = this.problems.filter((p) => p.severity === 'warning').length;
    const failedStep = this.steps.some((s) => s.status === 'error');
    this.status = this.cancelled ? 'cancelled' : errors || failedStep ? 'failed' : 'success';
    this.emit('end', { status: this.status, errors, warnings, durationMs: this.endedAt - this.startedAt, at: this.endedAt });
    if (typeof this.ctx.onBuildEnd === 'function') this.ctx.onBuildEnd(this.status);
  }

  // ---------------------------------------------------------------- .NET

  async dotnet(det) {
    const cfg = settings.get();
    const s0 = this.step('.NET SDK', 'dotnet');
    const dotnet = cfg.dotnet.path || which('dotnet');
    if (!dotnet) {
      this.out(s0, 'The dotnet CLI was not found on PATH.\nInstall the .NET SDK from https://dotnet.microsoft.com/download or set its path in Settings > .NET.\n');
      this.addProblems(s0, [{ severity: 'error', message: '.NET SDK not found. Install it from https://dotnet.microsoft.com/download', source: 'dotnet' }]);
      this.finish(s0, 'error', 'not found');
      return;
    }
    const firstTarget = det.dotnet.buildTargets[0];
    const ver = await run(dotnet, ['--version'], { cwd: firstTarget ? path.dirname(firstTarget) : det.root, timeout: 30000 });
    if (ver.code !== 0) {
      this.out(s0, (ver.stdout + ver.stderr).trim() + '\n');
      this.addProblems(s0, [{ severity: 'error', message: 'The .NET SDK required by this project (global.json) is not installed.', file: path.join(det.root, 'global.json'), line: 1, source: 'dotnet' }]);
      this.finish(s0, 'error', 'SDK mismatch');
      return;
    }
    this.out(s0, `dotnet ${ver.stdout.trim()} (${dotnet})\n`);
    this.finish(s0, 'success', `SDK ${ver.stdout.trim()}`);
    for (const p of det.dotnet.projects.filter((x) => x.legacy)) {
      this.addProblems(s0, [{ severity: 'warning', file: p.path, line: 1, message: `${p.name} is a legacy (non-SDK) project; dotnet build may not support it.`, source: 'dotnet' }]);
    }

    const baseEnv = { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_UI_LANGUAGE: 'en', MSBUILDTERMINALLOGGER: 'off', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', TERM: 'dumb' };
    for (const target of det.dotnet.buildTargets) {
      if (this.cancelled) return;
      const s = this.step(`Build ${path.basename(target)}`, 'dotnet', cfg.build.dotnetConfiguration);
      const auth = githubAuth.dotnetAuth(baseEnv, path.dirname(target));
      const env = auth.env;
      this.authNotes(s, auth, 'nuget.config');
      const args = ['build', target, '-nologo', '-p:GenerateFullPaths=true', '-c', cfg.build.dotnetConfiguration || 'Debug'];
      if (this.mode === 'rebuild') args.push('--no-incremental');
      if (cfg.build.dotnetExtraArgs) args.push(...cfg.build.dotnetExtraArgs.split(/\s+/).filter(Boolean));
      const baseDir = path.dirname(target);
      const code = await this.exec(s, dotnet, args, {
        cwd: baseDir,
        env,
        onLine: (line) => {
          const p = parseMsbuild(line, baseDir);
          if (p) this.addProblems(s, [p]);
        },
      });
      if (code === 0) this.finish(s, s.warnings ? 'warning' : 'success', `${cfg.build.dotnetConfiguration} · ${s.warnings} warning${s.warnings === 1 ? '' : 's'}`);
      else {
        if (!s.errors && code !== -2) this.addProblems(s, [{ severity: 'error', file: target, line: 1, message: `dotnet build exited with code ${code}. See the Build output for details.`, source: 'msbuild' }]);
        this.finish(s, 'error', `${s.errors} error${s.errors === 1 ? '' : 's'}`);
      }
    }
  }

  // -------------------------------------------------------------- Python

  async python(det, root) {
    const cfg = settings.get().build;
    const tag = det.python.roots.length > 1 ? ` · ${root.name}` : '';
    const uv = cfg.preferUv ? which('uv') : null;
    const usesUvLock = !!root.manifests.uvLock;
    const usesPoetry = !!(root.manifests.poetryLock || root.tool.poetry);
    const usesPipenv = !!root.manifests.pipfile && !root.manifests.pyproject && !root.manifests.requirements;
    const poetry = usesPoetry ? which('poetry') : null;
    const pipenv = usesPipenv ? which('pipenv') : null;

    const si = this.step('Python interpreter' + tag, 'python');
    let interp = resolveInterpreter(root.dir, det.root);
    if (!interp) {
      this.out(si, 'No Python 3 interpreter was found on PATH.\nInstall Python 3 or choose an interpreter in Settings > Python.\n');
      this.addProblems(si, [{ severity: 'error', message: 'No Python interpreter found. Install Python 3 or set one in Settings > Python.', source: 'python' }]);
      this.finish(si, 'error', 'not found');
      return;
    }

    const managedElsewhere = (usesPoetry && poetry) || (usesPipenv && pipenv);
    if (interp.source === 'system' && root.hasManifest && cfg.autoCreateVenv && !managedElsewhere && !(usesUvLock && uv)) {
      const sv = this.step('Create virtual environment' + tag, 'python', '.venv');
      const venvDir = path.join(root.dir, '.venv');
      const code = uv ? await this.exec(sv, uv, ['venv', venvDir], { cwd: root.dir }) : await this.exec(sv, interp.python, ['-m', 'venv', venvDir], { cwd: root.dir });
      if (code === 0 && fs.existsSync(venvPython(venvDir))) {
        interp = { python: venvPython(venvDir), venv: venvDir, source: 'venv', created: true };
        this.finish(sv, 'success', this.rel(venvDir));
      } else {
        this.addProblems(sv, [{ severity: 'warning', message: 'Could not create a virtual environment; using the system interpreter.', source: 'python' }]);
        this.finish(sv, 'warning', 'failed, using system Python');
      }
    }
    let version = await pythonVersion(interp.python);
    this.out(si, `${interp.python}\nPython ${version || '?'} (${interp.source === 'venv' ? 'virtualenv ' + this.rel(interp.venv) : interp.source})\n`);
    this.finish(si, version ? 'success' : 'error', `Python ${version || '?'} · ${interp.source === 'venv' ? this.rel(interp.venv) : interp.source}`);
    if (!version) return;

    if (root.hasManifest && cfg.autoInstallDeps && !this.cancelled) {
      const next = await this.pythonDeps(det, root, interp, { uv, poetry, pipenv, usesUvLock, usesPoetry, usesPipenv, tag });
      if (next) interp = next;
    } else if (root.hasManifest && !cfg.autoInstallDeps) {
      const s = this.step('Install dependencies' + tag, 'python');
      this.out(s, 'Automatic dependency installation is turned off in Settings > Build.\n');
      this.finish(s, 'skipped', 'disabled');
    }
    if (this.cancelled) return;
    this.service.interpreters.set(root.dir, interp);
    await this.pythonCheck(det, root, interp, tag);
    if (!this.cancelled && interp.venv) await this.pipCheck(root, interp, uv, tag);
  }

  async depsHash(root, interp) {
    const h = crypto.createHash('sha1');
    h.update(interp.python);
    const files = [root.manifests.pyproject, ...(root.manifests.requirements || []), root.manifests.setupPy, root.manifests.pipfile, root.manifests.uvLock, root.manifests.poetryLock, root.manifests.pipfileLock].filter(Boolean);
    for (const f of files) {
      try {
        h.update(f);
        h.update(await fsp.readFile(f));
      } catch {
        /* missing file */
      }
    }
    return h.digest('hex');
  }

  async pythonDeps(det, root, interp, o) {
    const s = this.step('Install dependencies' + o.tag, 'python');
    const hash = await this.depsHash(root, interp);
    const state = settings.getProjectState(det.root);
    const hashes = state.depsHashes || {};
    if (this.mode !== 'rebuild' && hashes[root.dir] === hash) {
      this.out(s, 'Dependencies are unchanged since the last successful install. Use Rebuild to reinstall.\n');
      this.finish(s, 'success', 'up to date');
      return null;
    }
    const manifests = [root.manifests.pyproject, ...(root.manifests.requirements || []), root.manifests.setupPy, root.manifests.pipfile].filter(Boolean);
    const auth = githubAuth.pythonAuth(pythonEnv(interp), manifests);
    this.authNotes(s, auth);
    const env = auth.env;
    let cmd = null;
    let args = [];
    let label = '';
    if (o.usesUvLock && o.uv) {
      cmd = o.uv;
      args = ['sync'];
      label = 'uv sync';
    } else if (o.usesPoetry && o.poetry) {
      cmd = o.poetry;
      args = ['install', '--no-interaction', '--no-root'];
      label = 'poetry install';
    } else if (o.usesPipenv && o.pipenv) {
      cmd = o.pipenv;
      args = ['install', '--dev'];
      label = 'pipenv install';
    } else {
      if (interp.source === 'system') {
        this.out(s, 'No virtual environment is active, so nothing is installed into the system interpreter.\nEnable "Create virtual environments automatically" in Settings > Build, or create one with: python3 -m venv .venv\n');
        this.addProblems(s, [{ severity: 'warning', message: 'Dependencies were not installed: no virtual environment (Kiln never installs into the system Python).', source: 'python', file: root.manifests.pyproject || (root.manifests.requirements || [])[0] || null, line: 1 }]);
        this.finish(s, 'warning', 'no virtualenv');
        return null;
      }
      const pip = o.uv ? { cmd: o.uv, base: ['pip', 'install', '--python', interp.python] } : { cmd: interp.python, base: ['-m', 'pip', 'install', '--disable-pip-version-check'] };
      const reqs = (root.manifests.requirements || []).filter((f) => !/docs?|lint/i.test(path.basename(f)));
      if (reqs.length) {
        args = [...pip.base, ...reqs.flatMap((r) => ['-r', r])];
        label = `pip install -r ${reqs.map((r) => path.basename(r)).join(' -r ')}`;
      } else if (root.hasBuildSystem && (root.manifests.pyproject || root.manifests.setupPy)) {
        args = [...pip.base, '-e', root.dir];
        label = 'pip install -e .';
      } else if (root.depSpecs.length) {
        args = [...pip.base, ...root.depSpecs];
        label = `pip install ${root.depSpecs.length} packages`;
      } else if (root.manifests.envYml) {
        this.out(s, 'This project uses a conda environment file. Create it with: conda env create -f environment.yml\n');
        this.finish(s, 'skipped', 'conda environment');
        return null;
      } else {
        this.out(s, 'No dependencies are declared.\n');
        this.finish(s, 'success', 'nothing to install');
        await this.saveHash(det, root, hash);
        return null;
      }
      cmd = pip.cmd;
      if (o.usesPoetry && !o.poetry) this.out(s, 'poetry is not installed; installing the declared dependencies with pip instead.\n');
    }
    s.detail = label;
    const code = await this.exec(s, cmd, args, { cwd: root.dir, env });
    if (code !== 0) {
      if (code !== -2) this.addProblems(s, [{ severity: 'error', message: `Dependency installation failed (${label}, exit code ${code}). See the Build output.`, source: 'pip', file: root.manifests.pyproject || (root.manifests.requirements || [])[0] || null, line: 1 }]);
      this.finish(s, 'error', label);
      return null;
    }
    // Environments created outside the project (poetry/pipenv) or by `uv sync` are picked up here.
    let next = null;
    if (cmd === o.poetry) {
      const r = await run(o.poetry, ['env', 'info', '-e'], { cwd: root.dir });
      if (r.code === 0 && r.stdout.trim()) next = { python: r.stdout.trim(), venv: path.dirname(path.dirname(r.stdout.trim())), source: 'poetry' };
    } else if (cmd === o.pipenv) {
      const r = await run(o.pipenv, ['--py'], { cwd: root.dir });
      if (r.code === 0 && r.stdout.trim()) next = { python: r.stdout.trim(), venv: path.dirname(path.dirname(r.stdout.trim())), source: 'pipenv' };
    } else if (cmd === o.uv && args[0] === 'sync' && fs.existsSync(venvPython(path.join(root.dir, '.venv')))) {
      next = { python: venvPython(path.join(root.dir, '.venv')), venv: path.join(root.dir, '.venv'), source: 'venv' };
    }
    if (next) recordInterpreter(det.root, root.dir, next);
    await this.saveHash(det, root, await this.depsHash(root, next || interp));
    this.finish(s, 'success', label);
    return next;
  }

  async saveHash(det, root, hash) {
    const state = settings.getProjectState(det.root);
    settings.setProjectState(det.root, { depsHashes: { ...(state.depsHashes || {}), [root.dir]: hash } });
  }

  async pythonCheck(det, root, interp, tag) {
    const cfg = settings.get().build;
    const s = this.step('Compile & check' + tag, 'python');
    const args = [PYCHECK, '--root', root.dir];
    if (!cfg.pythonLint) args.push('--no-lint');
    let summary = null;
    const stderr = [];
    const code = await this.exec(s, interp.python, args, {
      cwd: root.dir,
      env: pythonEnv(interp),
      raw: false,
      onLine: (line) => {
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          stderr.push(line);
          return;
        }
        if (o.type === 'summary') {
          summary = o;
          return;
        }
        const p = { file: o.file, line: o.line, col: o.col, endLine: o.endLine || undefined, endCol: o.endCol || undefined, severity: o.severity, code: o.code, message: o.message, source: o.source, module: o.module };
        const fresh = this.addProblems(s, [p]);
        if (fresh.length && p.severity !== 'info') {
          const color = p.severity === 'error' ? '31' : '33';
          this.out(s, `\x1b[${color}m${p.severity}\x1b[0m ${this.rel(p.file)}:${p.line}:${p.col} ${p.code ? p.code + ': ' : ''}${p.message}\n`);
        }
      },
    });
    if (stderr.length) this.out(s, stderr.join('\n') + '\n');
    if (!summary) {
      if (code !== -2) this.addProblems(s, [{ severity: 'error', message: `The Python checker failed to run (exit code ${code}).`, source: 'python' }]);
      this.finish(s, 'error', 'checker failed');
      return;
    }
    const infos = summary.infos || 0;
    this.out(s, `Checked ${summary.files} file${summary.files === 1 ? '' : 's'} with Python ${summary.python}${summary.pyflakes ? ' + pyflakes' : ''}: ${summary.errors} error(s), ${summary.warnings} warning(s)${infos ? `, ${infos} weak warning(s)` : ''}.\n`);
    const missing = this.problems.filter((p) => p.code === 'unresolved-import' && p.stepId === s.id).map((p) => p.module);
    if (missing.length) this.out(s, `\x1b[33mMissing modules:\x1b[0m ${[...new Set(missing)].join(', ')} (add them to your requirements, then rebuild)\n`);
    this.finish(s, summary.errors ? 'error' : summary.warnings ? 'warning' : 'success', `${summary.files} files · ${summary.errors} errors · ${summary.warnings} warnings`);
  }

  async pipCheck(root, interp, uv, tag) {
    const s = this.step('Dependency consistency' + tag, 'python');
    const manifest = root.manifests.pyproject || (root.manifests.requirements || [])[0] || null;
    let useUv = !!uv;
    if (!useUv) {
      const hasPip = await run(interp.python, ['-c', 'import pip'], { timeout: 15000 });
      if (hasPip.code !== 0) {
        this.out(s, 'pip is not available in this environment; skipped.\n');
        this.finish(s, 'skipped', 'pip not available');
        return;
      }
    }
    const code = await this.exec(s, useUv ? uv : interp.python, useUv ? ['pip', 'check', '--python', interp.python] : ['-m', 'pip', 'check'], {
      cwd: root.dir,
      env: pythonEnv(interp),
      onLine: (line) => this.addProblems(s, [parsePipCheck(line, manifest)]),
    });
    if (code === -2) return this.finish(s, 'cancelled');
    this.finish(s, s.warnings ? 'warning' : 'success', s.warnings ? `${s.warnings} conflict${s.warnings === 1 ? '' : 's'}` : 'no conflicts');
  }

  // ---------------------------------------------------------------- Node

  async node(det, root) {
    const tag = det.node.roots.length > 1 ? ` · ${root.name}` : '';
    const pmName = root.packageManager;
    const pm = which(pmName) || (pmName !== 'npm' ? which('npm') : null);
    const s0 = this.step(`Install packages${tag}`, 'node', pmName);
    if (!pm) {
      this.addProblems(s0, [{ severity: 'error', message: 'Node.js / npm was not found on PATH.', source: 'node' }]);
      this.finish(s0, 'error', 'npm not found');
      return;
    }
    const nm = path.join(root.dir, 'node_modules');
    let needInstall = this.mode === 'rebuild' || !fs.existsSync(nm);
    if (!needInstall && root.lockfile) {
      try {
        needInstall = fs.statSync(root.lockfile).mtimeMs > fs.statSync(nm).mtimeMs + 1000;
      } catch {
        needInstall = true;
      }
    }
    if (!needInstall) {
      this.out(s0, 'node_modules is up to date.\n');
      this.finish(s0, 'success', 'up to date');
    } else {
      const usesNpmCi = path.basename(pm).startsWith('npm') && root.lockfile && root.lockfile.endsWith('package-lock.json');
      const args = usesNpmCi ? ['ci', '--no-audit', '--no-fund'] : ['install'];
      const auth = githubAuth.npmAuth({ ...process.env, CI: '1', npm_config_fund: 'false', npm_config_audit: 'false' }, root.dir);
      this.authNotes(s0, auth, '.npmrc');
      const code = await this.exec(s0, pm, args, { cwd: root.dir, env: auth.env });
      if (code !== 0) {
        if (code !== -2) this.addProblems(s0, [{ severity: 'error', message: `${pmName} ${args[0]} failed with exit code ${code}.`, file: path.join(root.dir, 'package.json'), line: 1, source: 'node' }]);
        this.finish(s0, 'error');
        return;
      }
      this.finish(s0, 'success', `${pmName} ${args[0]}`);
    }
    if (this.cancelled) return;
    let s1 = null;
    const onLine = (line) => this.addProblems(s1, [parseTsc(line, root.dir)]);
    if (root.scripts.build) {
      s1 = this.step(`Build${tag}`, 'node', `${pmName} run build`);
      const code = await this.exec(s1, pm, ['run', 'build'], { cwd: root.dir, onLine, env: { ...process.env, CI: '1' } });
      this.finish(s1, code === 0 ? (s1.warnings ? 'warning' : 'success') : 'error', `${pmName} run build`);
      if (code !== 0 && !s1.errors && code !== -2) this.addProblems(s1, [{ severity: 'error', message: `${pmName} run build failed with exit code ${code}.`, file: path.join(root.dir, 'package.json'), line: 1, source: 'node' }]);
    } else if (root.hasTsconfig) {
      const tsc = [path.join(root.dir, 'node_modules', '.bin', isWin ? 'tsc.cmd' : 'tsc')].find((p) => fs.existsSync(p));
      s1 = this.step(`Type-check${tag}`, 'node', 'tsc --noEmit');
      if (!tsc) {
        this.out(s1, 'TypeScript is not installed in node_modules; skipped.\n');
        this.finish(s1, 'skipped', 'typescript not installed');
        return;
      }
      const code = await this.exec(s1, tsc, ['--noEmit', '-p', root.dir, '--pretty', 'false'], { cwd: root.dir, onLine });
      this.finish(s1, code === 0 ? 'success' : 'error', `${s1.errors} errors`);
    }
  }

  // ------------------------------------------------------------- Agentic

  async agentic(det) {
    const s = this.step('Agent environment & config', 'agentic', det.agentic.frameworks.map((f) => f.name).slice(0, 4).join(', '));
    const a = det.agentic;
    const ok = (msg) => this.out(s, `\x1b[32m✓\x1b[0m ${msg}\n`);
    const warn = (msg) => this.out(s, `\x1b[33m!\x1b[0m ${msg}\n`);
    const bad = (msg) => this.out(s, `\x1b[31m✗\x1b[0m ${msg}\n`);
    if (a.frameworks.length) ok(`Frameworks: ${a.frameworks.map((f) => `${f.name} (${f.via.slice(0, 2).join(', ')})`).join('; ')}`);

    // .env and keys
    if (a.env.example && !a.env.file) {
      warn(`${this.rel(a.env.example)} exists but there is no .env file`);
      this.addProblems(s, [{ severity: 'warning', file: a.env.example, line: 1, message: `No .env file found. Copy ${path.basename(a.env.example)} to .env and fill in the values.`, source: 'agent' }]);
    } else if (a.env.file) ok(`${this.rel(a.env.file)} found (${a.env.definedKeys.length} variable${a.env.definedKeys.length === 1 ? '' : 's'})`);
    for (const k of a.env.missingKeys) {
      warn(`${k} is not set`);
      this.addProblems(s, [{ severity: 'warning', file: a.env.example, line: lineOf(a.env.example, k), message: `${k} is listed in ${path.basename(a.env.example)} but is not set in .env or the environment.`, source: 'agent' }]);
    }
    for (const h of a.env.hints) {
      warn(`${h.framework}: ${h.keys.join(' / ')} not found`);
      this.addProblems(s, [{ severity: 'info', message: `${h.framework} usually needs ${h.keys.join(' or ')}; it is not set in .env or the environment.`, source: 'agent' }]);
    }

    // Config files
    for (const c of a.configs) {
      if (c.type === 'langgraph') this.checkLangGraph(s, c.path, ok, bad);
      else if (c.type === 'mcp') this.checkMcp(s, c.path, ok, warn, bad);
      else if (c.type === 'crewai') this.checkYaml(s, c.path, ok, bad);
      else if (c.type === 'claude') await this.checkClaudeDir(s, c.path, ok, warn, bad);
      else if (c.type === 'doc') ok(`${this.rel(c.path)} present`);
    }
    this.finish(s, s.errors ? 'error' : s.warnings ? 'warning' : 'success', `${a.frameworks.length} framework${a.frameworks.length === 1 ? '' : 's'} · ${s.errors + s.warnings} issue${s.errors + s.warnings === 1 ? '' : 's'}`);
  }

  checkLangGraph(s, file, ok, bad) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      bad(`${this.rel(file)}: invalid JSON`);
      this.addProblems(s, [{ severity: 'error', file, line: 1, message: `Invalid JSON: ${err.message}`, source: 'agent' }]);
      return;
    }
    const dir = path.dirname(file);
    let issues = 0;
    for (const [name, spec] of Object.entries(doc.graphs || {})) {
      const target = typeof spec === 'string' ? spec : spec && spec.path;
      if (!target) continue;
      const [rel] = target.split(':');
      const resolved = path.resolve(dir, rel);
      if (!fs.existsSync(resolved) && !fs.existsSync(resolved + '.py')) {
        issues++;
        this.addProblems(s, [{ severity: 'error', file, line: lineOf(file, name), message: `Graph "${name}" points to ${rel}, which does not exist.`, source: 'agent' }]);
      }
    }
    if (typeof doc.env === 'string' && !fs.existsSync(path.resolve(dir, doc.env))) {
      issues++;
      this.addProblems(s, [{ severity: 'warning', file, line: lineOf(file, '"env"'), message: `env file ${doc.env} does not exist.`, source: 'agent' }]);
    }
    if (issues) bad(`${this.rel(file)}: ${issues} issue(s)`);
    else ok(`${this.rel(file)}: ${Object.keys(doc.graphs || {}).length} graph(s) valid`);
  }

  checkMcp(s, file, ok, warn, bad) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      bad(`${this.rel(file)}: invalid JSON`);
      this.addProblems(s, [{ severity: 'error', file, line: 1, message: `Invalid JSON: ${err.message}`, source: 'agent' }]);
      return;
    }
    const servers = doc.mcpServers || doc.servers || {};
    let missing = 0;
    for (const [name, spec] of Object.entries(servers)) {
      if (spec && spec.command && !which(spec.command, process.env)) {
        missing++;
        this.addProblems(s, [{ severity: 'warning', file, line: lineOf(file, `"${name}"`), message: `MCP server "${name}": command "${spec.command}" was not found on PATH.`, source: 'agent' }]);
      }
    }
    if (missing) warn(`${this.rel(file)}: ${missing} MCP server command(s) not found`);
    else ok(`${this.rel(file)}: ${Object.keys(servers).length} MCP server(s) configured`);
  }

  checkYaml(s, file, ok, bad) {
    try {
      YAML.parse(fs.readFileSync(file, 'utf8'));
      ok(`${this.rel(file)}: valid YAML`);
    } catch (err) {
      bad(`${this.rel(file)}: invalid YAML`);
      this.addProblems(s, [{ severity: 'error', file, line: (err.linePos && err.linePos[0] && err.linePos[0].line) || 1, message: `Invalid YAML: ${err.message.split('\n')[0]}`, source: 'agent' }]);
    }
  }

  async checkClaudeDir(s, dir, ok, warn, bad) {
    let count = 0;
    for (const name of ['settings.json', 'settings.local.json']) {
      const f = path.join(dir, name);
      if (!fs.existsSync(f)) continue;
      try {
        JSON.parse(fs.readFileSync(f, 'utf8'));
        count++;
      } catch (err) {
        bad(`${this.rel(f)}: invalid JSON`);
        this.addProblems(s, [{ severity: 'error', file: f, line: 1, message: `Invalid JSON: ${err.message}`, source: 'claude' }]);
      }
    }
    const checkFrontmatter = (file, required) => {
      const text = fs.readFileSync(file, 'utf8');
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (!m) {
        if (required.length) this.addProblems(s, [{ severity: 'warning', file, line: 1, message: 'Missing YAML frontmatter (name and description).', source: 'claude' }]);
        return;
      }
      try {
        const fm = YAML.parse(m[1]) || {};
        for (const key of required) if (!fm[key]) this.addProblems(s, [{ severity: 'warning', file, line: 1, message: `Frontmatter is missing "${key}".`, source: 'claude' }]);
        count++;
      } catch (err) {
        this.addProblems(s, [{ severity: 'error', file, line: 1, message: `Invalid frontmatter: ${err.message.split('\n')[0]}`, source: 'claude' }]);
      }
    };
    const list = (sub) => {
      try {
        return fs.readdirSync(path.join(dir, sub), { withFileTypes: true });
      } catch {
        return [];
      }
    };
    for (const e of list('agents')) if (e.isFile() && e.name.endsWith('.md')) checkFrontmatter(path.join(dir, 'agents', e.name), ['name', 'description']);
    for (const e of list('skills')) {
      const f = path.join(dir, 'skills', e.name, 'SKILL.md');
      if (e.isDirectory() && fs.existsSync(f)) checkFrontmatter(f, ['name', 'description']);
    }
    for (const e of list('commands')) if (e.isFile() && e.name.endsWith('.md')) checkFrontmatter(path.join(dir, 'commands', e.name), []);
    ok(`${this.rel(dir)}: ${count} Claude config file(s) checked`);
  }
}

function lineOf(file, needle) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const i = lines.findIndex((l) => l.includes(needle));
    return i >= 0 ? i + 1 : 1;
  } catch {
    return 1;
  }
}

class BuildService {
  constructor(ctx) {
    this.ctx = ctx;
    this.current = null;
    this.last = null;
    this.seq = 0;
    this.interpreters = new Map();
  }

  start(opts = {}) {
    if (this.current) this.current.cancel();
    const r = new BuildRun(this, ++this.seq, { mode: opts.mode || 'build', reason: opts.reason || 'manual', only: opts.only });
    this.current = r;
    r.done = r.execute().finally(() => {
      if (this.current === r) this.current = null;
      this.last = r;
    });
    return { id: r.id };
  }

  cancel() {
    if (this.current) this.current.cancel();
    return { ok: true };
  }

  state() {
    const r = this.current || this.last;
    return r ? r.snapshot() : null;
  }

  /** Fast syntax/import check of one Python file, used on save. */
  async checkPythonFile(file) {
    const det = this.ctx.detection;
    if (!det || !det.python) return { file, problems: [] };
    const roots = det.python.roots.filter((r) => file.startsWith(r.dir + path.sep)).sort((a, b) => b.dir.length - a.dir.length);
    const root = roots[0] || det.python.roots[0];
    const interp = this.interpreters.get(root.dir) || resolveInterpreter(root.dir, det.root);
    if (!interp) return { file, problems: [] };
    const args = [PYCHECK, '--root', root.dir];
    if (!settings.get().build.pythonLint) args.push('--no-lint');
    args.push(file);
    const r = await run(interp.python, args, { cwd: root.dir, env: pythonEnv(interp), timeout: 30000 });
    const problems = [];
    for (const line of r.stdout.split('\n')) {
      try {
        const o = JSON.parse(line);
        if (o.type === 'problem') problems.push({ file: o.file, line: o.line, col: o.col, endLine: o.endLine || undefined, endCol: o.endCol || undefined, severity: o.severity, code: o.code, message: o.message, source: o.source, id: `chk:${problems.length}:${Date.now()}` });
      } catch {
        /* non-JSON noise */
      }
    }
    return { file, problems };
  }

  dispose() {
    if (this.current) this.current.cancel();
  }
}

module.exports = { BuildService, stripAnsi };
