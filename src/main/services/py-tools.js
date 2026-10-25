'use strict';
// Python tools Kiln uses on the project's own interpreter (rope for refactorings, coverage.py for test
// coverage): installed on first use into Kiln's tools folder, per tool and Python minor version, and
// put on PYTHONPATH only for Kiln's own commands - the project and its virtual environment are never
// modified.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { which, run, stream } = require('../util/proc');

function toolsDir() {
  return process.env.KILN_TOOLS_DIR || path.join(app.getPath('userData'), 'tools');
}

const installs = new Map(); // target -> Promise

/**
 * `pkg` (pip name) importable as `module` for this interpreter: { python, env: { PYTHONPATH } }.
 * `dir` is the folder name under tools/ (rope keeps its historical "rope").
 */
async function ensurePyTool(python, { pkg, module = pkg, dir = pkg, title = pkg }, log = () => {}) {
  if (!python) throw new Error('No Python interpreter found.');
  const v = await run(python, ['-c', 'import sys; sys.stdout.write("%d.%d" % sys.version_info[:2])'], { timeout: 20000 });
  if (v.code !== 0) throw new Error(`Could not run ${python}: ${(v.stderr || '').trim().split('\n').pop()}`);
  const target = path.join(toolsDir(), dir, `py${v.stdout.trim()}`);
  const installed = () => fs.existsSync(path.join(target, module, '__init__.py'));
  if (!installed()) {
    if (!installs.has(target)) installs.set(target, install(python, target, pkg, title, installed, log).finally(() => installs.delete(target)));
    await installs.get(target);
  }
  if (!installed()) throw new Error(`${title} could not be installed.`);
  return { python, env: { PYTHONPATH: target } };
}

async function install(python, target, pkg, title, installed, log) {
  fs.mkdirSync(target, { recursive: true });
  log(`Installing ${title} into the Kiln tools folder, one time…\n`);
  const attempts = [];
  const uv = which('uv');
  if (uv) attempts.push([uv, ['pip', 'install', '--quiet', '--target', target, '--python', python, pkg]]);
  attempts.push([python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--target', target, pkg]]);
  let last = '';
  for (const [cmd, args] of attempts) {
    const h = stream(cmd, args, { onData: (t) => log(t) });
    const code = await h.done;
    if (code === 0 && installed()) return;
    last = `${path.basename(cmd)} exited with ${code}`;
  }
  throw new Error(`Could not install ${title} (${last}). Check the network connection, or install it with "pip install ${pkg}".`);
}

/** Environment for running a tool: its folder first on PYTHONPATH. */
function toolEnv(base, tool) {
  const parts = [tool.env.PYTHONPATH, base.PYTHONPATH].filter(Boolean);
  return { ...base, PYTHONPATH: parts.join(path.delimiter) };
}

module.exports = { ensurePyTool, toolEnv, toolsDir };
