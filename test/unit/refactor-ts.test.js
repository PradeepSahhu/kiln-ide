'use strict';
// Spec: JavaScript / TypeScript refactorings come from the TypeScript language service over the whole
// project. Refactor This lists only refactorings that apply at the caret or selection, grouped the
// way Rider names them; running one returns the new text of every file it changes (nothing is
// written), named with the name the user chose, formatted with the file's indentation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, writeTree } = require('../helpers/fixtures');
const { TsProject } = require('../../src/main/services/refactor/ts-engine');

const SHOP = `export const TAX = 0.2;

export function totalPrice(items, discount) {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const taxed = subtotal * (1 + TAX);
  const result = taxed - discount;
  console.log('total', result);
  return result;
}

export class Animal {
  name() {
    return 'animal';
  }
}

export class Dog extends Animal {
  bark() {
    return 'woof';
  }
}
`;
const MAIN = `import { totalPrice, Dog } from './shop.js';

export function run() {
  console.log(new Dog().bark());
  return totalPrice([{ price: 2, qty: 3 }], 1);
}
`;

function project() {
  const root = writeTree(tmpdir('kiln-ts-'), { 'package.json': '{"type":"module"}\n', 'src/shop.js': SHOP, 'src/main.js': MAIN });
  const proj = new TsProject(root, { format: { tabSize: 2, insertSpaces: true } });
  return { root, proj, shop: path.join(root, 'src/shop.js'), main: path.join(root, 'src/main.js') };
}

const after = (r, file) => (r.files.find((f) => f.path === file) || {}).after;
const span = (text, snippet) => ({ start: text.indexOf(snippet), end: text.indexOf(snippet) + snippet.length });

test('lists the refactorings that apply to a selection of statements', () => {
  const { proj, shop } = project();
  const s = SHOP.indexOf('  const taxed');
  const e = SHOP.indexOf('  console.log');
  const items = proj.refactors({ file: shop, text: SHOP, start: s, end: e });
  const methods = items.filter((i) => i.kind === 'extractMethod');
  assert.ok(methods.length >= 1, 'extract method offered');
  assert.ok(methods.some((i) => /module scope/.test(i.title)));
  assert.ok(items.every((i) => i.id && i.title && i.kind), 'every item is complete');
  assert.ok(!items.some((i) => i.kind === 'inline'), 'inline is not offered for a statement selection');
});

test('extract method with the chosen name, formatted like the file', () => {
  const { proj, shop } = project();
  const s = SHOP.indexOf('  const taxed');
  const e = SHOP.indexOf('  console.log');
  const item = proj.refactors({ file: shop, text: SHOP, start: s, end: e }).find((i) => i.kind === 'extractMethod' && /module scope/.test(i.title));
  assert.equal(item.needs, 'name');
  const r = proj.edits({ file: shop, text: SHOP, start: s, end: e, id: item.id, name: 'applyTax' });
  const out = after(r, shop);
  assert.match(out, /const result = applyTax\(subtotal, discount\);/);
  assert.match(out, /\nfunction applyTax\(subtotal, discount\) \{\n  const taxed = subtotal \* \(1 \+ TAX\);\n  const result = taxed - discount;\n  return result;\n\}/);
  assert.doesNotMatch(out, /newFunction/);
  assert.equal(r.files.length, 1);
  assert.equal(fs.readFileSync(shop, 'utf8'), SHOP, 'nothing is written');
  assert.ok(r.select && r.select.file === shop && out.slice(r.select.start, r.select.end) === 'applyTax', 'the new name is selected');
});

test('introduce variable (constant in the enclosing scope) and inline it back', () => {
  const { proj, shop } = project();
  const { start, end } = span(SHOP, 'subtotal * (1 + TAX)');
  const items = proj.refactors({ file: shop, text: SHOP, start, end });
  const intro = items.find((i) => i.kind === 'introduceVariable');
  assert.ok(intro, 'introduce variable offered for an expression');
  assert.ok(!items.some((i) => i.kind === 'introduceConstant'), 'no module constant for an expression that uses locals');
  const out = after(proj.edits({ file: shop, text: SHOP, start, end, id: intro.id, name: 'gross' }), shop);
  assert.match(out, /const gross = subtotal \* \(1 \+ TAX\);\n  const taxed = gross;/);

  const at = SHOP.indexOf('taxed =') + 1;
  const inline = proj.refactors({ file: shop, text: SHOP, start: at, end: at }).find((i) => i.kind === 'inline');
  assert.ok(inline, 'inline offered on a variable');
  assert.equal(inline.needs, undefined);
  const inl = after(proj.edits({ file: shop, text: SHOP, start: at, end: at, id: inline.id }), shop);
  assert.match(inl, /const result = subtotal \* \(1 \+ TAX\) - discount;/);
  assert.doesNotMatch(inl, /const taxed/);
});

test('introduce constant moves an expression of module-level values to module scope', () => {
  const { proj, shop } = project();
  const { start, end } = span(SHOP, '1 + TAX');
  const c = proj.refactors({ file: shop, text: SHOP, start, end }).find((i) => i.kind === 'introduceConstant');
  assert.ok(c, 'introduce constant offered');
  const out = after(proj.edits({ file: shop, text: SHOP, start, end, id: c.id, name: 'TAX_FACTOR' }), shop);
  assert.match(out, /const TAX_FACTOR = 1 \+ TAX;\n/);
  assert.match(out, /const taxed = subtotal \* \(TAX_FACTOR\);/);
});

test('move a class to another file updates the imports that use it', () => {
  const { root, proj, shop, main } = project();
  const at = SHOP.indexOf('Dog extends');
  const move = proj.refactors({ file: shop, text: SHOP, start: at, end: at }).find((i) => i.kind === 'move' && i.needs === 'targetFile');
  assert.ok(move, 'move to file offered');
  const target = path.join(root, 'src/dog.js');
  const r = proj.edits({ file: shop, text: SHOP, start: at, end: at, id: move.id, targetFile: target });
  const dog = r.files.find((f) => f.path === target);
  assert.ok(dog && dog.created, 'the target file is created');
  assert.match(dog.after, /import \{ Animal \} from '\.\/shop\.js';/);
  assert.match(dog.after, /export class Dog extends Animal \{\n  bark\(\) \{/);
  assert.doesNotMatch(after(r, shop), /class Dog/);
  assert.match(after(r, main), /import \{ Dog \} from '\.\/dog\.js';/);
  assert.ok(!fs.existsSync(target), 'nothing is written');
});

test('unsaved editor text is what gets refactored', () => {
  const { proj, shop } = project();
  const edited = SHOP.replace('const result = taxed - discount;', 'const result = taxed - discount * 2;');
  const { start, end } = span(edited, 'discount * 2');
  const intro = proj.refactors({ file: shop, text: edited, start, end }).find((i) => i.kind === 'introduceVariable');
  const out = after(proj.edits({ file: shop, text: edited, start, end, id: intro.id, name: 'doubled' }), shop);
  assert.match(out, /const doubled = discount \* 2;\n  const result = taxed - doubled;/);
});
