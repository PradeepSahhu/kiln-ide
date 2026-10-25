// Minimal global store. Components subscribe to a selected slice and re-render only when that
// slice changes (shallow comparison), which keeps typing, output streaming and resizing fast.
import { useEffect, useReducer, useRef } from './preact.js';

export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

function createStore(initial) {
  let state = initial;
  const subs = new Set();
  let scheduled = false;
  const notify = () => {
    scheduled = false;
    for (const fn of subs) fn(state);
  };
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      if (!next) return;
      state = { ...state, ...next };
      // Batch notifications into one microtask so bursts of updates cause one render pass.
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(notify);
      }
    },
    /** Update a nested slice: store.update('layout', { left: 'project' }). */
    update(key, patch) {
      const cur = state[key];
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
      this.set({ [key]: next });
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const store = createStore({
  ready: false,
  settings: null,
  appInfo: null,
  toolchain: null,
  recent: [],
  project: null, // { root, name, detection, git }
  layout: { left: 'project', right: null, bottom: 'build', leftWidth: 300, rightWidth: 460, bottomHeight: 280, zen: false },
  editor: { tabs: [], active: null, cursor: null, selection: '', eol: 'LF', encoding: 'UTF-8', language: '' },
  git: { status: null, branches: null, stashes: [], log: [], loading: false, console: [] },
  build: { running: false, id: null, steps: [], status: null, errors: 0, warnings: 0, startedAt: null, endedAt: null, mode: null },
  problems: { build: [], live: {} }, // live: { [file]: [problem] } from on-save checks / language servers
  runs: { configs: [], selected: null, sessions: [], active: null },
  terminals: { list: [], active: null },
  claude: { chats: {}, active: 'chat-1', probe: null, status: {} },
  index: { state: 'idle' },
  lsp: {},
  usages: null,
  modals: [], // stack of { type, props, resolve, key }
  popup: null,
  contextMenu: null,
  toasts: [],
  quickInput: null,
});

/** Subscribe a component to a slice of the store. */
export function useStore(selector, eq = shallowEqual) {
  const [, force] = useReducer((x) => x + 1, 0);
  const sel = useRef(selector);
  sel.current = selector;
  const value = selector(store.get());
  const last = useRef(value);
  last.current = value;
  useEffect(
    () =>
      store.subscribe((s) => {
        const next = sel.current(s);
        if (!eq(next, last.current)) force();
      }),
    [],
  );
  return value;
}
