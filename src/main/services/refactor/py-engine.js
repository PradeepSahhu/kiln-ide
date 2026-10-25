'use strict';
// Python refactorings computed by rope (resources/kiln_refactor.py). rope is installed on first use
// into Kiln's tools folder, per Python minor version, and put on PYTHONPATH only for the helper - the
// project and its virtual environment are never modified.
const path = require('path');
const { run } = require('../../util/proc');
const { APP_ROOT } = require('../../protocol');
const { ensurePyTool, toolsDir } = require('../py-tools');

const SCRIPT = path.join(APP_ROOT, 'resources', 'kiln_refactor.py').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

/** rope for this interpreter: { python, env: { PYTHONPATH } }, installing it the first time. */
function ensureRope(python, log = () => {}) {
  return ensurePyTool(python, { pkg: 'rope', title: 'rope (Python refactoring library)' }, log);
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
