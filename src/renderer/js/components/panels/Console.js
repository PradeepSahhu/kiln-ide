// Terminal, Run and AI Agents tool windows (xterm.js sessions).
import { html, useEffect, useRef, useState } from '../../lib/preact.js';
import { useStore, store } from '../../lib/store.js';
import { Icon } from '../../lib/icons.js';
import { invoke } from '../../lib/ipc.js';
import { cls, timeAgo, relative, basename } from '../../lib/util.js';
import { ToolWindow, Spinner } from '../ui.js';
import { attach, fitSession, newTerminal, closeTerminal, startRun, stopRun } from '../../services/sessions.js';
import { run } from '../../lib/commands.js';
import * as ed from '../../services/editor.js';

function SessionView({ id }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!id) return undefined;
    attach(id, ref.current);
    const ro = new ResizeObserver(() => fitSession(id));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [id]);
  return html`<div class="console" ref=${ref} key=${id}></div>`;
}

export function TerminalPanel({ onHide }) {
  const t = useStore((s) => s.terminals);
  const list = t.list.filter((x) => !x.agent);
  const active = list.find((x) => x.id === t.active) ? t.active : list.length ? list[list.length - 1].id : null;
  useEffect(() => {
    if (!list.length) newTerminal();
  }, []);
  return html`<${ToolWindow} side="bottom" title="Terminal" testid="terminal-panel" onHide=${onHide}
      tabs=${html`${list.map((x) => html`<button class=${cls('tw-tab', x.id === active && 'active')} onClick=${() => store.update('terminals', { active: x.id })}>${x.title}${x.alive ? '' : ' (exited)'}<span class="close" onClick=${(e) => { e.stopPropagation(); closeTerminal(x.id); }}><${Icon} name="close" size=${12} /></span></button>`)}
        <button class="icon-btn sm" title="New Terminal" onClick=${() => newTerminal()}><${Icon} name="plus" /></button>`}>
    ${active ? html`<${SessionView} id=${active} />` : html`<div class="empty"><${Spinner} /> Starting shell…</div>`}
  <//>`;
}

export function RunPanel({ onHide }) {
  const runs = useStore((s) => s.runs);
  const active = runs.sessions.find((x) => x.id === runs.active) || runs.sessions[runs.sessions.length - 1];
  const cfg = active && runs.configs.find((c) => c.id === active.configId);
  return html`<${ToolWindow} side="bottom" title="Run" testid="run-panel" onHide=${onHide}
      tabs=${html`${runs.sessions.map((x) => html`<button class=${cls('tw-tab', active && x.id === active.id && 'active')} onClick=${() => store.update('runs', { active: x.id })}>
          ${x.running ? html`<${Icon} name="play" size=${12} className="ok" />` : html`<${Icon} name=${x.exitCode === 0 ? 'success' : 'error'} size=${12} className=${x.exitCode === 0 ? 'ok' : 'sev-error'} />`}${x.name}
          <span class="close" onClick=${(e) => { e.stopPropagation(); if (x.running) stopRun(x.id); store.update('runs', (r) => ({ ...r, sessions: r.sessions.filter((s) => s.id !== x.id) })); invoke('run:forget', x.id); }}><${Icon} name="close" size=${12} /></span></button>`)}`}
      actions=${html`
        <button class="icon-btn sm" title="Rerun" disabled=${!cfg && !(active && active.configId)} onClick=${() => { const c = cfg || runs.configs.find((x) => x.id === active.configId); if (c) startRun(c); }}><${Icon} name="refresh" /></button>
        <button class="icon-btn sm" title="Stop" disabled=${!active || !active.running} onClick=${() => stopRun(active.id)}><${Icon} name="stop" className=${active && active.running ? 'sev-error' : ''} /></button>`}>
    ${active ? html`<${SessionView} id=${active.id} />` : html`<div class="empty">Choose a run configuration in the toolbar and press <${Icon} name="play" size=${12} className="ok" /> Run.</div>`}
  <//>`;
}

/** Other AI coding agents (Codex, Gemini, Copilot, Aider, Claude Code CLI…) running in terminal tabs. */
export function AgentsPanel({ onHide }) {
  const t = useStore((s) => s.terminals);
  const agentsState = useStore((s) => s.agents || {});
  const fsChanged = useStore((s) => s.fsChanged);
  const root = useStore((s) => s.project.root);
  const [agents, setAgents] = useState(null);
  const [changes, setChanges] = useState([]);
  const sessions = t.list.filter((x) => x.agent);
  const active = sessions.find((x) => x.id === agentsState.active) || sessions[sessions.length - 1];
  useEffect(() => {
    invoke('agents:list').then(setAgents).catch(() => setAgents([]));
  }, []);
  // Files touched while an agent is working, shown live.
  useEffect(() => {
    if (!active || !fsChanged || !agentsState.lastActivity || Date.now() - agentsState.lastActivity > 20000) return;
    const interesting = fsChanged.filter((p) => !/\/(node_modules|\.git|bin|obj|\.venv|__pycache__)\//.test(p));
    if (interesting.length) setChanges((c) => [...new Set([...interesting, ...c])].slice(0, 100));
  }, [fsChanged]);
  const follow = agentsState.follow !== false;
  return html`<${ToolWindow} side="right" title="AI Agents" testid="agents-panel" onHide=${onHide}
      tabs=${html`${sessions.map((x) => html`<button class=${cls('tw-tab', active && x.id === active.id && 'active')} onClick=${() => store.update('agents', { active: x.id })}>${x.title}${x.alive ? '' : ' (exited)'}<span class="close" onClick=${(e) => { e.stopPropagation(); closeTerminal(x.id); }}><${Icon} name="close" size=${12} /></span></button>`)}`}
      actions=${html`<label class="checkbox" title="Open files in the editor as the agent edits them"><input type="checkbox" checked=${follow} onChange=${(e) => store.update('agents', { follow: e.target.checked })} />Follow edits</label>`}>
    ${active
      ? html`<div class="col grow">
          <${SessionView} id=${active.id} />
          ${changes.length
            ? html`<div style="max-height:150px;overflow:auto;border-top:1px solid var(--border-inner)">
                <div class="section-title">Changed while the agent worked</div>
                ${changes.map((p) => html`<div class="list-row" onClick=${() => ed.openFile(p)} onDblClick=${() => run('git.diffFile', p)}><${Icon} name="file" size=${14} className="muted" /><span>${basename(p)}</span><span class="muted" style="font-size:12px">${relative(root, p)}</span></div>`)}
              </div>`
            : null}
        </div>`
      : html`<div class="list">
          <div class="section-title">Start an agent in this project</div>
          ${!agents ? html`<div class="empty"><${Spinner} /></div>` : null}
          ${(agents || []).map(
            (a) => html`<div class="pkg-row">
              <${Icon} name=${a.id === 'claude-cli' ? 'claude' : 'agent'} style=${a.id === 'claude-cli' ? 'color:#D97757' : ''} />
              <div class="grow"><div class="nm">${a.name}</div><div class="desc">${a.found ? a.version || a.path : `Not installed · ${a.vendor}`}</div></div>
              ${a.found ? html`<button class="btn small primary" onClick=${() => newTerminal({ agent: a })}>Start</button>` : html`<a class="small" onClick=${() => invoke('app:openExternal', a.url)}>Get it</a>`}
            </div>`,
          )}
          <div class="empty" style="font-size:12px">Agents run in a terminal inside the project. Files they change are reloaded in the editor with the changed lines highlighted. For the built-in chat, use the Claude tool window.</div>
        </div>`}
  <//>`;
}
