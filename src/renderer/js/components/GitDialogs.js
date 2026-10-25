// Git log dialogs: Reset Current Branch to Here (soft / mixed / hard / keep) and Interactive Rebase
// from Here (reorder, reword, squash, fixup, drop).
import { html, useState } from '../lib/preact.js';
import { Icon } from '../lib/icons.js';
import { closeModal } from '../lib/ui.js';
import { cls, timeAgo } from '../lib/util.js';
import { Modal, registerModal } from './dialogs.js';

const MODES = [
  ['soft', 'Soft', 'Files stay as they are; the changes of the undone commits are staged.'],
  ['mixed', 'Mixed', 'Files stay as they are; the changes of the undone commits become unstaged local changes.'],
  ['hard', 'Hard', 'Files are reset to that commit: local changes and the undone commits are discarded.'],
  ['keep', 'Keep', 'Files are reset to that commit, but local changes are kept (stops if they would be overwritten).'],
];

function ResetDialog({ commit, branch }) {
  const [mode, setMode] = useState('mixed');
  return html`<${Modal} title="Git Reset" testid="reset-dialog" onClose=${() => closeModal(null)}
      footer=${html`<div class="spacer"></div><button class="btn" onClick=${() => closeModal(null)}>Cancel</button><button class=${cls('btn', mode === 'hard' ? 'danger' : 'primary')} data-testid="reset-confirm" onClick=${() => closeModal(mode)}>Reset</button>`}>
    <div class="message">Reset ${branch ? html`<b>${branch}</b>` : 'HEAD'} to <span class="mono">${commit.hash.slice(0, 10)}</span> ${commit.subject}</div>
    <div class="reset-modes">
      ${MODES.map(([id, label, desc]) => html`<label class=${cls('reset-mode', mode === id && 'selected')} data-testid=${`reset-mode-${id}`}>
          <input type="radio" name="reset-mode" checked=${mode === id} onChange=${() => setMode(id)} /><div><div class="nm">${label}</div><div class="muted">${desc}</div></div>
        </label>`)}
    </div>
  <//>`;
}

const ACTIONS = [
  ['pick', 'Pick'],
  ['reword', 'Reword'],
  ['squash', 'Squash'],
  ['fixup', 'Fixup'],
  ['drop', 'Drop'],
];

function RebaseDialog({ plan }) {
  const [steps, setSteps] = useState(() => plan.commits.map((c) => ({ ...c, action: 'pick', newMessage: c.message })));
  const [sel, setSel] = useState(0);
  const set = (i, patch) => setSteps((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    setSteps((list) => {
      const next = list.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setSel(j);
  };
  const first = steps.find((s) => s.action !== 'drop');
  const error = !first ? 'Every commit is dropped.' : first.action === 'squash' || first.action === 'fixup' ? 'The first commit cannot be squashed or fixed up: there is nothing before it to join.' : null;
  const start = () => closeModal(steps.map((s) => ({ hash: s.hash, action: s.action, message: s.action === 'reword' ? s.newMessage : undefined })));
  const cur = steps[sel];
  return html`<${Modal} title="Interactive Rebase" wide=${true} testid="rebase-dialog" onClose=${() => closeModal(null)}
      footer=${html`${error ? html`<span class="sev-warning" style="font-size:12px">${error}</span>` : html`<span class="muted" style="font-size:12px">${steps.length} commit${steps.length === 1 ? '' : 's'}, oldest first · local changes are stashed and re-applied</span>`}<div class="spacer"></div><button class="btn" onClick=${() => closeModal(null)}>Cancel</button><button class="btn primary" data-testid="rebase-start" disabled=${!!error} onClick=${start}>Start Rebasing</button>`}>
    <div class="rebase-list" data-testid="rebase-list">
      ${steps.map((s, i) => html`<div class=${cls('rebase-row', sel === i && 'selected', `a-${s.action}`)} data-testid="rebase-row" data-hash=${s.hash} data-subject=${s.subject} onClick=${() => setSel(i)}>
          <select class="input" data-testid=${`rebase-action-${i}`} value=${s.action} onClick=${(e) => e.stopPropagation()} onChange=${(e) => { set(i, { action: e.target.value }); setSel(i); }}>${ACTIONS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
          <span class="mono muted">${s.short}</span>
          <span class="ellipsis grow subj">${s.action === 'reword' ? (s.newMessage || '').split('\n')[0] : s.subject}</span>
          <span class="muted when">${s.author} · ${timeAgo(s.date)}</span>
          <button class="icon-btn sm" title="Move Up" data-testid=${`rebase-up-${i}`} disabled=${i === 0} onClick=${(e) => { e.stopPropagation(); move(i, -1); }}><${Icon} name="arrowUp" size=${13} /></button>
          <button class="icon-btn sm" title="Move Down" data-testid=${`rebase-down-${i}`} disabled=${i === steps.length - 1} onClick=${(e) => { e.stopPropagation(); move(i, 1); }}><${Icon} name="arrowDown" size=${13} /></button>
        </div>`)}
    </div>
    ${cur && cur.action === 'reword'
      ? html`<div class="field" style="margin-top:10px"><label>New message for ${cur.short}</label><textarea class="input mono" rows="4" data-testid="rebase-message" value=${cur.newMessage} onInput=${(e) => set(sel, { newMessage: e.target.value })}></textarea></div>`
      : html`<div class="muted" style="margin-top:10px;font-size:12px">Squash joins a commit into the one above it and keeps both messages; Fixup keeps only the message above. Reorder with the arrows.</div>`}
  <//>`;
}

registerModal('gitReset', ResetDialog);
registerModal('interactiveRebase', RebaseDialog);
