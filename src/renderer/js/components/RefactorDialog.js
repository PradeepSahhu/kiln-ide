// The refactoring dialog: the inputs a refactoring needs (a name, a destination, a signature, the
// members to pull up), and a live preview of every change before anything is applied.
import { html, useEffect, useRef, useState } from '../lib/preact.js';
import { store } from '../lib/store.js';
import { invoke } from '../lib/ipc.js';
import { closeModal, errorToast } from '../lib/ui.js';
import { cls, basename, dirname, relative, join } from '../lib/util.js';
import { lineEdits } from '../lib/diff.js';
import { Icon, FileIcon } from '../lib/icons.js';
import { Spinner } from './ui.js';
import { Modal, registerModal } from './dialogs.js';
import { applyRefactoring } from '../services/refactor.js';

const HEADINGS = {
  changeSignature: 'Change Signature',
  extractMethod: 'Extract Method',
  introduceVariable: 'Introduce Variable',
  introduceConstant: 'Introduce Constant',
  introduceField: 'Introduce Field',
  introduceParameter: 'Introduce Parameter',
  inline: 'Inline',
  move: 'Move',
  safeDelete: 'Safe Delete',
  pullMembersUp: 'Pull Members Up',
  extractType: 'Extract Type',
};

/** Changed lines of one file with two lines of context, for the preview. */
export function hunks(before, after, context = 2) {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const out = [];
  let shift = 0;
  for (const e of lineEdits(a, b)) {
    const first = e.start - 1;
    const rows = [];
    for (let i = Math.max(0, first - context); i < first; i++) rows.push({ t: ' ', s: a[i], n: i + 1 + shift });
    for (let i = 0; i < e.deleteCount; i++) rows.push({ t: '-', s: a[first + i], n: first + i + 1 });
    e.lines.forEach((s, i) => rows.push({ t: '+', s, n: first + i + 1 + shift }));
    const after0 = first + e.deleteCount;
    for (let i = after0; i < Math.min(a.length, after0 + context); i++) rows.push({ t: ' ', s: a[i], n: i + 1 + shift + e.lines.length - e.deleteCount });
    shift += e.lines.length - e.deleteCount;
    out.push(rows);
  }
  return out;
}

function Preview({ result, root, busy, error }) {
  const [open, setOpen] = useState(null);
  const files = (result && result.files) || [];
  const current = files.find((f) => f.path === open) || files[0];
  if (error) return html`<div class="refactor-error" data-testid="refactor-error"><${Icon} name="error" className="sev-error" />${error}</div>`;
  if (!result) return html`<div class="empty">${busy ? html`<${Spinner} /> Computing the changes…` : 'Preview appears here.'}</div>`;
  return html`<div class="refactor-preview" data-testid="refactor-preview">
    <div class="refactor-files">
      ${files.map((f) => html`<div class=${cls('list-row', current === f && 'selected')} data-testid="refactor-preview-file" data-path=${f.path} onClick=${() => setOpen(f.path)} title=${f.path}>
          <${FileIcon} name=${basename(f.path)} /><span class="nm">${basename(f.path)}</span>
          <span class="muted ellipsis" style="font-size:11px">${f.created ? 'new file' : dirname(f.path) === root ? '' : relative(root, dirname(f.path))}</span>
        </div>`)}
      ${!files.length ? html`<div class="empty">No changes.</div>` : null}
    </div>
    <div class="refactor-diff mono">
      ${current
        ? hunks(current.before, current.after).map(
            (rows) => html`<div class="hunk">${rows.map((r) => html`<div class=${cls('dl', r.t === '+' && 'add', r.t === '-' && 'del')}><span class="ln">${r.n}</span><span class="mark">${r.t}</span><span class="code">${r.s}</span></div>`)}</div>`,
          )
        : null}
    </div>
  </div>`;
}

function SignatureEditor({ sig, setSig, lang }) {
  const typed = lang !== 'python' && lang !== 'javascript';
  const set = (i, patch) => setSig({ ...sig, params: sig.params.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const move = (i, d) => {
    const list = sig.params.slice();
    const j = i + d;
    if (j < 0 || j >= list.length || list[i].kind === 'self' || list[j].kind === 'self') return;
    [list[i], list[j]] = [list[j], list[i]];
    setSig({ ...sig, params: list });
  };
  const remove = (i) => setSig({ ...sig, params: sig.params.filter((_, j) => j !== i) });
  const add = () => setSig({ ...sig, params: [...sig.params, { old: null, name: `param${sig.params.length + 1}`, type: typed ? (lang === 'csharp' ? 'int' : 'number') : '', default: '', value: '' }] });
  const preview = `${sig.name}(${sig.params.map((p) => (p.kind === 'self' ? p.name : `${typed && p.type ? (lang === 'csharp' ? `${p.type} ${p.name}` : `${p.name}: ${p.type}`) : p.name}${p.default ? ` = ${p.default}` : ''}`)).join(', ')})`;
  return html`<div class="sig-editor" data-testid="signature-editor">
    <table class="sig-table">
      <thead><tr><th>Name</th>${typed ? html`<th>Type</th>` : null}<th>Default value</th><th title="Value passed by existing calls for a new parameter">Value at calls</th><th></th></tr></thead>
      <tbody>
        ${sig.params.map(
          (p, i) => html`<tr data-testid="sig-param" data-name=${p.name} class=${cls(p.old == null && 'new')}>
            <td><input class="input" data-testid=${`sig-name-${i}`} value=${p.name} disabled=${p.kind === 'self'} onInput=${(e) => set(i, { name: e.target.value })} /></td>
            ${typed ? html`<td><input class="input" data-testid=${`sig-type-${i}`} value=${p.type} onInput=${(e) => set(i, { type: e.target.value })} /></td>` : null}
            <td><input class="input" data-testid=${`sig-default-${i}`} value=${p.default} disabled=${p.kind === 'self'} onInput=${(e) => set(i, { default: e.target.value })} /></td>
            <td><input class="input" data-testid=${`sig-value-${i}`} value=${p.value || ''} disabled=${p.old != null} placeholder=${p.old != null ? '' : p.default || 'required'} onInput=${(e) => set(i, { value: e.target.value })} /></td>
            <td class="sig-actions">
              <button class="icon-btn sm" title="Move up" data-testid=${`sig-up-${i}`} onClick=${() => move(i, -1)}><${Icon} name="arrowUp" size=${12} /></button>
              <button class="icon-btn sm" title="Move down" data-testid=${`sig-down-${i}`} onClick=${() => move(i, 1)}><${Icon} name="arrowDown" size=${12} /></button>
              <button class="icon-btn sm" title="Remove" data-testid=${`sig-remove-${i}`} disabled=${p.kind === 'self'} onClick=${() => remove(i)}><${Icon} name="close" size=${12} /></button>
            </td>
          </tr>`,
        )}
      </tbody>
    </table>
    <div class="row" style="gap:8px;margin-top:6px">
      <button class="btn small" data-testid="sig-add" onClick=${add}><${Icon} name="plus" size=${12} />Add Parameter</button>
      ${lang !== 'python' ? html`<label class="muted" style="font-size:12px">Return type <input class="input" style="width:140px" data-testid="sig-return" value=${sig.returnType} onInput=${(e) => setSig({ ...sig, returnType: e.target.value })} /></label>` : null}
    </div>
    <div class="sig-preview mono" data-testid="sig-preview">${preview}</div>
  </div>`;
}

export function RefactorDialog({ item, variants, req, lang }) {
  const root = store.get().project ? store.get().project.root : '';
  const [variant, setVariant] = useState(item);
  const [name, setName] = useState(item.defaultName || '');
  const [all, setAll] = useState(false);
  const [target, setTarget] = useState(() => {
    const ext = req.file.slice(req.file.lastIndexOf('.'));
    return relative(root, join(dirname(req.file), lang === 'python' ? 'new_module.py' : `moved${ext}`));
  });
  const [sig, setSig] = useState(null);
  const [pull, setPull] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const nameRef = useRef(null);
  const seq = useRef(0);
  const needs = variant.needs;
  const syntaxOp = String(variant.id).startsWith('syntax|');

  useEffect(() => {
    if (needs === 'signature')
      invoke('refactor:info', 'signature', req)
        .then((info) => setSig({ name: info.name, returnType: info.returnType, params: info.params.map((p, i) => ({ ...p, old: i, value: '' })), lang: info.lang }))
        .catch((err) => setError(err.message));
    if (needs === 'members')
      invoke('refactor:info', 'members', req)
        .then((info) => setPull({ ...info, target: info.targets[0] ? info.targets[0].name : '', chosen: info.members.filter((m) => m.selected).map((m) => m.name) }))
        .catch((err) => setError(err.message));
    setTimeout(() => {
      if (nameRef.current) {
        nameRef.current.focus();
        nameRef.current.select();
      }
    }, 0);
  }, []);

  const request = () => {
    const r = { ...req, id: variant.id, name: name.trim() };
    if (needs === 'targetFile') r.targetFile = target.startsWith('/') ? target : join(root, target);
    const input = {};
    if (syntaxOp) Object.assign(input, { name: name.trim(), all });
    if (needs === 'signature' && sig) input.params = sig.params.map((p) => ({ old: p.old, name: p.name, type: p.type, default: p.default, value: p.value, kind: p.kind }));
    if (needs === 'signature' && sig && sig.returnType != null) input.returnType = sig.returnType;
    if (needs === 'members' && pull) Object.assign(input, { target: pull.target, members: pull.chosen });
    r.input = input;
    return r;
  };

  const ready = (needs !== 'signature' || sig) && (needs !== 'members' || pull) && (needs !== 'name' || name.trim());
  useEffect(() => {
    if (!ready) return undefined;
    const id = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      invoke('refactor:compute', request())
        .then((r) => {
          if (seq.current !== id) return;
          setResult(r);
          setError(null);
        })
        .catch((err) => {
          if (seq.current !== id) return;
          setResult(null);
          setError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
        })
        .finally(() => seq.current === id && setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [variant.id, name, all, target, sig, pull, ready]);

  const apply = async (force = false) => {
    if (!result || busy || applying || (result.blocked && !force)) return;
    setApplying(true);
    try {
      await applyRefactoring(result);
      closeModal(true);
    } catch (err) {
      errorToast('Refactoring failed', err);
      setApplying(false);
    }
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      apply();
    }
  };
  const title = HEADINGS[variant.kind] || variant.title.replace(/…$/, '');
  const state = error ? 'error' : busy || !result ? 'busy' : result.blocked ? 'blocked' : 'ready';
  return html`<${Modal} title=${title} wide="x" testid="refactor-dialog" className="refactor-dialog" onClose=${() => closeModal(false)}
      footer=${html`
        ${result && result.blocked ? html`<button class="btn danger" data-testid="refactor-force" disabled=${applying} onClick=${() => apply(true)}>Delete Anyway</button>` : null}
        <div class="spacer"></div>
        <button class="btn" onClick=${() => closeModal(false)}>Cancel</button>
        <button class="btn primary" data-testid="refactor-apply" disabled=${state !== 'ready' || applying} onClick=${() => apply()}>${applying ? html`<${Spinner} />` : null}Refactor</button>`}>
    <div class="refactor-body" data-testid="refactor-state" data-state=${state} data-kind=${variant.kind}>
      ${variants.length > 1
        ? html`<div class="field"><label>Variant</label><select class="input" data-testid="refactor-variant" value=${variant.id} onChange=${(e) => setVariant(variants.find((v) => v.id === e.target.value))}>${variants.map((v) => html`<option value=${v.id}>${v.detail || v.title}</option>`)}</select></div>`
        : variant.detail && variant.detail !== variant.title ? html`<div class="muted" style="margin-bottom:8px">${variant.detail}</div>` : null}
      ${needs === 'name'
        ? html`<div class="field"><label>Name</label><input class="input mono" ref=${nameRef} data-testid="refactor-name" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${onKey} /></div>
            ${syntaxOp && (variant.kind === 'introduceVariable' || variant.kind === 'introduceConstant') ? html`<label class="checkbox"><input type="checkbox" data-testid="refactor-all" checked=${all} onChange=${(e) => setAll(e.target.checked)} />Replace all occurrences</label>` : null}`
        : null}
      ${needs === 'targetFile' ? html`<div class="field"><label>Move to file</label><input class="input mono" ref=${nameRef} data-testid="refactor-target" value=${target} onInput=${(e) => setTarget(e.target.value)} onKeyDown=${onKey} /></div>` : null}
      ${needs === 'signature' && sig ? html`<${SignatureEditor} sig=${sig} setSig=${setSig} lang=${sig.lang} />` : null}
      ${needs === 'members' && pull
        ? html`<div class="pull-up">
            <div class="field"><label>Pull members of ${pull.className} up to</label>
              <select class="input" data-testid="pullup-target" value=${pull.target} onChange=${(e) => setPull({ ...pull, target: e.target.value })}>${pull.targets.map((x) => html`<option value=${x.name}>${x.name} (${x.kind})</option>`)}</select></div>
            ${!pull.targets.length ? html`<div class="refactor-error">${pull.className} has no base class or interface declared in this project.</div>` : null}
            <div class="pull-members">${pull.members.map((m) => html`<label class="checkbox"><input type="checkbox" data-testid="pullup-member" data-name=${m.name} checked=${pull.chosen.includes(m.name)} onChange=${(e) => setPull({ ...pull, chosen: e.target.checked ? [...pull.chosen, m.name] : pull.chosen.filter((x) => x !== m.name) })} /><span class="mono">${m.name}</span><span class="muted">${m.kind}</span></label>`)}</div>
          </div>`
        : null}
      ${result && result.usages && result.usages.length
        ? html`<div class="refactor-usages" data-testid="refactor-usages">
            <div class="refactor-warning"><${Icon} name="warning" className="sev-warning" />${result.usages.length} usage${result.usages.length === 1 ? '' : 's'} of ${result.symbol || 'this symbol'} found. Deleting it would break ${result.usages.length === 1 ? 'it' : 'them'}.</div>
            ${result.usages.slice(0, 50).map((u) => html`<div class="usage-row" data-testid="refactor-usage"><span class="ln">${basename(u.file)}:${u.line}</span><span class="code">${u.text}</span></div>`)}
          </div>`
        : null}
      ${result && result.warnings && result.warnings.length ? html`<div class="refactor-warnings">${result.warnings.map((w) => html`<div class="refactor-warning" data-testid="refactor-warning"><${Icon} name="warning" className="sev-warning" />${w}</div>`)}</div>` : null}
      <div class="section-title" style="padding-left:0">Preview ${busy ? html`<${Spinner} size=${12} />` : null}</div>
      <${Preview} result=${result} root=${root} busy=${busy} error=${error} />
    </div>
  <//>`;
}

registerModal('refactor', RefactorDialog);
