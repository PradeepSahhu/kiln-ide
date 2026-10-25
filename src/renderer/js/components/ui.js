// Shared UI pieces: virtualized list, splitters, tool window frame, toasts, context menu, popups.
import { html, useState, useEffect, useRef, useLayoutEffect, useCallback } from '../lib/preact.js';
import { useStore, store } from '../lib/store.js';
import { Icon, KindIcon } from '../lib/icons.js';
import { cls } from '../lib/util.js';
import { dismissToast, closeContextMenu, closePopup } from '../lib/ui.js';

/** Fixed-row-height virtual list: renders only visible rows, so thousands of items stay fast. */
export function VirtualList({ items, rowHeight = 24, render, className = '', onKeyDown, scrollTo, overscan = 12, testid }) {
  const ref = useRef(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setView({ top: el.scrollTop, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || scrollTo == null || scrollTo < 0) return;
    const y = scrollTo * rowHeight;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = y + rowHeight - el.clientHeight;
  }, [scrollTo]);
  const start = Math.max(0, Math.floor(view.top / rowHeight) - overscan);
  const end = Math.min(items.length, Math.ceil((view.top + view.height) / rowHeight) + overscan);
  const rows = [];
  for (let i = start; i < end; i++) rows.push(render(items[i], i, { position: 'absolute', top: `${i * rowHeight}px`, left: 0, right: 0, height: `${rowHeight}px` }));
  return html`<div class=${cls('vlist', className)} ref=${ref} tabindex="0" onKeyDown=${onKeyDown} data-testid=${testid} onScroll=${(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
    <div class="vlist-inner" style=${{ height: `${items.length * rowHeight}px` }}>${rows}</div>
  </div>`;
}

/** Drag handle that resizes a tool window; `onResize(delta)` receives pixel deltas. */
export function Splitter({ dir = 'v', onResize, onEnd }) {
  const [drag, setDrag] = useState(false);
  const down = (e) => {
    e.preventDefault();
    let last = dir === 'v' ? e.clientX : e.clientY;
    setDrag(true);
    const move = (ev) => {
      const cur = dir === 'v' ? ev.clientX : ev.clientY;
      onResize(cur - last);
      last = cur;
    };
    const up = () => {
      setDrag(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      if (onEnd) onEnd();
    };
    document.body.style.cursor = dir === 'v' ? 'col-resize' : 'row-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return html`<div class=${cls('splitter', dir, drag && 'dragging')} onMouseDown=${down}></div>`;
}

export function ToolWindow({ side, title, actions, tabs, children, onHide, testid }) {
  return html`<div class=${cls('tool-window', side)} data-testid=${testid}>
    <div class="tw-header">
      <span class="tw-title">${title}</span>
      ${tabs ? html`<div class="tw-tabs">${tabs}</div>` : null}
      <div class="spacer"></div>
      ${actions}
      ${onHide ? html`<button class="icon-btn sm" title="Hide" onClick=${onHide}><${Icon} name="hide" /></button>` : null}
    </div>
    <div class="tw-body">${children}</div>
  </div>`;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return html`<div class="toasts">
    ${toasts.map(
      (t) => html`<div class="toast" key=${t.id} data-testid="toast" data-kind=${t.kind}>
        <${Icon} name=${t.kind === 'error' ? 'error' : t.kind === 'warning' ? 'warning' : t.kind === 'success' ? 'success' : 'info'} className=${t.kind === 'error' ? 'sev-error' : t.kind === 'warning' ? 'sev-warning' : t.kind === 'success' ? 'ok' : 'sev-info'} />
        <div class="t-body">
          ${t.title ? html`<div class="t-title">${t.title}</div>` : null}
          ${t.message ? html`<div class="t-msg">${t.message}</div>` : null}
          ${t.actions && t.actions.length
            ? html`<div class="t-actions">${t.actions.map((a) => html`<a onClick=${() => { dismissToast(t.id); a.run(); }}>${a.label}</a>`)}</div>`
            : null}
        </div>
        <button class="icon-btn sm" onClick=${() => dismissToast(t.id)}><${Icon} name="close" /></button>
      </div>`,
    )}
  </div>`;
}

export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(menu.x, window.innerWidth - r.width - 6), y: Math.min(menu.y, window.innerHeight - r.height - 6) });
  }, [menu]);
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => closeContextMenu();
    const key = (e) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', close);
    };
  }, [menu]);
  if (!menu) return null;
  return html`<div class="context-menu" ref=${ref} style=${{ left: `${(pos || menu).x}px`, top: `${(pos || menu).y}px`, visibility: pos ? 'visible' : 'hidden' }} onMouseDown=${(e) => e.stopPropagation()}>
    ${menu.items.map((it) =>
      it.separator
        ? html`<div class="sep"></div>`
        : html`<div class=${cls('item', it.disabled && 'disabled', it.danger && 'danger')} onClick=${() => { if (it.disabled) return; closeContextMenu(); it.run && it.run(); }}>
            ${it.icon ? html`<${Icon} name=${it.icon} />` : html`<span style="width:16px"></span>`}
            <span>${it.label}</span>${it.shortcut ? html`<span class="shortcut">${it.shortcut}</span>` : null}
          </div>`,
    )}
  </div>`;
}

/** Generic list popup (Choose Declaration, Context Actions, ...). */
export function PopupHost() {
  const popup = useStore((s) => s.popup);
  const [sel, setSel] = useState(0);
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => {
    setSel(0);
    setQ('');
    if (popup) setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
  }, [popup]);
  if (!popup || popup.type !== 'list') return null;
  const items = popup.items.filter((it) => it.separator || !q || it.label.toLowerCase().includes(q.toLowerCase()));
  const selectable = items.filter((it) => !it.separator);
  const runAt = (i) => {
    const it = selectable[i];
    if (!it) return;
    closePopup();
    it.run();
  };
  const key = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, selectable.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') runAt(sel);
    else if (e.key === 'Escape') closePopup();
  };
  let idx = -1;
  return html`<div class="overlay" onMouseDown=${closePopup}>
    <div class="popup" style=${{ left: '50%', top: '22%', transform: 'translateX(-50%)', width: '520px' }} onMouseDown=${(e) => e.stopPropagation()}>
      <div class="popup-header">${popup.title}</div>
      <div class="popup-search"><input class="input" ref=${inputRef} value=${q} onInput=${(e) => { setQ(e.target.value); setSel(0); }} onKeyDown=${key} placeholder="Filter" /></div>
      <div class="popup-body">
        ${items.map((it) => {
          if (it.separator) return html`<div class="popup-sep"></div>`;
          idx++;
          const i = idx;
          return html`<div class=${cls('popup-item', i === sel && 'selected')} onMouseEnter=${() => setSel(i)} onClick=${() => runAt(i)}>
            ${it.kind ? html`<${KindIcon} kind=${it.kind} />` : it.icon ? html`<${Icon} name=${it.icon} />` : null}
            <span class="ellipsis">${it.label}</span>${it.hint ? html`<span class="hint" style="margin-left:auto">${it.hint}</span>` : null}
          </div>`;
        })}
        ${!selectable.length ? html`<div class="empty">Nothing here</div>` : null}
      </div>
    </div>
  </div>`;
}

export function useOutsideClose(ref, onClose, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const k = (e) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', h), 0);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k);
    };
  }, [active]);
}

export function Spinner({ size = 14 }) {
  return html`<${Icon} name="spinner" size=${size} className="spin" />`;
}

export function Empty({ children }) {
  return html`<div class="empty">${children}</div>`;
}

export const useForceUpdate = () => {
  const [, set] = useState(0);
  return useCallback(() => set((x) => x + 1), []);
};

export { store };
