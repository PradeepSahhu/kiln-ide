'use strict';
// Two private URL schemes:
//   kiln://app/...       serves the IDE's own files (renderer, node_modules) from the app folder.
//   kiln-file:///abs/... serves files from the open project (image previews), limited to
//                        directories registered with allowFileRoot().
const { protocol } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_ROOT = path.resolve(__dirname, '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: kiln-file:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

const fileRoots = new Set();

function allowFileRoot(dir) {
  if (dir) fileRoots.add(path.resolve(dir));
}

function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'kiln', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
    { scheme: 'kiln-file', privileges: { secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

function inside(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

async function serve(file, extraHeaders = {}) {
  const data = await fs.promises.readFile(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return new Response(data, { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache', ...extraHeaders } });
}

function registerProtocols() {
  protocol.handle('kiln', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/src/renderer/index.html';
      const file = path.normalize(path.join(APP_ROOT, rel));
      if (!inside(APP_ROOT, file)) return new Response('Forbidden', { status: 403 });
      const headers = file.endsWith('.html') ? { 'Content-Security-Policy': CSP } : {};
      return await serve(file, headers);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  protocol.handle('kiln-file', async (request) => {
    try {
      const url = new URL(request.url);
      const file = path.normalize(decodeURIComponent(url.pathname));
      const allowed = [...fileRoots].some((root) => inside(root, file));
      if (!allowed) return new Response('Forbidden', { status: 403 });
      return await serve(file);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

module.exports = { registerSchemes, registerProtocols, allowFileRoot, APP_ROOT };
