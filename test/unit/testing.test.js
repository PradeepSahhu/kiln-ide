'use strict';
// Spec: the test runner covers .NET (xUnit/NUnit/MSTest), pytest and JavaScript (node:test, Jest, Vitest,
// Mocha). JavaScript tests are found in the code (test()/it() inside describe()), run singly or all,
// and every runner can collect code coverage, normalized to covered / uncovered lines per file
// (coverage.py JSON, Cobertura from coverlet, lcov from node, Jest and Vitest).
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpdir, writeTree, has, fakeContext } = require('../helpers/fixtures');

process.env.KILN_TOOLS_DIR = process.env.KILN_TOOLS_DIR || path.join(os.tmpdir(), 'kiln-test-tools');
const F = require('../../src/main/services/test-frameworks');
const { TestService } = require('../../src/main/services/tests');

test('the JavaScript test framework comes from the package', () => {
  assert.equal(F.jsFramework({ deps: ['jest'], scripts: { test: 'jest' } }), 'jest');
  assert.equal(F.jsFramework({ deps: ['vitest', 'vite'], scripts: {} }), 'vitest');
  assert.equal(F.jsFramework({ deps: ['mocha', 'chai'], scripts: { test: 'mocha' } }), 'mocha');
  assert.equal(F.jsFramework({ deps: [], scripts: { test: 'node --test' } }), 'node');
  assert.equal(F.jsFramework({ deps: [], scripts: {} }, { hasTestFiles: true }), 'node');
  assert.equal(F.jsFramework({ deps: [], scripts: { start: 'node index.js' } }), null);
});

test('JavaScript tests are found in the code, with their describe blocks', () => {
  const src = `const { describe, test, it } = require('node:test');

describe('cart', () => {
  test('adds items', () => {});
  describe("totals", () => {
    it(\`applies tax\`, async () => {});
  });
});

test('top level', () => {});
test.skip('skipped one', () => {});
// test('in a comment', () => {});
`;
  const tests = F.scanJsTests(src);
  assert.deepEqual(tests.map((t) => [t.name, t.line]), [['cart adds items', 4], ['cart totals applies tax', 6], ['top level', 10], ['skipped one', 11]]);
  assert.equal(tests[1].title, 'applies tax');
  assert.ok(F.isJsTestFile('src/cart.test.js') && F.isJsTestFile('test/cart.mjs') && F.isJsTestFile('__tests__/a.ts') && F.isJsTestFile('src/a.spec.tsx'));
  assert.ok(!F.isJsTestFile('src/cart.js'));
});

test('Jest JSON and node / Vitest / Mocha JUnit results become test results', () => {
  const jest = { testResults: [{ name: '/p/cart.test.js', assertionResults: [{ ancestorTitles: ['cart'], title: 'adds', fullName: 'cart adds', status: 'passed', duration: 4, failureMessages: [] }, { ancestorTitles: [], title: 'breaks', fullName: 'breaks', status: 'failed', duration: 2, failureMessages: ['Error: expected 1\n    at x (/p/cart.test.js:9:3)'], location: { line: 9, column: 3 } }] }] };
  const r = F.parseJestJson(JSON.stringify(jest));
  assert.deepEqual(r.map((x) => [x.id, x.outcome, x.durationMs]), [['/p/cart.test.js::cart adds', 'passed', 4], ['/p/cart.test.js::breaks', 'failed', 2]]);
  assert.match(r[1].message, /expected 1/);

  const junit = `<?xml version="1.0"?><testsuites><testsuite name="cart"><testcase name="adds items" time="0.001" classname="test" file="/p/cart.test.js"/><testcase name="breaks" time="0.002" classname="test" file="/p/cart.test.js"><failure message="nope" type="testCodeFailure">AssertionError: nope</failure></testcase></testsuite></testsuites>`;
  const j = F.parseJsJUnit(junit, '/p');
  assert.deepEqual(j.map((x) => [x.name, x.outcome, x.file]), [['cart adds items', 'passed', '/p/cart.test.js'], ['cart breaks', 'failed', '/p/cart.test.js']]);
  assert.equal(j[1].message, 'nope');
});

test('coverage reports become covered / uncovered lines per file', () => {
  const lcov = 'TN:\nSF:/p/src/cart.js\nDA:1,1\nDA:2,0\nDA:3,4\nLF:3\nLH:2\nend_of_record\nSF:src/tax.js\nDA:5,0\nend_of_record\n';
  const a = F.parseLcov(lcov, '/p');
  assert.deepEqual(a.files['/p/src/cart.js'], { covered: [1, 3], uncovered: [2], percent: 67 });
  assert.deepEqual(a.files['/p/src/tax.js'], { covered: [], uncovered: [5], percent: 0 });
  assert.deepEqual(a.summary, { lines: 4, covered: 2, percent: 50 });

  const cob = `<coverage><sources><source>/p/src/</source></sources><packages><package><classes>
    <class name="Calc" filename="Calc.cs"><lines><line number="5" hits="2"/><line number="6" hits="0"/></lines></class>
    <class name="Calc+Inner" filename="Calc.cs"><lines><line number="9" hits="1"/></lines></class>
  </classes></package></packages></coverage>`;
  assert.deepEqual(F.parseCobertura(cob, '/p').files['/p/src/Calc.cs'], { covered: [5, 9], uncovered: [6], percent: 67 });

  const py = { files: { 'app/main.py': { executed_lines: [1, 2, 4], missing_lines: [3] } } };
  assert.deepEqual(F.parseCoveragePy(JSON.stringify(py), '/p').files['/p/app/main.py'], { covered: [1, 2, 4], uncovered: [3], percent: 75 });
});

const node = process.execPath;
test('node:test projects: discover, run one test or all, and collect coverage', { timeout: 120000 }, async () => {
  const root = writeTree(tmpdir('kiln-jstest-'), {
    'package.json': JSON.stringify({ name: 'js-tests', scripts: { test: 'node --test' } }),
    'cart.js': 'function total(xs) {\n  if (xs.length === 0) {\n    return 0;\n  }\n  return xs.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { total };\n',
    'test/cart.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { total } = require('../cart');\n\ntest('sums', () => {\n  assert.equal(total([1, 2]), 3);\n});\n\ntest('fails on purpose', () => {\n  assert.equal(total([1]), 2);\n});\n",
  });
  const svc = new TestService(fakeContext(root, { detection: { node: { roots: [{ dir: root, name: 'js-tests', deps: [], scripts: { test: 'node --test' }, packageManager: 'npm' }] } } }));
  const [p] = svc.projects();
  assert.equal(p.kind, 'node');
  const found = await svc.discover(p.id);
  assert.deepEqual(found.tests.map((t) => t.name), ['sums', 'fails on purpose']);
  const all = await svc.runTests(p.id, { coverage: true });
  assert.deepEqual(all.results.map((r) => [r.name, r.outcome]), [['sums', 'passed'], ['fails on purpose', 'failed']]);
  const cart = all.coverage.files[path.join(root, 'cart.js')];
  assert.ok(cart, 'coverage of cart.js');
  assert.ok(cart.covered.includes(5) && cart.uncovered.includes(3), `line 5 covered, line 3 not (${JSON.stringify(cart)})`);
  const one = await svc.runTests(p.id, { filter: [found.tests[0].id] });
  assert.deepEqual(one.results.map((r) => [r.name, r.outcome]), [['sums', 'passed']]);
});

const python = has('python3') ? 'python3' : null;
test('pytest with coverage (coverage.py installed into the Kiln tools folder)', { skip: !python && 'no python3', timeout: 300000 }, async (t) => {
  const { run } = require('../../src/main/util/proc');
  if ((await run(python, ['-m', 'pytest', '--version'])).code !== 0) return t.skip('pytest is not installed');
  const root = writeTree(tmpdir('kiln-pytest-'), {
    'calc.py': 'def add(a, b):\n    return a + b\n\n\ndef unused():\n    return 1\n',
    'tests/test_calc.py': 'from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n',
    'pyproject.toml': '[tool.pytest.ini_options]\npythonpath = ["."]\n',
  });
  const ctx = fakeContext(root, { detection: { python: { roots: [{ dir: root, name: 'calc', hasTests: true }] } } });
  ctx.build.interpreters.set(root, { python: require('../../src/main/util/proc').which(python) });
  const svc = new TestService(ctx);
  const [p] = svc.projects();
  const r = await svc.runTests(p.id, { coverage: true });
  assert.deepEqual(r.results.map((x) => [x.name, x.outcome]), [['test_add', 'passed']]);
  const calc = r.coverage.files[path.join(root, 'calc.py')];
  assert.ok(calc && calc.covered.includes(2) && calc.uncovered.includes(6), JSON.stringify(calc));
  assert.ok(!fs.existsSync(path.join(root, '.coverage')), 'no coverage data file is left in the project');
});

test('Debug Test: each runner runs the test in the debugged process', () => {
  const node = F.jsDebugSpec('node', { dir: '/p', file: '/p/test/a.test.js', name: 'cart adds (1)' });
  assert.deepEqual([node.program, node.runtimeArgs], ['/p/test/a.test.js', ['--test-name-pattern=^cart adds \\(1\\)$']]);
  const jest = F.jsDebugSpec('jest', { dir: '/p', file: '/p/a.test.js', name: 'adds' });
  assert.equal(jest.program, path.join('/p', 'node_modules', 'jest', 'bin', 'jest.js'));
  assert.deepEqual(jest.args, ['--runInBand', '--ci', '--watchAll=false', '/p/a.test.js', '-t', '^adds$']);
  assert.equal(F.jsDebugSpec('mocha', { dir: '/p', file: '/p/a.js', name: 'x' }).program, path.join('/p', 'node_modules', 'mocha', 'bin', '_mocha'));
  assert.throws(() => F.jsDebugSpec('vitest', { dir: '/p', file: '/p/a.test.ts', name: 'x' }), /worker threads/);
  assert.deepEqual(F.splitJsId('/p/a.test.js::outer inner'), { file: '/p/a.test.js', name: 'outer inner' });

  const root = tmpdir('kiln-dbgspec-');
  const svc = new TestService(fakeContext(root, { detection: { dotnet: { projects: [{ isTest: true, path: path.join(root, 'T.csproj'), name: 'T', dir: root }] }, python: { roots: [{ dir: root, name: 'py', hasTests: true }] } } }));
  svc.ctx.build.interpreters.set(root, { python: '/usr/bin/python3' });
  assert.deepEqual(svc.debugSpec(`dotnet:${path.join(root, 'T.csproj')}`, 'T.Tests.Adds'), { kind: 'dotnet-test', project: path.join(root, 'T.csproj'), filter: 'FullyQualifiedName=T.Tests.Adds', cwd: root });
  const py = svc.debugSpec(`py:${root}`, 'tests/test_a.py::test_x');
  assert.deepEqual([py.kind, py.module, py.args.at(-1), py.cwd], ['python', 'pytest', 'tests/test_a.py::test_x', root]);
  // Gutter icons: only files that are tests relative to the project (a project inside a "test" folder is not all tests).
  writeTree(root, { 'src/cart.js': "test('not a test file', () => {});\n", 'src/cart.test.js': "test('real', () => {});\n" });
  assert.deepEqual(svc.scanFile(path.join(root, 'src/cart.js')), []);
  assert.deepEqual(svc.scanFile(path.join(root, 'src/cart.test.js')).map((t) => t.name), ['real']);
});
