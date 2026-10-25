'use strict';
// Parsers that turn tool output lines into Problems ({file, line, col, severity, code, message, source}).
const path = require('path');

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const stripAnsi = (s) => s.replace(ANSI, '');

function severity(word) {
  const w = word.toLowerCase();
  return w === 'error' ? 'error' : w === 'warning' ? 'warning' : 'info';
}

function resolveFile(file, baseDir) {
  if (!file) return null;
  const f = file.replace(/\\/g, path.sep);
  return path.isAbsolute(f) ? path.normalize(f) : baseDir ? path.resolve(baseDir, f) : f;
}

/** MSBuild / csc / NuGet diagnostics, e.g. `/p/Program.cs(10,13): error CS0103: msg [/p/app.csproj]`. */
function parseMsbuild(raw, baseDir) {
  const line = stripAnsi(raw).trim();
  if (!line || line.length > 4000) return null;
  let m = /^(.+?)\((\d+)(?:,(\d+))?(?:,(\d+),(\d+))?\)\s*:\s*(error|warning|info)\s*([A-Za-z]+\d+)?\s*:\s*(.*?)(?:\s+\[([^\]]+)\])?$/i.exec(line);
  if (m) {
    const project = m[9] || null;
    const dir = project ? path.dirname(resolveFile(project, baseDir)) : baseDir;
    return {
      file: resolveFile(m[1].trim(), dir),
      line: +m[2],
      col: m[3] ? +m[3] : 1,
      endLine: m[4] ? +m[4] : undefined,
      endCol: m[5] ? +m[5] : undefined,
      severity: severity(m[6]),
      code: m[7] || '',
      message: m[8].trim(),
      project,
      source: 'msbuild',
    };
  }
  m = /^(.+?)\s*:\s*(error|warning)\s+([A-Za-z]+\d+)\s*:\s*(.*?)(?:\s+\[([^\]]+)\])?$/i.exec(line);
  if (m) {
    const who = m[1].trim();
    const isFile = /[\\/]/.test(who) && !/^(MSBUILD|CSC|VBC|EXEC|NUGET)$/i.test(who);
    const file = isFile ? resolveFile(who, baseDir) : null;
    return {
      file,
      line: file ? 1 : undefined,
      col: 1,
      severity: severity(m[2]),
      code: m[3],
      message: m[4].trim(),
      project: m[5] || (file && /proj$/i.test(file) ? file : null),
      source: m[3].startsWith('NU') ? 'nuget' : 'msbuild',
    };
  }
  return null;
}

/** TypeScript compiler output in both plain and `--pretty` formats. */
function parseTsc(raw, baseDir) {
  const line = stripAnsi(raw).trim();
  let m = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/.exec(line);
  if (!m) m = /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s+(.*)$/.exec(line);
  if (!m) return null;
  return { file: resolveFile(m[1], baseDir), line: +m[2], col: +m[3], severity: severity(m[4]), code: m[5], message: m[6], source: 'tsc' };
}

/** `pip check` / `uv pip check` dependency conflicts. */
function parsePipCheck(raw, manifest) {
  const line = stripAnsi(raw).trim();
  if (!line || /^No broken requirements/i.test(line) || /^Checked \d+ packages/i.test(line) || /^All installed packages are compatible/i.test(line)) return null;
  if (/has requirement|requires .*, which is not installed|is not supported on this platform|but you have|incompatible/i.test(line)) {
    return { file: manifest || null, line: manifest ? 1 : undefined, col: 1, severity: 'warning', code: 'pip-check', message: line.replace(/^The package\s+/i, ''), source: 'pip' };
  }
  return null;
}

/** Splits a stream of chunks into complete lines. */
class LineSplitter {
  constructor(onLine) {
    this.onLine = onLine;
    this.buf = '';
  }
  push(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.search(/\r?\n/)) !== -1) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(this.buf[i] === '\r' ? i + 2 : i + 1);
      this.onLine(line);
    }
  }
  flush() {
    if (this.buf) this.onLine(this.buf);
    this.buf = '';
  }
}

function problemKey(p) {
  return [p.file || '', p.line || 0, p.col || 0, p.code || '', p.message].join('\u0000');
}

module.exports = { parseMsbuild, parseTsc, parsePipCheck, LineSplitter, stripAnsi, problemKey };
