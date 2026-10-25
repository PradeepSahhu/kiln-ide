// Post-install fixups so `npm install && npm start` works on a fresh checkout.
//  1. Make sure Electron's binary was downloaded (some npm setups skip its install script).
//  2. Restore the execute bit on node-pty's spawn-helper (lost when npm extracts the prebuilds).
//  3. Vendor the few browser ES modules that use bare import specifiers, so the renderer
//     can load them with plain relative imports (no bundler, no import map).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const nm = path.join(root, 'node_modules');

function ensureElectronBinary() {
  const pkgDir = path.join(nm, 'electron');
  if (!fs.existsSync(pkgDir) || fs.existsSync(path.join(pkgDir, 'path.txt'))) return;
  console.log('[kiln] Downloading the Electron binary...');
  execFileSync(process.execPath, [path.join(pkgDir, 'install.js')], { stdio: 'inherit', cwd: pkgDir });
}

function fixNodePtyPermissions() {
  const candidates = [];
  const prebuilds = path.join(nm, 'node-pty', 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    for (const dir of fs.readdirSync(prebuilds)) candidates.push(path.join(prebuilds, dir, 'spawn-helper'));
  }
  candidates.push(path.join(nm, 'node-pty', 'build', 'Release', 'spawn-helper'));
  for (const helper of candidates) {
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}

function vendorBrowserModules() {
  const out = path.join(root, 'src', 'renderer', 'vendor');
  fs.mkdirSync(out, { recursive: true });
  const copy = (from, to, transform = (s) => s) => {
    const src = path.join(nm, from);
    fs.writeFileSync(path.join(out, to), transform(fs.readFileSync(src, 'utf8')));
  };
  copy('preact/dist/preact.module.js', 'preact.mjs');
  copy('preact/hooks/dist/hooks.module.js', 'preact-hooks.mjs', (s) => s.replace(/from\s*(["'])preact\1/g, 'from"./preact.mjs"'));
  copy('htm/dist/htm.module.js', 'htm.mjs');
}

try {
  ensureElectronBinary();
  fixNodePtyPermissions();
  vendorBrowserModules();
  console.log('[kiln] postinstall complete');
} catch (err) {
  console.error('[kiln] postinstall failed:', err.message);
  process.exitCode = 1;
}
