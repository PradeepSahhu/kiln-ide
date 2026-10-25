'use strict';
// Unit tests: discovery and runs for .NET (dotnet test, TRX results) and Python (pytest, JUnit XML).
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const settings = require('../settings');
const { which, run, stream } = require('../util/proc');
const { resolveInterpreter, pythonEnv } = require('./python-env');
const { dotnetAuth } = require('./github-auth');

function decode(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#xD;/g, '\r')
    .replace(/&#xA;/g, '\n')
    .replace(/&amp;/g, '&');
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) out[m[1]] = decode(m[2]);
  return out;
}

function parseTrx(xml) {
  const defs = {};
  for (const m of xml.matchAll(/<UnitTest\b([^>]*)>[\s\S]*?<TestMethod\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    const t = attrs(m[2]);
    defs[a.id] = { className: t.className, method: t.name };
  }
  const results = [];
  for (const m of xml.matchAll(/<UnitTestResult\b([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
    const a = attrs(m[1]);
    const body = m[3] || '';
    const def = defs[a.testId] || {};
    const message = (/<Message>([\s\S]*?)<\/Message>/.exec(body) || [])[1];
    const stack = (/<StackTrace>([\s\S]*?)<\/StackTrace>/.exec(body) || [])[1];
    const stdout = (/<StdOut>([\s\S]*?)<\/StdOut>/.exec(body) || [])[1];
    const duration = /(\d+):(\d+):([\d.]+)/.exec(a.duration || '');
    results.push({
      id: def.className ? `${def.className}.${def.method}` : a.testName,
      name: a.testName,
      className: def.className || '',
      method: def.method || a.testName,
      outcome: a.outcome === 'Passed' ? 'passed' : a.outcome === 'Failed' ? 'failed' : a.outcome === 'NotExecuted' ? 'skipped' : (a.outcome || 'unknown').toLowerCase(),
      durationMs: duration ? Math.round((+duration[1] * 3600 + +duration[2] * 60 + +duration[3]) * 1000) : null,
      message: message ? decode(message) : '',
      stack: stack ? decode(stack) : '',
      output: stdout ? decode(stdout) : '',
    });
  }
  return results;
}

function parseJUnit(xml) {
  const results = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1]);
    const body = m[3] || '';
    const failure = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/.exec(body);
    const skipped = /<skipped\b/.test(body);
    const fa = failure ? attrs(failure[2] || failure[5] || '') : {};
    const file = a.file || (a.classname ? a.classname.replace(/\./g, '/') + '.py' : '');
    results.push({
      id: `${file}::${a.classname && !a.classname.endsWith(path.basename(file, '.py')) ? a.classname.split('.').pop() + '::' : ''}${a.name}`,
      name: a.name,
      className: a.classname || '',
      method: a.name,
      file,
      line: a.line ? +a.line + 1 : null,
      outcome: failure ? 'failed' : skipped ? 'skipped' : 'passed',
      durationMs: a.time ? Math.round(+a.time * 1000) : null,
      message: fa.message || '',
      stack: failure ? decode(failure[3] || '') : '',
      output: decode((/<system-out>([\s\S]*?)<\/system-out>/.exec(body) || [])[1] || ''),
    });
  }
  return results;
}

class TestService {
  constructor(ctx) {
    this.ctx = ctx;
    this.proc = null;
  }

  projects() {
    const det = this.ctx.detection || {};
    const list = [];
    for (const p of (det.dotnet && det.dotnet.projects) || []) if (p.isTest) list.push({ id: `dotnet:${p.path}`, kind: 'dotnet', name: p.name, path: p.path, dir: p.dir });
    for (const r of (det.python && det.python.roots) || []) if (r.hasTests) list.push({ id: `py:${r.dir}`, kind: 'python', name: r.name, dir: r.dir });
    return list;
  }

  async discover(projectId) {
    const p = this.projects().find((x) => x.id === projectId);
    if (!p) return [];
    if (p.kind === 'dotnet') {
      const dotnet = settings.get().dotnet.path || which('dotnet');
      const env = dotnetAuth({ ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_UI_LANGUAGE: 'en' }, p.dir).env;
      const r = await run(dotnet, ['test', p.path, '--list-tests', '-nologo'], { cwd: p.dir, env, timeout: 300000 });
      const out = r.stdout.split('\n');
      const i = out.findIndex((l) => /The following Tests are available/i.test(l));
      if (i < 0) return { error: (r.stdout + r.stderr).trim().split('\n').slice(-12).join('\n'), tests: [] };
      return {
        tests: out
          .slice(i + 1)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((name) => ({ id: name, name, kind: 'dotnet' })),
      };
    }
    const interp = this.ctx.build.interpreters.get(p.dir) || resolveInterpreter(p.dir, this.ctx.root);
    if (!interp) return { error: 'No Python interpreter found', tests: [] };
    const r = await run(interp.python, ['-m', 'pytest', '--collect-only', '-q', '-p', 'no:cacheprovider'], { cwd: p.dir, env: pythonEnv(interp), timeout: 120000 });
    if (/No module named pytest/.test(r.stderr + r.stdout)) return { error: 'pytest is not installed in this environment. Add it to your requirements and rebuild.', tests: [] };
    const tests = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('::') && !l.startsWith('='))
      .map((id) => ({ id, name: id.split('::').slice(1).join('::'), file: path.join(p.dir, id.split('::')[0]), kind: 'python' }));
    return { tests };
  }

  /** Run tests (all, or a filter list) and stream output; resolves with parsed results. */
  async runTests(projectId, { filter = [], onOutput = () => {} } = {}) {
    const p = this.projects().find((x) => x.id === projectId);
    if (!p) throw new Error('Test project not found');
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kiln-tests-'));
    let cmd;
    let args;
    let env;
    let resultFile;
    if (p.kind === 'dotnet') {
      cmd = settings.get().dotnet.path || which('dotnet');
      resultFile = path.join(tmp, 'results.trx');
      args = ['test', p.path, '-nologo', '--logger', `trx;LogFileName=${resultFile}`, '--results-directory', tmp];
      if (filter.length) args.push('--filter', filter.map((f) => `FullyQualifiedName=${f}`).join('|'));
      const auth = dotnetAuth({ ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_UI_LANGUAGE: 'en', MSBUILDTERMINALLOGGER: 'off' }, p.dir);
      env = auth.env;
    } else {
      const interp = this.ctx.build.interpreters.get(p.dir) || resolveInterpreter(p.dir, this.ctx.root);
      if (!interp) throw new Error('No Python interpreter found');
      cmd = interp.python;
      resultFile = path.join(tmp, 'results.xml');
      args = ['-m', 'pytest', '-p', 'no:cacheprovider', `--junitxml=${resultFile}`, '-o', 'junit_family=xunit1', ...filter];
      env = { ...pythonEnv(interp), FORCE_COLOR: '1', PY_COLORS: '1' };
    }
    onOutput(`\x1b[90m$ ${path.basename(cmd)} ${args.join(' ')}\x1b[0m\n`);
    this.proc = stream(cmd, args, { cwd: p.dir, env, onData: onOutput });
    const code = await this.proc.done;
    this.proc = null;
    let results = [];
    try {
      const xml = await fsp.readFile(resultFile, 'utf8');
      results = p.kind === 'dotnet' ? parseTrx(xml) : parseJUnit(xml);
    } catch {
      results = [];
    }
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    for (const r of results) if (p.kind === 'python' && r.file && !path.isAbsolute(r.file)) r.file = path.join(p.dir, r.file);
    return { code, results, cancelled: code === -2 };
  }

  cancel() {
    if (this.proc) this.proc.kill();
  }
}

module.exports = { TestService };
