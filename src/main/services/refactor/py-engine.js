'use strict';
// Python refactorings computed by rope (resources/kiln_refactor.py). rope is installed on first use
// into Kiln's tools folder, per Python minor version, and put on PYTHONPATH only for the helper - the
// project and its virtual environment are never modified.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { which, run, stream } = require('../../util/proc');
const { APP_ROOT } = require('../../protocol');

const SCRIPT = path.join(APP_ROOT, 'resources', 'kiln_refactor.py').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function toolsDir() {
  return process.env.KILN_TOOLS_DIR || path.join(app.getPath('userData'), 'tools');
}

const installs = new Map(); // target -> Promise (one install at a time per Python version)

/** rope for this interpreter: { python, env: { PYTHONPATH } }, installing it the first time. */
async function ensureRope(python, log = () => {}) {
  if (!python) throw new Error('No Python interpreter found.');
  const v = await run(python, ['-c', 'import sys; sys.stdout.write("%d.%d" % sys.version_info[:2])'], { timeout: 20000 });
  if (v.code !== 0) throw new Error(`Could not run ${python}: ${(v.stderr || '').trim().split('\n').pop()}`);
  const target = path.join(toolsDir(), 'rope', `py${v.stdout.trim()}`);
  const installed = () => fs.existsSync(path.join(target, 'rope', '__init__.py'));
  if (!installed()) {
    if (!installs.has(target)) installs.set(target, install(python, target, log).finally(() => installs.delete(target)));
    await installs.get(target);
  }
  if (!installed()) throw new Error('rope could not be installed.');
  return { python, env: { PYTHONPATH: target } };
}

async function install(python, target, log) {
  fs.mkdirSync(target, { recursive: true });
  log('Installing rope (Python refactoring library) into the Kiln tools folder, one time…\n');
  const attempts = [];
  const uv = which('uv');
  if (uv) attempts.push([uv, ['pip', 'install', '--quiet', '--target', target, '--python', python, 'rope']]);
  attempts.push([python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--target', target, 'rope']]);
  let last = '';
  for (const [cmd, args] of attempts) {
    const h = stream(cmd, args, { onData: (t) => log(t) });
    const code = await h.done;
    if (code === 0 && fs.existsSync(path.join(target, 'rope', '__init__.py'))) return;
    last = `${path.basename(cmd)} exited with ${code}`;
  }
  throw new Error(`Could not install rope (${last}). Check the network connection, or install it with "pip install rope".`);
}

/**
 * Run one rope refactoring. Returns { files: [{ path, before, after, created }], moves, deletes,
 * select }; throws with rope's explanation when the refactoring does not apply.
 */
async function ropeRefactor({ python, env, root, op, file, start, end, name, dest, similar }) {
  const input = JSON.stringify({ root, op, file, start, end: end == null ? start : end, name, dest, similar });
  const pythonPath = [env && env.PYTHONPATH, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const r = await run(python, [SCRIPT], { input, cwd: root, timeout: 180000, env: { ...process.env, ...env, PYTHONPATH: pythonPath, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } });
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Error(((r.stderr || r.stdout || '').trim().split('\n').pop()) || `rope exited with ${r.code}`);
  }
  if (out.error) throw new Error(out.error);
  return out;
}

module.exports = { ensureRope, ropeRefactor, toolsDir };
