// Skills tool window: every skill, slash command and subagent Claude can use in this project.
import { html, useEffect, useState, useMemo } from '../../lib/preact.js';
import { useStore, store } from '../../lib/store.js';
import { Icon } from '../../lib/icons.js';
import { invoke } from '../../lib/ipc.js';
import { cls } from '../../lib/util.js';
import { prompt, errorToast } from '../../lib/ui.js';
import { ToolWindow, Spinner } from '../ui.js';
import { openTool } from '../../services/layout.js';
import * as ed from '../../services/editor.js';

const SOURCE_LABEL = { project: 'Project', user: 'User', synced: 'claude.ai', plugin: 'Plugin', loaded: 'Loaded', builtin: 'Built-in' };
const KIND_ICON = { skill: 'skill', command: 'terminal', agent: 'agent' };

export function SkillsPanel({ onHide }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('skill');
  const [open, setOpen] = useState(null);
  const [loading, setLoading] = useState(false);
  const load = async (force = false) => {
    setLoading(true);
    try {
      setData(await invoke('skills:list', { force }));
    } catch (err) {
      setData({ items: [], probe: { ok: false, error: err.message } });
    }
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, []);
  const items = useMemo(() => ((data && data.items) || []).filter((i) => i.kind === kind && (!q || (i.name + ' ' + i.description).toLowerCase().includes(q.toLowerCase()))), [data, q, kind]);
  const groups = useMemo(() => {
    const g = new Map();
    for (const i of items) {
      const k = SOURCE_LABEL[i.source] || i.source;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(i);
    }
    return [...g];
  }, [items]);
  const counts = useMemo(() => {
    const c = { skill: 0, command: 0, agent: 0 };
    for (const i of (data && data.items) || []) c[i.kind] = (c[i.kind] || 0) + 1;
    c.mcp = ((data && data.probe && data.probe.mcpServers) || []).length;
    return c;
  }, [data]);
  const mcp = (data && data.probe && data.probe.mcpServers) || [];
  const use = (i) => {
    openTool('right', 'claude');
    const text = i.kind === 'agent' ? `Use the ${i.name} subagent to ` : `/${i.name} `;
    setTimeout(() => window.dispatchEvent(new CustomEvent('kiln:claude-insert', { detail: { text } })), 50);
  };
  const create = async () => {
    const name = await prompt({ title: 'New Skill', label: 'Skill name:', placeholder: 'deploy-to-staging', ok: 'Create', checkbox: { label: 'Store in this project (.claude/skills); otherwise for all projects', value: true } });
    if (!name) return;
    const value = typeof name === 'string' ? name : name.value;
    const scope = typeof name === 'string' || name.checked ? 'project' : 'user';
    try {
      const file = await invoke('skills:create', { name: value, scope });
      await ed.openFile(file);
      load(true);
    } catch (err) {
      errorToast('Could not create the skill', err);
    }
  };
  const probe = data && data.probe;
  return html`<${ToolWindow} side="right" title="Skills" testid="skills-panel" onHide=${onHide}
      tabs=${html`${['skill', 'command', 'agent', 'mcp'].map((k) => html`<button class=${cls('tw-tab', kind === k && 'active')} data-testid=${`skills-tab-${k}`} onClick=${() => setKind(k)}>${k === 'skill' ? 'Skills' : k === 'command' ? 'Commands' : k === 'agent' ? 'Agents' : 'MCP'}<span class="badge">${counts[k] || 0}</span></button>`)}`}
      actions=${html`<button class="icon-btn sm" title="New skill" onClick=${create}><${Icon} name="plus" /></button><button class="icon-btn sm" title="Reload" onClick=${() => load(true)}>${loading ? html`<${Spinner} />` : html`<${Icon} name="refresh" />`}</button>`}>
    <div style="padding:6px 8px"><input class="input" style="width:100%" placeholder=${`Search ${kind}s`} value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
    ${probe && !probe.ok ? html`<div class="repo-banner" style="font-size:12px"><${Icon} name="warning" className="sev-warning" /><span>Claude Code did not start (${probe.error}). Showing skills found on disk.</span></div>` : null}
    ${probe && probe.ok && probe.account ? html`<div class="muted" style="font-size:11px;padding:0 12px 4px">Claude Code ${probe.version || ''} · ${probe.account.subscriptionType || probe.account.apiProvider || ''} ${probe.account.email ? `· ${probe.account.email}` : ''}</div>` : null}
    <div class="list">
      ${kind === 'mcp'
        ? html`${mcp.map((m) => html`<div class="skill-item" data-testid="mcp-item" data-name=${m.name}><div class="top"><${Icon} name=${m.name === 'kiln-knowledge-graph' ? 'graph' : 'agent'} size=${13} className="muted" /><span class="nm">${m.name}</span><span class=${cls('badge', m.status === 'connected' ? 'ok' : m.status === 'failed' ? 'warn' : '')}>${m.status}</span>${m.tools != null ? html`<span class="muted" style="font-size:11px">${m.tools} tools</span>` : null}</div><div class="desc">${m.name === 'kiln-knowledge-graph' ? 'Kiln knowledge graph: definitions, callers, variable reads/writes, impact. Claude uses it first.' : 'MCP server from your Claude Code configuration.'}</div></div>`)}
            ${!mcp.length ? html`<div class="empty">${data ? 'No MCP servers.' : html`<${Spinner} />`}</div>` : null}`
        : null}
      ${kind !== 'mcp' && !data ? html`<div class="empty"><${Spinner} /> Loading skills from Claude Code…</div>` : null}
      ${groups.map(
        ([group, list]) => html`<div class="section-title">${group} <span class="badge">${list.length}</span></div>
          ${list.map(
            (i) => html`<div class=${cls('skill-item', open === i.name + i.source && 'open')} data-testid="skill-item" data-name=${i.name} onClick=${() => setOpen(open === i.name + i.source ? null : i.name + i.source)}>
              <div class="top"><${Icon} name=${KIND_ICON[i.kind]} size=${13} className="muted" /><span class="nm">${i.kind === 'agent' ? i.name : `/${i.name}`}</span>${i.argumentHint ? html`<span class="muted mono" style="font-size:11px">${i.argumentHint}</span>` : null}${i.plugin ? html`<span class="badge">${i.plugin}</span>` : null}${i.live === false ? html`<span class="badge warn">not loaded</span>` : null}</div>
              <div class="desc">${i.description || 'No description.'}</div>
              ${open === i.name + i.source
                ? html`<div class="acts">
                    <button class="btn small primary" onClick=${(e) => { e.stopPropagation(); use(i); }}><${Icon} name="claude" size=${12} />Use in Claude</button>
                    ${i.path ? html`<button class="btn small" onClick=${(e) => { e.stopPropagation(); ed.openFile(i.path); }}>Open ${i.kind === 'skill' ? 'SKILL.md' : 'file'}</button>` : null}
                    ${i.model ? html`<span class="badge">model: ${i.model}</span>` : null}
                  </div>`
                : null}
            </div>`,
          )}`,
      )}
      ${kind !== 'mcp' && data && !items.length ? html`<div class="empty">No ${kind}s${q ? ' match' : ''}.</div>` : null}
    </div>
  <//>`;
}
