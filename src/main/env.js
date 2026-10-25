'use strict';
// Apps started from Finder/Dock get a minimal environment (PATH=/usr/bin:/bin:...), so `dotnet`,
// Homebrew Python, `uv` or `claude` would not be found. Import the user's login-shell environment
// once at startup, the same way terminal-launched apps see it.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const home = os.homedir();
const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/share/dotnet',
  path.join(home, '.dotnet'),
  path.join(home, '.dotnet', 'tools'),
  path.join(home, '.local', 'bin'),
  path.join(home, '.cargo', 'bin'),
  '/Library/Frameworks/Python.framework/Versions/Current/bin',
];

// Variables that describe the probing shell itself rather than the user's environment.
const SKIP = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'ZDOTDIR', 'PS1', 'PS2', 'SHELL_SESSION_ID']);

let ready = null;

function loadShellEnv() {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    if (process.platform === 'win32') {
      appendFallbackPaths();
      resolve();
      return;
    }
    const shell = process.env.SHELL || '/bin/zsh';
    const mark = `__KILN_ENV_${Math.random().toString(36).slice(2)}__`;
    const script = `printf '%s' '${mark}'; /usr/bin/env; printf '%s' '${mark}'`;
    let out = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        const start = out.indexOf(mark);
        const end = out.indexOf(mark, start + mark.length);
        if (start !== -1 && end !== -1) apply(parse(out.slice(start + mark.length, end)));
      } catch (err) {
        console.warn('[env] could not parse shell environment:', err.message);
      }
      appendFallbackPaths();
      resolve();
    };
    let child;
    try {
      child = spawn(shell, ['-ilc', script], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTART: 'false', ZSH_TMUX_AUTOSTARTED: 'true' },
      });
    } catch {
      finish();
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.on('error', finish);
    child.on('close', finish);
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish();
    }, 6000).unref();
  });
  return ready;
}

function parse(text) {
  const vars = {};
  let current = null;
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) {
      current = m[1];
      vars[current] = m[2];
    } else if (current) {
      vars[current] += '\n' + line;
    }
  }
  return vars;
}

function apply(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (SKIP.has(key) || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE') continue;
    if (key === 'PATH') {
      process.env.PATH = mergePaths(value.split(':'), (process.env.PATH || '').split(':'));
    } else if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function mergePaths(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const p of list) {
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out.join(path.delimiter);
}

function appendFallbackPaths() {
  const existing = EXTRA_PATHS.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  process.env.PATH = mergePaths((process.env.PATH || '').split(path.delimiter), existing);
}

module.exports = { loadShellEnv };
