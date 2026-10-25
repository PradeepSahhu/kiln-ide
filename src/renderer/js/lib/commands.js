// Command registry: menu items, toolbar buttons, Find Action and keyboard shortcuts all run commands by id.
import { on } from './ipc.js';
import { formatAccelerator, canonicalAccelerator, eventToAccelerator, isPlainTyping } from './keys.js';

const registry = new Map();

export function register(id, title, run, opts = {}) {
  registry.set(id, { id, title, run, ...opts });
}

export function registerAll(list) {
  for (const c of list) register(c.id, c.title, c.run, c);
}

export async function run(id, arg) {
  const c = registry.get(id);
  if (!c) {
    console.warn('Unknown command', id);
    return undefined;
  }
  try {
    return await c.run(arg);
  } catch (err) {
    console.error(`[command ${id}]`, err);
    const { toast } = await import('./ui.js');
    toast({ kind: 'error', title: c.title, message: err.message });
    return undefined;
  }
}

export function allCommands() {
  return [...registry.values()].filter((c) => !c.hidden);
}

export function getCommand(id) {
  return registry.get(id);
}

/** Shortcut labels (first binding of each command), kept in sync with the keymap. */
export const SHORTCUTS = {};

let keymap = { effective: {} };
let index = new Map(); // canonical accelerator -> [command ids]
let recording = false;
let lastKeyDispatch = { id: null, at: 0 };

/** Apply the effective keymap ({ effective: { id: [accelerators] } }) from the main process. */
export function setKeymap(km) {
  keymap = km || { effective: {} };
  for (const k of Object.keys(SHORTCUTS)) delete SHORTCUTS[k];
  index = new Map();
  for (const [id, list] of Object.entries(keymap.effective || {})) {
    if (list && list.length) SHORTCUTS[id] = formatAccelerator(list[0]);
    for (const acc of list || []) {
      const c = canonicalAccelerator(acc);
      if (!c) continue;
      if (!index.has(c)) index.set(c, []);
      index.get(c).push(id);
    }
  }
}

export function getKeymap() {
  return keymap;
}

export function bindingsOf(id) {
  return (keymap.effective && keymap.effective[id]) || [];
}

/** While the Keymap settings record a shortcut, key presses must not run commands. */
export function setRecording(on) {
  recording = !!on;
}

function editableTarget(t) {
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
}

function dispatchKey(e) {
  if (recording) return;
  const acc = eventToAccelerator(e);
  if (!acc) return;
  const ids = index.get(canonicalAccelerator(acc));
  if (!ids) return;
  for (const id of ids) {
    const c = registry.get(id);
    if (!c) continue;
    if (c.when && !c.when()) continue;
    if (editableTarget(e.target) && isPlainTyping(acc)) continue;
    e.preventDefault();
    e.stopPropagation();
    lastKeyDispatch = { id, at: Date.now() };
    run(id);
    return;
  }
}

let lastShift = 0;
let shiftClean = false;

/** Global keys that menus cannot express (double Shift) plus Escape handling. */
export function installKeyHandlers() {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Shift') {
        if (!e.repeat) shiftClean = true;
        return;
      }
      shiftClean = false;
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (e.key !== 'Shift' || !shiftClean) return;
      const now = Date.now();
      if (now - lastShift < 380) {
        lastShift = 0;
        if (recording) return;
        const ids = index.get('DoubleShift') || [];
        const id = ids.find((x) => registry.has(x));
        if (id) run(id);
      } else {
        lastShift = now;
      }
    },
    true,
  );
  window.addEventListener('keydown', dispatchKey, true);
  // A menu accelerator can deliver the same key the window just handled: run it once.
  on('menu:command', ({ id, arg }) => {
    if (id === lastKeyDispatch.id && Date.now() - lastKeyDispatch.at < 250) return;
    run(id, arg);
  });
}
