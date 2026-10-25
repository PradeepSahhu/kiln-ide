// Toasts, dialogs and context menus driven through the store.
import { store } from './store.js';
import { uid } from './util.js';

export function toast({ title, message = '', kind = 'info', actions = [], timeout } = {}) {
  const id = uid('toast');
  const ms = timeout != null ? timeout : kind === 'error' ? 12000 : 6000;
  store.set((s) => ({ toasts: [...s.toasts.slice(-4), { id, title, message, kind, actions }] }));
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id) {
  store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/**
 * Open a modal component by type; resolves with the value it closes with. Modals stack, so a
 * confirmation opened from a dialog appears above it and returns to it.
 */
export function openModal(type, props = {}) {
  return new Promise((resolve) => {
    store.set((s) => ({ modals: [...s.modals, { type, props, resolve, key: uid('m') }] }));
  });
}

/** Close the topmost modal (or the one with `key`). */
export function closeModal(value, key) {
  const list = store.get().modals;
  const m = key ? list.find((x) => x.key === key) : list[list.length - 1];
  if (!m) return;
  store.set({ modals: list.filter((x) => x !== m) });
  if (m.resolve) m.resolve(value);
}

export function closeAllModals() {
  for (const m of store.get().modals.slice().reverse()) closeModal(null, m.key);
}

export function confirm(opts) {
  return openModal('confirm', opts);
}

export function prompt(opts) {
  return openModal('prompt', opts);
}

export function showContextMenu(event, items) {
  event.preventDefault();
  event.stopPropagation();
  store.set({ contextMenu: { x: event.clientX, y: event.clientY, items: items.filter(Boolean) } });
}

export function closeContextMenu() {
  if (store.get().contextMenu) store.set({ contextMenu: null });
}

export function openPopup(popup) {
  store.set({ popup });
}

export function closePopup() {
  if (store.get().popup) store.set({ popup: null });
}

export function errorToast(title, err) {
  return toast({ kind: 'error', title, message: (err && err.message) || String(err) });
}
