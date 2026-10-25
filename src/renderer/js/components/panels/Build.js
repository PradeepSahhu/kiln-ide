// Build tool window (steps + console) and Problems tool window.
import { html, useEffect, useRef, useState, useMemo } from '../../lib/preact.js';
import { useStore, store } from '../../lib/store.js';
import { Icon, FileIcon } from '../../lib/icons.js';
import { cls, formatDuration, relative, basename } from '../../lib/util.js';
import { Terminal } from '../../../../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { themeById, terminalTheme } from '../../lib/themes.js';
import { ToolWindow, Spinner } from '../ui.js';
import { buildOutput, onBuildOutput, startBuild, cancelBuild } from '../../services/build.js';
import * as ed from '../../services/editor.js';
import { fixBuildProblems } from '../../services/claude.js';

const STATUS_ICON = {
  running: html`<${Spinner} size=${14} />`,
  success: html`<${Icon} name="success" size=${14} className="ok" />`,
  warning: html`<${Icon} name="warning" size=${14} className="sev-warning" />`,
  error: html`<${Icon} name="error" size=${14} className="sev-error" />`,
  skipped: html`<${Icon} name="minus" size=${14} className="dim" />`,
  cancelled: html`<${Icon} name="stop" size=${14} className="dim" />`,
};

/** Read-only xterm that shows build output (keeps ANSI colors from dotnet/pip/npm). */
function BuildConsole({ stepId }) {
  const ref = useRef(null);
  const termRef = useRef(null);
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const term = new Terminal({ fontFamily: "'JetBrains Mono', Menlo, monospace", fontSize: 12, lineHeight: 1.2, convertEol: true, disableStdin: true, scrollback: 50000, cursorBlink: false, theme: terminalTheme(themeById(theme)) });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    termRef.current = { term, fit };
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      term.dispose();
    };
  }, []);
  useEffect(() => {
    if (termRef.current) termRef.current.term.options.theme = terminalTheme(themeById(theme));
  }, [theme]);
  useEffect(() => {
    const t = termRef.current;
    if (!t) return undefined;
    t.term.reset();
    t.term.write(buildOutput(stepId));
    return onBuildOutput((e) => {
      if (e.reset) t.term.reset();
      else if (!stepId || e.stepId === stepId) t.term.write(e.text);
    });
  }, [stepId]);
  return html`<div class="console" ref=${ref}></div>`;
}

export function BuildPanel({ onHide }) {
  const build = useStore((s) => s.build);
  const [selected, setSelected] = useState(null);
  const summary = build.running ? 'Building…' : build.status === 'success' ? 'Build succeeded' : build.status === 'failed' ? 'Build failed' : build.status === 'cancelled' ? 'Build cancelled' : 'Not built yet';
  return html`<${ToolWindow} side="bottom" title="Build" testid="build-panel" onHide=${onHide}
      actions=${html`
        <button class="icon-btn sm" title="Build" onClick=${() => startBuild({ reason: 'manual' })} disabled=${build.running}><${Icon} name="hammer" /></button>
        <button class="icon-btn sm" title="Rebuild (reinstall dependencies, no incremental build)" onClick=${() => startBuild({ reason: 'manual', mode: 'rebuild' })} disabled=${build.running}><${Icon} name="rebuild" /></button>
        <button class="icon-btn sm" title="Cancel" onClick=${cancelBuild} disabled=${!build.running}><${Icon} name="stop" /></button>`}>
    <div class="build-panel">
      <div class="build-steps">
        <div class=${cls('build-summary', build.status)} onClick=${() => setSelected(null)} style="cursor:pointer">
          ${build.running ? html`<${Spinner} />` : build.status === 'success' ? html`<${Icon} name="success" className="ok" />` : build.status === 'failed' ? html`<${Icon} name="error" className="sev-error" />` : html`<${Icon} name="hammer" className="muted" />`}
          <span>${summary}</span>
          <span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">${build.errors ? `${build.errors} errors ` : ''}${build.warnings ? `${build.warnings} warnings ` : ''}${build.durationMs ? formatDuration(build.durationMs) : ''}</span>
        </div>
        ${build.steps.map(
          (st) => html`<div key=${st.id} class=${cls('build-step', selected === st.id && 'selected')} data-testid="build-step" data-status=${st.status} onClick=${() => setSelected(st.id)} title=${st.detail || ''}>
            ${STATUS_ICON[st.status] || STATUS_ICON.running}
            <span class="title">${st.title}</span>
            ${st.detail ? html`<span class="detail">${st.detail}</span>` : null}
            <span class="time">${st.endedAt ? formatDuration(st.endedAt - st.startedAt) : ''}</span>
          </div>`,
        )}
      </div>
      <${BuildConsole} stepId=${selected} />
    </div>
  <//>`;
}

// ------------------------------------------------------------- Problems

export function ProblemsPanel({ onHide }) {
  const problems = useStore((s) => s.problems);
  const root = useStore((s) => s.project.root);
  const [filter, setFilter] = useState({ error: true, warning: true, info: false });
  const [collapsed, setCollapsed] = useState(() => new Set());
  const groups = useMemo(() => {
    const byFile = new Map();
    const add = (p) => {
      if (!filter[p.severity === 'hint' ? 'info' : p.severity]) return;
      const key = p.file || '';
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(p);
    };
    const liveFiles = new Set(Object.keys(problems.live));
    for (const p of problems.build) {
      // A saved file's live check supersedes build results from the same checker.
      if (p.file && liveFiles.has(p.file) && ['python', 'imports', 'pyflakes'].includes(p.source) && problems.live[p.file].some((x) => !x.lsp)) continue;
      add(p);
    }
    for (const list of Object.values(problems.live)) for (const p of list) add(p);
    const out = [...byFile.entries()].map(([file, list]) => ({ file, list: list.sort((a, b) => (a.severity === b.severity ? (a.line || 0) - (b.line || 0) : a.severity === 'error' ? -1 : 1)) }));
    out.sort((a, b) => (a.file ? 1 : 0) - (b.file ? 1 : 0) || b.list.filter((p) => p.severity === 'error').length - a.list.filter((p) => p.severity === 'error').length || a.file.localeCompare(b.file));
    return out;
  }, [problems, filter]);
  const total = groups.reduce((n, g) => n + g.list.length, 0);
  const errors = groups.reduce((n, g) => n + g.list.filter((p) => p.severity === 'error').length, 0);
  const toggle = (f) => {
    const n = new Set(collapsed);
    n.has(f) ? n.delete(f) : n.add(f);
    setCollapsed(n);
  };
  const sevBtn = (k, icon, label) => html`<button class=${cls('tw-tab', filter[k] && 'active')} onClick=${() => setFilter({ ...filter, [k]: !filter[k] })} title=${`Show ${label}`}><${Icon} name=${icon} size=${13} className=${k === 'error' ? 'sev-error' : k === 'warning' ? 'sev-warning' : 'sev-info'} />${label}</button>`;
  return html`<${ToolWindow} side="bottom" title="Problems" testid="problems-panel" onHide=${onHide}
      tabs=${html`${sevBtn('error', 'error', 'Errors')}${sevBtn('warning', 'warning', 'Warnings')}${sevBtn('info', 'info', 'Weak warnings')}`}
      actions=${html`${errors ? html`<button class="btn small" onClick=${fixBuildProblems}><${Icon} name="claude" size=${13} style="color:#D97757" />Fix with Claude</button>` : null}`}>
    <div class="list" style="padding:4px 0">
      ${groups.map(
        (g) => html`<div key=${g.file}>
          <div class="problem-file" onClick=${() => toggle(g.file)}>
            <${Icon} name=${collapsed.has(g.file) ? 'chevronRight' : 'chevronDown'} size=${12} className="muted" />
            ${g.file ? html`<${FileIcon} name=${basename(g.file)} />` : html`<${Icon} name="project" size=${14} />`}
            <span>${g.file ? basename(g.file) : 'Project'}</span>
            <span class="muted" style="font-size:12px;font-weight:400">${g.file ? relative(root, g.file) : ''}</span>
            <span class="badge">${g.list.length}</span>
          </div>
          ${collapsed.has(g.file)
            ? null
            : g.list.map(
                (p) => html`<div class="problem-item" data-testid="problem-item" data-severity=${p.severity} onDblClick=${() => p.file && ed.openFile(p.file, { line: p.line || 1, col: p.col || 1 })} onClick=${() => p.file && ed.openFile(p.file, { line: p.line || 1, col: p.col || 1, focus: false })}>
                  <${Icon} name=${p.severity === 'error' ? 'error' : p.severity === 'warning' ? 'warning' : 'info'} size=${14} className=${`sev-${p.severity}`} />
                  <span class="msg" title=${p.message}>${p.message}</span>
                  <span class="loc">${p.code ? `${p.code} · ` : ''}${p.source}${p.line ? ` · ${p.line}:${p.col || 1}` : ''}</span>
                </div>`,
              )}
        </div>`,
      )}
      ${!total ? html`<div class="empty">No problems found${problems.build.length ? ' for the selected severities' : ''}.</div>` : null}
    </div>
  <//>`;
}
