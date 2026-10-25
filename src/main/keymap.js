'use strict';
// Keyboard shortcuts: presets (Rider for macOS, VS Code) plus per-command user overrides stored in
// settings.keymap ({ commandId: [accelerators] }, [] = no shortcut). Accelerators use Electron's
// syntax; "DoubleShift" is the Rider Search Everywhere gesture handled by the window.
const mac = process.platform === 'darwin';

const RIDER = {
  'view.settings': [mac ? 'Cmd+,' : 'Ctrl+Alt+S'],
  'project.new': ['CmdOrCtrl+Shift+N'],
  'file.newFile': ['CmdOrCtrl+N'],
  'project.open': ['CmdOrCtrl+Shift+Alt+O'],
  'file.save': ['CmdOrCtrl+S'],
  'file.saveAll': ['CmdOrCtrl+Alt+S'],
  'file.closeTab': ['CmdOrCtrl+W'],
  'file.reopenClosed': ['CmdOrCtrl+Shift+T'],
  'edit.findInFiles': ['CmdOrCtrl+Shift+F'],
  'edit.replaceInFiles': ['CmdOrCtrl+Shift+R'],
  'edit.replace': ['CmdOrCtrl+R'],
  'edit.toggleComment': ['CmdOrCtrl+/'],
  'code.format': ['CmdOrCtrl+Alt+L'],
  'code.quickFix': ['Alt+Enter'],
  'refactor.rename': ['Shift+F6'],
  'navigate.searchEverywhere': ['DoubleShift'],
  'navigate.action': ['CmdOrCtrl+Shift+A'],
  'navigate.file': [mac ? 'Cmd+Shift+O' : 'Ctrl+Shift+N'],
  'navigate.symbol': ['CmdOrCtrl+Alt+O'],
  'navigate.class': ['CmdOrCtrl+O'],
  'navigate.recent': ['CmdOrCtrl+E'],
  'navigate.line': [mac ? 'Cmd+L' : 'Ctrl+G'],
  'navigate.definition': ['CmdOrCtrl+B', 'F12'],
  'navigate.implementation': ['CmdOrCtrl+Alt+B'],
  'navigate.usages': ['Alt+F7', 'Shift+F12'],
  'navigate.back': ['CmdOrCtrl+['],
  'navigate.forward': ['CmdOrCtrl+]'],
  'navigate.toggleBookmark': ['F3'],
  'navigate.bookmarks': ['CmdOrCtrl+F3'],
  'view.project': ['CmdOrCtrl+1'],
  'view.commit': ['CmdOrCtrl+0'],
  'view.git': ['CmdOrCtrl+9'],
  'view.structure': ['CmdOrCtrl+7'],
  'view.problems': ['CmdOrCtrl+6'],
  'view.debug': ['CmdOrCtrl+5'],
  'view.run': ['CmdOrCtrl+4'],
  'view.terminal': ['Alt+F12'],
  'view.claude': ['CmdOrCtrl+Shift+J'],
  'view.theme': ['Ctrl+`'],
  'view.zoomIn': ['CmdOrCtrl+='],
  'view.zoomOut': ['CmdOrCtrl+-'],
  'build.build': ['CmdOrCtrl+F9'],
  'build.rebuild': ['CmdOrCtrl+Shift+F9'],
  'build.cancel': ['CmdOrCtrl+Alt+F9'],
  'run.run': ['Ctrl+R'],
  'run.stop': ['CmdOrCtrl+F2'],
  'debug.start': [mac ? 'Ctrl+D' : 'Shift+F9'],
  'debug.resume': [mac ? 'Alt+Cmd+R' : 'F9'],
  'debug.stepOver': ['F8'],
  'debug.stepInto': ['F7'],
  'debug.stepOut': ['Shift+F8'],
  'debug.runToCursor': ['Alt+F9'],
  'debug.evaluate': ['Alt+F8'],
  'debug.toggleBreakpoint': ['CmdOrCtrl+F8'],
  'debug.viewBreakpoints': ['CmdOrCtrl+Shift+F8'],
  'git.commit': ['CmdOrCtrl+K'],
  'git.push': ['CmdOrCtrl+Shift+K'],
  'git.pull': ['CmdOrCtrl+T'],
  'git.branches': ['Ctrl+Shift+`'],
  'dev.tools': ['Alt+CmdOrCtrl+I'],
  'dev.reload': ['CmdOrCtrl+Shift+F5'],
  'editor.duplicateLine': ['CmdOrCtrl+D'],
  'editor.deleteLine': ['CmdOrCtrl+Backspace'],
  'editor.addNextOccurrence': [mac ? 'Ctrl+G' : 'Alt+J'],
  'editor.moveLineUp': ['Alt+Shift+Up'],
  'editor.moveLineDown': ['Alt+Shift+Down'],
  'editor.expandSelection': ['Alt+Up'],
  'editor.shrinkSelection': ['Alt+Down'],
};

const VSCODE = {
  ...RIDER,
  'view.settings': ['CmdOrCtrl+,'],
  'navigate.file': ['CmdOrCtrl+P'],
  'navigate.action': ['CmdOrCtrl+Shift+P'],
  'navigate.symbol': ['CmdOrCtrl+T'],
  'navigate.class': [],
  'navigate.line': ['Ctrl+G'],
  'navigate.definition': ['F12'],
  'navigate.implementation': ['CmdOrCtrl+F12'],
  'navigate.usages': ['Shift+F12'],
  'navigate.back': ['Ctrl+-'],
  'navigate.forward': ['Ctrl+Shift+-'],
  'navigate.toggleBookmark': [],
  'navigate.bookmarks': [],
  'refactor.rename': ['F2'],
  'code.quickFix': ['CmdOrCtrl+.'],
  'code.format': ['Alt+Shift+F'],
  'edit.replace': ['CmdOrCtrl+Alt+F'],
  'edit.replaceInFiles': ['CmdOrCtrl+Shift+H'],
  'view.project': ['CmdOrCtrl+Shift+E'],
  'view.commit': ['Ctrl+Shift+G'],
  'view.git': [],
  'view.problems': ['CmdOrCtrl+Shift+M'],
  'view.debug': ['CmdOrCtrl+Shift+D'],
  'view.terminal': ['Ctrl+`'],
  'view.theme': [],
  'build.build': ['CmdOrCtrl+Shift+B'],
  'build.rebuild': [],
  'build.cancel': [],
  'run.run': ['Ctrl+F5'],
  'run.stop': ['Shift+F5'],
  'debug.start': ['F5'],
  'debug.resume': [],
  'debug.stepOver': ['F10'],
  'debug.stepInto': ['F11'],
  'debug.stepOut': ['Shift+F11'],
  'debug.runToCursor': [],
  'debug.evaluate': [],
  'debug.toggleBreakpoint': ['F9'],
  'debug.viewBreakpoints': [],
  'git.commit': [],
  'git.push': [],
  'git.pull': [],
  'git.branches': [],
  'editor.duplicateLine': ['Alt+Shift+Down'],
  'editor.deleteLine': ['CmdOrCtrl+Shift+K'],
  'editor.addNextOccurrence': ['CmdOrCtrl+D'],
  'editor.moveLineUp': ['Alt+Up'],
  'editor.moveLineDown': ['Alt+Down'],
  'editor.expandSelection': ['Ctrl+Shift+Cmd+Right'],
  'editor.shrinkSelection': ['Ctrl+Shift+Cmd+Left'],
};

const PRESETS = { rider: RIDER, vscode: VSCODE };
const PRESET_NAMES = { rider: mac ? 'Rider (macOS)' : 'Rider', vscode: 'VS Code' };

// ------------------------------------------------------------------ syntax

const MODS = { cmdorctrl: 'CmdOrCtrl', commandorcontrol: 'CmdOrCtrl', cmd: 'Cmd', command: 'Cmd', meta: 'Cmd', super: 'Cmd', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', altgr: 'Alt', shift: 'Shift' };
const MOD_ORDER = ['CmdOrCtrl', 'Cmd', 'Ctrl', 'Alt', 'Shift'];
const NAMED = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', plus: 'Plus',
};
const PUNCT = new Set(['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/']);

function normalizeKey(k) {
  if (!k) return null;
  if (/^[a-z0-9]$/i.test(k)) return k.toUpperCase();
  if (/^f([1-9]|1\d|2[0-4])$/i.test(k)) return k.toUpperCase();
  if (PUNCT.has(k)) return k;
  return NAMED[k.toLowerCase()] || null;
}

/** Parse an accelerator into { mods: [...], key } or null when it is not valid. */
function parse(acc) {
  if (typeof acc !== 'string' || !acc.trim()) return null;
  if (acc.trim().toLowerCase() === 'doubleshift') return { mods: [], key: 'DoubleShift' };
  // "+" separates parts; a trailing "+" would be an empty key.
  const parts = acc.split('+').map((p) => p.trim());
  const keyPart = parts.pop();
  const mods = [];
  for (const p of parts) {
    const m = MODS[p.toLowerCase()];
    if (!m) return null;
    if (!mods.includes(m)) mods.push(m);
  }
  const key = normalizeKey(keyPart);
  if (!key) return null;
  return { mods: MOD_ORDER.filter((m) => mods.includes(m)), key };
}

function normalizeAccelerator(acc) {
  const p = parse(acc);
  if (!p) return null;
  return p.key === 'DoubleShift' ? 'DoubleShift' : [...p.mods, p.key].join('+');
}

function isValidAccelerator(acc) {
  return !!parse(acc);
}

/** Physical-key identity used to detect conflicts (CmdOrCtrl resolves per platform). */
function physical(acc, isMac = mac) {
  const p = parse(acc);
  if (!p) return null;
  if (p.key === 'DoubleShift') return 'DoubleShift';
  const mods = new Set(p.mods.map((m) => (m === 'CmdOrCtrl' ? (isMac ? 'Cmd' : 'Ctrl') : m)));
  return [...['Cmd', 'Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m)), p.key].join('+');
}

// ----------------------------------------------------------------- keymaps

function asList(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && isValidAccelerator(x)).map(normalizeAccelerator);
  if (typeof v === 'string') return v ? [normalizeAccelerator(v)].filter(Boolean) : [];
  return [];
}

/** { commandId: [accelerators] } for the settings' preset plus overrides. */
function effectiveKeymap(s = {}) {
  const preset = PRESETS[s.keymapPreset] || RIDER;
  const out = {};
  for (const [id, list] of Object.entries(preset)) out[id] = asList(list);
  for (const [id, list] of Object.entries(s.keymap || {})) out[id] = asList(list);
  return out;
}

/** { accelerator: [commandIds] } for shortcuts assigned to more than one command. */
function conflictsOf(keymap, isMac = mac) {
  const seen = new Map();
  for (const [id, list] of Object.entries(keymap)) {
    for (const acc of list || []) {
      const k = physical(acc, isMac);
      if (!k) continue;
      if (!seen.has(k)) seen.set(k, { label: normalizeAccelerator(acc), ids: [] });
      const e = seen.get(k);
      if (!e.ids.includes(id)) e.ids.push(id);
    }
  }
  const out = {};
  for (const e of seen.values()) if (e.ids.length > 1) out[e.label] = e.ids;
  return out;
}

/** First binding usable as a menu accelerator (the window handles DoubleShift itself). */
function menuAccelerator(keymap, id) {
  return ((keymap && keymap[id]) || []).find((a) => a !== 'DoubleShift');
}

function describe(s = {}) {
  const presetName = PRESETS[s.keymapPreset] ? s.keymapPreset : 'rider';
  return {
    preset: presetName,
    presets: Object.keys(PRESETS).map((id) => ({ id, name: PRESET_NAMES[id] })),
    defaults: effectiveKeymap({ keymapPreset: presetName, keymap: {} }),
    overrides: s.keymap || {},
    effective: effectiveKeymap(s),
  };
}

module.exports = { PRESETS, effectiveKeymap, normalizeAccelerator, isValidAccelerator, conflictsOf, menuAccelerator, physical, describe };
