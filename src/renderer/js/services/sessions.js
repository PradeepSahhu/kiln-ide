// Terminal, run-configuration and agent sessions, each rendered by its own xterm.js instance.
import { Terminal } from '../../../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebLinksAddon } from '../../../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';
import { store } from '../lib/store.js';
import { invoke, send, on } from '../lib/ipc.js';
import { themeById, terminalTheme } from '../lib/themes.js';
import { openTool } from './layout.js';
import * as ed from './editor.js';

const terms = new Map(); // session id -> { term, fit, kind, el, text }

function settings() {
  return store.get().settings || {};
}

function makeTerm(kind, id) {
  const s = settings();
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', Menlo, monospace",
    fontSize: (s.terminal && s.terminal.fontSize) || 13,
    lineHeight: 1.15,
    cursorBlink: kind !== 'run',
    allowProposedApi: true,
    scrollback: 10000,
    convertEol: kind === 'output',
    theme: terminalTheme(themeById(s.theme)),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((e, uri) => invoke('app:openExternal', uri)));
  // file:line links into the editor
  term.registerLinkProvider({
    provideLinks(y, cb) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return cb(undefined);
      const text = line.translateToString(true);
      const links = [];
      const re = /((?:\/|\.{0,2}\/)?[\w.\-/ ]*[\w-]\.(?:cs|py|ts|tsx|js|jsx|json|csproj|razor|xml|yml|yaml|toml))(?:\((\d+)(?:,(\d+))?\)|:(\d+)(?::(\d+))?|", line (\d+))/g;
      let m;
      while ((m = re.exec(text))) {
        const file = m[1].trim();
        const ln = +(m[2] || m[4] || m[6] || 1);
        const col = +(m[3] || m[5] || 1);
        links.push({
          range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
          text: m[0],
          activate: () => {
            const root = store.get().project && store.get().project.root;
            const abs = file.startsWith('/') ? file : `${root}/${file.replace(/^\.\//, '')}`;
            ed.openFile(abs, { line: ln, col });
          },
        });
      }
      cb(links);
    },
  });
  return { term, fit, kind, id, text: '' };
}

export function getSession(id) {
  return terms.get(id);
}

export function attach(id, el) {
  const s = terms.get(id);
  if (!s || !el) return;
  if (s.el !== el) {
    if (!s.opened) {
      s.term.open(el);
      s.opened = true;
    } else if (s.term.element && s.term.element.parentElement !== el) {
      el.appendChild(s.term.element);
    }
    s.el = el;
  }
  requestAnimationFrame(() => fitSession(id));
}

export function fitSession(id) {
  const s = terms.get(id);
  if (!s || !s.opened || !s.el || !s.el.offsetWidth) return;
  try {
    s.fit.fit();
  } catch {
    return;
  }
  const { cols, rows } = s.term;
  if (s.kind === 'terminal' || s.kind === 'agent') send('term:resize', id, cols, rows);
  else if (s.kind === 'run') send('run:resize', id, cols, rows);
}

export function applyTerminalTheme() {
  const t = terminalTheme(themeById(settings().theme));
  for (const s of terms.values()) s.term.options.theme = t;
}

// ---------------------------------------------------------------- terminals

export async function newTerminal({ agent } = {}) {
  const size = { cols: 120, rows: 30 };
  const r = agent ? await invoke('agents:start', agent.id, size) : await invoke('term:create', size);
  const s = makeTerm(agent ? 'agent' : 'terminal', r.id);
  s.term.onData((d) => send('term:write', r.id, d));
  terms.set(r.id, s);
  const list = store.get().terminals.list;
  const n = list.filter((x) => !x.agent).length;
  const title = agent ? agent.name : n ? `Local (${n + 1})` : 'Local';
  store.update('terminals', { list: [...list, { id: r.id, title, agent: agent ? agent.id : null, alive: true, startedAt: Date.now() }], active: r.id });
  if (agent) store.update('agents', { active: r.id });
  return r.id;
}

export async function closeTerminal(id) {
  await invoke('term:kill', id).catch(() => {});
  const s = terms.get(id);
  if (s) s.term.dispose();
  terms.delete(id);
  const list = store.get().terminals.list.filter((x) => x.id !== id);
  store.update('terminals', { list, active: list.length ? list[list.length - 1].id : null });
}

export function terminalSend(id, data) {
  send('term:write', id, data);
}

// --------------------------------------------------------------------- runs

export async function startRun(cfg) {
  await ed.saveAll({ quiet: true });
  openTool('bottom', 'run');
  const r = await invoke('run:start', cfg.id || cfg, { cols: 120, rows: 24 });
  return r.id;
}

export function stopRun(id) {
  return invoke('run:stop', id);
}

export function runText(id) {
  const s = terms.get(id);
  return s ? s.text : '';
}

export function terminalText(id) {
  const s = terms.get(id);
  if (!s) return '';
  const buf = s.term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true));
  return lines.join('\n').trim() || s.text;
}

export function initSessions() {
  on('term:data', ({ id, data }) => {
    const s = terms.get(id);
    if (!s) return;
    s.term.write(data);
    s.text = (s.text + data).slice(-200000);
    if (s.kind === 'agent') store.update('agents', { lastActivity: Date.now() });
  });
  on('term:exit', ({ id, code }) => {
    const s = terms.get(id);
    if (s) s.term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
    store.update('terminals', (t) => ({ ...t, list: t.list.map((x) => (x.id === id ? { ...x, alive: false } : x)) }));
  });
  on('run:started', (e) => {
    const s = makeTerm('run', e.id);
    s.term.onData((d) => send('run:input', e.id, d));
    terms.set(e.id, s);
    store.update('runs', (r) => ({ ...r, sessions: [...r.sessions.filter((x) => x.running || x.configId !== e.configId), { id: e.id, name: e.name, configId: e.configId, commandLine: e.commandLine, running: true, startedAt: Date.now() }], active: e.id }));
  });
  on('run:data', ({ id, data }) => {
    const s = terms.get(id);
    if (!s) return;
    s.term.write(data);
    s.text = (s.text + data).slice(-200000);
  });
  on('run:exit', ({ id, code }) => {
    store.update('runs', (r) => ({ ...r, sessions: r.sessions.map((x) => (x.id === id ? { ...x, running: false, exitCode: code } : x)) }));
  });
  window.addEventListener('resize', () => {
    for (const id of terms.keys()) fitSession(id);
  });
}

export function disposeAll() {
  for (const s of terms.values()) s.term.dispose();
  terms.clear();
  store.set({ terminals: { list: [], active: null }, runs: { ...store.get().runs, sessions: [], active: null } });
}
