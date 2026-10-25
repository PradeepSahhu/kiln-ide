'use strict';
// Debugger service (one per project window): resolves what to launch from a run configuration or a
// file, prepares the runtime's debug adapter (debugpy, netcoredbg, the Node inspector), builds .NET
// projects first, and forwards session events to the renderer on 'debug:event'.
const fs = require('fs');
const path = require('path');
const settings = require('../../settings');
const { which, run, stream } = require('../../util/proc');
const { resolveInterpreter, pythonEnv, scriptPath } = require('../python-env');
const { dotnetAuth } = require('../github-auth');
const { launchSpec, launchSpecForFile } = require('./launch');
const adapters = require('./adapters');
const { DapSession } = require('./dap-session');
const { NodeSession } = require('./node-session');

const DEFAULT_EXCEPTIONS = { python: ['uncaught'], dotnet: ['user-unhandled'], node: ['uncaught'] };
const RUNTIME = { 'dotnet-test': 'dotnet' };
// netcoredbg warns about every Release-built test platform assembly it loads.
const ADAPTER_NOISE = /^You are debugging a Release build of (testhost|Microsoft\.TestPlatform|Microsoft\.VisualStudio\.TestPlatform)/;

function cleanEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (v != null && k !== 'CLAUDECODE') out[k] = String(v);
  return out;
}

class DebugService {
  constructor(ctx) {
    this.ctx = ctx;
    this.session = null;
    this.current = null;
    this.seq = 0;
    this.breakpoints = {};
    this.breakOnExceptions = true;
    this.last = null;
  }

  emit(type, payload = {}) {
    this.ctx.send('debug:event', { sessionId: this.current ? this.current.id : null, type, ...payload });
  }

  log(text, category = 'console') {
    if (text) this.emit('output', { category, text });
  }

  interpreterFor(dir) {
    const known = this.ctx.build && this.ctx.build.interpreters && this.ctx.build.interpreters.get(dir);
    return known || resolveInterpreter(dir, this.ctx.root);
  }

  specOpts() {
    return { root: this.ctx.root, interpreterFor: (d) => this.interpreterFor(d), scriptPath };
  }

  configById(id) {
    const list = this.ctx.runs && this.ctx.runs.configs ? this.ctx.runs.configs() : [];
    const cfg = list.find((c) => c.id === id);
    if (!cfg) throw new Error('Run configuration not found.');
    return cfg;
  }

  /** Can this configuration be debugged? Returns { ok, reason }. */
  check(configOrId) {
    try {
      const cfg = typeof configOrId === 'string' ? this.configById(configOrId) : configOrId;
      launchSpec(cfg, this.specOpts());
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async start(configOrId, opts = {}) {
    const cfg = typeof configOrId === 'string' ? this.configById(configOrId) : configOrId;
    const spec = launchSpec(cfg, this.specOpts());
    return this.launch(spec, cfg.name || cfg.detail || 'Debug', { ...opts, configId: cfg.id });
  }

  async startFile(file, opts = {}) {
    const spec = launchSpecForFile(file, this.specOpts());
    return this.launch(spec, path.basename(file), { ...opts, file });
  }

  /** Debug one test (Tests tool window, gutter icon); see TestService.debugSpec. */
  async startTest(projectId, testId, opts = {}) {
    const spec = this.ctx.tests.debugSpec(projectId, testId);
    return this.launch(spec, opts.name || testId.split(/::|\./).pop(), { ...opts, test: { projectId, testId } });
  }

  async restart() {
    if (!this.last) throw new Error('Nothing to restart.');
    const { spec, name, opts } = this.last;
    return this.launch(spec, name, opts);
  }

  async launch(spec, name, opts) {
    if (this.session) await this.stop();
    if (opts.breakpoints) this.setAll(opts.breakpoints);
    if (opts.breakOnExceptions != null) this.breakOnExceptions = !!opts.breakOnExceptions;
    this.last = { spec, name, opts: { ...opts, breakpoints: undefined } };
    const id = `debug-${++this.seq}`;
    const kind = RUNTIME[spec.kind] || spec.kind;
    this.current = { id, name, kind, state: 'starting', configId: opts.configId || null, file: opts.file || null };
    this.emit('state', { state: 'starting', name, kind, configId: this.current.configId });
    let session;
    try {
      session = await this.createSession(spec, name);
      if (!this.current || this.current.id !== id) {
        session.stop();
        return { sessionId: id, cancelled: true };
      }
      this.session = session;
      this.wire(session, id);
      const filters = this.breakOnExceptions ? DEFAULT_EXCEPTIONS[kind] : [];
      await session.start({ breakpoints: this.breakpoints, exceptionFilters: filters, stopOnEntry: !!opts.stopOnEntry });
      if (this.current && this.current.id === id && this.current.state === 'starting') {
        this.current.state = 'running';
        this.emit('state', { state: 'running', name, kind });
      }
      return { sessionId: id };
    } catch (err) {
      if (this.current && this.current.id === id) {
        this.log(`${err.message}\n`, 'stderr');
        this.current.state = 'terminated';
        this.emit('terminated', { exitCode: null, error: err.message });
        this.session = null;
      }
      if (session) session.stop().catch(() => {});
      throw err;
    }
  }

  wire(session, id) {
    const mine = () => this.current && this.current.id === id;
    session.on('output', (o) => mine() && !ADAPTER_NOISE.test(o.text) && this.emit('output', { category: o.category, text: o.text }));
    session.on('breakpoint', (b) => mine() && this.emit('breakpoint', { ...b, file: this.mapPath(b.file) }));
    session.on('continued', (c) => {
      if (!mine()) return;
      this.current.state = 'running';
      this.emit('continued', c);
    });
    session.on('stopped', async (s) => {
      if (!mine()) return;
      this.current.state = 'stopped';
      try {
        const threads = await session.threads();
        const threadId = s.threadId || (threads[0] && threads[0].id);
        const frames = (await session.stackTrace(threadId)).map((f) => ({ ...f, file: this.mapPath(f.file) }));
        if (mine()) this.emit('stopped', { ...s, threadId, threads, frames });
      } catch (err) {
        if (mine()) this.emit('stopped', { ...s, threads: [], frames: [], error: err.message });
      }
    });
    session.on('terminated', (t) => {
      if (!mine()) return;
      this.current.state = 'terminated';
      this.session = null;
      this.emit('terminated', { exitCode: t.exitCode });
    });
  }

  /** Map adapter paths back to the project's spelling (e.g. /private/tmp -> /tmp). */
  mapPath(p) {
    if (!p || !this.ctx.root) return p;
    if (this.rootReal === undefined) {
      try {
        this.rootReal = fs.realpathSync(this.ctx.root);
      } catch {
        this.rootReal = this.ctx.root;
      }
    }
    if (this.rootReal !== this.ctx.root && p.startsWith(this.rootReal + path.sep)) return this.ctx.root + p.slice(this.rootReal.length);
    return p;
  }

  dotEnvFor(dirs) {
    try {
      return this.ctx.runs && this.ctx.runs.dotEnv ? this.ctx.runs.dotEnv(dirs.filter(Boolean)) : {};
    } catch {
      return {};
    }
  }

  async createSession(spec, name) {
    const log = (t) => this.log(t);
    if (spec.kind === 'python') {
      const adapter = await adapters.ensureDebugpy(spec.python, log);
      const env = cleanEnv({ ...pythonEnv(spec.interp, process.env), ...this.dotEnvFor([this.ctx.root, spec.cwd]) });
      delete env.PYTHONPATH;
      const launchArgs = { type: 'python', name, cwd: spec.cwd, args: spec.args, env, python: [spec.python], console: 'internalConsole', redirectOutput: true, justMyCode: true, showReturnValue: true, subProcess: false };
      if (spec.module) launchArgs.module = spec.module;
      else launchArgs.program = spec.program;
      const shown = spec.module ? `-m ${spec.module}` : path.relative(spec.cwd, spec.program) || spec.program;
      this.log(`\x1b[90m${spec.python} ${shown} ${spec.args.join(' ')}\x1b[0m\n`);
      return new DapSession({ command: adapter.python, args: ['-m', 'debugpy.adapter'], env: cleanEnv({ ...process.env, ...adapter.env }), cwd: spec.cwd, adapterID: 'debugpy', launchArgs });
    }
    if (spec.kind === 'dotnet') {
      const exe = await adapters.ensureNetcoredbg(log);
      const dotnet = settings.get().dotnet.path || which('dotnet') || 'dotnet';
      const env = cleanEnv(dotnetAuth({ ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' }, spec.cwd).env);
      this.log(`\x1b[90m${path.basename(dotnet)} build ${path.basename(spec.project)} -c Debug\x1b[0m\n`);
      const build = stream(dotnet, ['build', spec.project, '-c', 'Debug', '-nologo', '-v', 'q', '-clp:NoSummary'], { cwd: spec.cwd, env, onData: log });
      this.building = build;
      const code = await build.done;
      this.building = null;
      if (code !== 0) throw new Error(code === -2 ? 'Build cancelled.' : 'Build failed; fix the errors above and debug again.');
      const target = await this.dotnetTargetPath(dotnet, spec.project, env);
      const appEnv = cleanEnv({ ...env, ASPNETCORE_ENVIRONMENT: env.ASPNETCORE_ENVIRONMENT || 'Development', DOTNET_ENVIRONMENT: env.DOTNET_ENVIRONMENT || 'Development', ...this.dotEnvFor([this.ctx.root, spec.cwd]) });
      this.log(`\x1b[90m${target}\x1b[0m\n`);
      return new DapSession({ command: exe, args: ['--interpreter=vscode'], env: cleanEnv({ ...process.env, DOTNET_ROOT: env.DOTNET_ROOT || path.dirname(fs.realpathSync(dotnet)) }), cwd: spec.cwd, adapterID: 'coreclr', launchArgs: { type: 'coreclr', name, program: target, args: spec.args, cwd: spec.cwd, env: appEnv, justMyCode: true, enableStepFiltering: true } });
    }
    if (spec.kind === 'dotnet-test') return this.dotnetTestSession(spec, name);
    if (spec.kind === 'node') {
      const env = cleanEnv({ ...process.env, ...this.dotEnvFor([this.ctx.root, spec.cwd]), ...(spec.env || {}) });
      delete env.NODE_OPTIONS;
      const node = which('node', env);
      this.log(`\x1b[90mnode ${path.relative(spec.cwd, spec.program) || spec.program} ${spec.args.join(' ')}\x1b[0m\n`);
      return new NodeSession({ node, program: spec.program, args: spec.args, runtimeArgs: spec.runtimeArgs || [], cwd: spec.cwd, env });
    }
    throw new Error(`Cannot debug ${spec.kind} programs.`);
  }

  /**
   * `dotnet test` (which builds first) with VSTEST_HOST_DEBUG: the test host prints its process id and
   * waits for a debugger, and netcoredbg attaches to it. The test run's output goes to the Debug console.
   */
  async dotnetTestSession(spec, name) {
    const log = (t) => this.log(t);
    const exe = await adapters.ensureNetcoredbg(log);
    const dotnet = settings.get().dotnet.path || which('dotnet') || 'dotnet';
    const env = cleanEnv(dotnetAuth({ ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', MSBUILDTERMINALLOGGER: 'off', VSTEST_HOST_DEBUG: '1' }, spec.cwd).env);
    this.log(`\x1b[90m${path.basename(dotnet)} test ${path.basename(spec.project)} --filter ${spec.filter}\x1b[0m\n`);
    let text = '';
    let gotPid;
    const pid = new Promise((resolve) => (gotPid = resolve));
    const proc = stream(dotnet, ['test', spec.project, '-nologo', '--filter', spec.filter], {
      cwd: spec.cwd,
      env,
      onData: (t) => {
        text += t;
        const m = /Process Id:\s*(\d+)/.exec(text);
        if (m) gotPid(+m[1]);
        // The attach instructions are for people attaching by hand.
        log(t.replace(/^.*(Host debugging is enabled|Process Id: \d+|Waiting for debugger attach).*\r?\n?/gm, ''));
      },
    });
    this.building = proc;
    const ended = proc.done.then((code) => {
      throw new Error(code === -2 ? 'Cancelled.' : /error|failed/i.test(text) && !/Process Id/.test(text) ? 'The test project did not build; fix the errors above and debug again.' : 'dotnet test ended before the test host started; see the output above.');
    });
    ended.catch(() => {});
    const processId = await Promise.race([pid, ended]);
    this.building = null;
    this.testHost = proc;
    proc.done.then(() => {
      if (this.testHost === proc) this.testHost = null;
    });
    return new DapSession({ command: exe, args: ['--interpreter=vscode'], env: cleanEnv({ ...process.env, DOTNET_ROOT: env.DOTNET_ROOT || path.dirname(fs.realpathSync(dotnet)) }), cwd: spec.cwd, adapterID: 'coreclr', request: 'attach', launchArgs: { type: 'coreclr', name, processId, justMyCode: true, enableStepFiltering: true } });
  }

  async dotnetTargetPath(dotnet, project, env) {
    const r = await run(dotnet, ['msbuild', project, '-getProperty:TargetPath', '-p:Configuration=Debug', '-nologo'], { cwd: path.dirname(project), env, timeout: 120000 });
    const out = r.stdout.trim().split('\n').pop().trim();
    if (r.code === 0 && out && fs.existsSync(out)) return out;
    // Multi-targeting projects: newest <AssemblyName>.dll under bin/Debug.
    const name = path.basename(project, '.csproj');
    const bin = path.join(path.dirname(project), 'bin', 'Debug');
    let best = null;
    const walk = (d, depth) => {
      if (depth > 3 || !fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name === `${name}.dll`) {
          const m = fs.statSync(p).mtimeMs;
          if (!best || m > best.m) best = { p, m };
        }
      }
    };
    walk(bin, 0);
    if (!best) throw new Error(`Could not find the built ${name}.dll.`);
    return best.p;
  }

  need() {
    if (!this.session) throw new Error('No debug session is running.');
    return this.session;
  }

  async step(kind, threadId) {
    const s = this.need();
    await s[kind](threadId);
    if (kind !== 'pause' && this.current && this.current.state === 'stopped') {
      this.current.state = 'running';
      this.emit('continued', { threadId, allThreadsContinued: true });
    }
  }

  continue(threadId) {
    return this.step('continue', threadId);
  }

  next(threadId) {
    return this.step('next', threadId);
  }

  stepIn(threadId) {
    return this.step('stepIn', threadId);
  }

  stepOut(threadId) {
    return this.step('stepOut', threadId);
  }

  pause(threadId) {
    return this.step('pause', threadId);
  }

  threads() {
    return this.need().threads();
  }

  async stackTrace(threadId) {
    return (await this.need().stackTrace(threadId)).map((f) => ({ ...f, file: this.mapPath(f.file) }));
  }

  scopes(frameId) {
    return this.need().scopes(frameId);
  }

  variables(ref) {
    return this.need().variables(ref);
  }

  evaluate(expression, frameId, context) {
    return this.need().evaluate(expression, frameId, context);
  }

  setVariable(ref, name, value) {
    return this.need().setVariable(ref, name, value);
  }

  setAll(map) {
    this.breakpoints = {};
    for (const [file, list] of Object.entries(map || {})) {
      const bps = (list || []).filter((b) => b && b.line > 0 && b.enabled !== false);
      if (bps.length) this.breakpoints[file] = bps;
    }
  }

  async setBreakpoints(file, bps) {
    const active = (bps || []).filter((b) => b && b.line > 0 && b.enabled !== false);
    if (active.length) this.breakpoints[file] = active;
    else delete this.breakpoints[file];
    if (!this.session) return active.map((b) => ({ line: b.line, requestedLine: b.line, verified: false }));
    const result = (await this.session.setBreakpoints(file, active)).map((b) => ({ ...b }));
    return result;
  }

  async setBreakOnExceptions(on) {
    this.breakOnExceptions = !!on;
    if (this.session && this.current) await this.session.setExceptionFilters(on ? DEFAULT_EXCEPTIONS[this.current.kind] : []);
    return this.breakOnExceptions;
  }

  state() {
    return this.current ? { ...this.current } : null;
  }

  async stop() {
    if (this.building) this.building.kill();
    const s = this.session;
    if (!s) {
      if (this.current && this.current.state !== 'terminated') {
        this.current.state = 'terminated';
        this.emit('terminated', { exitCode: null });
      }
      return;
    }
    await s.stop();
    if (this.testHost) this.testHost.kill();
  }

  dispose() {
    if (this.session) this.session.stop().catch(() => {});
  }
}

module.exports = { DebugService };
