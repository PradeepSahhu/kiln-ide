'use strict';
// Spec: besides the built-in themes, users create their own: duplicate any theme, change UI, editor,
// syntax and terminal colors, save, export/import as JSON, and import VS Code color themes. Custom
// themes resolve like built-ins and drive the UI variables, the Monaco theme and the terminal colors.
const test = require('node:test');
const assert = require('node:assert/strict');

const themesLib = () => import('../../src/renderer/js/lib/themes.js');
const importLib = () => import('../../src/renderer/js/lib/theme-import.js');

test('custom themes are registered next to the built-ins and resolved by id', async () => {
  const { setCustomThemes, themeById, themes } = await themesLib();
  const builtins = themes.length;
  setCustomThemes([{ id: 'custom-mine', name: 'Mine', type: 'dark', basedOn: 'dracula', base: { panel: '#101010', editor: '#202020' }, syntax: { keyword: '#ff0000' } }]);
  const t = themeById('custom-mine');
  assert.equal(t.name, 'Mine');
  assert.equal(t.base.panel, '#101010');
  assert.equal(t.syntax.keyword, '#ff0000');
  // everything not customized comes from the theme it is based on
  assert.equal(t.syntax.string, themeById('dracula').syntax.string);
  assert.equal(t.editor.cursor, themeById('dracula').editor.cursor);
  assert.ok(themes.some((x) => x.id === 'custom-mine' && x.custom));
  setCustomThemes([]);
  assert.equal(themes.length, builtins);
  assert.equal(themeById('custom-mine').id, 'rider-dark', 'unknown ids fall back to the default theme');
});

test('invalid colors fall back to the base theme', async () => {
  const { setCustomThemes, themeById } = await themesLib();
  setCustomThemes([{ id: 'custom-bad', name: 'Bad', type: 'dark', basedOn: 'nord', base: { text: 'not-a-color', accent: '#12345' }, syntax: { comment: 'rgb(1,2,3)' } }]);
  const t = themeById('custom-bad');
  assert.equal(t.base.text, themeById('nord').base.text);
  assert.equal(t.base.accent, themeById('nord').base.accent);
  assert.equal(t.syntax.comment, themeById('nord').syntax.comment);
  setCustomThemes([]);
});

test('UI variables, the editor theme and terminal colors use custom values', async () => {
  const { setCustomThemes, themeById, cssVars, monacoTheme, terminalTheme } = await themesLib();
  const ansi = ['#000001', '#aa0000', '#00aa00', '#aaaa00', '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa', '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff'];
  setCustomThemes([{ id: 'custom-x', name: 'X', type: 'light', basedOn: 'rider-light', base: { panel: '#fafafa', editor: '#fffff0' }, editor: { cursor: '#ff00ff' }, syntax: { string: '#008800' }, terminal: { ansi } }]);
  const t = themeById('custom-x');
  assert.equal(cssVars(t)['--bg'], '#fafafa');
  assert.equal(cssVars(t)['--syn-string'], '#008800');
  const m = monacoTheme(t);
  assert.equal(m.base, 'vs');
  assert.equal(m.colors['editor.background'].toLowerCase(), '#fffff0');
  assert.equal(m.colors['editorCursor.foreground'].toLowerCase(), '#ff00ff');
  assert.ok(m.rules.some((r) => r.token === 'string' && r.foreground.toLowerCase() === '008800'));
  const term = terminalTheme(t);
  assert.equal(term.red, '#aa0000');
  assert.equal(term.brightWhite, '#ffffff');
  setCustomThemes([]);
});

test('VS Code color themes import into Kiln themes', async () => {
  const { fromVsCodeTheme } = await importLib();
  const vs = {
    name: 'Night Sky',
    type: 'dark',
    colors: {
      'editor.background': '#0B1021',
      'editor.foreground': '#D0D8F0',
      'sideBar.background': '#080C18',
      'focusBorder': '#4C8DFFAA',
      'editor.lineHighlightBackground': '#121A33',
      'editor.selectionBackground': '#264F78',
      'editorLineNumber.foreground': '#3A4466',
      'editorCursor.foreground': '#FFCC00',
      'terminal.ansiRed': '#FF5370',
    },
    tokenColors: [
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#5F6B8C', fontStyle: 'italic' } },
      { scope: 'keyword, storage.type', settings: { foreground: '#C792EA' } },
      { scope: 'string', settings: { foreground: '#C3E88D' } },
      { scope: 'constant.numeric', settings: { foreground: '#F78C6C' } },
      { scope: ['entity.name.type', 'entity.name.class'], settings: { foreground: '#FFCB6B' } },
      { scope: 'entity.name.function', settings: { foreground: '#82AAFF' } },
      { scope: 'variable.parameter', settings: { foreground: '#F07178' } },
    ],
  };
  const t = fromVsCodeTheme(vs);
  assert.equal(t.name, 'Night Sky');
  assert.equal(t.type, 'dark');
  assert.ok(t.id.startsWith('custom-'));
  assert.equal(t.base.editor.toLowerCase(), '#0b1021');
  assert.equal(t.base.panel.toLowerCase(), '#080c18');
  assert.equal(t.base.accent.toLowerCase(), '#4c8dff');
  assert.equal(t.editor.cursor.toLowerCase(), '#ffcc00');
  assert.equal(t.syntax.comment.toLowerCase(), '#5f6b8c');
  assert.equal(t.syntax.keyword.toLowerCase(), '#c792ea');
  assert.equal(t.syntax.string.toLowerCase(), '#c3e88d');
  assert.equal(t.syntax.number.toLowerCase(), '#f78c6c');
  assert.equal(t.syntax.type.toLowerCase(), '#ffcb6b');
  assert.equal(t.syntax.method.toLowerCase(), '#82aaff');
  assert.equal(t.syntax.param.toLowerCase(), '#f07178');
  assert.equal(t.terminal.ansi[1].toLowerCase(), '#ff5370');
  // a light VS Code theme without "type" is detected from its background
  assert.equal(fromVsCodeTheme({ colors: { 'editor.background': '#FDFDFD' }, tokenColors: [] }).type, 'light');
});

test('exported themes import back unchanged', async () => {
  const { exportTheme, importTheme } = await importLib();
  const { setCustomThemes, themeById } = await themesLib();
  setCustomThemes([{ id: 'custom-rt', name: 'Round Trip', type: 'dark', basedOn: 'one-dark', base: { accent: '#abcdef' } }]);
  const json = exportTheme(themeById('custom-rt'));
  const back = importTheme(json);
  assert.equal(back.name, 'Round Trip');
  assert.equal(back.base.accent, '#abcdef');
  assert.deepEqual(back.syntax, themeById('custom-rt').syntax);
  // a Kiln export and a VS Code theme are both accepted; garbage is rejected
  assert.throws(() => importTheme('{"hello": 1}'), /not a color theme/i);
  assert.throws(() => importTheme('nope'), /json/i);
  setCustomThemes([]);
});
