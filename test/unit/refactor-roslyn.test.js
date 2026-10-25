'use strict';
// Spec: C# refactorings come from Roslyn through csharp-ls code actions. Their titles are mapped to
// Rider's refactorings, actions that need Visual Studio dialogs ("…") are left out, the LSP edits are
// turned into new file text in the file's own line endings, and the name Roslyn generates
// (NewMethod, v, ...) is replaced by the name the user chose.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRoslyn, applyLspEdits, renameGenerated } = require('../../src/main/services/refactor/roslyn');

test('code action titles map to Rider refactorings', () => {
  const k = (t) => (classifyRoslyn(t) || {}).kind;
  assert.equal(k('Extract method'), 'extractMethod');
  assert.equal(k('Extract local function'), 'extractMethod');
  assert.equal(k("Introduce local for 'count * Legs + 1'"), 'introduceVariable');
  assert.equal(classifyRoslyn("Introduce local for all occurrences of 'x'").all, true);
  assert.equal(k("Introduce constant for '4'"), 'introduceConstant');
  assert.equal(k("Introduce field for 'x'"), 'introduceField');
  assert.equal(k('into extracted method to invoke at call sites'), 'introduceParameter');
  assert.equal(k('Inline temporary variable'), 'inline');
  assert.equal(k("Inline 'Helper()'"), 'inline');
  assert.equal(k('Move type to Dog.cs'), 'move');
  assert.equal(k("Pull 'Bark' up to 'Animal'"), 'pullMembersUp');
  assert.equal(k("Encapsulate field: 'Legs' (and use property)"), 'other');
  assert.equal(classifyRoslyn('Extract interface...'), null, 'dialog actions are not offered');
  assert.equal(classifyRoslyn('Generate overrides…'), null);
  assert.equal(classifyRoslyn('Add missing usings'), null, 'quick fixes are not refactorings');
});

const BEFORE = `namespace Shop;

public class Dog
{
    public int Legs = 4;

    public string Describe(int count, string prefix)
    {
        var total = count * Legs + 1;
        return prefix + total;
    }
}
`;

test('Roslyn edits become the new text; the generated name is replaced by the chosen one', () => {
  // The edit csharp-ls returns for Extract Method on `count * Legs + 1` (note the stray \r\n).
  const edits = [
    { line: 9, col: 9, endLine: 9, endCol: 37, text: 'int total = NewMethod(count)' },
    { line: 11, col: 6, endLine: 11, endCol: 6, text: '\n\n    private int NewMethod(int count)\n    {\r\n        return count * Legs + 1;\n    }' },
  ];
  const after = applyLspEdits(BEFORE, edits);
  assert.doesNotMatch(after, /\r/, 'line endings follow the file');
  assert.match(after, /int total = NewMethod\(count\);/);
  const r = renameGenerated(BEFORE, after, 'Scaled');
  assert.match(r.text, /int total = Scaled\(count\);/);
  assert.match(r.text, /private int Scaled\(int count\)\n    \{\n        return count \* Legs \+ 1;\n    \}/);
  assert.equal(r.text.slice(r.start, r.end), 'Scaled');
  assert.equal(renameGenerated(BEFORE, after, '').text, after, 'no name keeps Roslyn\'s');
});

test('CRLF files keep CRLF', () => {
  const crlf = BEFORE.replace(/\n/g, '\r\n');
  const after = applyLspEdits(crlf, [{ line: 11, col: 6, endLine: 11, endCol: 6, text: '\n    void A() { }' }]);
  assert.match(after, /\}\r\n    void A\(\) \{ \}/);
  assert.doesNotMatch(after.replace(/\r\n/g, ''), /\n/);
});
