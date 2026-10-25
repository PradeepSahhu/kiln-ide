'use strict';
// Spec: every IDE command has customizable keyboard shortcuts. A preset (Rider for macOS, or VS Code)
// supplies defaults; user overrides replace, add or remove bindings per command and survive restarts.
// The application menu shows and registers the effective shortcuts; conflicts are reported.
require('../helpers/electron-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const { PRESETS, effectiveKeymap, normalizeAccelerator, isValidAccelerator, conflictsOf } = require('../../src/main/keymap');
const { buildMenuTemplate } = require('../../src/main/menu');

function flatten(items, out = []) {
  for (const it of items) {
    out.push(it);
    if (Array.isArray(it.submenu)) flatten(it.submenu, out);
  }
  return out;
}

test('the Rider preset binds the IDE commands', () => {
  const km = effectiveKeymap({ keymapPreset: 'rider', keymap: {} });
  assert.deepEqual(km['build.build'], ['CmdOrCtrl+F9']);
  assert.deepEqual(km['debug.stepOver'], ['F8']);
  assert.deepEqual(km['navigate.searchEverywhere'], ['DoubleShift']);
  assert.ok(km['navigate.definition'].includes('CmdOrCtrl+B'));
  assert.deepEqual(km['editor.duplicateLine'], ['CmdOrCtrl+D']);
});

test('the VS Code preset maps the common commands', () => {
  const km = effectiveKeymap({ keymapPreset: 'vscode', keymap: {} });
  assert.deepEqual(km['navigate.file'], ['CmdOrCtrl+P']);
  assert.deepEqual(km['navigate.action'], ['CmdOrCtrl+Shift+P']);
  assert.deepEqual(km['debug.stepOver'], ['F10']);
  assert.deepEqual(km['refactor.rename'], ['F2']);
});

test('presets have no conflicting shortcuts', () => {
  for (const name of Object.keys(PRESETS)) assert.deepEqual(conflictsOf(effectiveKeymap({ keymapPreset: name, keymap: {} })), {}, `${name} preset`);
});

test('user overrides replace, add or remove bindings', () => {
  const km = effectiveKeymap({ keymapPreset: 'rider', keymap: { 'build.build': ['Alt+Shift+B'], 'git.commit': [], 'view.knowledgeGraph': ['CmdOrCtrl+Alt+G', 'F6'] } });
  assert.deepEqual(km['build.build'], ['Alt+Shift+B']);
  assert.deepEqual(km['git.commit'], []);
  assert.deepEqual(km['view.knowledgeGraph'], ['CmdOrCtrl+Alt+G', 'F6']);
  // unknown preset falls back to Rider
  assert.deepEqual(effectiveKeymap({ keymapPreset: 'nope', keymap: {} })['build.build'], ['CmdOrCtrl+F9']);
});

test('accelerators are normalized and validated', () => {
  assert.equal(normalizeAccelerator('shift+cmdorctrl+k'), 'CmdOrCtrl+Shift+K');
  assert.equal(normalizeAccelerator('alt+f7'), 'Alt+F7');
  assert.equal(normalizeAccelerator('Command+Option+r'), 'Cmd+Alt+R');
  assert.equal(normalizeAccelerator('ctrl+return'), 'Ctrl+Enter');
  assert.equal(normalizeAccelerator('CmdOrCtrl+='), 'CmdOrCtrl+=');
  assert.ok(isValidAccelerator('CmdOrCtrl+Shift+F9'));
  assert.ok(isValidAccelerator('DoubleShift'));
  assert.ok(isValidAccelerator('Alt+Up'));
  assert.ok(!isValidAccelerator('Cmd+'));
  assert.ok(!isValidAccelerator('Shift'));
  assert.ok(!isValidAccelerator('Cmd+Shift+Banana'));
  assert.ok(!isValidAccelerator('A+B'));
});

test('conflicts lists shortcuts bound to more than one command', () => {
  assert.deepEqual(conflictsOf({ a: ['CmdOrCtrl+K'], b: ['shift+F6', 'cmdorctrl+k'], c: ['F8'] }), { 'CmdOrCtrl+K': ['a', 'b'] });
});

test('the application menu uses the effective keymap', () => {
  const keymap = effectiveKeymap({ keymapPreset: 'rider', keymap: { 'build.build': ['Alt+Shift+B'], 'git.commit': [] } });
  const items = flatten(buildMenuTemplate({ recent: [], send: () => {}, keymap }));
  const find = (id) => items.filter((i) => i.commandId === id);
  assert.equal(find('build.build')[0].accelerator, 'Alt+Shift+B');
  assert.equal(find('git.commit')[0].accelerator, undefined);
  assert.equal(find('debug.stepOver')[0].accelerator, 'F8');
  assert.equal(find('navigate.searchEverywhere')[0].accelerator, undefined, 'double Shift is handled by the window, not the menu');
  assert.equal(find('code.format').filter((i) => i.accelerator).length, 1, 'a command listed twice registers its shortcut once');
});

test('renderer key helpers: labels, recording and matching', async () => {
  const { formatAccelerator, eventToAccelerator, matchesEvent, canonicalAccelerator } = await import('../../src/renderer/js/lib/keys.js');
  assert.equal(formatAccelerator('CmdOrCtrl+Shift+K', true), '⇧⌘K');
  assert.equal(formatAccelerator('Alt+CmdOrCtrl+R', true), '⌥⌘R');
  assert.equal(formatAccelerator('Ctrl+D', true), '⌃D');
  assert.equal(formatAccelerator('DoubleShift', true), '⇧⇧');
  assert.equal(formatAccelerator('Alt+F7', true), '⌥F7');
  assert.equal(formatAccelerator('CmdOrCtrl+Shift+K', false), 'Ctrl+Shift+K');
  assert.equal(formatAccelerator('Alt+Up', true), '⌥↑');

  assert.equal(eventToAccelerator({ metaKey: true, shiftKey: true, code: 'KeyK', key: 'K' }, true), 'CmdOrCtrl+Shift+K');
  assert.equal(eventToAccelerator({ altKey: true, code: 'KeyF', key: 'ƒ' }, true), 'Alt+F', 'uses the physical key, not the Option character');
  assert.equal(eventToAccelerator({ code: 'F8', key: 'F8' }, true), 'F8');
  assert.equal(eventToAccelerator({ ctrlKey: true, code: 'Backquote', key: '`' }, true), 'Ctrl+`');
  assert.equal(eventToAccelerator({ ctrlKey: true, code: 'KeyK', key: 'k' }, false), 'CmdOrCtrl+K');
  assert.equal(eventToAccelerator({ shiftKey: true, code: 'ShiftLeft', key: 'Shift' }, true), null, 'modifier alone is not a shortcut');

  assert.ok(matchesEvent({ metaKey: true, shiftKey: true, code: 'KeyK' }, 'CmdOrCtrl+Shift+K', true));
  assert.ok(!matchesEvent({ ctrlKey: true, shiftKey: true, code: 'KeyK' }, 'CmdOrCtrl+Shift+K', true));
  assert.ok(matchesEvent({ ctrlKey: true, shiftKey: true, code: 'KeyK' }, 'CmdOrCtrl+Shift+K', false));
  assert.ok(matchesEvent({ code: 'F8' }, 'F8', true));
  assert.ok(!matchesEvent({ code: 'F8', shiftKey: true }, 'F8', true));
  assert.equal(canonicalAccelerator('Cmd+Shift+K', true), canonicalAccelerator('shift+cmdorctrl+k', true));
});
