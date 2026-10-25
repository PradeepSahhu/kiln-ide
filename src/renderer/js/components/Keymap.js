// Settings › Keymap: every IDE action with its shortcuts. Pick a preset, search by name or by pressing
// a shortcut, record new shortcuts (with conflict warnings), remove or reset them.
import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { useStore, store } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { invoke } from '../lib/ipc.js';
import { allCommands, getCommand, setKeymap, setRecording } from '../lib/commands.js';
import { formatAccelerator, canonicalAccelerator, eventToAccelerator } from '../lib/keys.js';
import { cls, fuzzy } from '../lib/util.js';
import { confirm, errorToast } from '../lib/ui.js';

const GROUPS = [
  ['file', 'File'], ['project', 'Project'], ['edit', 'Edit'], ['editor', 'Editor'], ['code', 'Code'], ['refactor', 'Refactoring'], ['navigate', 'Navigate'],
  ['view', 'View & Tool Windows'], ['build', 'Build'], ['run', 'Run'], ['debug', 'Debug'], ['tests', 'Tests'], ['git', 'Version Control'], ['claude', 'Claude'], ['flow', 'Message Flow'], ['help', 'Help'], ['dev', 'Developer'],
];

async function apply(promise) {
  try {
    const km = await promise;
    setKeymap(km);
    store.set({ keymap: km });
  } catch (err) {
    errorToast('Could not change the shortcut', err);
  }
}

/** While active, every key press goes to `handler` (window capture: focus does not matter). */
function useKeyCapture(active, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return undefined;
    setRecording(true);
    const k = (e) => {
      if (e.target && e.target.closest && e.target.closest('input:not([type=checkbox]), textarea, select')) return;
      e.preventDefault();
      e.stopPropagation();
      ref.current(e);
    };
    window.addEventListener('keydown', k, true);
    return () => {
      window.removeEventListener('keydown', k, true);
      setRecording(false);
    };
  }, [active]);
}

/** Captures the next key combination; Enter saves, Escape cancels, Backspace clears. */
function Recorder({ title, onSave, onCancel, conflictsFor }) {
  const [acc, setAcc] = useState(null);
  const [takeOver, setTakeOver] = useState(true);
  const accRef = useRef(null);
  accRef.current = acc;
  const takeRef = useRef(takeOver);
  takeRef.current = takeOver;
  const ref = useRef(null);
  useEffect(() => {
    setTimeout(() => ref.current && ref.current.focus(), 0);
  }, []);
  useKeyCapture(true, (e) => {
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (plain && e.key === 'Escape') return onCancel();
    if (plain && e.key === 'Enter' && accRef.current) return onSave(accRef.current, takeRef.current);
    if (plain && e.key === 'Backspace') return setAcc(null);
    const a = eventToAccelerator(e);
    if (a) setAcc(a);
  });
  const conflicts = acc ? conflictsFor(acc) : [];
  return html`<div class="km-recorder" data-testid="keymap-recorder">
    <div class="muted" style="font-size:12px">Press the keys for <b style="color:var(--text)">${title}</b></div>
    <div class="km-capture" ref=${ref} tabIndex="0">${acc ? formatAccelerator(acc) : 'Waiting for a key combination…'}</div>
    ${conflicts.length
      ? html`<div class="km-conflict"><${Icon} name="warning" size=${13} />Already assigned to ${conflicts.map((c) => c.title).join(', ')}
          <label class="checkbox" style="margin-left:8px"><input type="checkbox" checked=${takeOver} onChange=${(e) => setTakeOver(e.target.checked)} />Remove it there</label></div>`
      : null}
    <div class="row" style="gap:6px;margin-top:8px">
      <button class="btn small primary" data-testid="keymap-save" disabled=${!acc} onMouseDown=${(e) => e.preventDefault()} onClick=${() => onSave(acc, takeOver)}>Save</button>
      <button class="btn small" onMouseDown=${(e) => e.preventDefault()} onClick=${onCancel}>Cancel</button>
      <span class="muted" style="font-size:11px;margin-left:auto">↩ save · ⌫ clear · ⎋ cancel</span>
    </div>
  </div>`;
}

export function KeymapSettings() {
  const km = useStore((s) => s.keymap);
  const [q, setQ] = useState('');
  const [byKey, setByKey] = useState(false);
  const [keyFilter, setKeyFilter] = useState(null);
  const [recordingFor, setRecordingFor] = useState(null);
  const effective = (km && km.effective) || {};
  const overrides = (km && km.overrides) || {};

  const byAccel = useMemo(() => {
    const m = new Map();
    for (const [id, list] of Object.entries(effective)) {
      for (const a of list) {
        const c = canonicalAccelerator(a);
        if (!c) continue;
        if (!m.has(c)) m.set(c, []);
        m.get(c).push(id);
      }
    }
    return m;
  }, [km]);

  const commands = useMemo(() => {
    const list = allCommands().filter((c) => !c.hidden);
    const seen = new Set(list.map((c) => c.id));
    for (const id of Object.keys(effective)) if (!seen.has(id) && getCommand(id)) list.push(getCommand(id));
    return list;
  }, [km]);

  const rows = useMemo(() => {
    let list = commands;
    if (keyFilter) {
      const c = canonicalAccelerator(keyFilter);
      list = list.filter((x) => (effective[x.id] || []).some((a) => canonicalAccelerator(a) === c));
    } else if (q.trim()) {
      list = list.map((x) => ({ x, m: fuzzy(q.trim(), x.title) || (x.id.toLowerCase().includes(q.trim().toLowerCase()) ? { score: 1 } : null) })).filter((r) => r.m).map((r) => r.x);
    }
    const groups = new Map(GROUPS.map(([g]) => [g, []]));
    groups.set('other', []);
    for (const c of list) {
      const g = c.id.split('.')[0];
      (groups.get(g) || groups.get('other')).push(c);
    }
    for (const arr of groups.values()) arr.sort((a, b) => a.title.localeCompare(b.title));
    return [...groups].filter(([, arr]) => arr.length);
  }, [commands, q, keyFilter, km]);

  useKeyCapture(byKey && !recordingFor, (e) => {
    if (e.key === 'Escape' && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
      setByKey(false);
      setKeyFilter(null);
      return;
    }
    const a = eventToAccelerator(e);
    if (a) setKeyFilter(a);
  });

  const conflictsFor = (id) => (acc) => (byAccel.get(canonicalAccelerator(acc)) || []).filter((x) => x !== id).map((x) => getCommand(x) || { id: x, title: x });

  const save = async (id, acc, takeOver) => {
    setRecordingFor(null);
    const current = effective[id] || [];
    if (current.some((a) => canonicalAccelerator(a) === canonicalAccelerator(acc))) return;
    if (takeOver) {
      for (const other of conflictsFor(id)(acc)) {
        await invoke('app:setKeybinding', other.id, (effective[other.id] || []).filter((a) => canonicalAccelerator(a) !== canonicalAccelerator(acc)));
      }
    }
    await apply(invoke('app:setKeybinding', id, [...current, acc]));
  };
  const removeBinding = (id, acc) => apply(invoke('app:setKeybinding', id, (effective[id] || []).filter((a) => a !== acc)));
  const reset = (id) => apply(invoke('app:setKeybinding', id, null));
  const resetAll = async () => {
    if (!Object.keys(overrides).length) return;
    if (await confirm({ title: 'Reset Keymap', message: `Reset ${Object.keys(overrides).length} customized shortcut${Object.keys(overrides).length === 1 ? '' : 's'} to the ${km.presets.find((p) => p.id === km.preset).name} defaults?`, ok: 'Reset', danger: true })) apply(invoke('app:resetKeymap'));
  };
  const changePreset = async (id) => {
    if (id === km.preset) return;
    const n = Object.keys(overrides).length;
    if (n && !(await confirm({ title: 'Change Keymap', message: `Switching presets removes your ${n} customized shortcut${n === 1 ? '' : 's'}.`, ok: 'Switch', danger: true }))) return;
    apply(invoke('app:setKeymapPreset', id));
  };

  if (!km) return html`<div class="empty">Loading…</div>`;
  return html`<div class="keymap" data-testid="keymap-section">
    <h3>Keymap</h3>
    <div class="row" style="gap:8px;margin-bottom:10px">
      <select class="input" data-testid="keymap-preset" value=${km.preset} onChange=${(e) => changePreset(e.target.value)}>${km.presets.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>
      ${byKey
        ? html`<div class="km-capture small grow" tabIndex="0">${keyFilter ? formatAccelerator(keyFilter) : 'Press a shortcut to find its actions…'}</div>`
        : html`<input class="input grow" data-testid="keymap-search" placeholder="Search actions" value=${q} onInput=${(e) => setQ(e.target.value)} />`}
      <button class=${cls('icon-btn', byKey && 'active')} title="Find actions by shortcut" onClick=${() => { setByKey(!byKey); setKeyFilter(null); }}><${Icon} name="keyboard" /></button>
      <button class="btn small" data-testid="keymap-reset-all" disabled=${!Object.keys(overrides).length} onClick=${resetAll}>Reset All</button>
    </div>
    <div class="km-list">
      ${rows.map(([g, list]) => html`<div class="section-title" style="padding-left:4px">${(GROUPS.find(([k]) => k === g) || [g, 'Other'])[1]}</div>
        ${list.map((c) => {
          const bindings = effective[c.id] || [];
          const modified = Object.prototype.hasOwnProperty.call(overrides, c.id);
          return html`<div class=${cls('km-row', modified && 'modified')} data-testid="keymap-row" data-command=${c.id}>
              <span class="title" title=${c.id}>${c.title}</span>
              <span class="chips">
                ${bindings.map((a) => {
                  const others = (byAccel.get(canonicalAccelerator(a)) || []).filter((x) => x !== c.id);
                  return html`<span class=${cls('kbd-chip', others.length && 'conflict')} title=${others.length ? `Also: ${others.map((x) => (getCommand(x) || { title: x }).title).join(', ')}` : a}>${formatAccelerator(a)}<button class="x" title="Remove shortcut" onClick=${() => removeBinding(c.id, a)}>×</button></span>`;
                })}
              </span>
              <button class="icon-btn sm" data-testid="keymap-add" data-command=${c.id} title="Add keyboard shortcut" onClick=${() => setRecordingFor(c.id)}><${Icon} name="plus" size=${13} /></button>
              ${modified ? html`<button class="btn small" data-testid="keymap-reset" title="Reset to the preset" onClick=${() => reset(c.id)}>Reset</button>` : html`<span style="width:52px"></span>`}
            </div>
            ${recordingFor === c.id ? html`<${Recorder} title=${c.title} conflictsFor=${conflictsFor(c.id)} onCancel=${() => setRecordingFor(null)} onSave=${(acc, takeOver) => save(c.id, acc, takeOver)} />` : null}`;
        })}`)}
      ${!rows.length ? html`<div class="empty">No actions match.</div>` : null}
    </div>
  </div>`;
}
