// Status bar: build/index progress, language servers, problems count, caret position, encoding, SDKs.
import { html } from '../lib/preact.js';
import { useStore } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { run } from '../lib/commands.js';
import { cls, formatDuration } from '../lib/util.js';
import { openTool } from '../services/layout.js';
import { Spinner } from './ui.js';

export function StatusBar() {
  const build = useStore((s) => ({ running: s.build.running, status: s.build.status, errors: s.build.errors, warnings: s.build.warnings, steps: s.build.steps, durationMs: s.build.durationMs }));
  const index = useStore((s) => s.index);
  const lsp = useStore((s) => s.lsp);
  const cursor = useStore((s) => s.editor.cursor);
  const meta = useStore((s) => ({ eol: s.editor.eol, encoding: s.editor.encoding, language: s.editor.language, hasFile: !!s.editor.tabs.find((t) => t.id === s.editor.active && t.kind === 'file') }));
  const counts = useStore((s) => {
    let e = 0;
    let w = 0;
    for (const p of s.problems.build) p.severity === 'error' ? e++ : p.severity === 'warning' ? w++ : 0;
    for (const list of Object.values(s.problems.live)) for (const p of list) p.severity === 'error' ? e++ : p.severity === 'warning' ? w++ : 0;
    return { e, w };
  });
  const tc = useStore((s) => s.toolchain);
  const det = useStore((s) => s.project && s.project.detection);
  const settings = useStore((s) => s.settings);
  const runningStep = build.running && build.steps.length ? build.steps[build.steps.length - 1] : null;
  const lspItems = Object.entries(lsp || {}).filter(([, v]) => v && v.state && v.state !== 'stopped');
  return html`<div class="statusbar" data-testid="statusbar">
    <span data-testid="build-status" data-status=${build.running ? 'running' : build.status || 'idle'} hidden></span>
    ${build.running
      ? html`<span class="item" onClick=${() => openTool('bottom', 'build')}><${Spinner} size=${12} />${runningStep ? runningStep.title : 'Building'}…<span class="progress indeterminate"><div></div></span></span>`
      : build.status
        ? html`<span class="item" data-testid="build-status-bar" onClick=${() => openTool('bottom', 'build')}>${build.status === 'success' ? html`<${Icon} name="success" size=${13} className="ok" />Build succeeded` : build.status === 'failed' ? html`<${Icon} name="error" size=${13} className="sev-error" />Build failed` : html`<${Icon} name="info" size=${13} />Build ${build.status}`}${build.durationMs ? html`<span class="dim">${formatDuration(build.durationMs)}</span>` : null}</span>`
        : null}
    ${index && index.state === 'indexing' ? html`<span class="item" title="Building the code index and knowledge graph"><${Spinner} size=${12} />Indexing${index.total ? ` ${index.done}/${index.total}` : '…'}</span>` : null}
    ${lspItems.map(([lang, v]) => html`<span class="item" title=${v.message || ''}>${v.state === 'starting' || v.state === 'busy' ? html`<${Spinner} size=${12} />` : v.state === 'ready' ? html`<${Icon} name="dot" size=${10} className="ok" />` : html`<${Icon} name="dot" size=${10} className=${v.state === 'error' ? 'sev-error' : 'muted'} />`}${v.server || (lang === 'python' ? 'pyright' : 'csharp-ls')}${v.state === 'missing' ? ' (not installed)' : ''}</span>`)}
    <div class="spacer"></div>
    <span class="item" data-testid="problem-counts" onClick=${() => openTool('bottom', 'problems')} title="Problems">
      <${Icon} name="error" size=${13} className=${counts.e ? 'sev-error' : 'dim'} />${counts.e}
      <${Icon} name="warning" size=${13} className=${counts.w ? 'sev-warning' : 'dim'} />${counts.w}
    </span>
    ${meta.hasFile && cursor ? html`<span class="item" onClick=${() => run('navigate.line')}>${cursor.line}:${cursor.col}</span>` : null}
    ${meta.hasFile ? html`<span class="item">${meta.eol}</span><span class="item">${meta.encoding}</span><span class="item">${settings && settings.editor.insertSpaces !== false ? `${settings.editor.tabSize || 4} spaces` : 'Tab'}</span>` : null}
    ${meta.hasFile && meta.language ? html`<span class="item">${meta.language}</span>` : null}
    ${det && det.python && tc && tc.python ? html`<span class="item" title=${tc.python.path || ''}><${Icon} name="dot" size=${10} style="color:#4B8BBE" />Python ${tc.python.version || ''}</span>` : null}
    ${det && det.dotnet && tc && tc.dotnet ? html`<span class="item" title=${(tc.dotnet.sdks || []).join(', ')}><${Icon} name="dot" size=${10} style="color:#8E5BD8" />.NET ${tc.dotnet.version || ''}</span>` : null}
    <span class="item" title="Claude" onClick=${() => run('view.claude')}><${Icon} name="claude" size=${12} style="color:#D97757" /></span>
  </div>`;
}
