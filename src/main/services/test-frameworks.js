'use strict';
// JavaScript test frameworks (node:test, Jest, Vitest, Mocha): which one a package uses, finding tests in
// the code, the command that runs them (one, several or all; with coverage), and their results.
// Coverage reports of every runner (lcov, Cobertura, coverage.py JSON) are normalized to
// { files: { [absPath]: { covered: [lines], uncovered: [lines], percent } }, summary }.
const fs = require('fs');
const path = require('path');

/** 'jest' | 'vitest' | 'mocha' | 'node' | null for a detected Node package. */
function jsFramework(pkg, { hasTestFiles = false } = {}) {
  const deps = new Set(pkg.deps || []);
  const script = (pkg.scripts && pkg.scripts.test) || '';
  if (deps.has('vitest') || /\bvitest\b/.test(script)) return 'vitest';
  if (deps.has('jest') || /\bjest\b/.test(script)) return 'jest';
  if (deps.has('mocha') || /\bmocha\b/.test(script)) return 'mocha';
  if (/node\s+(?:[^|&;]*\s)?--test\b/.test(script) || hasTestFiles) return 'node';
  return null;
}

const TEST_FILE = /(?:^|[\\/])(?:[^\\/]+\.(?:test|spec)\.[cm]?[jt]sx?|(?:test|tests|__tests__)[\\/].+\.[cm]?[jt]sx?)$/;
const isJsTestFile = (rel) => TEST_FILE.test(rel) && !/node_modules/.test(rel);

function findJsTestFiles(dir, limit = 400) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.venv']);
  const walk = (d, depth) => {
    if (depth > 8 || out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith('.')) walk(p, depth + 1);
      } else if (isJsTestFile(path.relative(dir, p))) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort();
}

/**
 * Tests in a JavaScript file: test()/it() (and .only/.skip/.todo) inside describe()/suite() blocks.
 * [{ name: 'outer inner title', title, line }]; comments and strings are skipped.
 */
function scanJsTests(src) {
  const tests = [];
  const stack = []; // { name, depth }
  let depth = 0;
  let line = 1;
  const re = /\b(describe|suite|context|test|it)(?:\.(?:only|skip|todo|each\([^)]*\)))?\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/y;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') {
      line++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      i--;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end < 0 ? src.length : end + 2);
      line += (body.match(/\n/g) || []).length;
      i = (end < 0 ? src.length : end + 2) - 1;
      continue;
    }
    if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') {
      depth--;
      while (stack.length && stack[stack.length - 1].depth > depth) stack.pop();
    } else if (/[A-Za-z]/.test(c) && !/[\w$.]/.test(src[i - 1] || '')) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (m) {
        const title = m[3].replace(/\\(.)/g, '$1');
        const full = [...stack.map((s) => s.name), title].join(' ');
        if (m[1] === 'describe' || m[1] === 'suite' || m[1] === 'context') stack.push({ name: title, depth: depth + 1 });
        else tests.push({ name: full, title, line });
        // continue after the opening "(" so the depth count sees it
        const open = src.indexOf('(', i);
        line += (src.slice(i, open).match(/\n/g) || []).length;
        i = open - 1;
      }
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n') line++;
        j++;
      }
      i = j;
    }
  }
  return tests;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How to run tests of a framework: { cmd: 'node' | relative bin, args, resultFile kind }. `files` and
 * `names` narrow the run; `coverageDir` collects lcov there.
 */
function jsCommand(framework, { dir, node = 'node', files = [], names = [], resultFile, coverageDir }) {
  const bin = (rel) => path.join(dir, 'node_modules', rel);
  const pattern = names.length ? `^(?:${names.map(escapeRe).join('|')})$` : null;
  if (framework === 'node') {
    const args = ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${resultFile}`];
    if (coverageDir) args.push('--experimental-test-coverage', '--test-reporter=lcov', `--test-reporter-destination=${path.join(coverageDir, 'lcov.info')}`);
    if (pattern) args.push(`--test-name-pattern=${pattern}`);
    return { cmd: node, args: [...args, ...files], results: 'junit' };
  }
  if (framework === 'jest') {
    const args = [bin('jest/bin/jest.js'), '--ci', '--json', `--outputFile=${resultFile}`];
    if (coverageDir) args.push('--coverage', '--coverageReporters=lcov', `--coverageDirectory=${coverageDir}`);
    if (pattern) args.push('-t', pattern);
    return { cmd: node, args: [...args, ...files], results: 'jest' };
  }
  if (framework === 'vitest') {
    const args = [bin('vitest/vitest.mjs'), 'run', '--reporter=default', '--reporter=junit', `--outputFile.junit=${resultFile}`];
    if (coverageDir) args.push('--coverage.enabled', '--coverage.reporter=lcov', `--coverage.reportsDirectory=${coverageDir}`);
    if (pattern) args.push('-t', pattern);
    return { cmd: node, args: [...args, ...files], results: 'junit' };
  }
  if (framework === 'mocha') {
    const args = [bin('mocha/bin/mocha.js'), '--reporter', 'xunit', '--reporter-option', `output=${resultFile}`];
    if (pattern) args.push('-g', pattern);
    return { cmd: node, args: [...args, ...files], results: 'junit', noCoverage: !!coverageDir };
  }
  throw new Error(`Unknown test framework ${framework}`);
}

/**
 * Debug launch spec for one JavaScript test (see debug/launch.js): the runner runs in the debugged
 * process itself (Jest --runInBand, Mocha's _mocha, a node:test file run directly), so breakpoints in
 * the test and the code under test are hit. Vitest runs tests in workers the debugger does not follow.
 */
function jsDebugSpec(framework, { dir, file, name }) {
  const pattern = `^${escapeRe(name)}$`;
  const bin = (rel) => path.join(dir, 'node_modules', rel);
  const spec = { kind: 'node', args: [], runtimeArgs: [], env: { CI: '1' }, cwd: dir };
  if (framework === 'node') return { ...spec, program: file, runtimeArgs: [`--test-name-pattern=${pattern}`] };
  if (framework === 'jest') return { ...spec, program: bin('jest/bin/jest.js'), args: ['--runInBand', '--ci', '--watchAll=false', file, '-t', pattern] };
  if (framework === 'mocha') return { ...spec, program: bin('mocha/bin/_mocha'), args: [file, '-g', pattern] };
  if (framework === 'vitest') throw new Error('Debugging Vitest tests is not supported: Vitest runs them in worker threads. Run the test instead, or start Vitest with --inspect-brk.');
  throw new Error(`Unknown test framework ${framework}`);
}

/** "file::name" test ids of JavaScript tests. */
function splitJsId(id) {
  const i = id.indexOf('::');
  return i < 0 ? { file: id, name: '' } : { file: id.slice(0, i), name: id.slice(i + 2) };
}

// ------------------------------------------------------------- results

function decode(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) out[m[1]] = decode(m[2]);
  return out;
}

function parseJestJson(text) {
  const data = JSON.parse(text);
  const out = [];
  for (const file of data.testResults || []) {
    for (const a of file.assertionResults || []) {
      const name = a.fullName || [...(a.ancestorTitles || []), a.title].join(' ');
      const failure = (a.failureMessages || []).join('\n');
      out.push({
        id: `${file.name}::${name}`,
        name,
        file: file.name,
        line: a.location ? a.location.line : null,
        outcome: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped',
        durationMs: a.duration != null ? Math.round(a.duration) : null,
        message: failure.split('\n')[0].replace(/\x1b\[[0-9;]*m/g, ''),
        stack: failure.replace(/\x1b\[[0-9;]*m/g, ''),
        output: '',
      });
    }
  }
  return out;
}

/** JUnit XML from node --test, Vitest or Mocha (xunit): suites give the describe names. */
function parseJsJUnit(xml, dir) {
  const out = [];
  const suiteStack = [];
  const re = /<testsuite\b([^>]*?)(\/?)>|<\/testsuite>|<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith('</testsuite')) {
      suiteStack.pop();
      continue;
    }
    if (m[0].startsWith('<testsuite')) {
      if (!m[2]) suiteStack.push(attrs(m[1]).name || '');
      continue;
    }
    const a = attrs(m[3]);
    const body = m[5] || '';
    const failure = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/.exec(body);
    const skipped = /<skipped\b/.test(body);
    const fa = failure ? attrs(failure[2] || failure[5] || '') : {};
    let file = a.file || '';
    if (file && !path.isAbsolute(file)) file = path.join(dir, file);
    // Vitest names suites after the file; node and Mocha after describe blocks.
    const suites = suiteStack.filter((s) => s && !/\.[cm]?[jt]sx?$/.test(s) && s !== 'Mocha Tests');
    const name = [...suites, a.name].join(' ');
    out.push({
      id: `${file}::${name}`,
      name,
      file,
      line: a.line ? +a.line : null,
      outcome: failure ? 'failed' : skipped ? 'skipped' : 'passed',
      durationMs: a.time ? Math.round(+a.time * 1000) : null,
      message: fa.message || decode(failure ? failure[3] : '').split('\n')[0],
      stack: failure ? decode(failure[3] || '') : '',
      output: decode((/<system-out>([\s\S]*?)<\/system-out>/.exec(body) || [])[1] || ''),
    });
  }
  return out;
}

// ------------------------------------------------------------- coverage

function summarize(files) {
  let lines = 0;
  let covered = 0;
  for (const f of Object.values(files)) {
    f.covered.sort((a, b) => a - b);
    f.uncovered.sort((a, b) => a - b);
    const n = f.covered.length + f.uncovered.length;
    f.percent = n ? Math.round((f.covered.length / n) * 100) : 100;
    lines += n;
    covered += f.covered.length;
  }
  return { files, summary: { lines, covered, percent: lines ? Math.round((covered / lines) * 100) : 100 } };
}

function addLine(files, file, line, hit) {
  const f = files[file] || (files[file] = { covered: [], uncovered: [] });
  const ci = f.covered.indexOf(line);
  const ui = f.uncovered.indexOf(line);
  if (hit) {
    if (ui >= 0) f.uncovered.splice(ui, 1);
    if (ci < 0) f.covered.push(line);
  } else if (ci < 0 && ui < 0) f.uncovered.push(line);
}

function parseLcov(text, dir) {
  const files = {};
  let file = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('SF:')) {
      file = l.slice(3);
      if (!path.isAbsolute(file)) file = path.join(dir, file);
      files[file] = files[file] || { covered: [], uncovered: [] };
    } else if (l.startsWith('DA:') && file) {
      const [line, hits] = l.slice(3).split(',');
      addLine(files, file, +line, +hits > 0);
    } else if (l === 'end_of_record') file = null;
  }
  return summarize(files);
}

function parseCobertura(xml, dir) {
  const files = {};
  const sources = [...xml.matchAll(/<source>([\s\S]*?)<\/source>/g)].map((m) => decode(m[1]).trim());
  for (const m of xml.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
    const a = attrs(m[1]);
    let file = a.filename || '';
    if (!path.isAbsolute(file)) {
      const base = sources.find((s) => fs.existsSync(path.join(s, file))) || sources[0] || dir;
      file = path.join(base, file);
    }
    const lines = (/<lines>([\s\S]*?)<\/lines>/.exec(m[2]) || [])[1] || '';
    for (const l of lines.matchAll(/<line\b([^>]*)\/?>/g)) {
      const la = attrs(l[1]);
      addLine(files, path.normalize(file), +la.number, +la.hits > 0);
    }
  }
  return summarize(files);
}

function parseCoveragePy(text, dir) {
  const data = JSON.parse(text);
  const files = {};
  for (const [rel, f] of Object.entries(data.files || {})) {
    const file = path.isAbsolute(rel) ? rel : path.join(dir, rel);
    files[file] = { covered: [...(f.executed_lines || [])], uncovered: [...(f.missing_lines || [])] };
  }
  return summarize(files);
}

module.exports = { jsFramework, isJsTestFile, findJsTestFiles, scanJsTests, jsCommand, jsDebugSpec, splitJsId, parseJestJson, parseJsJUnit, parseLcov, parseCobertura, parseCoveragePy, summarize };
