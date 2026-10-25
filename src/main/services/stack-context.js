'use strict';
// "Explain an exception": the frames of a stack trace (Python, Node.js, .NET, Java) and the code
// around the frames that are in the project, so Claude sees the source along with the exception.
const fs = require('fs');
const path = require('path');

const PATTERNS = [
  // Python:   File "/app/main.py", line 12, in handler
  { re: /File "([^"]+)", line (\d+)(?:, in (\S+))?/g, map: (m) => ({ file: m[1], line: +m[2], fn: m[3] || '' }) },
  // .NET:     at Shop.Cart.Total() in /src/Shop/Cart.cs:line 42
  { re: /at ([^\s(]+)\([^)]*\) in (.+?):line (\d+)/g, map: (m) => ({ file: m[2], line: +m[3], fn: m[1] }) },
  // Node.js:  at total (/app/price.js:4:11)   |   at /app/price.js:4:11
  { re: /at (?:(?:async )?([^\s(]+) \()?((?:file:\/\/)?\/[^\s():]+|[A-Za-z]:\\[^\s():]+):(\d+):\d+\)?/g, map: (m) => ({ file: m[2].replace(/^file:\/\//, ''), line: +m[3], fn: m[1] || '' }) },
  // Java:     at com.shop.Cart.total(Cart.java:42)
  { re: /at ([\w$.]+)\(([\w$]+\.(?:java|kt|scala)):(\d+)\)/g, map: (m) => ({ file: m[2], line: +m[3], fn: m[1] }) },
];

/** Frames in the order they appear in the trace (duplicates removed). */
function parseFrames(text) {
  const found = [];
  for (const p of PATTERNS) {
    for (const m of String(text || '').matchAll(p.re)) found.push({ ...p.map(m), at: m.index });
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set();
  return found
    .filter((f) => {
      const k = `${f.file}:${f.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(({ at, ...f }) => f);
}

/** Find a file named in a trace: absolute, relative to the project, or (Java) by file name. */
function resolveFile(file, root) {
  if (path.isAbsolute(file)) return fs.existsSync(file) ? file : null;
  if (!root) return null;
  const direct = path.join(root, file);
  if (fs.existsSync(direct)) return direct;
  return null;
}

/**
 * The frames of a trace and code excerpts (±radius lines) of up to `max` frames inside the project;
 * frames in libraries (node_modules, site-packages, the runtime) are listed but not excerpted.
 */
function stackContext(text, { root, max = 4, radius = 6 } = {}) {
  const frames = parseFrames(text);
  const excerpts = [];
  for (const f of frames) {
    if (excerpts.length >= max) break;
    const abs = resolveFile(f.file, root);
    if (!abs || (root && !abs.startsWith(root + path.sep)) || /[\\/](node_modules|site-packages|dist-packages|\.venv|venv)[\\/]/.test(abs)) continue;
    let lines;
    try {
      lines = fs.readFileSync(abs, 'utf8').split('\n');
    } catch {
      continue;
    }
    const from = Math.max(1, f.line - radius);
    const to = Math.min(lines.length, f.line + radius);
    const code = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(4)}${from + i === f.line ? ' >' : '  '} ${l}`).join('\n');
    excerpts.push({ file: abs, rel: root ? path.relative(root, abs) : abs, line: f.line, fn: f.fn, code });
  }
  return { frames, excerpts };
}

module.exports = { parseFrames, stackContext };
