'use strict';
// Spec: Python refactorings are computed by rope, which Kiln installs into its own tools folder (never
// into the project or its virtual environment). A refactoring returns the new text of every file it
// changes and writes nothing; a module created by Move is reported as created and is not left on disk.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpdir, writeTree, has } = require('../helpers/fixtures');

// One rope install per machine for the test runs.
process.env.KILN_TOOLS_DIR = process.env.KILN_TOOLS_DIR || path.join(os.tmpdir(), 'kiln-test-tools');
const { ensureRope, ropeRefactor } = require('../../src/main/services/refactor/py-engine');

const python = has('python3') ? 'python3' : has('python') ? 'python' : null;
const skip = !python && 'no Python interpreter';

const SHOP = `TAX = 0.2


def total_price(items, discount):
    subtotal = sum(i["price"] * i["qty"] for i in items)
    taxed = subtotal * (1 + TAX)
    result = taxed - discount
    print("total", result)
    return result


class Counter:
    def bump(self, n):
        step = n * 3
        return step + 1
`;
const MAIN = `from app.shop import total_price


def run():
    return total_price([{"price": 2, "qty": 3}], 1)
`;

function project() {
  const root = writeTree(tmpdir('kiln-py-'), { 'app/__init__.py': '', 'app/shop.py': SHOP, 'app/main.py': MAIN });
  return { root, shop: path.join(root, 'app/shop.py'), main: path.join(root, 'app/main.py') };
}

let rope;
async function refactor(req) {
  rope = rope || (await ensureRope(python));
  return ropeRefactor({ ...rope, ...req });
}
const after = (r, file) => (r.files.find((f) => f.path === file) || {}).after;
const at = (text, snippet) => text.indexOf(snippet);

test('rope is installed into the Kiln tools folder and found again', { skip, timeout: 300000 }, async () => {
  const r = await ensureRope(python);
  assert.ok(r.env.PYTHONPATH.startsWith(process.env.KILN_TOOLS_DIR), 'installed under the tools folder');
  assert.ok(fs.existsSync(path.join(r.env.PYTHONPATH, 'rope', '__init__.py')));
  const again = await ensureRope(python);
  assert.equal(again.env.PYTHONPATH, r.env.PYTHONPATH);
});

test('extract method with the chosen name; nothing is written', { skip, timeout: 120000 }, async () => {
  const { root, shop } = project();
  const r = await refactor({ root, op: 'extract_method', file: shop, start: at(SHOP, '    taxed ='), end: at(SHOP, '    print('), name: 'apply_tax' });
  const out = after(r, shop);
  assert.match(out, /    result = apply_tax\(subtotal, discount\)\n/);
  assert.match(out, /def apply_tax\(subtotal, discount\):\n    taxed = subtotal \* \(1 \+ TAX\)\n    result = taxed - discount\n    return result\n/);
  assert.equal(fs.readFileSync(shop, 'utf8'), SHOP);
  assert.ok(r.select && out.slice(r.select.start, r.select.end) === 'apply_tax', 'the new function name is selected');
});

test('introduce variable, introduce field and inline', { skip, timeout: 120000 }, async () => {
  const { root, shop } = project();
  const s = at(SHOP, 'subtotal * (1 + TAX)');
  const v = after(await refactor({ root, op: 'extract_variable', file: shop, start: s, end: s + 'subtotal * (1 + TAX)'.length, name: 'gross' }), shop);
  assert.match(v, /    gross = subtotal \* \(1 \+ TAX\)\n    taxed = gross\n/);

  const f = after(await refactor({ root, op: 'introduce_field', file: shop, start: at(SHOP, 'step ='), end: at(SHOP, 'step =') }), shop);
  assert.match(f, /        self\.step = n \* 3\n        return self\.step \+ 1\n/);

  const i = after(await refactor({ root, op: 'inline', file: shop, start: at(SHOP, 'taxed ='), end: at(SHOP, 'taxed =') }), shop);
  assert.match(i, /    result = subtotal \* \(1 \+ TAX\) - discount\n/);
  assert.doesNotMatch(i, /taxed/);
});

test('move a function to a new module updates its importers', { skip, timeout: 120000 }, async () => {
  const { root, shop, main } = project();
  const dest = path.join(root, 'app/pricing.py');
  const r = await refactor({ root, op: 'move', file: shop, start: at(SHOP, 'total_price'), end: at(SHOP, 'total_price'), dest });
  const created = r.files.find((f) => f.path === dest);
  assert.ok(created && created.created, 'the module is reported as created');
  assert.match(created.after, /def total_price\(items, discount\):/);
  assert.match(created.after, /from app\.shop import TAX/);
  assert.doesNotMatch(after(r, shop), /def total_price/);
  assert.match(after(r, main), /pricing/);
  assert.match(after(r, main), /import[^\n]*\n\n\ndef run\(\):/, 'two blank lines after the imports');
  assert.ok(!fs.existsSync(dest), 'nothing is left on disk');
});

test("rope's reason is reported when a refactoring does not apply", { skip, timeout: 120000 }, async () => {
  const { root, shop } = project();
  await assert.rejects(refactor({ root, op: 'inline', file: shop, start: at(SHOP, 'class Counter') + 7, end: at(SHOP, 'class Counter') + 7 }), /method, local variable or parameter/);
});
