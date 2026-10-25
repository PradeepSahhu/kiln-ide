'use strict';
// Spec: the debugger speaks the Debug Adapter Protocol to debugpy (Python) and netcoredbg (.NET), and the
// V8 inspector protocol to Node. Run configurations map to launch specs; a session stops at breakpoints,
// exposes frames, scopes and variables, evaluates expressions, steps, accepts breakpoint changes while
// running, streams program output and reports when the program ends. Events reach the renderer on the
// 'debug:event' channel.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpdir, writeTree, fakeContext, has } = require('../helpers/fixtures');

// Debug adapters downloaded by the tests are cached between runs.
process.env.KILN_TOOLS_DIR = process.env.KILN_TOOLS_DIR || path.join(os.tmpdir(), 'kiln-test-tools');

const { encode, MessageReader } = require('../../src/main/services/debug/dap');
const { launchSpec, launchSpecForFile } = require('../../src/main/services/debug/launch');
const { DebugService } = require('../../src/main/services/debug');
const adapters = require('../../src/main/services/debug/adapters');

const debugEvents = (ctx) => ctx.events.filter((e) => e.channel === 'debug:event').map((e) => e.payload);

/** Wait for the next debug event (after index `after`) matching `pred`. */
async function nextEvent(ctx, pred, { after = 0, timeout = 60000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const list = debugEvents(ctx);
    for (let i = after; i < list.length; i++) if (pred(list[i])) return { event: list[i], index: i + 1 };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for a debug event; got: ${JSON.stringify(debugEvents(ctx).slice(after).map((e) => e.type))}`);
}

const outputOf = (ctx) => debugEvents(ctx).filter((e) => e.type === 'output').map((e) => e.text).join('');

test('DAP messages are framed with a byte-accurate Content-Length and reassembled from chunks', () => {
  const msg = { seq: 1, type: 'request', command: 'evaluate', arguments: { expression: '"héllo — ✓"' } };
  const buf = encode(msg);
  const text = buf.toString('utf8');
  const header = /^Content-Length: (\d+)\r\n\r\n/.exec(text);
  assert.ok(header, 'header present');
  assert.equal(Number(header[1]), Buffer.byteLength(JSON.stringify(msg)));

  const second = encode({ seq: 2, type: 'event', event: 'stopped', body: { reason: 'breakpoint' } });
  const all = Buffer.concat([buf, second]);
  const reader = new MessageReader();
  const got = [];
  // Split inside the header, inside the multi-byte body, and deliver the rest together.
  for (const piece of [all.subarray(0, 7), all.subarray(7, header[0].length + 20), all.subarray(header[0].length + 20)]) got.push(...reader.push(piece));
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], msg);
  assert.equal(got[1].event, 'stopped');
});

test('run configurations map to launch specs', () => {
  const root = writeTree(tmpdir(), {
    'main.py': 'print(1)\n',
    'app/__init__.py': '',
    'app/main.py': 'print(2)\n',
    'tools/x.py': 'print(3)\n',
    'web/package.json': JSON.stringify({ scripts: { start: 'node src/index.js --port 3000', build: 'tsc -p .' } }),
    'web/src/index.js': 'console.log(1)\n',
    'Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
  });
  const interp = { python: '/usr/bin/python3' };
  const opts = { root, interpreterFor: () => interp };

  const file = launchSpec({ python: true, pyRoot: root, args: ['main.py', '--flag'], cwd: root }, opts);
  assert.equal(file.kind, 'python');
  assert.equal(file.program, path.join(root, 'main.py'));
  assert.deepEqual(file.args, ['--flag']);
  assert.equal(file.python, '/usr/bin/python3');
  assert.equal(file.cwd, root);

  const mod = launchSpec({ python: true, pyRoot: root, args: ['-m', 'app.main'], cwd: root }, opts);
  assert.equal(mod.module, 'app.main');
  assert.equal(mod.program, undefined);

  // --reload would move the server into a child process the debugger does not follow.
  const uv = launchSpec({ python: true, pyRoot: root, args: ['-m', 'uvicorn', 'app:api', '--reload'], cwd: root }, opts);
  assert.equal(uv.module, 'uvicorn');
  assert.deepEqual(uv.args, ['app:api']);

  const custom = launchSpec({ custom: true, usePython: true, commandLine: 'python tools/x.py a', cwd: '' }, opts);
  assert.equal(custom.kind, 'python');
  assert.equal(custom.program, path.join(root, 'tools', 'x.py'));
  assert.deepEqual(custom.args, ['a']);

  const proj = path.join(root, 'Api', 'Api.csproj');
  const dn = launchSpec({ command: 'dotnet', args: ['run', '--project', proj], cwd: path.dirname(proj) }, opts);
  assert.equal(dn.kind, 'dotnet');
  assert.equal(dn.project, proj);
  assert.throws(() => launchSpec({ command: 'dotnet', args: ['test', proj], cwd: root }, opts), /test/i);

  const web = path.join(root, 'web');
  const node = launchSpec({ command: 'npm', args: ['run', 'start'], cwd: web }, opts);
  assert.equal(node.kind, 'node');
  assert.equal(node.program, path.join(web, 'src', 'index.js'));
  assert.deepEqual(node.args, ['--port', '3000']);
  assert.throws(() => launchSpec({ command: 'npm', args: ['run', 'build'], cwd: web }, opts), /cannot be debugged/i);

  assert.equal(launchSpecForFile(path.join(root, 'main.py'), opts).program, path.join(root, 'main.py'));
  assert.equal(launchSpecForFile(path.join(web, 'src', 'index.js'), opts).kind, 'node');
  assert.throws(() => launchSpecForFile(path.join(root, 'Api', 'Program.cs'), opts), /cannot be debugged/i);
});

test('Node: stops at a breakpoint, inspects, steps, moves breakpoints and finishes', { timeout: 60000 }, async () => {
  const root = writeTree(tmpdir(), {
    'package.json': JSON.stringify({ name: 'dbg', scripts: { start: 'node index.js' } }),
    'index.js': 'function greet(name) {\n  const message = `hi ${name}`;\n  return message;\n}\nconst out = greet("kiln");\nconsole.log(out);\n',
  });
  const file = path.join(root, 'index.js');
  const ctx = fakeContext(root);
  const dbg = new DebugService(ctx);
  await dbg.start({ id: 'node:.:start', name: 'npm run start', command: 'npm', args: ['run', 'start'], cwd: root }, { breakpoints: { [file]: [{ line: 2 }] } });

  let { event: stopped, index } = await nextEvent(ctx, (e) => e.type === 'stopped');
  assert.equal(stopped.frames[0].file, file);
  assert.equal(stopped.frames[0].line, 2);
  assert.equal(stopped.frames[0].name, 'greet');
  assert.equal(stopped.reason, 'breakpoint');

  assert.equal((await dbg.evaluate('name.length', stopped.frames[0].id)).result, '4');

  await dbg.next(stopped.threadId);
  ({ event: stopped, index } = await nextEvent(ctx, (e) => e.type === 'stopped', { after: index }));
  assert.equal(stopped.frames[0].line, 3);
  const scopes = await dbg.scopes(stopped.frames[0].id);
  const locals = await dbg.variables(scopes[0].variablesReference);
  assert.match(locals.find((v) => v.name === 'message').value, /hi kiln/);

  // Breakpoints can change while the program runs: drop line 2, add line 6.
  await dbg.setBreakpoints(file, [{ line: 6 }]);
  await dbg.continue(stopped.threadId);
  ({ event: stopped, index } = await nextEvent(ctx, (e) => e.type === 'stopped', { after: index }));
  assert.equal(stopped.frames[0].line, 6);

  await dbg.continue(stopped.threadId);
  const { event: end } = await nextEvent(ctx, (e) => e.type === 'terminated', { after: index });
  assert.equal(end.exitCode, 0);
  assert.match(outputOf(ctx), /hi kiln/);
});

test('Node: stopping a session ends the program', { timeout: 30000 }, async () => {
  const root = writeTree(tmpdir(), { 'loop.js': 'setInterval(() => {}, 1000);\nconsole.log("looping");\n' });
  const ctx = fakeContext(root);
  const dbg = new DebugService(ctx);
  await dbg.startFile(path.join(root, 'loop.js'), {});
  await nextEvent(ctx, (e) => e.type === 'output' && /looping/.test(e.text));
  await dbg.stop();
  await nextEvent(ctx, (e) => e.type === 'terminated', { timeout: 10000 });
});

let debugpyReady = null;
async function pythonDebugging() {
  if (!has('python3')) return false;
  if (debugpyReady === null) {
    debugpyReady = await adapters
      .ensureDebugpy(execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim(), () => {})
      .then(() => true)
      .catch(() => false);
  }
  return debugpyReady;
}

test('Python: stops at a breakpoint, steps, reads locals, evaluates and finishes', { timeout: 120000 }, async (t) => {
  if (!(await pythonDebugging())) return t.skip('python3 with debugpy is not available');
  const root = writeTree(tmpdir(), { 'calc.py': 'def add(a, b):\n    total = a + b\n    return total\n\n\nresult = add(2, 40)\nprint("result is", result)\n' });
  const file = path.join(root, 'calc.py');
  const ctx = fakeContext(root);
  const dbg = new DebugService(ctx);
  await dbg.start({ id: 'py:file:.:calc.py', name: 'calc.py', python: true, pyRoot: root, args: ['calc.py'], cwd: root }, { breakpoints: { [file]: [{ line: 2 }] } });

  let { event: stopped, index } = await nextEvent(ctx, (e) => e.type === 'stopped');
  assert.equal(stopped.frames[0].file, file);
  assert.equal(stopped.frames[0].line, 2);
  assert.equal(stopped.frames[0].name, 'add');

  await dbg.next(stopped.threadId);
  ({ event: stopped, index } = await nextEvent(ctx, (e) => e.type === 'stopped', { after: index }));
  assert.equal(stopped.frames[0].line, 3);
  const scopes = await dbg.scopes(stopped.frames[0].id);
  const locals = await dbg.variables(scopes[0].variablesReference);
  assert.equal(locals.find((v) => v.name === 'total').value, '42');
  assert.equal((await dbg.evaluate('a * b', stopped.frames[0].id)).result, '80');

  await dbg.continue(stopped.threadId);
  await nextEvent(ctx, (e) => e.type === 'terminated', { after: index });
  assert.match(outputOf(ctx), /result is 42/);
});

test('.NET: builds, stops at a breakpoint, reads locals, evaluates and finishes', { timeout: 400000 }, async (t) => {
  if (!has('dotnet')) return t.skip('dotnet is not installed');
  try {
    await adapters.ensureNetcoredbg(() => {});
  } catch (err) {
    return t.skip(`netcoredbg is not available: ${err.message}`);
  }
  const root = tmpdir();
  execFileSync('dotnet', ['new', 'console', '-o', 'App', '--force'], { cwd: root, stdio: 'ignore', env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
  const program = path.join(root, 'App', 'Program.cs');
  writeTree(root, { 'App/Program.cs': 'int Add(int a, int b)\n{\n    var total = a + b;\n    return total;\n}\nvar result = Add(2, 40);\nConsole.WriteLine($"result is {result}");\n' });
  const ctx = fakeContext(root);
  const dbg = new DebugService(ctx);
  const proj = path.join(root, 'App', 'App.csproj');
  await dbg.start({ id: 'dotnet:run:App', name: 'App', command: 'dotnet', args: ['run', '--project', proj], cwd: path.dirname(proj) }, { breakpoints: { [program]: [{ line: 3 }] } });

  let { event: stopped, index } = await nextEvent(ctx, (e) => e.type === 'stopped', { timeout: 300000 });
  assert.equal(stopped.frames[0].file, program);
  assert.equal(stopped.frames[0].line, 3);

  await dbg.next(stopped.threadId);
  ({ event: stopped, index } = await nextEvent(ctx, (e) => e.type === 'stopped', { after: index }));
  assert.equal(stopped.frames[0].line, 4);
  const scopes = await dbg.scopes(stopped.frames[0].id);
  const locals = await dbg.variables(scopes[0].variablesReference);
  assert.equal(locals.find((v) => v.name === 'total').value, '42');
  assert.equal((await dbg.evaluate('a * b', stopped.frames[0].id)).result, '80');

  await dbg.continue(stopped.threadId);
  await nextEvent(ctx, (e) => e.type === 'terminated', { after: index, timeout: 60000 });
  assert.match(outputOf(ctx), /result is 42/);
});
