// Main toolbar (Rider New UI): project widget, Git branch widget, run configurations, build/run/stop.
import { html, useState, useRef, useMemo, useEffect } from '../lib/preact.js';
import { useStore, store } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { isMac } from '../lib/ipc.js';
import { run, SHORTCUTS } from '../lib/commands.js';
import { cls, timeAgo } from '../lib/util.js';
import { showContextMenu } from '../lib/ui.js';
import { ProjectBadge } from './Welcome.js';
import { useOutsideClose, Spinner } from './ui.js';
import * as git from '../services/git.js';
import { openProject } from '../services/project.js';
import { startBuild, cancelBuild } from '../services/build.js';
import { startRun, stopRun } from '../services/sessions.js';
import { startDebug, stopDebug, canDebugConfig, isActive as isDebugActive } from '../services/debug.js';
import { openTool } from '../services/layout.js';

function ProjectPopup({ onClose }) {
  const recent = useStore((s) => s.recent);
  const root = useStore((s) => s.project && s.project.root);
  const ref = useRef(null);
  useOutsideClose(ref, onClose);
  return html`<div class="popup" ref=${ref} style="left:${isMac ? 80 : 8}px;top:38px;width:380px">
    <div class="popup-body">
      <div class="popup-item" onClick=${() => { onClose(); run('project.new'); }}><${Icon} name="plus" />New Solution…</div>
      <div class="popup-item" onClick=${() => { onClose(); run('project.open'); }}><${Icon} name="folder" />Open…</div>
      <div class="popup-item" onClick=${() => { onClose(); run('project.clone'); }}><${Icon} name="git" />Clone Repository…</div>
      <div class="popup-sep"></div>
      <div class="popup-header">Recent Projects</div>
      ${recent.filter((r) => r.path !== root).slice(0, 12).map((r) => html`<div class="popup-item" onClick=${() => { onClose(); openProject(r.path); }}><${ProjectBadge} name=${r.name} size=${18} /><span>${r.name}</span><span class="hint">${r.path.replace(/^\/Users\/[^/]+/, '~')}</span></div>`)}
      <div class="popup-sep"></div>
      <div class="popup-item" onClick=${() => { onClose(); run('project.close'); }}><${Icon} name="close" />Close Project</div>
    </div>
  </div>`;
}

export function BranchPopup({ onClose }) {
  const branches = useStore((s) => s.git.branches);
  const status = useStore((s) => s.git.status);
  const [q, setQ] = useState('');
  const [showRemote, setShowRemote] = useState(false);
  const ref = useRef(null);
  const inputRef = useRef(null);
  useOutsideClose(ref, onClose);
  useEffect(() => {
    git.refreshBranches();
    setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
  }, []);
  const filt = (b) => !q || b.name.toLowerCase().includes(q.toLowerCase());
  const local = ((branches && branches.local) || []).filter(filt);
  const remote = ((branches && branches.remote) || []).filter(filt);
  const current = branches && branches.current;
  const act = (fn) => () => {
    onClose();
    fn();
  };
  const branchMenu = (e, b, isRemote) =>
    showContextMenu(e, [
      { label: 'Checkout', icon: 'branch', disabled: b.current, run: () => { onClose(); git.checkout(b.name, { remote: isRemote }); } },
      { label: `New Branch from '${b.name}'…`, icon: 'plus', run: () => { onClose(); git.newBranch(b.name); } },
      { label: 'Show Changes vs Current', icon: 'diff', disabled: b.current, run: () => { onClose(); run('git.branchChanges', b.name); } },
      { separator: true },
      { label: `Merge '${b.name}' into '${current}'`, icon: 'pull', disabled: b.current, run: () => { onClose(); git.mergeInto(b.name); } },
      { label: `Rebase '${current}' onto '${b.name}'`, icon: 'rebuild', disabled: b.current, run: () => { onClose(); git.rebaseOnto(b.name); } },
      ...(isRemote ? [] : [{ separator: true }, { label: 'Rename…', icon: 'edit', run: () => { onClose(); git.renameBranch(b.name); } }, { label: 'Delete', icon: 'trash', danger: true, disabled: b.current, run: () => git.deleteBranch(b.name) }]),
    ]);
  return html`<div class="popup branch-popup" ref=${ref} data-testid="branch-popup" style="left:${isMac ? 220 : 150}px;top:38px">
    <div class="popup-search"><input class="input" ref=${inputRef} placeholder="Search for branches and actions" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
    <div class="popup-body">
      ${!q
        ? html`
            <div class="popup-item" onClick=${act(() => git.pull())}><${Icon} name="pull" />Update Project…<span class="shortcut">${SHORTCUTS['git.pull']}</span></div>
            <div class="popup-item" onClick=${act(() => run('view.commit'))}><${Icon} name="commit" />Commit…<span class="shortcut">${SHORTCUTS['git.commit']}</span></div>
            <div class="popup-item" onClick=${act(() => git.push())}><${Icon} name="push" />Push…<span class="shortcut">${SHORTCUTS['git.push']}</span></div>
            <div class="popup-item" onClick=${act(() => git.newBranch())}><${Icon} name="plus" />New Branch…</div>
            <div class="popup-item" onClick=${act(() => git.fetch())}><${Icon} name="fetch" />Fetch</div>
            <div class="popup-sep"></div>`
        : null}
      <div class="popup-header">Local</div>
      ${local.map(
        (b) => html`<div class="popup-item" data-testid="branch-row" data-branch=${b.name} onClick=${(e) => (b.current ? branchMenu(e, b, false) : git.checkout(b.name).then(onClose))} onContextMenu=${(e) => branchMenu(e, b, false)} title=${b.subject || ''}>
          <${Icon} name=${b.current ? 'success' : 'branch'} className=${b.current ? 'current' : 'muted'} size=${14} />
          <span class=${cls('ellipsis', b.current && 'current')} style=${b.current ? 'font-weight:600' : ''}>${b.name}</span>
          ${b.upstream ? html`<span class="track">${b.ahead ? `↑${b.ahead} ` : ''}${b.behind ? `↓${b.behind} ` : ''}${b.upstream}</span>` : null}
          <span class="trail">
            <span class="hint" style="font-size:11px">${b.date ? timeAgo(b.date) : ''}</span>
            <button class="icon-btn sm" title="Branch actions" onClick=${(e) => { e.stopPropagation(); branchMenu(e, b, false); }}><${Icon} name="chevronRight" size=${14} /></button>
            ${!b.current ? html`<button class="icon-btn sm del" title=${`Delete ${b.name}`} data-testid="branch-delete" onClick=${(e) => { e.stopPropagation(); git.deleteBranch(b.name); }}><${Icon} name="close" size=${14} /></button>` : null}
          </span>
        </div>`,
      )}
      ${!local.length ? html`<div class="empty" style="padding:8px">No local branches${q ? ' match' : ''}</div>` : null}
      ${remote.length
        ? html`<div class="popup-header row" style="cursor:pointer" onClick=${() => setShowRemote(!showRemote)}><${Icon} name=${showRemote || q ? 'chevronDown' : 'chevronRight'} size=${12} />Remote (${remote.length})</div>
            ${showRemote || q
              ? remote.map((b) => html`<div class="popup-item" data-testid="remote-branch-row" onClick=${() => git.checkout(b.name, { remote: true }).then(onClose)} onContextMenu=${(e) => branchMenu(e, b, true)}><${Icon} name="branch" className="muted" size=${14} /><span class="ellipsis">${b.name}</span><span class="hint" style="margin-left:auto;font-size:11px">${timeAgo(b.date)}</span></div>`)
              : null}`
        : null}
      ${status && status.branch && status.branch.detached ? html`<div class="popup-sep"></div><div class="empty" style="padding:6px">HEAD is detached at ${status.branch.short}</div>` : null}
    </div>
  </div>`;
}

function RunPopup({ onClose }) {
  const runs = useStore((s) => s.runs);
  const ref = useRef(null);
  useOutsideClose(ref, onClose);
  const groups = useMemo(() => {
    const g = new Map();
    for (const c of runs.configs) {
      if (!g.has(c.group)) g.set(c.group, []);
      g.get(c.group).push(c);
    }
    return [...g];
  }, [runs.configs]);
  return html`<div class="popup" ref=${ref} style="right:120px;top:38px;width:400px">
    <div class="popup-body">
      ${groups.map(
        ([name, list]) => html`<div class="popup-header">${name}</div>
          ${list.map((c) => html`<div class=${cls('popup-item', runs.selected === c.id && 'selected')} data-testid="run-config-item" onClick=${() => { store.update('runs', { selected: c.id }); onClose(); }} title=${c.detail || ''}>
            <${Icon} name=${c.icon === 'test' ? 'test' : c.icon === 'agent' ? 'agent' : c.icon === 'web' ? 'web' : 'play'} className=${c.icon === 'test' ? 'ok' : 'muted'} size=${14} />
            <span class="ellipsis">${c.name}</span><span class="hint" style="margin-left:auto;font-size:11px">${c.detail || ''}</span>
            <button class="icon-btn sm" title="Run" onClick=${(e) => { e.stopPropagation(); onClose(); startRun(c); }}><${Icon} name="play" className="ok" size=${14} /></button>
            ${canDebugConfig(c) ? html`<button class="icon-btn sm" title="Debug" onClick=${(e) => { e.stopPropagation(); store.update('runs', { selected: c.id }); onClose(); startDebug(c); }}><${Icon} name="debug" className="ok" size=${14} /></button>` : null}
          </div>`)}`,
      )}
      ${!runs.configs.length ? html`<div class="empty">No run configurations were detected.</div>` : null}
      <div class="popup-sep"></div>
      <div class="popup-item" onClick=${() => { onClose(); run('run.editConfigurations'); }}><${Icon} name="edit" />Edit Configurations…</div>
    </div>
  </div>`;
}

export function Toolbar() {
  const project = useStore((s) => s.project);
  const status = useStore((s) => s.git.status);
  const runs = useStore((s) => s.runs);
  const build = useStore((s) => ({ running: s.build.running, steps: s.build.steps.length, status: s.build.status }));
  const [popup, setPopup] = useState(null);
  const popupReq = useStore((s) => s.toolbarPopup);
  useEffect(() => {
    if (popupReq) setPopup(popupReq.name);
  }, [popupReq]);
  const cfg = runs.configs.find((c) => c.id === runs.selected);
  const running = runs.sessions.filter((s) => s.running);
  const debugState = useStore((s) => (s.debug ? s.debug.state : null));
  const debugName = useStore((s) => (s.debug ? s.debug.name : ''));
  const debugging = isDebugActive(debugState);
  const isRepo = project && project.git && project.git.isRepo;
  const branchName = status && status.branch ? status.branch.head || (status.branch.detached ? status.branch.short : '') : '';
  const close = () => setPopup(null);
  return html`<div class=${cls('toolbar', isMac && 'mac')}>
    <button class=${cls('widget', popup === 'project' && 'open')} data-testid="project-widget" onClick=${() => setPopup(popup === 'project' ? null : 'project')}>
      <${ProjectBadge} name=${project.name} /><span class="label">${project.name}</span><${Icon} name="chevronDown" size=${12} className="chev" />
    </button>
    ${isRepo
      ? html`<button class=${cls('widget', popup === 'branch' && 'open')} data-testid="branch-widget" onClick=${() => setPopup(popup === 'branch' ? null : 'branch')} title="Git branches">
          <${Icon} name="branch" /><span class="label" style="font-weight:400">${branchName || '…'}</span>
          ${status && (status.branch.ahead || status.branch.behind) ? html`<span class="muted" style="font-size:11px">${status.branch.ahead ? `↑${status.branch.ahead}` : ''}${status.branch.behind ? ` ↓${status.branch.behind}` : ''}</span>` : null}
          <${Icon} name="chevronDown" size=${12} className="chev" />
        </button>`
      : html`<button class="widget" onClick=${() => git.initRepo()} title="Create a Git repository for this project"><${Icon} name="branch" className="muted" /><span class="muted">Version control</span></button>`}
    <div class="drag"></div>
    ${build.running ? html`<span class="build-indicator"><${Spinner} />Building…</span>` : null}
    <button class="icon-btn build" data-testid="build-button" title=${`Build Solution (${SHORTCUTS['build.build']})`} onClick=${() => (build.running ? cancelBuild() : startBuild({ reason: 'manual' }))}><${Icon} name=${build.running ? 'stop' : 'hammer'} /></button>
    <div class="run-widget">
      <button class=${cls('widget config', popup === 'run' && 'open')} data-testid="run-config" onClick=${() => setPopup(popup === 'run' ? null : 'run')} title=${cfg ? cfg.detail || cfg.name : 'Run configurations'}>
        <${Icon} name=${cfg && cfg.icon === 'test' ? 'test' : 'play'} size=${14} className="muted" /><span class="label" style="font-weight:400">${cfg ? cfg.name : 'No configurations'}</span><${Icon} name="chevronDown" size=${12} className="chev" />
      </button>
      <button class="icon-btn run" data-testid="run-button" disabled=${!cfg} title=${`Run '${cfg ? cfg.name : ''}' (${SHORTCUTS['run.run']})`} onClick=${() => cfg && startRun(cfg)}><${Icon} name="play" /></button>
      <button class="icon-btn debug" data-testid="debug-button" disabled=${!cfg && !debugging} title=${debugging ? `Debugging '${debugName}'` : `Debug '${cfg ? cfg.name : ''}' (⌃D)`} onClick=${() => (debugging ? openTool('bottom', 'debug') : startDebug(cfg))}><${Icon} name="debug" /></button>
      <button class="icon-btn stop" data-testid="stop-button" disabled=${!running.length && !debugging} title="Stop" onClick=${() => { running.forEach((s) => stopRun(s.id)); if (debugging) stopDebug(); }}><${Icon} name="stop" /></button>
    </div>
    <div class="sep"></div>
    <button class="icon-btn" title="Search Everywhere (⇧⇧)" onClick=${() => run('navigate.searchEverywhere')}><${Icon} name="search" /></button>
    <button class="icon-btn" title="Claude" onClick=${() => run('view.claude')}><${Icon} name="claude" style="color:#D97757" /></button>
    <button class="icon-btn" title="Settings" onClick=${() => run('view.settings')}><${Icon} name="settings" /></button>
    ${popup === 'project' ? html`<${ProjectPopup} onClose=${close} />` : null}
    ${popup === 'branch' ? html`<${BranchPopup} onClose=${close} />` : null}
    ${popup === 'run' ? html`<${RunPopup} onClose=${close} />` : null}
  </div>`;
}
