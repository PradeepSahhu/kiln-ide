// AI dialogs: a preview of what Generate Documentation / Generate Tests would change (nothing is written
// before Apply), and the review of the changes to commit.
import { html, useEffect, useState } from '../lib/preact.js';
import { Icon, FileIcon } from '../lib/icons.js';
import { invoke } from '../lib/ipc.js';
import { closeModal } from '../lib/ui.js';
import { cls, basename } from '../lib/util.js';
import { store } from '../lib/store.js';
import { Spinner } from './ui.js';
import { Modal, registerModal } from './dialogs.js';
import * as ed from '../services/editor.js';

function Hunks({ hunks }) {
  return html`<div class="change-lines ai-hunks" data-testid="ai-preview-hunks">
    ${hunks.map((h) => html`<div class="change-hunk">
      <div class="hunk-head">@@ -${h.oldStart} +${h.newStart}</div>
      ${h.lines.map((l) => html`<div class=${cls('change-line', l.type)}><span>${l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span><span class="txt">${l.text}</span></div>`)}
    </div>`)}
  </div>`;
}

function PreviewDialog({ title, run }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    run()
      .then((r) => setState({ result: r }))
      .catch((err) => setState({ error: err.message }));
  }, []);
  const r = state.result;
  const root = (store.get().project || {}).root || '';
  return html`<${Modal} title=${title} wide="x" testid="ai-preview" onClose=${() => closeModal(null)}
      footer=${html`${r ? html`<span class="muted" style="font-size:12px">${r.created ? 'New file' : 'Changes to'} ${r.file.startsWith(root) ? r.file.slice(root.length + 1) : r.file}</span>` : null}<div class="spacer"></div>
        <button class="btn" onClick=${() => closeModal(null)}>Cancel</button>
        <button class="btn primary" data-testid="ai-apply" disabled=${!r || !r.hunks.length} onClick=${() => closeModal(r)}>Apply</button>`}>
    <div data-testid="ai-preview-state" data-state=${state.loading ? 'loading' : state.error ? 'error' : 'ready'}>
      ${state.loading ? html`<div class="empty"><${Spinner} /> Claude is writing…</div>` : null}
      ${state.error ? html`<div class="empty sev-error">${state.error}</div>` : null}
      ${r ? html`<div class="row" style="gap:6px;margin-bottom:6px"><${FileIcon} name=${basename(r.file)} /><b>${basename(r.file)}</b>${r.framework ? html`<span class="badge">${r.framework}</span>` : null}</div><${Hunks} hunks=${r.hunks} />` : null}
      ${r && !r.hunks.length ? html`<div class="empty">No changes.</div>` : null}
    </div>
  <//>`;
}

const SEV_ICON = { error: ['error', 'sev-error'], warning: ['warning', 'sev-warning'], info: ['info', 'sev-info'] };

function ReviewDialog({ files }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    invoke('ai:review', { files })
      .then((r) => setState({ result: r }))
      .catch((err) => setState({ error: err.message }));
  }, []);
  const r = state.result;
  const open = (f) => {
    closeModal(false);
    ed.openFile(f.abs, { line: f.line });
  };
  return html`<${Modal} title="Review Changes with Claude" wide=${true} testid="ai-review" onClose=${() => closeModal(false)}
      footer=${html`<span class="muted" style="font-size:12px">${files.length} file${files.length === 1 ? '' : 's'} reviewed${r && r.truncated ? ' (long diff: only its beginning)' : ''}</span><div class="spacer"></div>
        <button class="btn" onClick=${() => closeModal(false)}>Close</button>
        <button class=${cls('btn', r && r.findings.some((f) => f.severity === 'error') ? '' : 'primary')} data-testid="ai-review-commit" disabled=${!r} onClick=${() => closeModal(true)}>${r && r.findings.length ? 'Commit Anyway' : 'Commit'}</button>`}>
    <div data-testid="ai-review-state" data-state=${state.loading ? 'loading' : state.error ? 'error' : 'ready'}>
      ${state.loading ? html`<div class="empty"><${Spinner} /> Claude is reviewing the changes…</div>` : null}
      ${state.error ? html`<div class="empty sev-error">${state.error}</div>` : null}
      ${r ? html`<div class="message" style="margin-bottom:10px">${r.summary}</div>
          <div class="list review-list">
            ${r.findings.map((f) => {
              const [icon, tone] = SEV_ICON[f.severity] || SEV_ICON.info;
              return html`<div class="review-row" data-testid="ai-finding" data-severity=${f.severity} onClick=${() => open(f)} title="Open">
                <${Icon} name=${icon} className=${tone} size=${14} />
                <div class="grow" style="min-width:0"><div><span class="mono">${f.file}:${f.line}</span> ${f.message}</div>${f.suggestion ? html`<div class="muted" style="font-size:12px">${f.suggestion}</div>` : null}</div>
              </div>`;
            })}
            ${!r.findings.length ? html`<div class="empty"><${Icon} name="success" className="ok" /> No problems found.</div>` : null}
          </div>` : null}
    </div>
  <//>`;
}

registerModal('aiPreview', PreviewDialog);
registerModal('aiReview', ReviewDialog);
