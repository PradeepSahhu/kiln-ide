'use strict';
// Locates or installs the debug adapters: debugpy for Python (from the interpreter, or installed into
// the Kiln tools folder) and netcoredbg for .NET (downloaded from Samsung's GitHub releases).
// Nothing is installed into the user's project or virtual environment.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { which, run, stream, isWin } = require('../../util/proc');

const NETCOREDBG_REPO = 'Samsung/netcoredbg';

function toolsDir() {
  return process.env.KILN_TOOLS_DIR || path.join(app.getPath('userData'), 'tools');
}

// ------------------------------------------------------------------ debugpy

/**
 * Returns how to start the debugpy adapter: { python, env }. Prefers a debugpy importable from the
 * project interpreter, then one previously installed into tools/debugpy, then installs it there.
 */
async function ensureDebugpy(python, log = () => {}) {
  if (!python) throw new Error('No Python interpreter found.');
  const probe = await run(python, ['-c', 'import debugpy, sys; sys.stdout.write(debugpy.__version__)'], { timeout: 30000 });
  if (probe.code === 0) return { python, env: {}, version: probe.stdout.trim(), source: 'interpreter' };

  const target = path.join(toolsDir(), 'debugpy');
  const env = { PYTHONPATH: target };
  const installed = () => fs.existsSync(path.join(target, 'debugpy', '__init__.py'));
  if (!installed()) {
    fs.mkdirSync(target, { recursive: true });
    log('Installing debugpy into the Kiln tools folder (one time)…\n');
    const uv = which('uv');
    const attempts = [];
    if (uv) attempts.push([uv, ['pip', 'install', '--quiet', '--target', target, '--python', python, 'debugpy']]);
    attempts.push([python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--target', target, 'debugpy']]);
    const sys = which('python3');
    if (sys && sys !== python) attempts.push([sys, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--target', target, 'debugpy']]);
    let last = '';
    for (const [cmd, args] of attempts) {
      const h = stream(cmd, args, { onData: (t) => log(t) });
      const code = await h.done;
      if (code === 0 && installed()) break;
      last = `${path.basename(cmd)} exited with ${code}`;
    }
    if (!installed()) throw new Error(`Could not install debugpy (${last}). Install it in your environment with "pip install debugpy".`);
  }
  const check = await run(python, ['-c', 'import debugpy, sys; sys.stdout.write(debugpy.__version__)'], { timeout: 30000, env: { ...process.env, ...env } });
  if (check.code !== 0) throw new Error(`debugpy could not be loaded by ${python}: ${check.stderr.trim().split('\n').pop()}`);
  return { python, env, version: check.stdout.trim(), source: 'tools' };
}

// --------------------------------------------------------------- netcoredbg

function netcoredbgExe() {
  return path.join(toolsDir(), 'netcoredbg', isWin ? 'netcoredbg.exe' : 'netcoredbg');
}

/** Release asset name candidates for this platform, best first. */
function assetCandidates() {
  const arch = os.arch();
  if (process.platform === 'darwin') return arch === 'arm64' ? ['osx-arm64'] : ['osx-amd64', 'osx-x64'];
  if (process.platform === 'linux') return arch === 'arm64' ? ['linux-arm64'] : ['linux-amd64'];
  if (process.platform === 'win32') return ['win64'];
  return [];
}

function githubHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'kiln-ide' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function findAsset() {
  const wanted = assetCandidates();
  if (!wanted.length) throw new Error(`netcoredbg has no build for ${process.platform}/${os.arch()}.`);
  const res = await fetch(`https://api.github.com/repos/${NETCOREDBG_REPO}/releases?per_page=10`, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} while looking for netcoredbg releases.`);
  const releases = await res.json();
  for (const rel of releases) {
    if (rel.draft || rel.prerelease) continue;
    for (const w of wanted) {
      const asset = (rel.assets || []).find((a) => a.name.startsWith(`netcoredbg-${w}.`));
      if (asset) return { url: asset.browser_download_url, name: asset.name, tag: rel.tag_name };
    }
  }
  throw new Error(`No netcoredbg release has a ${wanted.join('/')} build.`);
}

let installing = null;

/** Path of a working netcoredbg, downloading it on first use. */
async function ensureNetcoredbg(log = () => {}) {
  const exe = netcoredbgExe();
  if (fs.existsSync(exe)) return exe;
  if (!installing) {
    installing = (async () => {
      const dir = toolsDir();
      fs.mkdirSync(dir, { recursive: true });
      const asset = await findAsset();
      log(`Downloading netcoredbg ${asset.tag} (${asset.name})…\n`);
      const res = await fetch(asset.url, { headers: { 'User-Agent': 'kiln-ide' } });
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
      const archive = path.join(dir, asset.name);
      fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
      fs.rmSync(path.join(dir, 'netcoredbg'), { recursive: true, force: true });
      const r = asset.name.endsWith('.zip')
        ? await run(which('unzip') ? 'unzip' : 'tar', which('unzip') ? ['-o', '-q', archive, '-d', dir] : ['-xf', archive, '-C', dir], { timeout: 120000 })
        : await run('tar', ['-xzf', archive, '-C', dir], { timeout: 120000 });
      fs.rmSync(archive, { force: true });
      if (r.code !== 0 || !fs.existsSync(exe)) throw new Error(`Could not unpack netcoredbg: ${r.stderr.trim() || 'executable missing'}`);
      if (!isWin) fs.chmodSync(exe, 0o755);
      const v = await run(exe, ['--version'], { timeout: 20000 });
      if (v.code !== 0) throw new Error(`netcoredbg does not start on this machine: ${v.stderr.trim() || v.stdout.trim()}`);
      log(`${v.stdout.split('\n')[0].trim()}\n`);
      return exe;
    })().finally(() => {
      installing = null;
    });
  }
  return installing;
}

module.exports = { toolsDir, ensureDebugpy, ensureNetcoredbg, netcoredbgExe };
