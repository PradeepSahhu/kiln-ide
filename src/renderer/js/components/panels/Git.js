// Commit tool window (changes, stash, branch changes) and Git tool window (branches, log, console).
import { html, useEffect, useMemo, useState, useRef } from '../../lib/preact.js';
import { useStore, store } from '../../lib/store.js';
import { Icon, FileIcon } from '../../lib/icons.js';
import { invoke } from '../../lib/ipc.js';
import { run } from '../../lib/commands.js';
import { cls, basename, dirname, timeAgo, formatDate } from '../../lib/util.js';
import { confirm, toast, errorToast, showContextMenu } from '../../lib/ui.js';
import { ToolWindow, VirtualList, Spinner, Splitter } from '../ui.js';
import * as git from '../../services/git.js';
import * as ed from '../../services/editor.js';
import { openMerge, showConflicts, checkConflicts } from '../../services/conflicts.js';

const KIND_LETTER = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: 'C', copied: 'C' };

export async function showFileDiff(spec, title) {
  try {
    const v = await invoke('git:fileVersions', spec);
    const root = store.get().project.git.root;
    if (v.binary) return toast({ title: 'Binary file', message: 'Binary files cannot be compared.' });
    ed.openDiff({ path: `${root}/${spec.path}`, original: v.original, modified: v.modified, labels: v.labels, title: title || `${basename(spec.path)} (${v.labels.join(' ↔ ')})`, id: `diff:${spec.kind}:${spec.ref || ''}:${spec.base || ''}:${spec.path}` });
  } catch (err) {
    errorToast('Cannot show the diff', err);
  }
}

function ChangeRow({ f, checked, onCheck, selected, onSelect, onOpen, onMenu, testid = 'change-row', stats }) {
  return html`<div class=${cls('change-row', `k-${f.kind}`, selected && 'selected')} data-testid=${testid} data-path=${f.path} onClick=${onSelect} onDblClick=${onOpen} onContextMenu=${onMenu} title=${`${f.path}${f.origPath ? ` (renamed from ${f.origPath})` : ''}`}>
    ${onCheck ? html`<input type="checkbox" checked=${checked} onClick=${(e) => e.stopPropagation()} onChange=${(e) => onCheck(e.target.checked)} />` : null}
    <${FileIcon} name=${basename(f.path)} />
    <span class="name">${basename(f.path)}</span>
    <span class="dir">${dirname(f.path) === '/' || !f.path.includes('/') ? '' : dirname(f.path)}</span>
    <span class="stats">${stats || (f.added != null ? html`<span class="a">+${f.added}</span><span class="d">−${f.deleted}</span>` : null)}<span class="muted">${KIND_LETTER[f.kind] || ''}</span></span>
  </div>`;
}

function CommitTab() {
  const status = useStore((s) => s.git.status);
  const [checked, setChecked] = useState(() => new Set());
  const [known, setKnown] = useState(() => new Set());
  const [sel, setSel] = useState(null);
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const files = (status && status.files) || [];
  // Newly appearing changes start checked (Rider's default change list behaviour).
  useEffect(() => {
    const nextKnown = new Set(files.map((f) => f.path));
    const nextChecked = new Set([...checked].filter((p) => nextKnown.has(p)));
    for (const f of files) if (!known.has(f.path)) nextChecked.add(f.path);
    setChecked(nextChecked);
    setKnown(nextKnown);
  }, [status]);
  useEffect(() => {
    if (amend && !message) invoke('git:lastCommitMessage').then(setMessage);
  }, [amend]);
  const tracked = files.filter((f) => f.kind !== 'untracked');
  const untracked = files.filter((f) => f.kind === 'untracked');
  const selectedFiles = files.filter((f) => checked.has(f.path));
  const toggleAll = (list, on) => {
    const n = new Set(checked);
    for (const f of list) on ? n.add(f.path) : n.delete(f.path);
    setChecked(n);
  };
  const doCommit = async (andPush) => {
    if (!message.trim()) return toast({ kind: 'warning', title: 'Enter a commit message' });
    if (!selectedFiles.length && !amend) return toast({ kind: 'warning', title: 'Select files to commit' });
    setBusy(true);
    await ed.saveAll({ quiet: true });
    const r = await invoke('git:commit', { message, files: selectedFiles, amend });
    setBusy(false);
    if (!r.ok) return errorToast('Commit failed', new Error(r.error));
    toast({ kind: 'success', title: `Committed ${r.hash}`, message: message.split('\n')[0], timeout: 3500 });
    setMessage('');
    setAmend(false);
    await git.refreshAll();
    if (andPush) git.push();
  };
  const fileMenu = (e, f) =>
    showContextMenu(e, [
      f.kind === 'conflict' ? { label: 'Resolve Conflicts…', icon: 'branch', run: () => openMerge(f.path) } : null,
      { label: 'Show Diff', icon: 'diff', run: () => showFileDiff({ kind: 'working', path: f.path, origPath: f.origPath }) },
      { label: 'Open File', icon: 'file', disabled: f.kind === 'deleted', run: () => ed.openFile(`${store.get().project.git.root}/${f.path}`) },
      { separator: true },
      { label: 'Rollback…', icon: 'refresh', danger: true, run: () => rollback([f]) },
      { label: 'Stash This File…', icon: 'stash', run: async () => { const r = await invoke('git:stashPush', { message: `Stash ${basename(f.path)}`, includeUntracked: true, paths: [f.path] }); if (!r.ok) errorToast('Stash failed', new Error(r.error)); git.refreshAll(); } },
      { separator: true },
      { label: 'Copy Path', icon: 'copy', run: () => navigator.clipboard.writeText(f.path) },
      { label: 'Local History…', icon: 'history', run: () => run('file.localHistory', `${store.get().project.git.root}/${f.path}`) },
    ]);
  const rollback = async (list) => {
    const ok = await confirm({ title: 'Rollback Changes', message: `Discard local changes in ${list.length} file${list.length === 1 ? '' : 's'}?${list.some((f) => f.kind === 'untracked') ? '\nUnversioned files go to the Trash.' : ''}`, ok: 'Rollback', danger: true });
    if (!ok) return;
    const r = await invoke('git:rollback', list).catch((err) => ({ error: err.message }));
    if (r.error) errorToast('Rollback failed', new Error(r.error));
    git.refreshAll();
  };
  const group = (title, list) =>
    list.length
      ? html`<div class="list-group" onClick=${() => toggleAll(list, !list.every((f) => checked.has(f.path)))}>
            <input type="checkbox" checked=${list.every((f) => checked.has(f.path))} onClick=${(e) => e.stopPropagation()} onChange=${(e) => toggleAll(list, e.target.checked)} />${title}<span class="badge">${list.length}</span>
          </div>
          ${list.map((f) => html`<${ChangeRow} f=${f} checked=${checked.has(f.path)} selected=${sel === f.path} onSelect=${() => setSel(f.path)} onCheck=${(on) => { const n = new Set(checked); on ? n.add(f.path) : n.delete(f.path); setChecked(n); }} onOpen=${() => (f.kind === 'conflict' ? openMerge(f.path) : showFileDiff({ kind: 'working', path: f.path, origPath: f.origPath }))} onMenu=${(e) => fileMenu(e, f)} />`)}`
      : null;
  return html`<div class="commit-panel">
    ${status && (status.merging || status.rebasing || status.cherryPicking) ? html`<div class="repo-banner"><${Icon} name="warning" className="sev-warning" />${status.merging ? 'Merging' : status.rebasing ? 'Rebasing' : 'Cherry-picking'} — resolve conflicts, then commit.<div class="spacer"></div><button class="btn small primary" data-testid="resolve-conflicts" onClick=${() => showConflicts()}>Resolve…</button><button class="btn small" onClick=${async () => { await invoke('git:abort'); git.refreshAll(); }}>Abort</button></div>` : null}
    <div class="tw-toolbar">
      <button class="icon-btn sm" title="Refresh" onClick=${() => git.refreshAll()}><${Icon} name="refresh" /></button>
      <button class="icon-btn sm" title="Rollback selected" disabled=${!selectedFiles.length} onClick=${() => rollback(selectedFiles)}><${Icon} name="arrowLeft" /></button>
      <button class="icon-btn sm" title="Show diff" disabled=${!sel} onClick=${() => { const f = files.find((x) => x.path === sel); if (f) showFileDiff({ kind: 'working', path: f.path, origPath: f.origPath }); }}><${Icon} name="diff" /></button>
      <div class="spacer"></div>
      <span class="muted" style="font-size:12px">${selectedFiles.length}/${files.length} selected</span>
    </div>
    <div class="list">
      ${group('Changes', tracked)}
      ${group('Unversioned Files', untracked)}
      ${!files.length ? html`<div class="empty">No local changes.</div>` : null}
    </div>
    <div class="commit-box">
      <textarea class="input" data-testid="commit-message" placeholder="Commit message" value=${message} onInput=${(e) => setMessage(e.target.value)} onKeyDown=${(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doCommit(false); }}></textarea>
      <div class="actions">
        <label class="checkbox"><input type="checkbox" checked=${amend} onChange=${(e) => setAmend(e.target.checked)} />Amend</label>
        <div class="spacer"></div>
        <button class="btn primary" data-testid="commit-button" disabled=${busy} onClick=${() => doCommit(false)}>${busy ? html`<${Spinner} />` : null}Commit</button>
        <button class="btn" disabled=${busy} onClick=${() => doCommit(true)}>Commit and Push…</button>
      </div>
    </div>
  </div>`;
}

function StashTab() {
  const stashes = useStore((s) => s.git.stashes);
  const status = useStore((s) => s.git.status);
  const [open, setOpen] = useState(null);
  const [files, setFiles] = useState([]);
  useEffect(() => {
    if (!open) return setFiles([]);
    invoke('git:stashFiles', open).then(setFiles).catch(() => setFiles([]));
  }, [open, stashes]);
  const hasChanges = !!(status && status.files && status.files.length);
  const act = async (fn, ref) => {
    const r = await fn(ref);
    if (r && !r.ok) errorToast('Stash operation failed', new Error(r.error));
    if (open === ref) setOpen(null);
    await git.refreshAll();
    if (r && !r.ok) await checkConflicts();
  };
  return html`<div class="commit-panel">
    <div class="tw-toolbar">
      <button class="btn small" data-testid="stash-changes" disabled=${!hasChanges} onClick=${() => git.stashChanges()}><${Icon} name="stash" size=${14} />Stash Changes…</button>
      <div class="spacer"></div>
      <button class="icon-btn sm" title="Refresh" onClick=${() => git.refreshStashes()}><${Icon} name="refresh" /></button>
    </div>
    <div class="list">
      ${stashes.map(
        (s) => html`<div>
          <div class=${cls('stash-row', open === s.ref && 'selected')} data-testid="stash-row" onClick=${() => setOpen(open === s.ref ? null : s.ref)}>
            <${Icon} name=${open === s.ref ? 'chevronDown' : 'chevronRight'} size=${12} className="muted" />
            <${Icon} name="stash" size=${14} className="muted" />
            <span class="msg">${s.message || s.subject}</span>
            <span class="when">${s.branch ? `${s.branch} · ` : ''}${timeAgo(s.date)}</span>
          </div>
          ${open === s.ref
            ? html`<div>
                ${files.map((f) => html`<${ChangeRow} f=${f} testid="stash-file" onSelect=${() => {}} onOpen=${() => showFileDiff({ kind: 'stash', path: f.path, origPath: f.origPath, ref: s.ref, untracked: f.kind === 'untracked' }, `${basename(f.path)} (${s.ref})`)} onMenu=${(e) => e.preventDefault()} />`)}
                <div class="row" style="padding:6px 10px 10px 32px;gap:6px">
                  <button class="btn small" onClick=${() => act((r) => invoke('git:stashApply', r, {}), s.ref)}>Apply</button>
                  <button class="btn small primary" data-testid="stash-pop" onClick=${() => act((r) => invoke('git:stashApply', r, { pop: true }), s.ref)}>Pop</button>
                  <button class="btn small" onClick=${async () => { const name = await import('../../lib/ui.js').then((u) => u.prompt({ title: 'Branch from Stash', label: 'New branch name:', ok: 'Create' })); if (name) act((r) => invoke('git:stashBranch', r, name), s.ref); }}>Branch…</button>
                  <div class="spacer"></div>
                  <button class="btn small" data-testid="stash-drop" onClick=${async () => { if (await confirm({ title: 'Drop Stash', message: `Drop ${s.ref} (${s.message})? This cannot be undone.`, ok: 'Drop', danger: true })) act((r) => invoke('git:stashDrop', r), s.ref); }}><${Icon} name="trash" size=${13} />Drop</button>
                </div>
              </div>`
            : null}
        </div>`,
      )}
      ${!stashes.length ? html`<div class="empty">No stashes. Stash your changes to set them aside and get a clean working tree.</div>` : null}
    </div>
  </div>`;
}

function BranchChangesTab({ initialBase }) {
  const branches = useStore((s) => s.git.branches);
  const tick = useStore((s) => s.git.tick);
  const [base, setBase] = useState(initialBase || null);
  const [includeWorking, setIncludeWorking] = useState(true);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (initialBase) setBase(initialBase);
  }, [initialBase]);
  useEffect(() => {
    if (!base) invoke('git:defaultBase').then((b) => setBase(b || '')).catch(() => setBase(''));
  }, []);
  useEffect(() => {
    if (base == null) return;
    if (!base) return setData({ error: 'Choose a branch to compare with.', files: [], commits: [] });
    setLoading(true);
    invoke('git:branchChanges', { base, includeWorking })
      .then(setData)
      .catch((err) => setData({ error: err.message, files: [], commits: [] }))
      .finally(() => setLoading(false));
  }, [base, includeWorking, tick]);
  const options = [...((branches && branches.local) || []).filter((b) => !b.current).map((b) => b.name), ...((branches && branches.remote) || []).map((b) => b.name)];
  if (base && !options.includes(base)) options.unshift(base);
  return html`<div class="commit-panel" data-testid="branch-changes">
    <div class="tw-toolbar" style="gap:6px;height:auto;padding:6px 8px;flex-wrap:wrap">
      <span class="muted" style="font-size:12px">${(branches && branches.current) || 'HEAD'} vs</span>
      <select class="input" style="height:24px;max-width:180px" value=${base || ''} onChange=${(e) => setBase(e.target.value)}>${options.map((o) => html`<option value=${o}>${o}</option>`)}</select>
      <label class="checkbox" style="font-size:12px"><input type="checkbox" checked=${includeWorking} onChange=${(e) => setIncludeWorking(e.target.checked)} />Include uncommitted</label>
      ${loading ? html`<${Spinner} />` : null}
    </div>
    ${data && data.error ? html`<div class="empty">${data.error}</div>` : null}
    ${data && !data.error
      ? html`<div class="list">
          <div class="section-title">${data.ahead || data.commits.length} commit${(data.ahead || data.commits.length) === 1 ? '' : 's'} ahead${data.behind ? `, ${data.behind} behind` : ''} · ${data.files.length} file${data.files.length === 1 ? '' : 's'} changed</div>
          ${data.files.map((f) => html`<${ChangeRow} f=${f} testid="branch-change-file" onSelect=${() => {}} onOpen=${() => showFileDiff({ kind: 'range', path: f.path, origPath: f.origPath, base: data.mergeBase, includeWorking }, `${basename(f.path)} (${base} ↔ ${includeWorking ? 'working tree' : 'HEAD'})`)} onMenu=${(e) => showContextMenu(e, [{ label: 'Show Diff', icon: 'diff', run: () => showFileDiff({ kind: 'range', path: f.path, origPath: f.origPath, base: data.mergeBase, includeWorking }) }, { label: 'Open File', icon: 'file', run: () => ed.openFile(`${store.get().project.git.root}/${f.path}`) }])} />`)}
          ${data.commits.length ? html`<div class="section-title">Commits</div>` : null}
          ${data.commits.map((c) => html`<div class="list-row" title=${c.hash}><${Icon} name="commit" size=${14} className="muted" /><span class="ellipsis grow">${c.subject}</span><span class="muted" style="font-size:12px">${c.author} · ${timeAgo(c.date)}</span></div>`)}
        </div>`
      : null}
  </div>`;
}

export function CommitPanel({ onHide }) {
  const project = useStore((s) => s.project);
  const stashCount = useStore((s) => s.git.stashes.length);
  const changeCount = useStore((s) => (s.git.status && s.git.status.files ? s.git.status.files.length : 0));
  const tabReq = useStore((s) => s.commitTab);
  const [tab, setTab] = useState('commit');
  useEffect(() => {
    if (tabReq) setTab(tabReq.tab);
  }, [tabReq]);
  if (!project.git.isRepo) {
    return html`<${ToolWindow} side="left" title="Commit" testid="commit-panel" onHide=${onHide}>
      <div class="empty">This project is not under version control.<br /><br /><button class="btn primary" onClick=${() => git.initRepo()}>Create Git Repository</button></div>
    <//>`;
  }
  return html`<${ToolWindow} side="left" title="Commit" testid="commit-panel" onHide=${onHide}
      tabs=${html`<button class=${cls('tw-tab', tab === 'commit' && 'active')} data-testid="commit-tab" onClick=${() => setTab('commit')}>Changes${changeCount ? html`<span class="badge">${changeCount}</span>` : null}</button>
        <button class=${cls('tw-tab', tab === 'stash' && 'active')} data-testid="stash-tab" onClick=${() => setTab('stash')}>Stash${stashCount ? html`<span class="badge">${stashCount}</span>` : null}</button>
        <button class=${cls('tw-tab', tab === 'branch' && 'active')} data-testid="branch-changes-tab" onClick=${() => setTab('branch')}>Branch</button>`}>
    ${tab === 'commit' ? html`<${CommitTab} />` : tab === 'stash' ? html`<${StashTab} />` : html`<${BranchChangesTab} initialBase=${tabReq && tabReq.base} />`}
  <//>`;
}

// ------------------------------------------------------------- Git log

const LANE_COLORS = ['#3574F0', '#5FB865', '#E8A33E', '#C0526A', '#8E5BD8', '#2E9E8F', '#E5675F', '#6C9FE8'];

function computeGraph(commits) {
  const lanes = [];
  let max = 1;
  const rows = commits.map((c) => {
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(null);
      }
    }
    const before = lanes.slice();
    const [first, ...rest] = c.parents;
    lanes[lane] = first || null;
    for (let i = 0; i < lanes.length; i++) if (i !== lane && before[i] === c.hash) lanes[i] = null;
    const merges = [];
    for (const p of rest) {
      let l = lanes.indexOf(p);
      if (l === -1) {
        l = lanes.indexOf(null);
        if (l === -1) {
          l = lanes.length;
          lanes.push(null);
        }
        lanes[l] = p;
      }
      merges.push(l);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    max = Math.max(max, before.length, lanes.length, lane + 1);
    return { lane, before, after: lanes.slice(), merges, hash: c.hash };
  });
  return { rows, max };
}

function GraphCell({ g, width }) {
  const x = (i) => 8 + i * 12;
  const parts = [];
  g.before.forEach((h, i) => {
    if (!h) return;
    if (h === g.hash) parts.push(`<path d="M${x(i)} 0 L${x(g.lane)} 13" stroke="${LANE_COLORS[i % 8]}" stroke-width="1.5" fill="none"/>`);
    else if (g.after[i] === h) parts.push(`<path d="M${x(i)} 0 L${x(i)} 26" stroke="${LANE_COLORS[i % 8]}" stroke-width="1.5"/>`);
  });
  if (g.after[g.lane]) parts.push(`<path d="M${x(g.lane)} 13 L${x(g.lane)} 26" stroke="${LANE_COLORS[g.lane % 8]}" stroke-width="1.5"/>`);
  for (const l of g.merges) parts.push(`<path d="M${x(g.lane)} 13 L${x(l)} 26" stroke="${LANE_COLORS[l % 8]}" stroke-width="1.5" fill="none"/>`);
  parts.push(`<circle cx="${x(g.lane)}" cy="13" r="4" fill="var(--bg)" stroke="${LANE_COLORS[g.lane % 8]}" stroke-width="2"/>`);
  return html`<svg class="graph" width=${width} height="26" dangerouslySetInnerHTML=${{ __html: parts.join('') }}></svg>`;
}

function RefLabels({ refs }) {
  return refs.map((r) => {
    const head = r.startsWith('HEAD -> ');
    const name = head ? r.slice(8) : r.replace(/^tag: /, '');
    const kind = head ? 'head' : r.startsWith('tag: ') ? 'tag' : r.includes('/') && !r.startsWith('HEAD') ? 'remote' : '';
    return html`<span class=${cls('ref-label', kind)}>${name}</span>`;
  });
}

function LogTab() {
  const branches = useStore((s) => s.git.branches);
  const tick = useStore((s) => s.git.tick);
  const [ref, setRef] = useState(null);
  const [q, setQ] = useState('');
  const [commits, setCommits] = useState([]);
  const [sel, setSel] = useState(null);
  const [details, setDetails] = useState(null);
  const [bq, setBq] = useState('');
  useEffect(() => {
    invoke('git:log', { all: ref === '__all__', ref: ref && ref !== '__all__' ? ref : undefined, limit: 600, grep: q && !/^[0-9a-f]{6,40}$/i.test(q) ? q : undefined })
      .then((list) => setCommits(/^[0-9a-f]{6,40}$/i.test(q) ? list.filter((c) => c.hash.startsWith(q.toLowerCase())) : list))
      .catch(() => setCommits([]));
  }, [ref, q, tick]);
  useEffect(() => {
    if (!sel) return setDetails(null);
    invoke('git:commitDetails', sel).then(setDetails).catch(() => setDetails(null));
  }, [sel]);
  const graph = useMemo(() => computeGraph(commits), [commits]);
  const gw = Math.min(8 + graph.max * 12, 160);
  const filt = (b) => !bq || b.name.toLowerCase().includes(bq.toLowerCase());
  const local = ((branches && branches.local) || []).filter(filt);
  const remote = ((branches && branches.remote) || []).filter(filt);
  return html`<div class="git-panel">
    <div class="git-branches" data-testid="git-branches">
      <div style="padding:6px"><input class="input" style="width:100%;height:24px" placeholder="Filter branches" value=${bq} onInput=${(e) => setBq(e.target.value)} /></div>
      <div class="list">
        <div class=${cls('list-row', !ref && 'selected')} onClick=${() => setRef(null)}><${Icon} name="commit" size=${14} />HEAD (current branch)</div>
        <div class=${cls('list-row', ref === '__all__' && 'selected')} onClick=${() => setRef('__all__')}><${Icon} name="git" size=${14} />All branches</div>
        <div class="section-title">Local</div>
        ${local.map((b) => html`<div class=${cls('list-row', ref === b.name && 'selected')} data-testid="git-branch-row" data-branch=${b.name} onClick=${() => setRef(b.name)} onDblClick=${() => !b.current && git.checkout(b.name)} onContextMenu=${(e) => showContextMenu(e, [{ label: 'Checkout', disabled: b.current, run: () => git.checkout(b.name) }, { label: 'New Branch from Here…', run: () => git.newBranch(b.name) }, { label: 'Show Changes vs Current', disabled: b.current, run: () => run('git.branchChanges', b.name) }, { separator: true }, { label: 'Rename…', run: () => git.renameBranch(b.name) }, { label: 'Delete', danger: true, disabled: b.current, run: () => git.deleteBranch(b.name) }])}>
            <${Icon} name=${b.current ? 'success' : 'branch'} size=${14} className=${b.current ? 'ok' : 'muted'} />
            <span class="ellipsis grow" style=${b.current ? 'font-weight:600' : ''}>${b.name}</span>
            ${b.ahead || b.behind ? html`<span class="muted" style="font-size:11px">${b.ahead ? `↑${b.ahead}` : ''}${b.behind ? `↓${b.behind}` : ''}</span>` : null}
            ${!b.current ? html`<button class="icon-btn sm" title=${`Delete ${b.name}`} onClick=${(e) => { e.stopPropagation(); git.deleteBranch(b.name); }}><${Icon} name="close" size=${12} /></button>` : null}
          </div>`)}
        ${remote.length ? html`<div class="section-title">Remote</div>` : null}
        ${remote.map((b) => html`<div class=${cls('list-row', ref === b.name && 'selected')} onClick=${() => setRef(b.name)} onDblClick=${() => git.checkout(b.name, { remote: true })}><${Icon} name="branch" size=${14} className="muted" /><span class="ellipsis">${b.name}</span></div>`)}
      </div>
    </div>
    <div class="git-log">
      <div class="tw-toolbar"><input class="input" style="height:24px;width:260px" placeholder="Text or hash" value=${q} onInput=${(e) => setQ(e.target.value)} /><div class="spacer"></div><span class="muted" style="font-size:12px">${commits.length} commits</span></div>
      <${VirtualList} items=${commits} rowHeight=${26} testid="git-log"
        render=${(c, i, style) => html`<div key=${c.hash} class=${cls('log-row', sel === c.hash && 'selected')} style=${style} onClick=${() => setSel(c.hash)} title=${c.hash}>
          <${GraphCell} g=${graph.rows[i]} width=${gw} />
          <span class="subject"><${RefLabels} refs=${c.refs} />${c.subject}</span>
          <span class="author">${c.author}</span>
          <span class="date">${timeAgo(c.date)}</span>
        </div>`} />
    </div>
    <div class="git-details">
      ${details
        ? html`<div class="commit-meta"><div class="msg">${details.message}</div><div class="sub">${details.author} &lt;${details.email}&gt;<br />${formatDate(details.date)} · <span class="mono">${details.hash.slice(0, 10)}</span></div></div>
            <div class="list">${details.files.map((f) => html`<${ChangeRow} f=${f} onSelect=${() => {}} onOpen=${() => showFileDiff({ kind: 'commit', path: f.path, origPath: f.origPath, ref: details.hash, parent: details.parents[0] })} onMenu=${(e) => e.preventDefault()} />`)}</div>`
        : html`<div class="empty">Select a commit to see its changes.</div>`}
    </div>
  </div>`;
}

function ConsoleTab() {
  const entries = useStore((s) => s.git.console);
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries.length]);
  return html`<div class="git-console" ref=${ref}>
    ${entries.map((e) => html`<div><div class=${cls('cmd', e.code !== 0 && 'fail')}>${new Date(e.at).toLocaleTimeString()} ${e.cmd}</div>${e.output ? html`<div class="out">${e.output.trim()}</div>` : null}</div>`)}
    ${!entries.length ? html`<div class="muted">Git commands run by the IDE appear here.</div>` : null}
  </div>`;
}

export function GitPanel({ onHide }) {
  const project = useStore((s) => s.project);
  const [tab, setTab] = useState('log');
  if (!project.git.isRepo) return html`<${ToolWindow} side="bottom" title="Git" onHide=${onHide}><div class="empty">Not a Git repository. <a onClick=${() => git.initRepo()}>Create one</a>.</div><//>`;
  return html`<${ToolWindow} side="bottom" title="Git" testid="git-panel" onHide=${onHide}
      tabs=${html`<button class=${cls('tw-tab', tab === 'log' && 'active')} onClick=${() => setTab('log')}>Log</button><button class=${cls('tw-tab', tab === 'console' && 'active')} onClick=${() => setTab('console')}>Console</button>`}
      actions=${html`<button class="icon-btn sm" title="Fetch" onClick=${() => git.fetch()}><${Icon} name="fetch" /></button><button class="icon-btn sm" title="Update Project" onClick=${() => git.pull()}><${Icon} name="pull" /></button><button class="icon-btn sm" title="Push" onClick=${() => git.push()}><${Icon} name="push" /></button>`}>
    ${tab === 'log' ? html`<${LogTab} />` : html`<${ConsoleTab} />`}
  <//>`;
}
