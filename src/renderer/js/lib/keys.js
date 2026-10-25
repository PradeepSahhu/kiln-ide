// Keyboard shortcut helpers shared by the dispatcher and the Keymap settings: display labels
// (⇧⌘K on macOS), recording accelerators from key events (physical keys, so ⌥F is "Alt+F" and not
// "ƒ"), and matching events against Electron-style accelerators.
const detectMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

const CODE_KEYS = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', NumpadAdd: 'Plus', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/', NumpadDecimal: '.',
};
const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS|Fn|CapsLock)/;
const MOD_ALIASES = { cmdorctrl: 'CmdOrCtrl', commandorcontrol: 'CmdOrCtrl', cmd: 'Cmd', command: 'Cmd', meta: 'Cmd', super: 'Cmd', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift' };
const NAMED = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', plus: 'Plus' };
const MAC_SYMBOLS = { Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↩', Escape: '⎋', Backspace: '⌫', Delete: '⌦', Tab: '⇥', Space: 'Space', PageUp: '⇞', PageDown: '⇟', Home: '↖', End: '↘', Plus: '+' };

function keyFromCode(code) {
  if (!code) return null;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (m) return m[1];
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code] || null;
}

function normalizeKey(k) {
  if (!k) return null;
  if (/^[a-z0-9]$/i.test(k)) return k.toUpperCase();
  if (/^f([1-9]|1\d|2[0-4])$/i.test(k)) return k.toUpperCase();
  if ('`-=[]\\;\',./*'.includes(k) && k.length === 1) return k;
  return NAMED[k.toLowerCase()] || null;
}

/** { cmd, ctrl, alt, shift, key } with CmdOrCtrl resolved for the platform; null if invalid. */
export function parseAccelerator(acc, mac = detectMac()) {
  if (!acc) return null;
  if (acc === 'DoubleShift') return { doubleShift: true, cmd: false, ctrl: false, alt: false, shift: true, key: 'Shift' };
  const parts = acc.split('+').map((p) => p.trim());
  const key = normalizeKey(parts.pop());
  if (!key) return null;
  const r = { cmd: false, ctrl: false, alt: false, shift: false, key };
  for (const p of parts) {
    const m = MOD_ALIASES[p.toLowerCase()];
    if (!m) return null;
    if (m === 'CmdOrCtrl') r[mac ? 'cmd' : 'ctrl'] = true;
    else r[m.toLowerCase()] = true;
  }
  return r;
}

/** Comparable identity of an accelerator on this platform. */
export function canonicalAccelerator(acc, mac = detectMac()) {
  const p = parseAccelerator(acc, mac);
  if (!p) return null;
  if (p.doubleShift) return 'DoubleShift';
  return `${p.cmd ? 'Cmd+' : ''}${p.ctrl ? 'Ctrl+' : ''}${p.alt ? 'Alt+' : ''}${p.shift ? 'Shift+' : ''}${p.key}`;
}

/** Accelerator for a key event, portable (the platform's primary modifier becomes CmdOrCtrl). */
export function eventToAccelerator(e, mac = detectMac()) {
  if (!e || MODIFIER_CODES.test(e.code || '') || /^(Shift|Control|Alt|Meta)$/.test(e.key || '')) return null;
  const key = keyFromCode(e.code) || normalizeKey(e.key && e.key.length === 1 ? e.key : e.key || '');
  if (!key) return null;
  const parts = [];
  const primary = mac ? e.metaKey : e.ctrlKey;
  if (primary) parts.push('CmdOrCtrl');
  if (mac && e.ctrlKey) parts.push('Ctrl');
  if (!mac && e.metaKey) parts.push('Cmd');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

export function matchesEvent(e, acc, mac = detectMac()) {
  const a = canonicalAccelerator(acc, mac);
  const b = canonicalAccelerator(eventToAccelerator(e, mac), mac);
  return !!a && a === b;
}

/** Display label: ⇧⌘K on macOS (⌃⌥⇧⌘ order), Ctrl+Shift+K elsewhere. */
export function formatAccelerator(acc, mac = detectMac()) {
  const p = parseAccelerator(acc, mac);
  if (!p) return acc || '';
  if (p.doubleShift) return mac ? '⇧⇧' : 'Shift Shift';
  if (mac) return `${p.ctrl ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.cmd ? '⌘' : ''}${MAC_SYMBOLS[p.key] || p.key}`;
  return [p.ctrl && 'Ctrl', p.cmd && 'Win', p.alt && 'Alt', p.shift && 'Shift', p.key].filter(Boolean).join('+');
}

/** Shortcuts without Ctrl/Cmd/Alt (e.g. Shift+A) would swallow typing in text fields. */
export function isPlainTyping(acc, mac = detectMac()) {
  const p = parseAccelerator(acc, mac);
  if (!p || p.doubleShift) return false;
  if (p.cmd || p.ctrl || p.alt) return false;
  return !/^F\d+$/.test(p.key) && !['Escape', 'Up', 'Down', 'PageUp', 'PageDown'].includes(p.key) ? true : false;
}

export function hasPrimaryModifier(acc, mac = detectMac()) {
  const p = parseAccelerator(acc, mac);
  return !!p && (mac ? p.cmd : p.ctrl);
}
