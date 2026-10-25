'use strict';
// Spec: the knowledge graph is available to AI agents (Claude Code, Codex, Gemini CLI, Antigravity,
// Cursor, ...) as a skill (CLI) and an MCP server, and agents are told to use it first. Both read the
// project's graph from Kiln's app data (never from the repository) and refresh files changed since
// indexing, so answers stay correct when the IDE is closed. Installing is idempotent, keeps the
// user's existing agent configuration and can be undone.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { tmpdir, writeTree } = require('../helpers/fixtures');

const APP = path.resolve(__dirname, '../..');
const CLI = path.join(APP, 'src/agent-tools/kg-cli.js');
const MCP = path.join(APP, 'src/agent-tools/kg-mcp.js');
const USER_DATA = process.env.KILN_TEST_USERDATA;

const PROJECT = {
  'shop/__init__.py': '',
  'shop/config.py': 'TAX_RATE = 0.2\n',
  'shop/orders.py': 'from shop.config import TAX_RATE\n\npending = []\n\n\ndef validate(order_id, qty):\n    return bool(order_id) and qty > 0\n\n\ndef place_order(order_id, qty):\n    if validate(order_id, qty):\n        pending.append((order_id, qty * (1 + TAX_RATE)))\n        return True\n    return False\n',
  'shop/main.py': 'from shop.orders import place_order\n\n\ndef main():\n    place_order("A-1", 3)\n\n\nif __name__ == "__main__":\n    main()\n',
};

async function indexProject(root) {
  const { CodeIndex } = require('../../src/main/services/codeindex');
  const index = new CodeIndex({ send() {} });
  const files = Object.keys(PROJECT).filter((f) => /\.py$/.test(f));
  await index.open(root, files);
  await index.call('save', {});
  index.dispose();
}

function cli(args, cwd, env = {}) {
  const out = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, KILN_USER_DATA: USER_DATA, ...env } });
  return JSON.parse(out);
}

let root;
test.before(async () => {
  root = writeTree(tmpdir('kiln-kg-'), PROJECT);
  await indexProject(root);
});

test('CLI: overview, search, symbol details with callers, reads and writes', () => {
  const sub = path.join(root, 'shop');
  const ov = cli(['overview'], sub);
  assert.equal(ov.root, root, 'the project is found from a subfolder');
  assert.ok(ov.stats.files >= 3);
  assert.ok(ov.mostCalled.some((f) => f.name === 'validate'));

  const found = cli(['search', 'place'], root);
  assert.ok(found.results.some((r) => r.name === 'place_order' && r.file === 'shop/orders.py'));

  const sym = cli(['symbol', 'place_order'], root);
  const d = sym.matches[0];
  assert.equal(d.file, 'shop/orders.py');
  assert.ok(d.callers.some((c) => c.name === 'main'), 'main calls place_order');
  assert.ok(d.calls.some((c) => c.name === 'validate'));
  assert.ok(d.reads.some((v) => v.name === 'TAX_RATE'), 'reads the imported constant');
  assert.ok(d.reads.some((v) => v.name === 'pending'));
  assert.ok(d.locals.some((l) => l.name === 'qty' && l.kind === 'parameter'));
});

test('CLI: usages, impact, call path, file outline and variables', () => {
  const uses = cli(['usages', 'TAX_RATE'], root);
  assert.ok(uses.usages.some((u) => u.file === 'shop/orders.py' && u.in === 'place_order' && u.kind === 'read'));

  const impact = cli(['impact', 'validate'], root);
  const names = impact.levels.flatMap((l) => l.nodes.map((n) => n.name));
  assert.ok(names.includes('place_order') && names.includes('main'), `impact: ${names}`);

  const p = cli(['path', 'main', 'validate'], root);
  assert.deepEqual(p.path.map((n) => n.name), ['main', 'place_order', 'validate']);

  const outline = cli(['file', 'shop/orders.py'], root);
  assert.ok(outline.defs.some((x) => x.name === 'pending' && x.kind === 'variable'));
  assert.ok(outline.importedBy.includes('shop/main.py'));

  const v = cli(['variable', 'pending'], root);
  assert.ok(v.matches[0].readers.some((r) => r.name === 'place_order'));
});

test('CLI: files changed after indexing are re-read (the IDE does not need to be running)', () => {
  fs.appendFileSync(path.join(root, 'shop/orders.py'), '\n\ndef cancel_order(order_id):\n    pending.clear()\n    return validate(order_id, 1)\n');
  fs.writeFileSync(path.join(root, 'shop/refunds.py'), 'from shop.orders import cancel_order\n\n\ndef refund(order_id):\n    return cancel_order(order_id)\n');
  const sym = cli(['symbol', 'cancel_order'], root);
  assert.equal(sym.matches[0].file, 'shop/orders.py');
  assert.ok(sym.matches[0].callers.some((c) => c.name === 'refund'), 'a new file is indexed too');
  assert.ok(sym.matches[0].writes.length + sym.matches[0].reads.length > 0, 'pending.clear() reads the module variable');
  assert.ok(sym.stale === undefined || sym.stale === 0);
});

test('CLI: an unindexed folder explains how to index it', () => {
  const other = tmpdir('kiln-kg-none-');
  let err;
  try {
    cli(['overview'], other);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'fails');
  assert.match(String(err.stdout || err.stderr || err.message), /not indexed|open it in Kiln/i);
});

function mcpSession(cwd) {
  const p = spawn(process.execPath, [MCP], { cwd, env: { ...process.env, KILN_USER_DATA: USER_DATA }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    }
  });
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const t = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 20000);
      waiting.set(n, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  const notify = (method, params) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  return { request, notify, close: () => p.kill() };
}

test('MCP server: tools for agents, described as the first thing to use', async (t) => {
  const s = mcpSession(root);
  t.after(() => s.close());
  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'kiln-knowledge-graph');
  assert.ok(init.result.capabilities.tools);
  assert.match(init.result.instructions, /first/i);
  s.notify('notifications/initialized', {});
  const list = await s.request('tools/list', {});
  const names = list.result.tools.map((x) => x.name);
  for (const n of ['kg_overview', 'kg_search', 'kg_symbol', 'kg_usages', 'kg_impact', 'kg_path', 'kg_file', 'kg_variable']) assert.ok(names.includes(n), n);
  assert.ok(list.result.tools.every((x) => x.inputSchema && x.inputSchema.type === 'object'));
  assert.match(list.result.tools.find((x) => x.name === 'kg_symbol').description, /before grep|first/i);
  const res = await s.request('tools/call', { name: 'kg_symbol', arguments: { name: 'place_order' } });
  assert.ok(!res.result.isError, JSON.stringify(res.result));
  const payload = JSON.parse(res.result.content[0].text);
  assert.ok(payload.matches[0].reads.some((v) => v.name === 'TAX_RATE'));
  const bad = await s.request('tools/call', { name: 'kg_symbol', arguments: {} });
  assert.equal(bad.result.isError, true);
  const unknown = await s.request('nope/method', {});
  assert.ok(unknown.error && unknown.error.code === -32601);
});

test('installer: skill, MCP servers and "use it first" instructions for each agent, idempotent and reversible', async () => {
  const integ = require('../../src/main/services/agent-integration');
  const home = tmpdir('kiln-home-');
  writeTree(home, {
    '.claude/CLAUDE.md': '# My rules\nBe concise.\n',
    '.codex/config.toml': 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n',
    '.gemini/settings.json': JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }, null, 2),
    '.gemini/antigravity/mcp_config.json': JSON.stringify({ mcpServers: {} }),
    '.cursor/mcp.json': '{}',
  });
  const opts = { home, node: process.execPath, toolsDir: path.join(APP, 'src/agent-tools'), runClaudeMcpAdd: async () => ({ ok: false }) };
  const detected = integ.detectAgents({ home });
  for (const a of ['claude', 'codex', 'gemini', 'antigravity', 'cursor']) assert.ok(detected.find((x) => x.id === a && x.present), a);

  const r1 = await integ.install({ ...opts, agents: ['claude', 'codex', 'gemini', 'antigravity', 'cursor'] });
  assert.ok(r1.every((x) => x.ok), JSON.stringify(r1));
  const skill = fs.readFileSync(path.join(home, '.claude/skills/kiln-knowledge-graph/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: kiln-knowledge-graph\ndescription: .*(first|before)/im);
  assert.ok(skill.includes(CLI) || skill.includes('kg-cli.js'));
  assert.ok(fs.existsSync(path.join(home, '.codex/skills/kiln-knowledge-graph/SKILL.md')));
  const claudeMd = fs.readFileSync(path.join(home, '.claude/CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /# My rules\nBe concise\./);
  assert.match(claudeMd, /kiln-knowledge-graph:start[\s\S]*first[\s\S]*kiln-knowledge-graph:end/i);
  const toml = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
  assert.match(toml, /model = "gpt-5"/);
  assert.match(toml, /\[mcp_servers\.other\]/);
  assert.match(toml, /\[mcp_servers\.kiln-knowledge-graph\]\ncommand = ".*"\nargs = \[.*kg-mcp\.js.*\]/);
  assert.match(fs.readFileSync(path.join(home, '.codex/AGENTS.md'), 'utf8'), /Kiln knowledge graph/);
  const gem = JSON.parse(fs.readFileSync(path.join(home, '.gemini/settings.json'), 'utf8'));
  assert.equal(gem.theme, 'dark');
  assert.ok(gem.mcpServers.other && gem.mcpServers['kiln-knowledge-graph'].args.some((x) => x.endsWith('kg-mcp.js')));
  assert.ok(JSON.parse(fs.readFileSync(path.join(home, '.gemini/antigravity/mcp_config.json'), 'utf8')).mcpServers['kiln-knowledge-graph']);
  assert.ok(JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8')).mcpServers['kiln-knowledge-graph']);
  assert.match(fs.readFileSync(path.join(home, '.gemini/GEMINI.md'), 'utf8'), /kiln-knowledge-graph:start/);

  // Installing again changes nothing
  const snapshot = () => ['.claude/CLAUDE.md', '.codex/config.toml', '.codex/AGENTS.md', '.gemini/settings.json', '.gemini/GEMINI.md'].map((f) => fs.readFileSync(path.join(home, f), 'utf8')).join('\n---\n');
  const before = snapshot();
  await integ.install({ ...opts, agents: ['claude', 'codex', 'gemini', 'antigravity', 'cursor'] });
  assert.equal(snapshot(), before);
  assert.ok(integ.status({ home }).every((x) => !x.present || x.installed), JSON.stringify(integ.status({ home })));

  // Uninstall restores the user's own content
  await integ.uninstall({ ...opts, agents: ['claude', 'codex', 'gemini', 'antigravity', 'cursor'] });
  assert.equal(fs.readFileSync(path.join(home, '.claude/CLAUDE.md'), 'utf8'), '# My rules\nBe concise.\n');
  assert.equal(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
  assert.ok(!fs.existsSync(path.join(home, '.claude/skills/kiln-knowledge-graph')));
  const gem2 = JSON.parse(fs.readFileSync(path.join(home, '.gemini/settings.json'), 'utf8'));
  assert.ok(gem2.mcpServers.other && !gem2.mcpServers['kiln-knowledge-graph']);
  void os;
});
