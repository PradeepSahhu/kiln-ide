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
const F = require('./test-frameworks');
const { ensurePyTool, toolEnv } = require('./py-tools');

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
    for (const r of (det.node && det.node.roots) || []) {
      const framework = F.jsFramework(r, { hasTestFiles: F.findJsTestFiles(r.dir, 1).length > 0 });
      if (framework) list.push({ id: `js:${r.dir}`, kind: 'node', framework, name: r.name, dir: r.dir });
    }
    return list;
  }

  project(projectId) {
    const p = this.projects().find((x) => x.id === projectId);
    if (!p) throw new Error('Test project not found');
    return p;
  }

  interpreter(p) {
    const interp = (this.ctx.build.interpreters && this.ctx.build.interpreters.get(p.dir)) || resolveInterpreter(p.dir, this.ctx.root);
    if (!interp) throw new Error('No Python interpreter found');
    return interp;
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
    if (p.kind === 'node') {
      const tests = [];
      for (const file of F.findJsTestFiles(p.dir)) {
        let src = '';
        try {
          src = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        for (const t of F.scanJsTests(src)) tests.push({ id: `${file}::${t.name}`, name: t.name, file, line: t.line, kind: 'node' });
      }
      return { tests, framework: p.framework };
    }
    const interp = this.interpreter(p);
    const r = await run(interp.python, ['-m', 'pytest', '--collect-only', '-q', '-p', 'no:cacheprovider'], { cwd: p.dir, env: pythonEnv(interp), timeout: 120000 });
    if (/No module named pytest/.test(r.stderr + r.stdout)) return { error: 'pytest is not installed in this environment. Add it to your requirements and rebuild.', tests: [] };
    const tests = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('::') && !l.startsWith('='))
      .map((id) => ({ id, name: id.split('::').slice(1).join('::'), file: path.join(p.dir, id.split('::')[0]), kind: 'python' }));
    return { tests };
  }

  /**
   * Run tests (all, or the `filter` ids) and stream output; resolves with { code, results, coverage }.
   * With `coverage`, the runner's coverage tool collects which lines ran.
   */
  async runTests(projectId, { filter = [], coverage = false, onOutput = () => {} } = {}) {
    const p = this.project(projectId);
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kiln-tests-'));
    let cmd;
    let args;
    let env;
    let resultFile;
    let parse;
    let collect = null; // async () => coverage
    if (p.kind === 'dotnet') {
      cmd = settings.get().dotnet.path || which('dotnet');
      resultFile = path.join(tmp, 'results.trx');
      args = ['test', p.path, '-nologo', '--logger', `trx;LogFileName=${resultFile}`, '--results-directory', tmp];
      if (filter.length) args.push('--filter', filter.map((f) => `FullyQualifiedName=${f}`).join('|'));
      if (coverage) {
        args.push('--collect', 'XPlat Code Coverage');
        collect = async () => {
          const xml = findFile(tmp, 'coverage.cobertura.xml');
          if (!xml) throw new Error('No coverage report: add the coverlet.collector package to the test project.');
          return F.parseCobertura(await fsp.readFile(xml, 'utf8'), p.dir);
        };
      }
      env = dotnetAuth({ ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_UI_LANGUAGE: 'en', MSBUILDTERMINALLOGGER: 'off' }, p.dir).env;
      parse = (xml) => parseTrx(xml);
    } else if (p.kind === 'node') {
      resultFile = path.join(tmp, p.framework === 'jest' ? 'results.json' : 'results.xml');
      const chosen = filter.map((id) => ({ file: id.slice(0, id.indexOf('::')), name: id.slice(id.indexOf('::') + 2) })).filter((x) => x.file);
      const covDir = coverage ? path.join(tmp, 'coverage') : null;
      if (covDir) await fsp.mkdir(covDir, { recursive: true });
      const node = which('node') || process.execPath;
      const c = F.jsCommand(p.framework, { dir: p.dir, node, files: [...new Set(chosen.map((x) => x.file))], names: chosen.map((x) => x.name), resultFile, coverageDir: covDir });
      if (c.noCoverage) onOutput('\x1b[33mMocha has no built-in coverage; running without it.\x1b[0m\n');
      cmd = c.cmd;
      args = c.args;
      env = { ...process.env, FORCE_COLOR: '1', CI: '1' };
      // Started from inside a test runner, node --test would report to that runner instead.
      delete env.NODE_OPTIONS;
      delete env.NODE_TEST_CONTEXT;
      parse = (text) => (c.results === 'jest' ? F.parseJestJson(text) : F.parseJsJUnit(text, p.dir));
      if (covDir && !c.noCoverage) collect = async () => F.parseLcov(await fsp.readFile(findFile(covDir, 'lcov.info') || path.join(covDir, 'lcov.info'), 'utf8'), p.dir);
    } else {
      const interp = this.interpreter(p);
      resultFile = path.join(tmp, 'results.xml');
      const pytest = ['-m', 'pytest', '-p', 'no:cacheprovider', `--junitxml=${resultFile}`, '-o', 'junit_family=xunit1', ...filter];
      env = { ...pythonEnv(interp), FORCE_COLOR: '1', PY_COLORS: '1' };
      cmd = interp.python;
      args = pytest;
      if (coverage) {
        const tool = await ensurePyTool(interp.python, { pkg: 'coverage', title: 'coverage.py' }, onOutput);
        env = toolEnv(env, tool);
        const data = path.join(tmp, '.coverage');
        args = ['-m', 'coverage', 'run', `--data-file=${data}`, `--source=${p.dir}`, '--omit=*/.venv/*,*/venv/*,*/site-packages/*', ...pytest.slice(0)];
        collect = async () => {
          const json = path.join(tmp, 'coverage.json');
          const r = await run(interp.python, ['-m', 'coverage', 'json', `--data-file=${data}`, '-o', json], { cwd: p.dir, env, timeout: 120000 });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'coverage json failed');
          return F.parseCoveragePy(await fsp.readFile(json, 'utf8'), p.dir);
        };
      }
      parse = (xml) => parseJUnit(xml);
    }
    onOutput(`\x1b[90m$ ${path.basename(cmd)} ${args.join(' ')}\x1b[0m\n`);
    this.proc = stream(cmd, args, { cwd: p.dir, env, onData: onOutput });
    const code = await this.proc.done;
    this.proc = null;
    let results = [];
    try {
      results = parse(await fsp.readFile(resultFile, 'utf8'));
    } catch {
      results = [];
    }
    for (const r of results) if (p.kind === 'python' && r.file && !path.isAbsolute(r.file)) r.file = path.join(p.dir, r.file);
    let cov = null;
    if (collect && code !== -2) {
      try {
        cov = await collect();
      } catch (err) {
        onOutput(`\x1b[33mCoverage: ${err.message}\x1b[0m\n`);
      }
    }
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return { code, results, coverage: cov, cancelled: code === -2 };
  }

  /**
   * Debug launch spec for one test (see debug/launch.js). .NET tests run under `dotnet test` with
   * VSTEST_HOST_DEBUG, and the debugger attaches to the test host it starts.
   */
  debugSpec(projectId, testId) {
    const p = this.project(projectId);
    if (p.kind === 'python') {
      const interp = this.interpreter(p);
      return { kind: 'python', python: interp.python, interp, cwd: p.dir, module: 'pytest', args: ['-p', 'no:cacheprovider', '-q', testId] };
    }
    if (p.kind === 'node') {
      const { file, name } = F.splitJsId(testId);
      return F.jsDebugSpec(p.framework, { dir: p.dir, file, name });
    }
    return { kind: 'dotnet-test', project: p.path, filter: `FullyQualifiedName=${testId}`, cwd: p.dir };
  }

  /** Tests in one JavaScript test file (editor gutter icons). */
  scanFile(file, text) {
    // Relative to the project: a project inside a folder named "test" is not all tests.
    if (!F.isJsTestFile(this.ctx.root ? path.relative(this.ctx.root, file) : file)) return [];
    let src = text;
    if (src == null) {
      try {
        src = fs.readFileSync(file, 'utf8');
      } catch {
        return [];
      }
    }
    return F.scanJsTests(src);
  }

  cancel() {
    if (this.proc) this.proc.kill();
  }
}

/** First file named `name` under `dir` (coverage reports land in generated subfolders). */
function findFile(dir, name, depth = 0) {
  if (depth > 5) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && e.name === name) return path.join(dir, e.name);
  for (const e of entries) if (e.isDirectory()) {
    const f = findFile(path.join(dir, e.name), name, depth + 1);
    if (f) return f;
  }
  return null;
}

module.exports = { TestService, parseTrx, parseJUnit };
