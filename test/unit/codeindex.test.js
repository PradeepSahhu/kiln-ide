'use strict';
// Spec: the code index answers Go to Definition / Find Usages / Go to Symbol / usage counts, produces
// semantic tokens, and builds a knowledge graph (files -> functions -> calls) that updates when code
// changes and is persisted outside the project folder.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { tmpdir, writeTree } = require('../helpers/fixtures');

const APP = path.resolve(__dirname, '../..');

function startWorker(graphFile) {
  const w = new Worker(path.join(APP, 'src/main/services/codeindex/worker.js'), { workerData: { wasmDir: path.join(APP, 'node_modules/@vscode/tree-sitter-wasm/wasm'), graphFile } });
  let id = 0;
  const pending = new Map();
  const events = [];
  w.on('message', (m) => {
    if (m.event) return events.push(m);
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error));
  });
  const call = (type, payload) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      w.postMessage({ id, type, payload });
    });
  return { call, events, stop: () => w.terminate() };
}

const CS = `namespace Shop;
public class OrderService
{
    public void Place(Order order)
    {
        Validate(order);
        Audit.Log(order);
    }
    private void Validate(Order order) { }
}
public static class Audit { public static void Log(Order o) { } }
public record Order(string Id);
`;
const PY = `from helpers import fmt

class Report:
    def render(self, rows):
        return fmt(rows)

def main():
    Report().render([1, 2])
`;

test('definitions, references, symbols, lenses and graph', async (t) => {
  const root = writeTree(tmpdir(), { 'src/OrderService.cs': CS, 'src/Program.cs': 'new Shop.OrderService().Place(new Shop.Order("1"));\n', 'report.py': PY, 'helpers.py': 'def fmt(rows):\n    return str(rows)\n' });
  const graphFile = path.join(tmpdir(), 'kg.json');
  const w = startWorker(graphFile);
  t.after(() => w.stop());
  const stats = await w.call('init', { root, files: ['src/OrderService.cs', 'src/Program.cs', 'report.py', 'helpers.py'] });
  assert.equal(stats.files, 4);

  const cs = path.join(root, 'src/OrderService.cs');
  const def = await w.call('definitions', { file: cs, line: 6, col: 10 });
  assert.equal(def.defs[0].name, 'Validate');
  assert.equal(def.defs[0].line, 9);

  const refs = await w.call('references', { name: 'Place', file: cs });
  const kinds = refs.refs.map((r) => `${r.rel}:${r.kind}`);
  assert.ok(kinds.includes('src/OrderService.cs:declaration'));
  assert.ok(kinds.includes('src/Program.cs:call'));

  const syms = await w.call('workspaceSymbols', { query: 'OrdSer' });
  assert.equal(syms[0].name, 'OrderService');

  const outline = await w.call('documentSymbols', { file: cs });
  assert.ok(outline.some((s) => s.name === 'Validate' && s.kind === 'method' && s.container === 'Shop.OrderService'));

  const lens = await w.call('codeLens', { file: cs });
  assert.equal(lens.find((l) => l.name === 'Validate').usages, 1);

  const g = await w.call('graph', { mode: 'all' });
  const calls = g.edges.filter((e) => e.kind === 'calls').map((e) => `${e.source.split('::')[1]}->${e.target.split('::')[1]}`);
  assert.ok(calls.includes('Shop.OrderService.Place->Shop.OrderService.Validate'));
  assert.ok(calls.includes('Shop.OrderService.Place->Shop.Audit.Log'));
  assert.ok(calls.includes('Report.render->fmt'));
  assert.ok(g.edges.some((e) => e.kind === 'imports' && e.source === 'f:report.py' && e.target === 'f:helpers.py'));

  const files = await w.call('graph', { mode: 'files' });
  assert.ok(files.nodes.every((n) => n.kind === 'file'));

  const focus = await w.call('graph', { mode: 'focus', focus: g.nodes.find((n) => n.label === 'Validate').id, depth: 1 });
  assert.ok(focus.nodes.some((n) => n.label === 'Place'));

  const tokens = await w.call('semanticTokens', { file: cs, text: CS });
  assert.ok(tokens.data.length > 20 && tokens.data.length % 5 === 0);
});

test('knowledge graph updates when a function is added and records the change', async (t) => {
  const root = writeTree(tmpdir(), { 'app.py': 'def a():\n    return 1\n' });
  const graphFile = path.join(tmpdir(), 'kg.json');
  const w = startWorker(graphFile);
  t.after(() => w.stop());
  await w.call('init', { root, files: ['app.py'] });
  const before = Date.now();
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(root, 'app.py'), 'def a():\n    return b()\n\ndef b():\n    return 2\n');
  const upd = await w.call('update', { files: [path.join(root, 'app.py')] });
  assert.deepEqual(upd.changed, ['app.py']);
  const g = await w.call('graph', { mode: 'all' });
  const b = g.nodes.find((n) => n.label === 'b');
  assert.ok(b, 'new function appears');
  assert.ok(b.modifiedAt >= before, 'new function is marked as recently changed');
  assert.ok(g.edges.some((e) => e.kind === 'calls' && e.source.endsWith('::a::function') && e.target.endsWith('::b::function')));
  await w.call('save', {});
  assert.ok(fs.existsSync(graphFile), 'graph is persisted to the app-data file');
  assert.ok(!fs.readdirSync(root).some((f) => /kg|graph|\.kiln/i.test(f)), 'nothing is written into the project');
});

test('switching projects keeps the index working while the previous worker shuts down', async () => {
  const { CodeIndex } = require('../../src/main/services/codeindex');
  const a = writeTree(tmpdir(), { 'a.py': 'def alpha():\n    return 1\n' });
  const b = writeTree(tmpdir(), { 'b.py': 'def beta():\n    return 2\n\n\ndef gamma():\n    return beta()\n' });
  const index = new CodeIndex({ send() {} });
  await index.open(a, ['a.py']);
  await index.open(b, ['b.py']);
  // The previous worker is terminated shortly after the switch; the new index must be unaffected.
  await new Promise((r) => setTimeout(r, 800));
  const syms = await index.call('workspaceSymbols', { query: 'beta', limit: 10 });
  assert.ok(syms.some((s) => s.name === 'beta'), 'symbols of the new project');
  assert.ok(!syms.some((s) => s.name === 'alpha'), 'no symbols of the old project');
  assert.equal(index.status.state, 'ready');
  index.dispose();
});

test('the knowledge graph includes variables and which functions read and write them', async (t) => {
  const root = writeTree(tmpdir(), {
    'shop/__init__.py': '',
    'shop/config.py': 'TAX_RATE = 0.2\nretries = 3\n',
    'shop/cart.py': 'from shop.config import TAX_RATE\n\ncount = 0\n\n\nclass Cart:\n    currency = "EUR"\n\n    def __init__(self):\n        self.items = []\n        self.total = 0\n\n    def add(self, price):\n        global count\n        subtotal = price * (1 + TAX_RATE)\n        self.items.append(subtotal)\n        self.total += subtotal\n        count += 1\n        return self.total\n\n    def summary(self):\n        return f"{len(self.items)} items, {self.total} {self.currency}"\n',
    'Shop/Order.cs': 'namespace Shop;\n\npublic class Order\n{\n    private decimal _total;\n    public string Status { get; set; } = "new";\n    public static int Created;\n\n    public void Add(decimal amount)\n    {\n        var before = _total;\n        _total = before + amount;\n        Created++;\n    }\n\n    public decimal Total() => _total;\n\n    public void Close()\n    {\n        Status = "closed";\n    }\n}\n',
    'web/store.js': 'let hits = 0;\nconst LIMIT = 10;\n\nexport function track(path) {\n  hits += 1;\n  if (hits > LIMIT) return false;\n  return path.length;\n}\n\nexport class Counter {\n  constructor() {\n    this.value = 0;\n  }\n  inc(step) {\n    this.value += step;\n    return this.value;\n  }\n}\n',
  });
  const w = startWorker(path.join(tmpdir(), 'graph.json'));
  t.after(() => w.stop());
  await w.call('init', { root, files: ['shop/__init__.py', 'shop/config.py', 'shop/cart.py', 'Shop/Order.cs', 'web/store.js'] });
  const g = await w.call('graph', { mode: 'all', limit: 5000 });
  const node = (label, kind) => {
    const n = g.nodes.find((x) => x.label === label && (!kind || x.kind === kind));
    assert.ok(n, `node ${label}${kind ? ` (${kind})` : ''}`);
    return n;
  };
  const has = (from, to, kind) => g.edges.some((e) => e.source === from.id && e.target === to.id && e.kind === kind);

  // Python: module variables, constants (imported across files), class attributes and self fields
  assert.ok(has(node('add', 'method'), node('TAX_RATE', 'constant'), 'reads'), 'add reads the imported constant');
  assert.ok(has(node('add', 'method'), node('count', 'variable'), 'writes'), '`global count; count += 1` writes the module variable');
  assert.ok(has(node('add', 'method'), node('total', 'field'), 'writes'), 'self.total += ... writes the field');
  assert.ok(has(node('add', 'method'), node('items', 'field'), 'reads'));
  assert.ok(has(node('__init__', 'method'), node('items', 'field'), 'writes'));
  assert.ok(has(node('summary', 'method'), node('currency', 'field'), 'reads'), 'class attribute read through self');
  assert.ok(!has(node('summary', 'method'), node('total', 'field'), 'writes'));
  assert.ok(!g.nodes.some((n) => n.label === 'subtotal'), 'locals are not graph nodes');

  // C#: fields, static fields, properties, ++
  assert.ok(has(node('Add', 'method'), node('_total', 'field'), 'reads'));
  assert.ok(has(node('Add', 'method'), node('_total', 'field'), 'writes'));
  assert.ok(has(node('Add', 'method'), node('Created', 'field'), 'writes'), 'Created++ writes the static field');
  assert.ok(has(node('Total', 'method'), node('_total', 'field'), 'reads'));
  assert.ok(has(node('Close', 'method'), node('Status', 'property'), 'writes'));

  // JavaScript: module let/const and this.fields
  assert.ok(has(node('track', 'function'), node('hits', 'variable'), 'writes'));
  assert.ok(has(node('track', 'function'), node('LIMIT', 'constant'), 'reads'));
  assert.ok(has(node('inc', 'method'), node('value', 'field'), 'writes'));
  assert.ok(has(node('constructor', 'method'), node('value', 'field'), 'writes'));

  // Function details: locals with read/write counts; variable details: who reads and writes it
  const add = await w.call('neighbors', { id: node('add', 'method').id });
  const subtotal = add.locals.find((l) => l.name === 'subtotal');
  assert.ok(subtotal && subtotal.kind === 'local' && subtotal.writes >= 1 && subtotal.reads >= 2, `subtotal local: ${JSON.stringify(add.locals)}`);
  assert.ok(add.locals.some((l) => l.name === 'price' && l.kind === 'parameter'));
  const csAdd = await w.call('neighbors', { id: node('Add', 'method').id });
  assert.ok(csAdd.locals.some((l) => l.name === 'before' && l.kind === 'local'));
  assert.ok(csAdd.locals.some((l) => l.name === 'amount' && l.kind === 'parameter'));
  const total = await w.call('neighbors', { id: node('total', 'field').id });
  assert.deepEqual(total.writers.map((x) => x.label).sort(), ['__init__', 'add']);
  assert.deepEqual(total.readers.map((x) => x.label).sort(), ['add', 'summary']);
});

test('the knowledge graph covers Go, Java, Rust, C/C++, Ruby, PHP and Bash projects too', async (t) => {
  const root = writeTree(tmpdir(), {
    'shop/order.go': 'package shop\n\nimport "fmt"\n\nvar total int\nconst Limit = 10\n\ntype Order struct {\n\tID string\n\tQty int\n}\n\nfunc (o *Order) Add(n int) int {\n\to.Qty += n\n\ttotal = total + n\n\treturn helper(o.Qty)\n}\n\nfunc helper(x int) int {\n\ty := x * 2\n\tfmt.Println(y, Limit)\n\treturn y\n}\n',
    'src/Shop/Cart.java': 'package shop;\nimport java.util.List;\npublic class Cart {\n  private int qty;\n  static final int LIMIT = 10;\n  public Cart(int q) { this.qty = q; }\n  public int add(int n) {\n    int before = qty;\n    qty += n;\n    return check(before);\n  }\n  private int check(int x) { return Math.max(x, LIMIT); }\n}\n',
    'src/lib.rs': 'use std::fmt;\nstatic mut TOTAL: i32 = 0;\nconst MAX: i32 = 10;\npub struct Basket { items: i32 }\nimpl Basket {\n    pub fn push(&mut self, n: i32) -> i32 {\n        self.items += n;\n        let doubled = twice(self.items);\n        doubled\n    }\n}\nfn twice(x: i32) -> i32 { x * MAX }\n',
    'native/stock.cpp': '#include <vector>\nint stockTotal = 0;\nclass Stock {\npublic:\n  int level;\n  int put(int n) { level += n; stockTotal = stockTotal + n; return clampLevel(level); }\n};\nint clampLevel(int x) { int y = x * 2; return y; }\n',
    'app/ledger.rb': 'require "json"\nRATE = 10\nclass Ledger < Base\n  def initialize(qty)\n    @qty = qty\n  end\n  def record(n)\n    @qty += n\n    scale(@qty)\n  end\nend\ndef scale(x)\n  y = x * RATE\n  y\nend\n',
    'web/Invoice.php': '<?php\nnamespace Shop;\nconst VAT = 20;\nclass Invoice {\n  private $amount = 0;\n  public function charge($n) {\n    $this->amount += $n;\n    return withVat($this->amount);\n  }\n}\nfunction withVat($x) { $y = $x * VAT; return $y; }\n',
    'scripts/deploy.sh': 'COUNT=0\nbuild() {\n  local target=$1\n  COUNT=$((COUNT+1))\n  ship "$target"\n}\nship() { echo "$1"; }\nbuild app\n',
  });
  const files = ['shop/order.go', 'src/Shop/Cart.java', 'src/lib.rs', 'native/stock.cpp', 'app/ledger.rb', 'web/Invoice.php', 'scripts/deploy.sh'];
  const w = startWorker(path.join(tmpdir(), 'graph.json'));
  t.after(() => w.stop());
  const stats = await w.call('init', { root, files });
  assert.equal(stats.files, files.length, 'every file is indexed');
  const g = await w.call('graph', { mode: 'all', limit: 5000 });
  const node = (label, kind, file) => {
    const n = g.nodes.find((x) => x.label === label && (!kind || x.kind === kind) && (!file || x.file === file));
    assert.ok(n, `node ${label} (${kind || '*'}) in ${file || '*'}: ${g.nodes.filter((x) => x.file === file).map((x) => `${x.kind}:${x.label}`).join(', ')}`);
    return n;
  };
  const has = (from, to, kind) => g.edges.some((e) => e.source === from.id && e.target === to.id && e.kind === kind);
  const locals = async (n) => (await w.call('neighbors', { id: n.id })).locals.map((l) => `${l.kind}:${l.name}`);

  // Go
  const goAdd = node('Add', 'method', 'shop/order.go');
  assert.equal(goAdd.container, 'Order', 'Go methods belong to their receiver type');
  assert.ok(node('Order', 'struct', 'shop/order.go'));
  assert.ok(has(goAdd, node('helper', 'function', 'shop/order.go'), 'calls'));
  assert.ok(has(goAdd, node('Qty', 'field', 'shop/order.go'), 'writes'), 'o.Qty += n writes the field');
  assert.ok(has(goAdd, node('total', 'variable', 'shop/order.go'), 'writes'));
  assert.ok(has(node('helper', 'function', 'shop/order.go'), node('Limit', 'constant', 'shop/order.go'), 'reads'));
  assert.ok((await locals(node('helper', 'function', 'shop/order.go'))).includes('local:y'));

  // Java
  const jAdd = node('add', 'method', 'src/Shop/Cart.java');
  assert.ok(has(jAdd, node('check', 'method', 'src/Shop/Cart.java'), 'calls'));
  assert.ok(has(jAdd, node('qty', 'field', 'src/Shop/Cart.java'), 'writes'), 'qty += n writes the implicit field');
  assert.ok(has(node('Cart', 'constructor', 'src/Shop/Cart.java'), node('qty', 'field', 'src/Shop/Cart.java'), 'writes'), 'this.qty = q');
  assert.ok(has(node('check', 'method', 'src/Shop/Cart.java'), node('LIMIT', 'constant', 'src/Shop/Cart.java'), 'reads'));
  assert.ok((await locals(jAdd)).includes('local:before'));

  // Rust
  const push = node('push', 'method', 'src/lib.rs');
  assert.equal(push.container, 'Basket', 'impl blocks give methods their type');
  assert.ok(has(push, node('twice', 'function', 'src/lib.rs'), 'calls'));
  assert.ok(has(push, node('items', 'field', 'src/lib.rs'), 'writes'));
  assert.ok(has(node('twice', 'function', 'src/lib.rs'), node('MAX', 'constant', 'src/lib.rs'), 'reads'));
  assert.ok(node('TOTAL', 'variable', 'src/lib.rs'));

  // C++
  const put = node('put', 'method', 'native/stock.cpp');
  assert.ok(has(put, node('level', 'field', 'native/stock.cpp'), 'writes'));
  assert.ok(has(put, node('stockTotal', 'variable', 'native/stock.cpp'), 'writes'));
  assert.ok(has(put, node('clampLevel', 'function', 'native/stock.cpp'), 'calls'));

  // Ruby
  const record = node('record', 'method', 'app/ledger.rb');
  assert.ok(has(record, node('@qty', 'field', 'app/ledger.rb'), 'writes'));
  assert.ok(has(node('initialize', 'method', 'app/ledger.rb'), node('@qty', 'field', 'app/ledger.rb'), 'writes'));
  assert.ok(has(record, node('scale', 'function', 'app/ledger.rb'), 'calls'));
  assert.ok(has(node('scale', 'function', 'app/ledger.rb'), node('RATE', 'constant', 'app/ledger.rb'), 'reads'));

  // PHP
  const charge = node('charge', 'method', 'web/Invoice.php');
  assert.ok(has(charge, node('amount', 'field', 'web/Invoice.php'), 'writes'), '$this->amount += $n');
  assert.ok(has(charge, node('withVat', 'function', 'web/Invoice.php'), 'calls'));
  assert.ok(has(node('withVat', 'function', 'web/Invoice.php'), node('VAT', 'constant', 'web/Invoice.php'), 'reads'));
  assert.ok((await locals(node('withVat', 'function', 'web/Invoice.php'))).includes('local:y'));

  // Bash
  const build = node('build', 'function', 'scripts/deploy.sh');
  assert.ok(has(build, node('ship', 'function', 'scripts/deploy.sh'), 'calls'));
  assert.ok(has(build, node('COUNT', 'variable', 'scripts/deploy.sh'), 'writes'));
  assert.ok((await locals(build)).includes('local:target'));
});
