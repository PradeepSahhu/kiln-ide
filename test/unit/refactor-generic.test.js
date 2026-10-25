'use strict';
// Spec: refactorings that work from the syntax tree and the project's code index, for C#, Python and
// JavaScript/TypeScript, with no language server: Safe Delete, Change Signature, Pull Members Up,
// Introduce Constant, and (for C# without csharp-ls) Introduce Variable, Inline Variable and Move Type
// to File. Each returns the new text of the files it changes; nothing is written.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { tmpdir, writeTree } = require('../helpers/fixtures');

const APP = path.resolve(__dirname, '../..');

function startWorker() {
  const w = new Worker(path.join(APP, 'src/main/services/codeindex/worker.js'), { workerData: { wasmDir: path.join(APP, 'node_modules/@vscode/tree-sitter-wasm/wasm'), graphFile: null } });
  let id = 0;
  const pending = new Map();
  w.on('message', (m) => {
    if (m.event) return;
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
  return { call, stop: () => w.terminate() };
}

async function indexed(t, files) {
  const root = writeTree(tmpdir('kiln-refactor-'), files);
  const w = startWorker();
  t.after(() => w.stop());
  await w.call('init', { root, files: Object.keys(files) });
  const abs = (rel) => path.join(root, rel);
  const refactor = (op, rel, params = {}) => {
    const file = abs(rel);
    const text = params.text != null ? params.text : fs.readFileSync(file, 'utf8');
    const pos = (s, n = 0) => text.indexOf(s) + n;
    const at = params.at != null ? pos(params.at, params.offset || 0) : params.start;
    const start = params.select != null ? pos(params.select) : at;
    const end = params.select != null ? pos(params.select) + params.select.length : at;
    return w.call('refactor', { op, file, text, start, end, ...params.input });
  };
  return { root, abs, refactor };
}

const after = (r, file) => (r.files.find((f) => f.path === file) || {}).after;

// ---------------------------------------------------------------- C#

const ANIMALS = `namespace Shop;

public interface IPet
{
    string Name();
}

public class Animal
{
    public virtual string Name() => "animal";
}

public class Dog : Animal, IPet
{
    public int Legs = 4;

    public string Describe(int count, string prefix)
    {
        var total = count * Legs + 1;
        var label = prefix + ":" + total;
        Console.WriteLine(label);
        return label;
    }

    /// <summary>Not used anywhere.</summary>
    private void Unused()
    {
        Console.WriteLine("never");
    }

    public void Bark()
    {
        Console.WriteLine("woof " + Legs);
    }
}
`;
const PROGRAM = `using System;

namespace Shop;

public static class Program
{
    public static void Main()
    {
        var d = new Dog();
        Console.WriteLine(d.Describe(2, "dogs"));
        Console.WriteLine(d.Describe(count: 3, prefix: "named"));
        d.Bark();
    }
}
`;

test('C#: safe delete removes an unused member with its doc comment, and reports usages of a used one', async (t) => {
  const { abs, refactor } = await indexed(t, { 'Animals.cs': ANIMALS, 'Program.cs': PROGRAM });
  const r = await refactor('safeDelete', 'Animals.cs', { at: 'Unused()' });
  assert.equal(r.usages.length, 0);
  const out = after(r, abs('Animals.cs'));
  assert.doesNotMatch(out, /Unused|Not used anywhere/);
  assert.match(out, /        return label;\n    }\n\n    public void Bark\(\)/, 'one blank line is left between the members');

  const used = await refactor('safeDelete', 'Animals.cs', { at: 'Bark()' });
  assert.equal(used.blocked, true);
  assert.equal(used.usages.length, 1);
  assert.equal(used.usages[0].file, abs('Program.cs'));
  const forced = await refactor('safeDelete', 'Animals.cs', { at: 'Bark()', input: { force: true } });
  assert.doesNotMatch(after(forced, abs('Animals.cs')), /void Bark/);
});

test('C#: change signature reorders, renames and adds parameters and updates every call', async (t) => {
  const { abs, refactor } = await indexed(t, { 'Animals.cs': ANIMALS, 'Program.cs': PROGRAM });
  const ctx = await refactor('context', 'Animals.cs', { at: 'int count', offset: 1 });
  assert.equal(ctx.callable, true, 'a caret on a parameter type is on the function');
  const info = await refactor('signatureInfo', 'Animals.cs', { at: 'int count', offset: 1 });
  assert.equal(info.name, 'Describe');
  assert.deepEqual(info.params.map((p) => [p.name, p.type]), [['count', 'int'], ['prefix', 'string']]);
  const r = await refactor('changeSignature', 'Animals.cs', {
    at: 'Describe(',
    input: { params: [{ old: 1, name: 'prefix', type: 'string' }, { old: 0, name: 'n', type: 'int' }, { old: null, name: 'loud', type: 'bool', default: 'false', value: 'true' }] },
  });
  const decl = after(r, abs('Animals.cs'));
  assert.match(decl, /public string Describe\(string prefix, int n, bool loud = false\)/);
  assert.match(decl, /var total = n \* Legs \+ 1;/, 'the renamed parameter is renamed in the body');
  const calls = after(r, abs('Program.cs'));
  assert.match(calls, /d\.Describe\("dogs", 2, true\)/);
  assert.match(calls, /d\.Describe\(n: 3, prefix: "named", loud: true\)/);
});

test('C#: pull members up to a base class moves the member; to an interface adds its signature', async (t) => {
  const { abs, refactor } = await indexed(t, { 'Animals.cs': ANIMALS, 'Program.cs': PROGRAM });
  const info = await refactor('pullUpInfo', 'Animals.cs', { at: 'Bark()' });
  assert.equal(info.className, 'Dog');
  assert.deepEqual(info.targets.map((x) => x.name).sort(), ['Animal', 'IPet']);
  assert.ok(info.members.find((m) => m.name === 'Bark').selected);

  const toClass = await refactor('pullMembersUp', 'Animals.cs', { at: 'Bark()', input: { target: 'Animal', members: ['Bark'] } });
  const a = after(toClass, abs('Animals.cs'));
  assert.match(a, /public class Animal\n\{\n    public virtual string Name\(\) => "animal";\n\n    public void Bark\(\)\n    \{\n        Console\.WriteLine\("woof " \+ Legs\);\n    \}\n\}/);
  assert.equal((a.match(/void Bark/g) || []).length, 1, 'moved, not copied');
  assert.ok(toClass.warnings.some((w) => /Legs/.test(w)), 'warns that the member uses Legs, which stays in Dog');

  const toInterface = await refactor('pullMembersUp', 'Animals.cs', { at: 'Bark()', input: { target: 'IPet', members: ['Bark'] } });
  const b = after(toInterface, abs('Animals.cs'));
  assert.match(b, /public interface IPet\n\{\n    string Name\(\);\n    void Bark\(\);\n\}/);
  assert.match(b, /public void Bark\(\)\n    \{/, 'the implementation stays in Dog');
});

test('C#: introduce variable, inline variable and move type to file without a language server', async (t) => {
  const { abs, refactor } = await indexed(t, { 'Animals.cs': ANIMALS, 'Program.cs': PROGRAM });
  const iv = await refactor('introduceVariable', 'Animals.cs', { select: 'count * Legs', input: { name: 'scaled' } });
  assert.match(after(iv, abs('Animals.cs')), /        var scaled = count \* Legs;\n        var total = scaled \+ 1;/);

  const inl = await refactor('inlineVariable', 'Animals.cs', { at: 'label =' });
  const out = after(inl, abs('Animals.cs'));
  assert.match(out, /Console\.WriteLine\(prefix \+ ":" \+ total\);\n        return prefix \+ ":" \+ total;/);
  assert.doesNotMatch(out, /var label/);

  const mv = await refactor('moveTypeToFile', 'Animals.cs', { at: 'class Dog', offset: 6 });
  const created = mv.files.find((f) => f.path === abs('Dog.cs'));
  assert.ok(created && created.created);
  assert.match(created.after, /^namespace Shop;\n\npublic class Dog : Animal, IPet\n\{/);
  assert.doesNotMatch(after(mv, abs('Animals.cs')), /class Dog/);
});

test('C#: introduce constant for a literal', async (t) => {
  const { abs, refactor } = await indexed(t, { 'Animals.cs': ANIMALS, 'Program.cs': PROGRAM });
  await assert.rejects(refactor('introduceConstant', 'Animals.cs', { select: '1;', input: { name: 'Extra' } }), /expression/);
  const c = await refactor('introduceConstant', 'Animals.cs', { at: '+ 1;', offset: 2, input: { name: 'Extra' } });
  const out = after(c, abs('Animals.cs'));
  assert.match(out, /public class Dog : Animal, IPet\n\{\n    private const int Extra = 1;\n\n    public int Legs = 4;/);
  assert.match(out, /var total = count \* Legs \+ Extra;/);
  assert.equal(out.slice(c.select.start, c.select.end), 'Extra');
});

// ---------------------------------------------------------------- Python

const PY_SHOP = `import json

TAX = 0.2


class Animal:
    def name(self):
        return "animal"


class Dog(Animal):
    def describe(self, count, prefix="x"):
        return prefix + str(count * 0.05)

    def bark(self):
        return "woof"


@staticmethod
def unused_helper():
    return json.dumps({})


def total(items):
    return sum(items) * (1 + TAX)
`;
const PY_MAIN = `from shop import Dog


def run():
    d = Dog()
    print(d.describe(1, "a"))
    print(d.describe(count=2))
    return d.bark()
`;

test('Python: safe delete, change signature with keyword arguments, pull members up, introduce constant', async (t) => {
  const { abs, refactor } = await indexed(t, { 'shop.py': PY_SHOP, 'main.py': PY_MAIN });
  const del = await refactor('safeDelete', 'shop.py', { at: 'unused_helper' });
  assert.equal(del.usages.length, 0);
  const d = after(del, abs('shop.py'));
  assert.doesNotMatch(d, /unused_helper|@staticmethod/);
  assert.match(d, /        return "woof"\n\n\ndef total\(items\):/, 'two blank lines stay between top-level definitions');

  const info = await refactor('signatureInfo', 'shop.py', { at: 'describe' });
  assert.deepEqual(info.params.map((p) => [p.name, p.kind]), [['self', 'self'], ['count', 'normal'], ['prefix', 'normal']]);
  const cs = await refactor('changeSignature', 'shop.py', {
    at: 'describe',
    input: { params: [{ old: 0, name: 'self' }, { old: 2, name: 'prefix', default: '"x"' }, { old: null, name: 'suffix', default: '""', value: '"!"' }] },
  });
  assert.match(after(cs, abs('shop.py')), /def describe\(self, prefix="x", suffix=""\):\n        return prefix \+ str\(count \* 0\.05\)/);
  assert.ok(cs.warnings.some((w) => /count/.test(w)), 'warns that the removed parameter is still used');
  const m = after(cs, abs('main.py'));
  assert.match(m, /d\.describe\("a", "!"\)/);
  assert.match(m, /d\.describe\(suffix="!"\)/);

  const pu = await refactor('pullMembersUp', 'shop.py', { at: 'def bark', offset: 4, input: { target: 'Animal', members: ['bark'] } });
  assert.match(after(pu, abs('shop.py')), /class Animal:\n    def name\(self\):\n        return "animal"\n\n    def bark\(self\):\n        return "woof"\n\n\nclass Dog\(Animal\):/);

  const cst = await refactor('introduceConstant', 'shop.py', { select: '0.05', input: { name: 'RATE' } });
  const c = after(cst, abs('shop.py'));
  assert.match(c, /^import json\n\nRATE = 0\.05\nTAX = 0\.2\n/);
  assert.match(c, /str\(count \* RATE\)/);
  await assert.rejects(refactor('introduceConstant', 'shop.py', { select: 'count * 0.05', input: { name: 'BAD' } }), /local/);
});

// ------------------------------------------------------------ TypeScript

test('TypeScript: change signature and safe delete', async (t) => {
  const SHOP = `export function totalPrice(items: number[], discount = 0): number {
  return items.reduce((a, b) => a + b, 0) - discount;
}

/** Old helper. */
export function legacy(): void {}
`;
  const MAIN = `import { totalPrice } from './shop';

console.log(totalPrice([1, 2], 1), totalPrice([3]));
`;
  const { abs, refactor } = await indexed(t, { 'shop.ts': SHOP, 'main.ts': MAIN });
  const r = await refactor('changeSignature', 'shop.ts', { at: 'totalPrice', input: { params: [{ old: 1, name: 'discount', default: '0' }, { old: 0, name: 'items', type: 'number[]' }] } });
  assert.match(after(r, abs('shop.ts')), /export function totalPrice\(discount = 0, items: number\[\]\): number/);
  assert.match(after(r, abs('main.ts')), /totalPrice\(1, \[1, 2\]\), totalPrice\(undefined, \[3\]\)/);

  const del = await refactor('safeDelete', 'shop.ts', { at: 'legacy' });
  assert.equal(del.usages.length, 0);
  assert.equal(after(del, abs('shop.ts')), `export function totalPrice(items: number[], discount = 0): number {\n  return items.reduce((a, b) => a + b, 0) - discount;\n}\n`);
});
