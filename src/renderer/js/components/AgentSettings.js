// Settings › AI Agents: give Claude Code, Codex, Gemini CLI, Antigravity and Cursor the project
// knowledge graph (skill + MCP server) and tell them to use it first.
import { html, useEffect, useState } from '../lib/preact.js';
import { useStore, store } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { invoke } from '../lib/ipc.js';
import { cls } from '../lib/util.js';
import { toast, errorToast } from '../lib/ui.js';
import { Spinner } from './ui.js';

export function AgentSettings() {
  const s = useStore((st) => st.settings);
  const [info, setInfo] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const load = async () => {
    try {
      const i = await invoke('agents:kgStatus');
      setInfo(i);
      setSel(new Set(i.agents.filter((a) => a.present).map((a) => a.id)));
    } catch (err) {
      errorToast('Could not read agent configuration', err);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const act = async (channel) => {
    setBusy(true);
    try {
      const r = await invoke(channel, [...sel]);
      setResults(r);
      if (channel === 'agents:kgInstall') {
        const failed = r.filter((x) => !x.ok);
        toast({ kind: failed.length ? 'warning' : 'success', title: failed.length ? 'Some agents could not be set up' : 'Knowledge graph available to your agents', message: failed.map((x) => `${x.name}: ${x.error}`).join('\n') });
      }
      await load();
    } catch (err) {
      errorToast('Agent setup failed', err);
    }
    setBusy(false);
  };
  const setKg = (on) => invoke('app:updateSettings', { agents: { kgInClaudeChat: on } }).then((next) => store.set({ settings: next }));
  const snippet = info ? JSON.stringify({ mcpServers: { 'kiln-knowledge-graph': { command: info.node || 'node', args: [info.mcp] } } }, null, 2) : '';
  return html`<div data-testid="agents-section">
    <h3>AI Agents</h3>
    <p class="muted" style="font-size:12px;line-height:1.55;margin:-6px 0 12px">
      Kiln keeps a knowledge graph of each project: files, classes, functions, variables, calls, and which functions read and write each variable.
      Agents get it as a <b>skill</b> and an <b>MCP server</b>, with instructions to use it <b>first</b>, before grep or reading files.
      It reads Kiln's local index, so nothing is added to your repositories.
    </p>
    <div class="setting"><div class="lbl">Kiln's Claude chat uses the knowledge graph first<div class="h">Read-only tools; no permission prompts</div></div><input type="checkbox" checked=${(s.agents || {}).kgInClaudeChat !== false} onChange=${(e) => setKg(e.target.checked)} /></div>
    <div class="section-title" style="padding-left:0;margin-top:14px">Agents on this computer</div>
    ${!info
      ? html`<div class="empty"><${Spinner} /></div>`
      : html`<div class="agent-list">
          ${info.agents.map((a) => html`<label class=${cls('agent-row', !a.present && 'missing')} data-testid="agent-row" data-agent=${a.id}>
              <input type="checkbox" checked=${sel.has(a.id)} disabled=${busy} onChange=${(e) => { const n = new Set(sel); if (e.target.checked) n.add(a.id); else n.delete(a.id); setSel(n); }} />
              <span class="name">${a.name}</span>
              <span class=${cls('chip', a.installed ? 'ok' : a.present ? '' : 'muted')} data-testid="agent-status">${a.installed ? 'Installed' : a.present ? 'Not installed' : 'Not found'}</span>
            </label>`)}
        </div>
        <div class="row" style="gap:8px;margin-top:10px">
          <button class="btn primary small" data-testid="agents-install" disabled=${busy || !sel.size || !info.node} onClick=${() => act('agents:kgInstall')}>${busy ? html`<${Spinner} size=${12} />` : html`<${Icon} name="download" size=${13} />`}Install for selected</button>
          <button class="btn small" data-testid="agents-remove" disabled=${busy || !sel.size} onClick=${() => act('agents:kgUninstall')}>Remove</button>
          ${!info.node ? html`<span class="sev-warning" style="font-size:12px">Node.js is needed to run the tools (not found on PATH).</span>` : null}
        </div>
        ${results
          ? html`<div class="agent-results">${results.map((r) => html`<div><b>${r.name || r.id}</b>: ${r.ok ? (r.changes && r.changes.length ? r.changes.join(', ') : 'up to date') : html`<span class="sev-error">${r.error}</span>`}${r.note ? html` <span class="muted">${r.note}</span>` : null}</div>`)}</div>`
          : null}
        <div class="section-title" style="padding-left:0;margin-top:16px">Any other agent</div>
        <div class="muted" style="font-size:12px;margin-bottom:6px">Add this MCP server to the agent's configuration:</div>
        <pre class="snippet" data-testid="agents-snippet">${snippet}</pre>
        <div class="row" style="gap:8px"><button class="btn small" onClick=${() => invoke('app:clipboard', snippet).then(() => toast({ title: 'Copied', timeout: 1500 }))}><${Icon} name="copy" size=${13} />Copy</button>
          <span class="muted" style="font-size:12px">or run <code>node "${info.cli}" overview</code> in a project folder.</span></div>`}
  </div>`;
}
