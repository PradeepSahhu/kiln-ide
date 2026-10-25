// The Conflicts dialog: every file with unresolved conflicts, resolved by accepting a side or opening
// the merge view; finishes the merge / rebase / cherry-pick when none are left.
import { html, useEffect, useState } from '../lib/preact.js';
import { useStore } from '../lib/store.js';
import { invoke } from '../lib/ipc.js';
import { closeModal, errorToast } from '../lib/ui.js';
import { basename, dirname } from '../lib/util.js';
import { FileIcon, Icon } from '../lib/icons.js';
import { Spinner } from './ui.js';
import { Modal, registerModal } from './dialogs.js';
import { openMerge, afterResolve, finishOperation } from '../services/conflicts.js';

const HOW = { UU: 'both modified', AA: 'both added', DU: 'deleted by you', UD: 'deleted by them', AU: 'added by you', UA: 'added by them', DD: 'both deleted' };

export function ConflictsDialog() {
  const status = useStore((s) => s.git.status);
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = () => invoke('git:conflicts').then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
  }, [status]);
  const accept = async (rel, side) => {
    setBusy(rel);
    try {
      await invoke('git:acceptSide', rel, side);
      await afterResolve();
    } catch (err) {
      errorToast('Could not resolve the conflict', err);
    }
    setBusy(null);
    load();
  };
  const op = status && (status.merging ? 'Merge' : status.rebasing ? 'Rebase' : status.cherryPicking ? 'Cherry-Pick' : status.reverting ? 'Revert' : null);
  return html`<${Modal} title="Conflicts" wide=${true} testid="conflicts-dialog"
      footer=${html`<div class="spacer"></div>${op && list && !list.length ? html`<button class="btn primary" data-testid="conflicts-finish" onClick=${() => { closeModal(true); finishOperation(); }}>${op === 'Merge' ? 'Commit Merge' : `Continue ${op}`}</button>` : null}<button class="btn" onClick=${() => closeModal(false)}>Close</button>`}>
    ${!list ? html`<div class="empty"><${Spinner} /></div>` : null}
    ${list && !list.length ? html`<div class="empty"><${Icon} name="success" className="ok" /> All conflicts are resolved.</div>` : null}
    ${list && list.length ? html`<div class="muted" style="margin-bottom:8px">${list.length} file${list.length === 1 ? '' : 's'} with conflicts. Accept one side, or Merge to choose per conflict.</div>` : null}
    <div class="list conflicts-list">
      ${(list || []).map(
        (c) => html`<div class="list-row conflict-row" data-testid="conflict-row" data-path=${c.path}>
          <${FileIcon} name=${basename(c.path)} /><span class="nm">${basename(c.path)}</span><span class="muted ellipsis" style="font-size:12px">${dirname(c.path) === '.' ? '' : dirname(c.path)}</span>
          <span class="badge warn">${HOW[c.how] || 'conflict'}</span><div class="spacer"></div>
          ${busy === c.path ? html`<${Spinner} />` : null}
          <button class="btn small" data-testid="conflict-ours" disabled=${!!busy} onClick=${() => accept(c.path, 'ours')}>Accept Yours</button>
          <button class="btn small" data-testid="conflict-theirs" disabled=${!!busy} onClick=${() => accept(c.path, 'theirs')}>Accept Theirs</button>
          <button class="btn small primary" data-testid="conflict-merge" disabled=${!!busy} onClick=${() => { closeModal(true); openMerge(c.path); }}>Merge…</button>
        </div>`,
      )}
    </div>
  <//>`;
}

registerModal('conflicts', ConflictsDialog);
