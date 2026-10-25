// Editor area: editor groups (splits) laid out side by side or stacked, each with a tab bar (drag to
// reorder, to another split, or to an edge to split), Monaco editor / diff editor, previews and graph
// views as tabs, breadcrumbs.
import { html, useEffect, useRef, useState } from '../lib/preact.js';
import { useStore, store } from '../lib/store.js';
import { Icon, FileIcon } from '../lib/icons.js';
import { invoke, isMac } from '../lib/ipc.js';
import { run, SHORTCUTS } from '../lib/commands.js';
import { cls, basename, relative, extname } from '../lib/util.js';
import { showContextMenu } from '../lib/ui.js';
import { Splitter } from './ui.js';
import { renderMarkdown, enhanceCodeBlocks } from '../lib/markdown.js';
import * as ed from '../services/editor.js';
import { registerLanguageFeatures } from '../services/lang.js';
import { KnowledgeGraphView } from './views/Graph.js';
import { MessageFlowView } from './views/Flow.js';
import { MergeView } from './views/Merge.js';

const TAB_MIME = 'application/x-kiln-tab';

function TabBar({ gid }) {
  const tabs = useStore((s) => s.editor.tabs.filter((t) => (t.group || ed.MAIN_GROUP) === gid), (a, b) => a.length === b.length && a.every((t, i) => t === b[i]));
  const active = useStore((s) => (s.editor.groups.find((g) => g.id === gid) || {}).active);
  const focused = useStore((s) => s.editor.activeGroup === gid);
  const split = useStore((s) => s.editor.groups.length > 1);
  const problems = useStore((s) => s.problems);
  const [dropAt, setDropAt] = useState(null);
  const errFiles = new Set([...problems.build.filter((p) => p.severity === 'error').map((p) => p.file), ...Object.entries(problems.live).filter(([, l]) => l.some((p) => p.severity === 'error')).map(([f]) => f)]);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current && ref.current.querySelector('.tab.active');
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  const menu = (e, t) =>
    showContextMenu(e, [
      { label: 'Close', shortcut: isMac ? '⌘W' : 'Ctrl+W', run: () => ed.closeTab(t.id) },
      { label: 'Close Other Tabs', run: () => ed.closeAll({ except: t.id, group: gid }) },
      { label: 'Close All Tabs', run: () => ed.closeAll({ group: gid }) },
      { label: 'Close Tabs to the Right', run: async () => { const list = ed.groupTabs(gid); const i = list.findIndex((x) => x.id === t.id); for (const x of list.slice(i + 1)) if (!x.pinned) await ed.closeTab(x.id); } },
      { separator: true },
      { label: t.pinned ? 'Unpin Tab' : 'Pin Tab', icon: 'pin', run: () => ed.togglePinned(t.id) },
      { separator: true },
      { label: 'Split Right', icon: 'layout', run: () => ed.splitGroup('row', { tabId: t.id }) },
      { label: 'Split Down', icon: 'layout', run: () => ed.splitGroup('column', { tabId: t.id }) },
      { label: split ? 'Move to Opposite Group' : 'Split and Move Right', run: () => ed.moveToOppositeGroup(t.id) },
      split ? { label: 'Unsplit All', run: () => ed.unsplitAll() } : null,
      { separator: true },
      t.path ? { label: 'Copy Path', icon: 'copy', run: () => navigator.clipboard.writeText(t.path) } : null,
      t.path ? { label: 'Select in Project View', icon: 'locate', run: () => run('view.project') } : null,
      t.kind === 'file' ? { label: 'Show Diff with HEAD', icon: 'diff', run: () => run('git.diffFile', t.path) } : null,
      t.kind === 'file' ? { label: 'Local History…', icon: 'history', run: () => run('file.localHistory', t.path) } : null,
      t.kind === 'file' && /\.(md|markdown)$/i.test(t.path) ? { label: 'Open Preview', icon: 'eye', run: () => run('file.markdownPreview', t.path) } : null,
    ]);
  // Drag a tab to reorder it, or onto another split's tab bar to move it there.
  const indexAt = (e) => {
    const els = [...ref.current.querySelectorAll('.tab')];
    const i = els.findIndex((el) => { const r = el.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
    return i < 0 ? els.length : i;
  };
  const over = (e) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropAt(indexAt(e));
  };
  const drop = (e) => {
    const id = e.dataTransfer.getData(TAB_MIME);
    setDropAt(null);
    if (!id) return;
    e.preventDefault();
    let index = indexAt(e);
    const from = ed.groupTabs(gid).findIndex((x) => x.id === id);
    if (from >= 0 && from < index) index -= 1;
    ed.moveTab(id, gid, { index });
  };
  return html`<div class=${cls('tabs', focused && split && 'focused')} ref=${ref} data-testid="editor-tabs" data-group=${gid} onDragOver=${over} onDragLeave=${() => setDropAt(null)} onDrop=${drop}>
    ${tabs.map((t, i) => {
      const icon = t.kind === 'diff' ? html`<${Icon} name="diff" size=${14} />` : t.kind === 'graph' ? html`<${Icon} name="graph" size=${14} />` : t.kind === 'flow' ? html`<${Icon} name="flow" size=${14} />` : t.kind === 'markdown' ? html`<${Icon} name="eye" size=${14} />` : t.kind === 'merge' ? html`<${Icon} name="branch" size=${14} />` : html`<${FileIcon} name=${t.title} />`;
      return html`<div key=${t.id} class=${cls('tab', t.id === active && 'active', t.dirty && 'dirty', t.preview && 'preview', t.pinned && 'pinned', errFiles.has(t.path) && 'err', dropAt === i && 'drop-before', dropAt === tabs.length && i === tabs.length - 1 && 'drop-after')}
          data-testid="editor-tab" data-name=${t.title} data-path=${t.path || ''} data-group=${gid} data-pinned=${t.pinned ? 'true' : 'false'} data-active=${String(t.id === active)} draggable="true"
          onDragStart=${(e) => { e.dataTransfer.setData(TAB_MIME, t.id); e.dataTransfer.effectAllowed = 'move'; }}
          onClick=${() => ed.activate(t.id)} onDblClick=${() => ed.pinTab(t.id)} onMouseDown=${(e) => e.button === 1 && ed.closeTab(t.id)} onContextMenu=${(e) => menu(e, t)} title=${t.path || t.title}>
        ${icon}<span class="name">${t.title}</span>
        ${t.pinned
          ? html`<span class="pin" data-testid="tab-unpin" title="Unpin" onClick=${(e) => { e.stopPropagation(); ed.togglePinned(t.id, false); }}><${Icon} name="pin" size=${12} /></span>`
          : html`<span class="close" onClick=${(e) => { e.stopPropagation(); ed.closeTab(t.id); }}><${Icon} name="close" size=${12} /></span>`}
      </div>`;
    })}
    <div class="tabs-fill" onDblClick=${() => run('file.newFile')}></div>
  </div>`;
}

function Breadcrumbs({ gid }) {
  const path = useStore((s) => {
    const g = s.editor.groups.find((x) => x.id === gid);
    const t = g && s.editor.tabs.find((x) => x.id === g.active);
    return t && t.kind === 'file' ? t.path : null;
  });
  const root = useStore((s) => s.project && s.project.root);
  if (!path) return null;
  const parts = relative(root, path).split('/');
  return html`<div class="breadcrumbs">
    <span class="crumb" onClick=${() => run('view.project')}>${basename(root)}</span>
    ${parts.map((p, i) => html`<${Icon} name="chevronRight" size=${10} /><span class="crumb" onClick=${() => i < parts.length - 1 && run('view.project')}>${i === parts.length - 1 ? html`<${FileIcon} name=${p} size=${14} />` : null}${p}</span>`)}
  </div>`;
}

function DiffView({ tab, gid }) {
  useEffect(() => {
    ed.showDiffModels(tab.data, gid);
  }, [tab.id, tab.data]);
  const labels = tab.data.labels || [];
  return html`<div class="diff-header row" style="position:absolute;top:0;left:0;right:0;height:26px;padding:0 12px;font-size:12px;color:var(--text-secondary);border-bottom:1px solid var(--border-inner);z-index:2;background:var(--bg-editor)">
    <span class="grow ellipsis">${labels[0] || 'Before'}</span><span class="grow ellipsis">${labels[1] || 'After'}</span>
    ${tab.data.path ? html`<button class="btn small" onClick=${() => ed.openFile(tab.data.path)}>Open File</button>` : null}
  </div>`;
}

function ImageView({ path }) {
  return html`<div class="image-preview"><img src=${`kiln-file://${encodeURI(path)}`} alt=${basename(path)} /></div>`;
}

function MarkdownView({ path }) {
  const ref = useRef(null);
  const [text, setText] = useState('');
  const fsTick = useStore((s) => s.fsTick || 0);
  useEffect(() => {
    invoke('fs:readFile', path).then((r) => setText(r.content || '')).catch(() => setText('Could not read the file.'));
  }, [path, fsTick]);
  useEffect(() => {
    if (ref.current) enhanceCodeBlocks(ref.current);
  }, [text]);
  return html`<div class="md-preview msg-assistant" ref=${ref} dangerouslySetInnerHTML=${{ __html: renderMarkdown(text) }}></div>`;
}

function EmptyEditor() {
  const rows = [
    ['Search Everywhere', SHORTCUTS['navigate.searchEverywhere']],
    ['Go to File', SHORTCUTS['navigate.file']],
    ['Recent Files', SHORTCUTS['navigate.recent']],
    ['Find in Files', SHORTCUTS['edit.findInFiles']],
    ['Build Solution', SHORTCUTS['build.build']],
    ['Commit', SHORTCUTS['git.commit']],
    ['Ask Claude', isMac ? '⇧⌘J' : 'Ctrl+Shift+J'],
  ];
  return html`<div class="editor-empty"><div class="shortcuts">${rows.map(([a, k]) => html`<span>${a}</span><span class="k">${k}</span>`)}</div></div>`;
}

/** One split: its tab bar, Monaco editor / diff editor and the special views of its active tab. */
function EditorGroup({ gid }) {
  const tab = useStore((s) => {
    const g = s.editor.groups.find((x) => x.id === gid);
    return (g && s.editor.tabs.find((t) => t.id === g.active)) || null;
  });
  const focused = useStore((s) => s.editor.activeGroup === gid);
  const split = useStore((s) => s.editor.groups.length > 1);
  const editorRef = useRef(null);
  const diffRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [drop, setDrop] = useState(null);
  useEffect(() => {
    let alive = true;
    ed.attachGroup(gid, editorRef.current, diffRef.current).then(() => {
      if (!alive) return;
      registerLanguageFeatures(ed.getMonaco());
      setReady(true);
      window.__kilnEditorReady = true;
    });
    return () => {
      alive = false;
      ed.detachGroup(gid);
    };
  }, []);
  useEffect(() => {
    if (ready && tab && tab.kind === 'file') {
      const e = ed.allEditors().find((x) => x.getContainerDomNode() && editorRef.current && editorRef.current.contains(x.getContainerDomNode()));
      if (e) e.layout();
    }
  }, [ready, tab && tab.id]);
  // Drop a tab on the editor: the right or bottom edge splits, anywhere else moves it here.
  const zone = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    return x > 0.75 ? 'right' : y > 0.75 ? 'down' : 'center';
  };
  const over = (e) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return;
    e.preventDefault();
    setDrop(zone(e));
  };
  const onDrop = async (e) => {
    const id = e.dataTransfer.getData(TAB_MIME);
    const z = zone(e);
    setDrop(null);
    if (!id) return;
    e.preventDefault();
    if (z === 'center') return ed.moveTab(id, gid);
    ed.setActiveGroup(gid);
    const t = store.get().editor.tabs.find((x) => x.id === id);
    if (!t) return;
    const wasHere = (t.group || ed.MAIN_GROUP) === gid;
    // Same group: split with a copy and close the original only if other tabs remain here.
    await ed.splitGroup(z === 'right' ? 'row' : 'column', { tabId: id, move: !wasHere || ed.groupTabs(gid).length > 1 });
  };
  const kind = tab ? tab.kind : null;
  return html`<div class=${cls('editor-area', split && 'split', focused && 'focused')} data-testid="editor-group" data-group=${gid} data-active=${String(focused)} onMouseDown=${() => !focused && ed.setActiveGroup(gid)}>
    <${TabBar} gid=${gid} />
    <div class="editor-host" onDragOver=${over} onDragLeave=${() => setDrop(null)} onDrop=${onDrop}>
      <div class="mount" ref=${editorRef} style=${{ display: kind === 'file' ? 'block' : 'none' }}></div>
      <div class="mount" ref=${diffRef} data-testid=${kind === 'diff' ? 'diff-view' : undefined} style=${{ display: kind === 'diff' ? 'block' : 'none', top: '26px' }}></div>
      ${kind === 'diff' ? html`<${DiffView} tab=${tab} gid=${gid} />` : null}
      ${kind === 'image' ? html`<${ImageView} path=${tab.path} />` : null}
      ${kind === 'binary' ? html`<div class="editor-empty"><div>${basename(tab.path)} is a binary or very large file and cannot be shown as text.</div></div>` : null}
      ${kind === 'markdown' ? html`<${MarkdownView} path=${tab.data.path} />` : null}
      ${kind === 'graph' ? html`<${KnowledgeGraphView} key=${tab.id} tab=${tab} />` : null}
      ${kind === 'flow' ? html`<${MessageFlowView} key=${tab.id} />` : null}
      ${kind === 'merge' ? html`<${MergeView} key=${tab.id} tab=${tab} />` : null}
      ${!tab ? html`<${EmptyEditor} />` : null}
      ${drop ? html`<div class=${cls('drop-zone', drop)}></div>` : null}
    </div>
    ${kind === 'file' ? html`<${Breadcrumbs} gid=${gid} />` : null}
  </div>`;
}

/** A node of the split layout: a group, or groups side by side ('row') / stacked ('column'). */
function LayoutNode({ node, path }) {
  const ref = useRef(null);
  if (node.type === 'leaf') return html`<${EditorGroup} key=${node.group} gid=${node.group} />`;
  const resize = (i, delta) => {
    const el = ref.current;
    if (!el) return;
    const total = node.dir === 'row' ? el.clientWidth : el.clientHeight;
    const sizes = node.sizes.slice();
    const d = delta / Math.max(total, 1);
    const min = 0.1;
    const a = Math.max(min, Math.min(sizes[i] + sizes[i + 1] - min, sizes[i] + d));
    sizes[i + 1] = sizes[i] + sizes[i + 1] - a;
    sizes[i] = a;
    ed.setSplitSizes(path, sizes);
  };
  return html`<div class=${cls('editor-split', `split-${node.dir}`)} ref=${ref} data-testid="editor-split" data-dir=${node.dir}>
    ${node.children.map((c, i) => html`${i ? html`<${Splitter} dir=${node.dir === 'row' ? 'v' : 'h'} onResize=${(d) => resize(i - 1, d)} />` : null}
      <div class="editor-split-cell" key=${c.type === 'leaf' ? c.group : `s${i}`} style=${{ flex: `${node.sizes[i]} 1 0` }}><${LayoutNode} node=${c} path=${[...path, i]} /></div>`)}
  </div>`;
}

export function EditorArea() {
  const layout = useStore((s) => s.editor.layout);
  return html`<div class="editor-root"><${LayoutNode} node=${layout || { type: 'leaf', group: ed.MAIN_GROUP }} path=${[]} /></div>`;
}
