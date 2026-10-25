'use strict';
// Small process helpers shared by every service: buffered runs, streaming runs that can be
// cancelled as a whole process tree, and a PATH lookup that does not depend on a shell.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';

/** Find an executable on PATH (or the given env's PATH). Returns an absolute path or null. */
function which(cmd, env = process.env) {
  if (!cmd) return null;
  if (cmd.includes('/') || (isWin && cmd.includes('\\'))) {
    return isExecutable(cmd) ? cmd : null;
  }
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}

function isExecutable(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (isWin) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a command to completion and collect its output. Never rejects: spawn failures are
 * reported as code -1 with the error message in stderr.
 */
function run(cmd, args = [], opts = {}) {
  const { cwd, env = process.env, input, timeout = 0, encoding = 'utf8', maxBuffer = 128 * 1024 * 1024 } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: encoding === 'buffer' ? Buffer.alloc(0) : '', stderr: String(err.message || err) });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let timer = null;
    let settled = false;
    const finish = (code, extraErr) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdoutBuf = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8') + (extraErr || '');
      resolve({ code, stdout: encoding === 'buffer' ? stdoutBuf : stdoutBuf.toString('utf8'), stderr });
    };
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size <= maxBuffer) out.push(d);
    });
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => finish(-1, String(e.message || e)));
    child.on('close', (code) => finish(code == null ? -1 : code));
    if (timeout > 0) {
      timer = setTimeout(() => {
        killTree(child);
        finish(-1, `\nTimed out after ${Math.round(timeout / 1000)}s`);
      }, timeout);
    }
    if (input != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Spawn a command and stream its combined output through onData. Returns a handle with a
 * `done` promise (resolving to the exit code) and `kill()` which stops the whole process tree.
 */
function stream(cmd, args = [], opts = {}) {
  const { cwd, env = process.env, onData = () => {} } = opts;
  let child;
  let killed = false;
  const done = new Promise((resolve) => {
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true, detached: !isWin });
    } catch (err) {
      onData(`Failed to start ${cmd}: ${err.message}\n`);
      resolve(-1);
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.end();
    child.on('error', (err) => {
      onData(`Failed to start ${cmd}: ${err.message}\n`);
      resolve(-1);
    });
    child.on('close', (code, signal) => resolve(killed ? -2 : code == null ? (signal ? -2 : -1) : code));
  });
  return {
    done,
    get pid() {
      return child && child.pid;
    },
    kill() {
      killed = true;
      killTree(child);
    },
  };
}

/** Kill a child and everything it started. Children spawned with `detached` lead their own group. */
function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode != null || !child.pid) return;
  if (isWin) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 3000);
  timer.unref();
}

module.exports = { which, run, stream, killTree, isWin };
