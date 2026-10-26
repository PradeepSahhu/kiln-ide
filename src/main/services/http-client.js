'use strict';
// Sends the requests of the Endpoints tool window and the Send buttons above endpoint methods.
// Local development servers often use self-signed certificates (ASP.NET's dev certificate), so
// certificates are not verified for localhost.
const http = require('http');
const https = require('https');

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/;
const MAX_BODY = 2 * 1024 * 1024;

/** The request URL: path parameters filled in ({id} and :id), query parameters appended. */
function buildUrl(base, routePath, pathValues = {}, query = {}) {
  const filled = routePath.replace(/\{(\w+)(?::[^}]*)?\}|:(\w+)/g, (m, a, b) => {
    const name = a || b;
    const v = pathValues[name];
    if (v == null || v === '') throw new Error(`Enter a value for the path parameter "${name}".`);
    return encodeURIComponent(String(v));
  });
  const url = new URL(filled, base.endsWith('/') ? base : `${base}/`);
  url.pathname = filled.startsWith('/') ? filled : `/${filled}`;
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.append(k, String(v));
  return url.toString();
}

/** { method, url, headers, body } -> { status, statusText, headers, body, ms, size, truncated }. */
function sendRequest({ method = 'GET', url, headers = {}, body, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body == null || body === '' ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { Accept: 'application/json, */*;q=0.8', 'User-Agent': 'Kiln-IDE', ...headers };
    if (payload) {
      if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
      h['Content-Length'] = payload.length;
    }
    const started = Date.now();
    // A new connection per request: a restarted dev server must not get a stale kept-alive socket.
    const req = lib.request(u, { method, headers: h, timeout, agent: false, rejectUnauthorized: !LOCAL.test(u.hostname) }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage || '', headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started, size, truncated: size > MAX_BODY, url }));
    });
    req.on('timeout', () => req.destroy(new Error(`No answer from ${u.host} in ${Math.round(timeout / 1000)} s.`)));
    req.on('error', (err) => reject(err.code === 'ECONNREFUSED' ? new Error(`Nothing is listening on ${u.host}. Is the app running?`) : err));
    if (payload) req.write(payload);
    req.end();
  });
}

/** The addresses a server prints when it starts (uvicorn, Kestrel, Express, Flask, Vite, ...). */
function urlsIn(text) {
  const clean = String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const out = [];
  for (const m of clean.matchAll(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]|[\w-]+\.local):\d{2,5}\b/g)) {
    out.push(m[0].replace('0.0.0.0', '127.0.0.1').replace(/\[::1?\]/, 'localhost'));
  }
  if (!out.length) {
    const port = /(?:listening|running|started|serving)\b[^\n]{0,40}?\bport\s*:?\s*(\d{2,5})\b/i.exec(clean);
    if (port) out.push(`http://localhost:${port[1]}`);
  }
  return [...new Set(out)];
}

module.exports = { buildUrl, sendRequest, urlsIn };
