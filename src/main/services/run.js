'use strict';
// Run configurations: detected ones (dotnet run/test, python scripts, uvicorn, langgraph dev, ...)
// plus user-defined ones, executed in a PTY so interactive console apps work.
const fs = require('fs');
const path = require('path');
const settings = require('../settings');
const { which } = require('../util/proc');
const { parseDotEnv } = require('./detect');
const { resolveInterpreter, pythonEnv, scriptPath } = require('./python-env');
const { Batcher, loadPty } = require('./terminal');
const { dotnetAuth } = require('./github-auth');
const { urlsIn } = require('./http-client');

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

class RunService {
  constructor(ctx) {
    this.ctx = ctx;
    this.sessions = new Map();
    this.seq = 0;
  }

  configs() {
    const det = this.ctx.detection;
    const custom = (settings.getProjectState(this.ctx.root).customRunConfigs || []).map((c) => ({ ...c, custom: true, group: 'Custom', icon: c.icon || 'run' }));
    return [...((det && det.runConfigs) || []), ...custom];
  }

  saveCustom(list) {
    const clean = (list || []).map((c, i) => ({
      id: c.id || `custom:${Date.now()}:${i}`,
      name: c.name || `Configuration ${i + 1}`,
      commandLine: c.commandLine || '',
      cwd: c.cwd || '',
      envText: c.envText || '',
      usePython: !!c.usePython,
    }));
    settings.setProjectState(this.ctx.root, { customRunConfigs: clean });
    return this.configs();
  }

  dotEnv(dirs) {
    const vars = {};
    if (!settings.get().run.loadDotEnv) return vars;
    for (const dir of dirs) {
      const f = path.join(dir, '.env');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        try {
          Object.assign(vars, parseDotEnv(fs.readFileSync(f, 'utf8')));
        } catch {
          /* unreadable .env */
        }
      }
    }
    return vars;
  }

  resolve(cfg) {
    const root = this.ctx.root;
    const cwd = cfg.cwd ? (path.isAbsolute(cfg.cwd) ? cfg.cwd : path.join(root, cfg.cwd)) : root;
    let env = { ...process.env };
    delete env.CLAUDECODE;
    let cmd;
    let args = cfg.args || [];
    if (cfg.custom) {
      const parts = splitArgs(cfg.commandLine);
      cmd = parts[0];
      args = parts.slice(1);
      if (cfg.usePython) {
        const interp = this.ctx.build.interpreters.get(root) || resolveInterpreter(root, root);
        env = pythonEnv(interp, env);
        if (cmd === 'python' || cmd === 'python3') cmd = interp ? interp.python : cmd;
      }
      for (const line of (cfg.envText || '').split('\n')) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (m) env[m[1]] = m[2];
      }
    } else if (cfg.python) {
      const interp = this.ctx.build.interpreters.get(cfg.pyRoot) || resolveInterpreter(cfg.pyRoot || root, root);
      if (!interp) throw new Error('No Python interpreter found for this configuration.');
      env = pythonEnv(interp, env);
      cmd = cfg.script ? scriptPath(interp, cfg.script) : interp.python;
      if (!cmd) throw new Error(`"${cfg.script}" is not installed in ${interp.venv || interp.python}. Build the project to install dependencies.`);
    } else {
      cmd = cfg.command;
    }
    if (cfg.command === 'dotnet' || /dotnet$/.test(cmd || '')) {
      env = dotnetAuth({ ...env, DOTNET_NOLOGO: '1' }, cwd).env;
      if (settings.get().dotnet.path) cmd = settings.get().dotnet.path;
    }
    const dotEnv = this.dotEnv([...new Set([root, cfg.pyRoot, cwd].filter(Boolean))]);
    for (const [k, v] of Object.entries(dotEnv)) if (env[k] === undefined) env[k] = v;
    const resolved = which(cmd, env) || cmd;
    return { cmd: resolved, args, cwd, env };
  }

  start(configOrId, { cols = 120, rows = 24 } = {}) {
    const cfg = typeof configOrId === 'string' ? this.configs().find((c) => c.id === configOrId) : configOrId;
    if (!cfg) throw new Error('Run configuration not found.');
    const id = `run-${++this.seq}`;
    let spec;
    try {
      spec = this.resolve(cfg);
    } catch (err) {
      this.ctx.send('run:started', { id, name: cfg.name, configId: cfg.id, commandLine: '' });
      this.ctx.send('run:data', { id, data: `\x1b[31m${err.message}\x1b[0m\r\n` });
      this.ctx.send('run:exit', { id, code: -1 });
      return { id, error: err.message };
    }
    const commandLine = [spec.cmd, ...spec.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    this.ctx.send('run:started', { id, name: cfg.name, configId: cfg.id, commandLine, cwd: spec.cwd });
    this.ctx.send('run:data', { id, data: `\x1b[90m${commandLine}\x1b[0m\r\n` });
    let p;
    try {
      p = loadPty().spawn(spec.cmd, spec.args, { name: 'xterm-256color', cols, rows, cwd: spec.cwd, env: spec.env });
    } catch (err) {
      this.ctx.send('run:data', { id, data: `\x1b[31mFailed to start: ${err.message}\x1b[0m\r\n` });
      this.ctx.send('run:exit', { id, code: -1 });
      return { id, error: err.message };
    }
    const session = { id, cfg, cwd: spec.cwd, pty: p, running: true, startedAt: Date.now(), urls: [], tail: '' };
    const batch = new Batcher((data) => this.ctx.send('run:data', { id, data }));
    p.onData((d) => {
      batch.push(d);
      // The address a server prints when it starts (for the endpoint Send buttons).
      if (session.urls.length < 4) {
        session.tail = (session.tail + d).slice(-4000);
        for (const u of urlsIn(session.tail)) {
          if (session.urls.includes(u)) continue;
          session.urls.push(u);
          this.ctx.send('run:url', { id, url: u });
        }
      }
    });
    p.onExit(({ exitCode, signal }) => {
      batch.flush();
      session.running = false;
      const secs = ((Date.now() - session.startedAt) / 1000).toFixed(1);
      this.ctx.send('run:data', { id, data: `\r\n\x1b[90mProcess finished with exit code ${exitCode}${signal ? ` (signal ${signal})` : ''} in ${secs}s\x1b[0m\r\n` });
      this.ctx.send('run:exit', { id, code: exitCode, signal });
    });
    this.sessions.set(id, session);
    return { id };
  }

  stop(id) {
    const s = this.sessions.get(id);
    if (!s || !s.running) return;
    try {
      s.pty.write('\x03');
    } catch {
      /* exited */
    }
    setTimeout(() => {
      if (s.running) {
        try {
          s.pty.kill('SIGTERM');
        } catch {
          /* exited */
        }
      }
    }, 1500);
    setTimeout(() => {
      if (s.running) {
        try {
          s.pty.kill('SIGKILL');
        } catch {
          /* exited */
        }
      }
    }, 5000);
  }

  input(id, data) {
    const s = this.sessions.get(id);
    if (s && s.running) s.pty.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s && s.running && cols > 0 && rows > 0) {
      try {
        s.pty.resize(cols, rows);
      } catch {
        /* exited */
      }
    }
  }

  /** Running sessions with the addresses they listen on: [{ id, cfg, cwd, urls }]. */
  servers() {
    return [...this.sessions.values()].filter((s) => s.running && s.urls.length).map((s) => ({ id: s.id, cfg: s.cfg, cwd: s.cwd, urls: s.urls.slice() }));
  }

  forget(id) {
    const s = this.sessions.get(id);
    if (s && !s.running) this.sessions.delete(id);
  }

  dispose() {
    for (const s of this.sessions.values()) {
      if (s.running) {
        try {
          s.pty.kill('SIGKILL');
        } catch {
          /* exited */
        }
      }
    }
    this.sessions.clear();
  }
}

module.exports = { RunService };
