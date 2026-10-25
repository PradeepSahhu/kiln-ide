// Merge conflict resolver (Rider's Merge Revisions): every conflict with yours / base / theirs side by
// side and one-click choices, over an editable Result. Apply writes the result and marks the file
// resolved; when no conflicts are left the merge / rebase / cherry-pick can be finished from here.
import { html, useEffect, useRef, useState } from '../../lib/preact.js';
import { store } from '../../lib/store.js';
import { invoke } from '../../lib/ipc.js';
import { toast, errorToast, confirm } from '../../lib/ui.js';
import { basename, languageOf, cls } from '../../lib/util.js';
import { parseConflicts, buildResult } from '../../lib/merge.js';
import { Icon } from '../../lib/icons.js';
import { Spinner } from '../ui.js';
import * as ed from '../../services/editor.js';
import { afterResolve } from '../../services/conflicts.js';

const CHOICES = [
  ['ours', 'Accept Yours', 'merge-accept-ours'],
  ['theirs', 'Accept Theirs', 'merge-accept-theirs'],
  ['both', 'Accept Both', 'merge-accept-both'],
  ['theirsFirst', 'Both, Theirs First', 'merge-accept-theirs-first'],
];

function Code({ text, label, empty }) {
  return html`<div class="merge-side"><div class="merge-side-label">${label}</div><pre class="mono">${text || html`<span class="muted">${empty}</span>`}</pre></div>`;
}

export function MergeView({ tab }) {
  const rel = tab.data.path;
  const host = useRef(null);
  const editorRef = useRef(null);
  const [v, setV] = useState(null);
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    invoke('git:mergeVersions', rel)
      .then((data) => {
        if (!alive) return;
        setV(data);
        setText(data.merged || '');
      })
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [rel]);

  // The Result editor, once its container is on screen.
  useEffect(() => {
    if (!v || v.binary || !host.current) return undefined;
    const monaco = ed.getMonaco();
    const model = monaco.editor.createModel(v.merged, languageOf(rel));
    const editor = monaco.editor.create(host.current, { model, automaticLayout: true, minimap: { enabled: false }, fontSize: (store.get().settings.editor || {}).fontSize || 13, scrollBeyondLastLine: false, glyphMargin: false });
    editorRef.current = editor;
    const sub = model.onDidChangeContent(() => setText(model.getValue()));
    return () => {
      sub.dispose();
      editorRef.current = null;
      editor.dispose();
      model.dispose();
    };
  }, [v]);

  const segments = parseConflicts(text);
  const conflicts = segments.filter((s) => s.type === 'conflict');
  const total = v && !v.binary ? parseConflicts(v.merged).filter((s) => s.type === 'conflict').length : 0;

  const choose = (index, choice) => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    const next = buildResult(parseConflicts(model.getValue()), { [index]: choice });
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null);
    model.pushStackElement();
  };
  const chooseAll = (choice) => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    const segs = parseConflicts(model.getValue());
    const all = {};
    for (const s of segs) if (s.type === 'conflict') all[s.index] = choice;
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: buildResult(segs, all) }], () => null);
    model.pushStackElement();
  };
  const reveal = (c) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(c.line);
    editor.setPosition({ lineNumber: c.line, column: 1 });
    editor.focus();
  };
  const finish = async (fn) => {
    setBusy(true);
    try {
      await fn();
      ed.closeTab(tab.id);
      const open = ed.getDoc(`${store.get().project.git.root}/${rel}`);
      if (open) await ed.onFsChanged([`${store.get().project.git.root}/${rel}`]);
      await afterResolve();
    } catch (err) {
      errorToast('Could not resolve the conflict', err);
      setBusy(false);
    }
  };
  const apply = () => finish(() => invoke('git:resolveConflict', rel, editorRef.current.getModel().getValue()));
  const acceptFile = async (side) => {
    const missing = side === 'ours' ? v.oursMissing : v.theirsMissing;
    if (missing && !(await confirm({ title: 'Delete File', message: `${side === 'ours' ? 'Your' : 'Their'} side deleted ${basename(rel)}. Accepting it deletes the file.`, ok: 'Delete', danger: true }))) return;
    finish(() => invoke('git:acceptSide', rel, side));
  };

  if (error) return html`<div class="editor-empty" data-testid="merge-view"><div class="sev-error">${error}</div></div>`;
  if (!v) return html`<div class="editor-empty" data-testid="merge-view"><${Spinner} /> Loading the conflict…</div>`;
  return html`<div class="merge-view" data-testid="merge-view" data-unresolved=${conflicts.length}>
    <div class="merge-toolbar">
      <span class="title">${basename(rel)}</span>
      <span class="muted">${v.operation === 'rebase' ? 'Rebasing' : v.operation === 'cherry-pick' ? 'Cherry-picking' : v.operation === 'stash' ? 'Applying stash' : 'Merging'}: yours <b>${v.oursLabel}</b> ← theirs <b>${v.theirsLabel}</b></span>
      <div class="spacer"></div>
      <span class=${cls('badge', conflicts.length ? 'warn' : 'ok')} data-testid="merge-count">${conflicts.length ? `${conflicts.length} of ${total} conflict${total === 1 ? '' : 's'} left` : 'All conflicts resolved'}</span>
      <button class="btn small" data-testid="merge-file-ours" disabled=${busy} onClick=${() => acceptFile('ours')}>Accept Yours</button>
      <button class="btn small" data-testid="merge-file-theirs" disabled=${busy} onClick=${() => acceptFile('theirs')}>Accept Theirs</button>
      ${!v.binary ? html`<button class="btn small primary" data-testid="merge-apply" disabled=${busy || conflicts.length > 0} title=${conflicts.length ? 'Resolve every conflict first' : 'Save the result and mark the file resolved'} onClick=${apply}>${busy ? html`<${Spinner} />` : null}Apply</button>` : null}
    </div>
    ${v.binary
      ? html`<div class="editor-empty">Binary file: choose a side.</div>`
      : html`<div class="merge-body">
          <div class="merge-conflicts">
            ${conflicts.length > 1 ? html`<div class="row" style="gap:6px;margin-bottom:6px"><span class="muted" style="font-size:12px">All conflicts:</span>${CHOICES.slice(0, 2).map(([c, label]) => html`<button class="btn small" data-testid=${`merge-all-${c}`} onClick=${() => chooseAll(c)}>${label}</button>`)}</div>` : null}
            ${conflicts.map(
              (c) => html`<div class="merge-card" data-testid="merge-conflict" data-index=${c.index}>
                <div class="merge-card-head"><a onClick=${() => reveal(c)}>Conflict ${c.index + 1} · line ${c.line}</a><div class="spacer"></div>
                  ${CHOICES.map(([choice, label, testid]) => html`<button class="btn small" data-testid=${testid} onClick=${() => choose(c.index, choice)}>${label}</button>`)}
                  ${c.base != null ? html`<button class="btn small" data-testid="merge-accept-base" onClick=${() => choose(c.index, 'base')}>Base</button>` : null}
                </div>
                <div class="merge-sides">
                  <${Code} text=${c.ours} label=${`Yours (${v.oursLabel})`} empty="(deleted)" />
                  ${c.base != null ? html`<${Code} text=${c.base} label="Base" empty="(empty)" />` : null}
                  <${Code} text=${c.theirs} label=${`Theirs (${v.theirsLabel})`} empty="(deleted)" />
                </div>
              </div>`,
            )}
            ${!conflicts.length ? html`<div class="empty"><${Icon} name="success" className="ok" /> No conflicts left. Check the result, then Apply.</div>` : null}
          </div>
          <div class="merge-result-label">Result <span class="muted">(editable)</span></div>
          <div class="merge-result" ref=${host} data-testid="merge-result"></div>
        </div>`}
  </div>`;
}
