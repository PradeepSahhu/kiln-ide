// Welcome screen: recent solutions with a preview of each, toolchain status, New / Open / Clone.
import { html, useState, useEffect, useMemo } from '../lib/preact.js';
import { useStore } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { invoke, isMac } from '../lib/ipc.js';
import { run } from '../lib/commands.js';
import { cls, timeAgo, dirname, formatDate } from '../lib/util.js';
import { openProject, loadRecent } from '../services/project.js';

const PALETTE = ['#E5375B', '#3574F0', '#8E5BD8', '#2E9E8F', '#E08A2E', '#C0526A', '#4A9C5D', '#5B6CD8'];
export function projectColor(name = '') {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export function initials(name = '') {
  const parts = name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const caps = name.match(/[A-Z]/g);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (caps && caps.length > 1) return (caps[0] + caps[1]).toUpperCase();
  return (name.slice(0, 2) || '?').toUpperCase();
}

export function ProjectBadge({ name, size = 20, className = '' }) {
  return html`<span class=${cls('project-badge', className)} style=${{ background: projectColor(name), width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, borderRadius: `${Math.round(size * 0.26)}px` }}>${initials(name)}</span>`;
}

const KIND_LABEL = { dotnet: '.NET', python: 'Python', node: 'Node', agentic: 'Agentic AI' };

function Toolchain() {
  const tc = useStore((s) => s.toolchain);
  const items = [
    ['dotnet', '.NET SDK', tc && tc.dotnet],
    ['python', 'Python', tc && tc.python],
    ['git', 'Git', tc && tc.git],
    ['node', 'Node.js', tc && tc.node],
    ['uv', 'uv', tc && tc.uv],
    ['claude', 'Claude Agent SDK', tc && tc.claudeSdk && { found: tc.claudeSdk.found, version: tc.claudeSdk.claudeCode ? `Claude Code ${tc.claudeSdk.claudeCode}` : tc.claudeSdk.version }],
  ];
  return html`<div class="toolchain">
    ${items.map(
      ([id, label, t]) => html`<div class="tool-card" data-testid=${`toolchain-${id}`} data-found=${t ? String(!!t.found) : 'pending'} title=${t && t.path ? t.path : ''}>
        ${!t ? html`<${Icon} name="spinner" className="spin muted" />` : t.found ? html`<${Icon} name="success" className="ok" />` : html`<${Icon} name="warning" className="sev-warning" />`}
        <span>${label}</span>
        <span class="v">${!t ? '' : t.found ? t.version || 'found' : 'not found'}</span>
      </div>`,
    )}
  </div>`;
}

function Preview({ item }) {
  if (!item) return html`<div class="recent-preview"><div class="empty">Select a solution to see its details.</div></div>`;
  const lb = item.lastBuild;
  return html`<div class="recent-preview" data-testid="recent-preview">
    <div class="row" style="gap:12px"><${ProjectBadge} name=${item.name} size=${40} /><div class="grow"><h3 class="ellipsis">${item.name}</h3><div class="muted ellipsis" style="font-size:12px">${dirname(item.path)}</div></div></div>
    <div class="kv">
      <span class="k">Type</span><span>${(item.kinds || []).map((k) => KIND_LABEL[k] || k).join(', ') || 'Folder'}</span>
      ${item.summary ? html`<span class="k">Detected</span><span>${item.summary}</span>` : null}
      ${item.frameworks && item.frameworks.length ? html`<span class="k">Agent frameworks</span><span>${item.frameworks.join(', ')}</span>` : null}
      ${item.branch ? html`<span class="k">Branch</span><span class="row"><${Icon} name="branch" size=${14} />${item.branch}</span>` : null}
      <span class="k">Last opened</span><span>${formatDate(item.openedAt)}</span>
      <span class="k">Last build</span><span>${lb ? html`<span class=${lb.status === 'success' ? 'ok' : lb.status === 'failed' ? 'sev-error' : 'muted'}>${lb.status}</span> <span class="muted">· ${timeAgo(lb.at)}</span>` : html`<span class="muted">not built yet</span>`}</span>
    </div>
    <div class="row" style="gap:8px">
      <button class="btn primary" onClick=${() => openProject(item.path)}>Open</button>
      <button class="btn" onClick=${() => invoke('app:newWindow', item.path)}>Open in New Window</button>
      <button class="btn" onClick=${() => invoke('app:showItemInFolder', item.path)}>Reveal</button>
    </div>
  </div>`;
}

export function Welcome() {
  const recent = useStore((s) => s.recent);
  const info = useStore((s) => s.appInfo);
  const loading = useStore((s) => s.projectLoading);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [nav, setNav] = useState('projects');
  useEffect(() => {
    loadRecent();
  }, []);
  const list = useMemo(() => recent.filter((r) => !q || (r.name + ' ' + r.path).toLowerCase().includes(q.toLowerCase())), [recent, q]);
  const current = list[Math.min(sel, list.length - 1)];
  const key = (e) => {
    if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, list.length - 1));
    else if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0));
    else if (e.key === 'Enter' && current) openProject(current.path);
  };
  return html`<div class="welcome" data-testid="welcome">
    <div class="welcome-side">
      <div class="welcome-brand">
        <div class="logo">K</div>
        <div><div class="name">Kiln IDE</div><div class="ver">${info ? `v${info.version}` : ''}</div></div>
      </div>
      <div class=${cls('welcome-nav', nav === 'projects' && 'active')} onClick=${() => setNav('projects')}><${Icon} name="project" />Projects</div>
      <div class=${cls('welcome-nav', nav === 'customize' && 'active')} onClick=${() => run('view.settings')}><${Icon} name="palette" />Customize</div>
      <div class=${cls('welcome-nav')} onClick=${() => run('view.artifacts')}><${Icon} name="book" />Artifacts Library</div>
      <div class=${cls('welcome-nav')} onClick=${() => run('help.shortcuts')}><${Icon} name="keyboard" />Keyboard Shortcuts</div>
      <div class="spacer"></div>
    </div>
    <div class="welcome-main">
      <div class="welcome-top">
        <input class="input" placeholder="Search projects" value=${q} onInput=${(e) => { setQ(e.target.value); setSel(0); }} onKeyDown=${key} />
        <div class="spacer"></div>
        <button class="btn primary" data-testid="welcome-new-project" onClick=${() => run('project.new')}><${Icon} name="plus" />New Solution</button>
        <button class="btn" data-testid="welcome-open" onClick=${() => run('project.open')}><${Icon} name="folder" />Open</button>
        <button class="btn" onClick=${() => run('project.clone')}><${Icon} name="git" />Clone Repository</button>
      </div>
      <${Toolchain} />
      ${loading ? html`<div class="claude-status" style="padding:0 18px 8px"><${Icon} name="spinner" className="spin" />Opening ${loading}…</div>` : null}
      <div class="welcome-content">
        ${list.length
          ? html`<div class="recent-list" data-testid="recent-list">
              <div class="section-title">Recent solutions</div>
              ${list.map(
                (r, i) => html`<div class=${cls('recent-item', i === sel && 'selected')} data-testid="recent-item" data-path=${r.path} onClick=${() => setSel(i)} onDblClick=${() => openProject(r.path)}>
                  <${ProjectBadge} name=${r.name} size=${34} className="pb" />
                  <div class="info">
                    <div class="title">${r.name}${r.branch ? html`<span class="muted" style="font-weight:400;font-size:12px"><${Icon} name="branch" size=${12} /> ${r.branch}</span>` : null}</div>
                    <div class="path">${r.path.replace(/^\/Users\/[^/]+/, '~')}</div>
                    <div class="kinds">${(r.kinds || []).map((k) => html`<span class=${cls('badge', k === 'agentic' && 'accent')}>${KIND_LABEL[k] || k}</span>`)}${r.lastBuild ? html`<span class=${cls('badge', r.lastBuild.status === 'success' ? 'ok' : r.lastBuild.status === 'failed' ? 'err' : '')}>${r.lastBuild.status}</span>` : null}</div>
                  </div>
                  <span class="muted" style="font-size:11px">${timeAgo(r.openedAt)}</span>
                  <button class="icon-btn sm remove" title="Remove from list" onClick=${async (e) => { e.stopPropagation(); await invoke('app:removeRecent', r.path); loadRecent(); }}><${Icon} name="close" /></button>
                </div>`,
              )}
            </div>
            <${Preview} item=${current} />`
          : html`<div class="welcome-empty"><div>
              <div style="font-size:16px;color:var(--text);margin-bottom:6px">Welcome to Kiln IDE</div>
              <div>Create a new C#/.NET, Python or JavaScript solution, or open an existing folder.<br />Projects build automatically when they open.</div>
              <div class="actions"><button class="btn primary" onClick=${() => run('project.new')}>New Solution</button><button class="btn" onClick=${() => run('project.open')}>Open…</button></div>
              <div style="margin-top:14px;font-size:12px">Tip: press ${isMac ? '⇧⇧' : 'Shift Shift'} anywhere to search everything.</div>
            </div></div>`}
      </div>
    </div>
  </div>`;
}
