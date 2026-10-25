'use strict';
// Spec: the AI features - inline completion, commit messages from the diff, Generate Documentation /
// Tests, review before commit, explain an exception - send Claude focused prompts and turn its answers
// into exactly the text to insert or the edit to apply. Through the Anthropic API they use the
// configured model (Claude Opus 5.5 by default) with refusal fallbacks; without an API key they go
// through Claude Code.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { gitRepo, git, fakeContext, tmpdir, writeTree } = require('../helpers/fixtures');
const AI = require('../../src/main/services/ai');
const { parseFrames, stackContext } = require('../../src/main/services/stack-context');
const { GitService } = require('../../src/main/services/git');

test('inline completions are cleaned to exactly the text to insert', () => {
  assert.equal(AI.cleanCompletion('```python\nreturn a + b\n```', { prefix: 'def add(a, b):\n    ', suffix: '\n' }), 'return a + b');
  assert.equal(AI.cleanCompletion('    total = sum(xs)', { prefix: 'def f(xs):\n    total = ', suffix: '\n' }), 'sum(xs)', 'a repeated line is dropped');
  assert.equal(AI.cleanCompletion('    return 1', { prefix: 'def f():\n    ', suffix: '\n' }), 'return 1', 'repeated indentation is dropped');
  assert.equal(AI.cleanCompletion('\n    return 1', { prefix: 'def f():', suffix: '\n' }), '\n    return 1', 'a completion on the next line keeps its newline');
  assert.equal(AI.cleanCompletion('total = sum(xs)', { prefix: 'x = 1\ntotal = ', suffix: '\n' }), 'sum(xs)', 'a repeated line start is dropped');
  assert.equal(AI.cleanCompletion('items.length)', { prefix: 'len(', suffix: ')\n' }), 'items.length', 'text the suffix already has is dropped');
  assert.equal(AI.cleanCompletion('', { prefix: 'x', suffix: '' }), '');
  const p = AI.completionPrompt({ file: 'a.py', language: 'python', prefix: 'def f(', suffix: '):' });
  assert.match(p, /<prefix>def f\(<\/prefix><suffix>\):<\/suffix>/);
});

test('commit messages: the prompt has the diff and the recent subjects; fences and labels are removed', () => {
  const p = AI.commitPrompt({ diff: '+x', recent: ['Fix the build', 'Add tests'], truncated: true });
  assert.match(p, /- Fix the build\n- Add tests/);
  assert.match(p, /only its beginning/);
  assert.equal(AI.cleanCommitMessage('```\nAdd the tax rate\n\nBody.\n```'), 'Add the tax rate\n\nBody.');
  assert.equal(AI.cleanCommitMessage('Commit message: Fix login'), 'Fix login');
});

test('review findings are normalized and sorted by severity', () => {
  const r = AI.normalizeFindings({ summary: 's', findings: [{ file: 'b/z.py', line: 0, severity: 'info', message: 'm' }, { file: 'a.py', line: 3, severity: 'error', message: 'bug' }] });
  assert.deepEqual(r.findings.map((f) => [f.severity, f.file, f.line]), [['error', 'a.py', 3], ['info', 'z.py', 1]]);
  assert.deepEqual(AI.REVIEW_SCHEMA.required, ['summary', 'findings']);
});

test('suggested test file locations follow the language conventions', () => {
  const root = tmpdir('kiln-ai-paths-');
  assert.equal(AI.suggestedTestPath(root, path.join(root, 'shop', 'cart.py'), 'python'), path.join('tests', 'test_cart.py'));
  assert.equal(AI.suggestedTestPath(root, path.join(root, 'src', 'cart.js'), 'node'), path.join('src', 'cart.test.js'));
  fs.mkdirSync(path.join(root, 'test'));
  assert.equal(AI.suggestedTestPath(root, path.join(root, 'src', 'cart.js'), 'node'), path.join('test', 'cart.test.js'));
  assert.equal(AI.suggestedTestPath(root, path.join(root, 'Shop', 'Cart.cs'), 'dotnet'), path.join('Shop.Tests', 'CartTests.cs'));
});

test('stack traces: frames of Python, Node.js, .NET and Java, with code from the project', () => {
  const root = writeTree(tmpdir('kiln-stack-'), { 'app/main.py': 'a\nb\ndef f():\n    raise ValueError("x")\n' });
  const py = `Traceback (most recent call last):\n  File "${root}/app/main.py", line 4, in f\n    raise ValueError("x")\n  File "/usr/lib/python3.12/json/__init__.py", line 10, in loads\nValueError: x`;
  const ctx = stackContext(py, { root });
  assert.deepEqual(ctx.frames.map((f) => [path.basename(f.file), f.line, f.fn]), [['main.py', 4, 'f'], ['__init__.py', 10, 'loads']]);
  assert.equal(ctx.excerpts.length, 1, 'only frames in the project are excerpted');
  assert.match(ctx.excerpts[0].code, /   4 > {5}raise ValueError/);
  assert.deepEqual(parseFrames('TypeError: x\n    at total (/app/price.js:4:11)\n    at /app/index.js:2:3').map((f) => [f.file, f.line, f.fn]), [['/app/price.js', 4, 'total'], ['/app/index.js', 2, '']]);
  assert.deepEqual(parseFrames('   at Shop.Cart.Total() in /src/Shop/Cart.cs:line 42').map((f) => [f.file, f.line, f.fn]), [['/src/Shop/Cart.cs', 42, 'Shop.Cart.Total']]);
  assert.deepEqual(parseFrames('\tat com.shop.Cart.total(Cart.java:42)').map((f) => [f.file, f.line]), [['Cart.java', 42]]);
});

test('through the Anthropic API: the configured model, effort, structured output and refusal fallbacks', async () => {
  const svc = new AI.AiService(fakeContext(tmpdir('kiln-ai-api-')));
  const calls = [];
  const reply = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
  svc.client = {
    messages: { create: async (p) => (calls.push({ beta: false, p }), reply('plain')) },
    beta: { messages: { create: async (p) => (calls.push({ beta: true, p }), reply(p.output_config.format ? '{"code":"x"}' : 'fallback-enabled')) } },
  };
  const key = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    assert.deepEqual(await svc.ask({ kind: 'x', system: 's', prompt: 'p' }), { text: 'fallback-enabled' });
    assert.equal(calls[0].p.model, 'claude-opus-5-5', 'Claude Opus 5.5 by default');
    assert.equal(calls[0].p.fallbacks, 'default');
    assert.deepEqual(calls[0].p.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(calls[0].p.output_config.effort, 'low');
    assert.ok(!('temperature' in calls[0].p) && !('thinking' in calls[0].p));
    assert.deepEqual(await svc.ask({ kind: 'x', system: 's', prompt: 'p', schema: { type: 'object' } }), { json: { code: 'x' } });
    assert.deepEqual(calls[1].p.output_config.format, { type: 'json_schema', schema: { type: 'object' } });
    await svc.ask({ kind: 'x', system: 's', prompt: 'p', model: 'claude-haiku-5-5' });
    assert.equal(calls[2].beta, false, 'no server-side fallback for Claude Haiku 5.5');
    svc.client.beta.messages.create = async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });
    await assert.rejects(() => svc.ask({ kind: 'x', system: 's', prompt: 'p' }), /declined.*cyber/);
  } finally {
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
  }
});

test('commit message and review use the diff of the selected files (stubbed answers)', async () => {
  const root = gitRepo({ 'a.txt': 'one\n' });
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'fresh\n');
  const ctx = fakeContext(root);
  ctx.git = new GitService(ctx);
  await ctx.git.init(root);
  const svc = new AI.AiService(ctx);
  const stub = path.join(tmpdir('kiln-ai-stub-'), 'stub.json');
  fs.writeFileSync(stub, JSON.stringify({ commitMessage: '```\nAdd two\n```', review: { summary: 'One issue', findings: [{ file: 'b/a.txt', line: 2, severity: 'warning', message: 'w', suggestion: 's' }] } }));
  process.env.KILN_AI_STUB = stub;
  try {
    const files = [{ path: 'a.txt', kind: 'modified' }, { path: 'new.txt', kind: 'untracked' }];
    const { diff } = await svc.diffOf(files);
    assert.match(diff, /\+two/);
    assert.match(diff, /\+\+\+ b\/new\.txt\n\+fresh/);
    assert.equal((await svc.commitMessage({ files })).message, 'Add two');
    const review = await svc.reviewChanges({ files });
    assert.equal(review.findings[0].file, 'a.txt');
    assert.equal(review.findings[0].abs, path.join(root, 'a.txt'));
    await assert.rejects(() => svc.commitMessage({ files: [] }), /Select the files/);
  } finally {
    delete process.env.KILN_AI_STUB;
  }
});
