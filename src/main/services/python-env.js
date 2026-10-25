'use strict';
// Python interpreter resolution shared by the build, run configurations and the terminal.
// Order: explicit setting > interpreter recorded for the root (poetry/pipenv) > project venv > system.
const path = require('path');
const settings = require('../settings');
const { which, run, isWin } = require('../util/proc');
const { findVenv } = require('./detect');

const venvPython = (dir) => (isWin ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python'));
const venvBin = (dir, name) => (isWin ? path.join(dir, 'Scripts', name + '.exe') : path.join(dir, 'bin', name));

function resolveInterpreter(rootDir, projectRoot) {
  const s = settings.get();
  if (s.python.interpreter) return { python: s.python.interpreter, source: 'settings' };
  const recorded = ((settings.getProjectState(projectRoot).pythonEnvs || {})[rootDir]) || null;
  if (recorded) {
    const fs = require('fs');
    if (fs.existsSync(recorded.python)) return { ...recorded, source: recorded.source || 'managed' };
  }
  const v = findVenv(rootDir) || (projectRoot && projectRoot !== rootDir ? findVenv(projectRoot) : null);
  if (v) return { python: v.python, venv: v.dir, source: 'venv' };
  const sys = which('python3') || which('python');
  return sys ? { python: sys, source: 'system' } : null;
}

function recordInterpreter(projectRoot, rootDir, interp) {
  const envs = { ...(settings.getProjectState(projectRoot).pythonEnvs || {}) };
  envs[rootDir] = { python: interp.python, venv: interp.venv || null, source: interp.source };
  settings.setProjectState(projectRoot, { pythonEnvs: envs });
}

async function pythonVersion(python) {
  const r = await run(python, ['-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'], { timeout: 15000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Environment that behaves like an activated virtualenv. */
function pythonEnv(interp, base = process.env) {
  const env = { ...base, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
  if (interp && interp.venv) {
    env.VIRTUAL_ENV = interp.venv;
    env.PATH = path.dirname(venvPython(interp.venv)) + path.delimiter + (base.PATH || '');
    delete env.PYTHONHOME;
  }
  return env;
}

/** Locate a console script (langgraph, crewai, adk, ...) next to the interpreter. */
function scriptPath(interp, name) {
  if (interp && interp.venv) {
    const p = venvBin(interp.venv, name);
    const fs = require('fs');
    if (fs.existsSync(p)) return p;
  }
  if (interp && interp.python) {
    const fs = require('fs');
    const sibling = path.join(path.dirname(interp.python), isWin ? name + '.exe' : name);
    if (fs.existsSync(sibling)) return sibling;
  }
  return which(name);
}

module.exports = { resolveInterpreter, recordInterpreter, pythonVersion, pythonEnv, scriptPath, venvPython, venvBin };
