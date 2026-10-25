// Settings › Theme Editor: create custom themes from any theme, edit every UI, editor, syntax and
// terminal color with a live preview across the IDE, import/export (Kiln or VS Code theme files).
import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { useStore, store } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { invoke } from '../lib/ipc.js';
import { cls, debounce } from '../lib/util.js';
import { confirm, toast, errorToast } from '../lib/ui.js';
import { themes, themeById, completeTheme, normalizeColor, setPreviewTheme, applyThemeVars, terminalTheme, DEFAULT_ANSI, THEME_FIELDS } from '../lib/themes.js';
import { setMonacoTheme } from '../lib/monaco.js';
import { newThemeId, exportTheme, importTheme } from '../lib/theme-import.js';
import { applyTerminalTheme } from '../services/sessions.js';

const LABELS = {
  base: { panel: 'Tool windows & panels', editor: 'Editor background', text: 'Text', accent: 'Accent (buttons, focus, links)', selection: 'Selection in lists', border: 'Outer borders', inner: 'Separators' },
  editor: { lineHighlight: 'Current line', selection: 'Text selection', lineNumber: 'Line numbers', lineNumberActive: 'Current line number', cursor: 'Caret' },
  syntax: { fg: 'Default text', comment: 'Comments', keyword: 'Keywords', string: 'Strings', number: 'Numbers', type: 'Classes & types', iface: 'Interfaces', struct: 'Structs & records', enum: 'Enums', method: 'Methods & functions', field: 'Fields & properties', local: 'Local variables', param: 'Parameters', namespace: 'Namespaces & modules', constant: 'Constants & enum members', decorator: 'Attributes & decorators', builtin: 'Built-ins', escape: 'Escape sequences', tag: 'Markup tags', attr: 'Markup attributes', event: 'Events', self: 'self / this' },
};
const GROUP_TITLES = { base: 'User interface', editor: 'Editor', syntax: 'Syntax', terminal: 'Terminal' };
const ANSI_NAMES = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White', 'Bright black', 'Bright red', 'Bright green', 'Bright yellow', 'Bright blue', 'Bright magenta', 'Bright cyan', 'Bright white'];

const clone = (t) => JSON.parse(JSON.stringify(t));

function applyLive(theme) {
  setPreviewTheme(theme);
  if (store.get().settings.theme === theme.id) {
    applyThemeVars(theme.id);
    setMonacoTheme(theme.id);
    applyTerminalTheme();
  }
}

function ColorRow({ label, value, inherited, testid, onChange, onReset }) {
  const [text, setText] = useState(value || '');
  // Follow outside changes (picker, reset) only; effects run after paint, so syncing on mount too
  // would overwrite whatever was typed in the meantime.
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    setText(value || '');
  }, [value]);
  const commit = (v) => {
    const c = normalizeColor(v);
    if (c) onChange(c);
    else setText(value || '');
  };
  return html`<div class="te-row">
    <span class="label">${label}</span>
    <input type="color" value=${value || '#000000'} onInput=${(e) => onChange(e.target.value)} title="Pick a color" />
    <input class="input mono" data-testid=${testid} value=${text} spellcheck="false" onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && commit(e.target.value)} onBlur=${(e) => commit(e.target.value)} />
    ${onReset && inherited && value !== inherited ? html`<button class="icon-btn sm" title=${`Reset to ${inherited}`} onClick=${onReset}><${Icon} name="refresh" size=${12} /></button>` : html`<span style="width:22px"></span>`}
  </div>`;
}

/** A small UI + code sample painted with the edited colors. */
function Preview({ t }) {
  const s = t.syntax;
  const e = t.editor;
  const b = t.base;
  const k = (c, text) => html`<span style=${{ color: c }}>${text}</span>`;
  const lines = [
    [k(s.comment, '// Applies the discount and publishes the event')],
    [k(s.keyword, 'public'), ' ', k(s.keyword, 'async'), ' ', k(s.type, 'Task'), '<', k(s.type, 'Order'), '> ', k(s.method, 'PlaceAsync'), '(', k(s.type, 'Order'), ' ', k(s.param, 'order'), ')'],
    ['{'],
    ['    ', k(s.keyword, 'var'), ' ', k(s.local, 'total'), ' = ', k(s.param, 'order'), '.', k(s.field, 'Total'), ' * ', k(s.number, '0.9m'), ';'],
    ['    ', k(s.keyword, 'await'), ' ', k(s.field, '_producer'), '.', k(s.method, 'ProduceAsync'), '(', k(s.string, '"orders"'), ', ', k(s.param, 'order'), ');'],
    ['    ', k(s.keyword, 'return'), ' ', k(s.param, 'order'), ';'],
    ['}'],
  ];
  return html`<div class="te-preview" style=${{ background: b.panel, color: b.text, borderColor: b.border }}>
    <div class="te-tabs" style=${{ borderColor: b.inner }}>
      <span class="te-tab on" style=${{ background: b.editor, boxShadow: `inset 0 -2px 0 ${b.accent}` }}>OrderService.cs</span><span class="te-tab">Program.cs</span>
      <span style="flex:1"></span><span class="te-btn" style=${{ background: b.accent }}>Run</span>
    </div>
    <div class="te-body">
      <div class="te-tree" style=${{ borderColor: b.inner }}>
        <div>▾ Shop.Api</div><div style=${{ background: b.selection, borderRadius: '4px', paddingLeft: '12px' }}>OrderService.cs</div><div style="padding-left:12px">Program.cs</div>
      </div>
      <div class="te-code" style=${{ background: b.editor, color: s.fg }}>
        ${lines.map((l, i) => html`<div class="te-line" style=${{ background: i === 3 ? e.lineHighlight : 'transparent' }}><span class="ln" style=${{ color: i === 3 ? e.lineNumberActive : e.lineNumber }}>${i + 1}</span><span>${i === 4 ? html`<span style=${{ background: e.selection }}>${l}</span>` : l}${i === 3 ? html`<span style=${{ borderLeft: `2px solid ${e.cursor}`, marginLeft: '1px' }}></span>` : null}</span></div>`)}
      </div>
    </div>
    <div class="te-term" style=${{ background: b.panel, borderColor: b.inner }}>
      ${terminalTheme(t) && ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].map((n) => html`<span style=${{ color: terminalTheme(t)[n] }}>■ </span>`)}
      <span style=${{ color: terminalTheme(t).green }}>✓</span> Build succeeded
    </div>
  </div>`;
}

export function ThemeEditor() {
  const settings = useStore((s) => s.settings);
  const customs = themes.filter((t) => t.custom);
  const [editingId, setEditingId] = useState(() => (customs.some((t) => t.id === settings.theme) ? settings.theme : customs[0] ? customs[0].id : null));
  const [draft, setDraft] = useState(null);
  const [startFrom, setStartFrom] = useState(settings.theme);
  const draftRef = useRef(null);

  const persist = useMemo(() => debounce((t) => invoke('app:saveCustomTheme', t).catch((err) => errorToast('Could not save the theme', err)), 300), []);
  useEffect(() => {
    if (!editingId) return setDraft(null);
    const t = clone(themeById(editingId));
    if (t.id !== editingId) return setDraft(null);
    draftRef.current = t;
    setDraft(t);
  }, [editingId]);
  useEffect(() => () => {
    // Leaving the editor: the saved theme takes over from the preview.
    if (draftRef.current) invoke('app:saveCustomTheme', draftRef.current).finally(() => setPreviewTheme(null));
    else setPreviewTheme(null);
  }, []);

  const update = (fn) => {
    const next = completeTheme(fn(clone(draftRef.current)));
    draftRef.current = next;
    setDraft(next);
    applyLive(next);
    persist(next);
  };
  const setColor = (group, key, value) => update((t) => ({ ...t, [group]: { ...t[group], [key]: value } }));
  const setAnsi = (i, value) => update((t) => {
    const ansi = (t.terminal && t.terminal.ansi ? t.terminal.ansi : DEFAULT_ANSI[t.type]).slice();
    ansi[i] = value;
    return { ...t, terminal: { ansi } };
  });

  const create = async () => {
    const base = themeById(startFrom);
    const t = completeTheme({ ...clone(base), id: newThemeId(base.name), name: `${base.name.replace(/ \(Custom\)( \d+)?$/, '')} (Custom)`, basedOn: base.custom ? base.basedOn : base.id });
    await invoke('app:saveCustomTheme', t, { activate: true });
    setEditingId(t.id);
  };
  const edit = async (id) => {
    if (draftRef.current) await invoke('app:saveCustomTheme', draftRef.current).catch(() => {});
    setPreviewTheme(null);
    await invoke('app:updateSettings', { theme: id }).then((s) => store.set({ settings: s }));
    setEditingId(id);
  };
  const remove = async () => {
    if (!draft || !(await confirm({ title: 'Delete Theme', message: `Delete the theme "${draft.name}"?`, ok: 'Delete', danger: true }))) return;
    draftRef.current = null;
    setPreviewTheme(null);
    await invoke('app:deleteCustomTheme', draft.id);
    const rest = themes.filter((t) => t.custom && t.id !== draft.id);
    setEditingId(rest.length ? rest[0].id : null);
  };
  const doExport = async () => {
    try {
      const file = await invoke('app:exportTheme', draft.name, exportTheme(draft));
      if (file) toast({ kind: 'success', title: 'Theme exported', message: file });
    } catch (err) {
      errorToast('Export failed', err);
    }
  };
  const doImport = async () => {
    try {
      const f = await invoke('app:readThemeFile');
      if (!f) return;
      const t = importTheme(f.content);
      await invoke('app:saveCustomTheme', t, { activate: true });
      setEditingId(t.id);
      toast({ kind: 'success', title: `Imported "${t.name}"`, message: f.name });
    } catch (err) {
      errorToast('Import failed', err);
    }
  };

  const baseTheme = draft ? themeById(draft.basedOn) : null;
  const ansi = draft ? (draft.terminal && draft.terminal.ansi) || DEFAULT_ANSI[draft.type] : [];
  return html`<div class="theme-editor" data-testid="theme-editor">
    <h3>Theme Editor</h3>
    <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <span class="muted" style="font-size:12px">New theme from</span>
      <select class="input" value=${startFrom} onChange=${(e) => setStartFrom(e.target.value)}>${themes.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select>
      <button class="btn small primary" data-testid="theme-new" onClick=${create}><${Icon} name="plus" size=${13} />New Theme</button>
      <span class="spacer"></span>
      <button class="btn small" data-testid="theme-import" onClick=${doImport} title="Kiln theme or VS Code color theme (.json)"><${Icon} name="download" size=${13} />Import…</button>
    </div>
    ${customs.length
      ? html`<div class="te-themes">${customs.map((t) => html`<button class=${cls('te-chip', editingId === t.id && 'on')} data-testid="theme-custom" data-theme=${t.id} onClick=${() => edit(t.id)}><span class="sw" style=${{ background: themeById(t.id).base.editor, borderColor: themeById(t.id).base.accent }}></span>${t.name}</button>`)}</div>`
      : null}
    ${!draft
      ? html`<div class="empty">Create a theme from any built-in theme, then change its colors. Changes apply to the whole IDE as you edit; themes can be exported and shared, and VS Code color themes can be imported.</div>`
      : html`<div class="te-grid">
          <div class="te-fields">
            <div class="row" style="gap:8px;margin-bottom:8px">
              <input class="input grow" data-testid="theme-name" value=${draft.name} onInput=${(e) => update((t) => ({ ...t, name: e.target.value || 'Custom Theme' }))} />
              <select class="input" value=${draft.type} onChange=${(e) => update((t) => ({ ...t, type: e.target.value }))} title="Light or dark base (affects derived colors and scrollbars)"><option value="dark">Dark</option><option value="light">Light</option></select>
            </div>
            <div class="muted" style="font-size:12px;margin-bottom:8px">Based on ${baseTheme ? baseTheme.name : '—'} · changes apply live${settings.theme !== draft.id ? html` · <a onClick=${() => edit(draft.id)}>use this theme</a>` : ''}</div>
            ${Object.entries(THEME_FIELDS).map(([group, keys]) => html`<div class="section-title" style="padding-left:0">${GROUP_TITLES[group]}</div>
              ${keys.filter((k) => draft[group][k] || (baseTheme && baseTheme[group][k])).map((k) => html`<${ColorRow} key=${`${group}.${k}`} label=${LABELS[group][k] || k} value=${draft[group][k]} inherited=${baseTheme && baseTheme[group][k]} testid=${`theme-color-${group}.${k}`} onChange=${(v) => setColor(group, k, v)} onReset=${() => setColor(group, k, baseTheme[group][k])} />`)}`)}
            <div class="section-title" style="padding-left:0">${GROUP_TITLES.terminal}</div>
            ${ansi.map((c, i) => html`<${ColorRow} key=${`ansi.${i}`} label=${ANSI_NAMES[i]} value=${c} inherited=${DEFAULT_ANSI[draft.type][i]} testid=${`theme-color-terminal.${i}`} onChange=${(v) => setAnsi(i, v)} onReset=${() => setAnsi(i, DEFAULT_ANSI[draft.type][i])} />`)}
          </div>
          <div class="te-side">
            <${Preview} t=${draft} />
            <div class="row" style="gap:6px;margin-top:10px">
              <button class="btn small" data-testid="theme-export" onClick=${doExport}><${Icon} name="upload" size=${13} />Export…</button>
              <span class="spacer"></span>
              <button class="btn small danger" data-testid="theme-delete" onClick=${remove}><${Icon} name="trash" size=${13} />Delete</button>
            </div>
          </div>
        </div>`}
  </div>`;
}
