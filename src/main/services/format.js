'use strict';
// Reformat Code for files Monaco cannot format itself: C# via the language server or `dotnet format`,
// Python via ruff or black (from the project environment first, then PATH).
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const settings = require('../settings');
const { which, run } = require('../util/proc');
const { resolveInterpreter, scriptPath, pythonEnv } = require('./python-env');

async function formatText(ctx, file, text) {
  const ext = path.extname(file).toLowerCase();
  // Format a temporary copy so the user's file is only touched when they save.
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kiln-fmt-'));
  const tmp = path.join(tmpDir, path.basename(file));
  await fsp.writeFile(tmp, text);
  try {
    if (ext === '.py' || ext === '.pyi') {
      const interp = resolveInterpreter(ctx.root, ctx.root);
      const ruff = scriptPath(interp, 'ruff');
      const black = scriptPath(interp, 'black');
      let r;
      if (ruff) r = await run(ruff, ['format', '--quiet', tmp], { cwd: ctx.root, env: pythonEnv(interp), timeout: 30000 });
      else if (black) r = await run(black, ['--quiet', tmp], { cwd: ctx.root, env: pythonEnv(interp), timeout: 30000 });
      else return { error: 'Install ruff or black (for example: pip install ruff) to format Python code.' };
      if (r.code !== 0) return { error: (r.stderr || r.stdout).trim().split('\n').slice(-4).join('\n') };
      return { text: await fsp.readFile(tmp, 'utf8'), tool: ruff ? 'ruff' : 'black' };
    }
    if (ext === '.cs') {
      const dotnet = settings.get().dotnet.path || which('dotnet');
      if (!dotnet) return { error: 'The .NET SDK was not found.' };
      const editorconfig = findUp(path.dirname(file), '.editorconfig');
      if (editorconfig) await fsp.copyFile(editorconfig, path.join(tmpDir, '.editorconfig'));
      const r = await run(dotnet, ['format', 'whitespace', tmpDir, '--folder', '--include', path.basename(file)], { cwd: tmpDir, env: { ...process.env, DOTNET_NOLOGO: '1' }, timeout: 60000 });
      if (r.code !== 0) return { error: (r.stderr || r.stdout).trim().split('\n').slice(-4).join('\n') };
      return { text: await fsp.readFile(tmp, 'utf8'), tool: 'dotnet format' };
    }
    return { error: 'No formatter is available for this file type.' };
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function findUp(dir, name) {
  for (let d = dir; ; ) {
    const f = path.join(d, name);
    if (fs.existsSync(f)) return f;
    const p = path.dirname(d);
    if (p === d) return null;
    d = p;
  }
}

module.exports = { formatText };
