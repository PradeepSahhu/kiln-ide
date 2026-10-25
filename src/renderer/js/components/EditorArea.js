// Editor area: tab bar, Monaco editor / diff editor, previews and graph views as tabs, breadcrumbs.
import { html, useEffect, useRef, useState } from '../lib/preact.js';
import { useStore, store } from '../lib/store.js';
import { Icon, FileIcon } from '../lib/icons.js';
import { invoke, isMac } from '../lib/ipc.js';
import { run, SHORTCUTS } from '../lib/commands.js';
import { cls, basename, relative, extname } from '../lib/util.js';
import { showContextMenu } from '../lib/ui.js';
import { renderMarkdown, enhanceCodeBlocks } from '../lib/markdown.js';
import * as ed from '../services/editor.js';
import { registerLanguageFeatures } from '../services/lang.js';
import { KnowledgeGraphView } from './views/Graph.js';
import { MessageFlowView } from './views/Flow.js';
import { MergeView } from './views/Merge.js';

function TabBar() {
  const tabs = useStore((s) => s.editor.tabs);
  const active = useStore((s) => s.editor.active);
  const problems = useStore((s) => s.problems);
  const errFiles = new Set([...problems.build.filter((p) => p.severity === 'error').map((p) => p.file), ...Object.entries(problems.live).filter(([, l]) => l.some((p) => p.severity === 'error')).map(([f]) => f)]);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current && ref.current.querySelector('.tab.active');
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  const menu = (e, t) =>
    showContextMenu(e, [
      { label: 'Close', shortcut: isMac ? '⌘W' : 'Ctrl+W', run: () => ed.closeTab(t.id) },
      { label: 'Close Other Tabs', run: () => ed.closeAll({ except: t.id }) },
      { label: 'Close All Tabs', run: () => ed.closeAll() },
      { label: 'Close Tabs to the Right', run: async () => { const list = store.get().editor.tabs; const i = list.findIndex((x) => x.id === t.id); for (const x of list.slice(i + 1)) await ed.closeTab(x.id); } },
      { separator: true },
      t.path ? { label: 'Copy Path', icon: 'copy', run: () => navigator.clipboard.writeText(t.path) } : null,
      t.path ? { label: 'Select in Project View', icon: 'locate', run: () => run('view.project') } : null,
      t.kind === 'file' ? { label: 'Show Diff with HEAD', icon: 'diff', run: () => run('git.diffFile', t.path) } : null,
      t.kind === 'file' ? { label: 'Local History…', icon: 'history', run: () => run('file.localHistory', t.path) } : null,
      t.kind === 'file' && /\.(md|markdown)$/i.test(t.path) ? { label: 'Open Preview', icon: 'eye', run: () => run('file.markdownPreview', t.path) } : null,
    ]);
  return html`<div class="tabs" ref=${ref} data-testid="editor-tabs">
    ${tabs.map((t) => {
      const icon = t.kind === 'diff' ? html`<${Icon} name="diff" size=${14} />` : t.kind === 'graph' ? html`<${Icon} name="graph" size=${14} />` : t.kind === 'flow' ? html`<${Icon} name="flow" size=${14} />` : t.kind === 'markdown' ? html`<${Icon} name="eye" size=${14} />` : t.kind === 'merge' ? html`<${Icon} name="branch" size=${14} />` : html`<${FileIcon} name=${t.title} />`;
      return html`<div key=${t.id} class=${cls('tab', t.id === active && 'active', t.dirty && 'dirty', t.preview && 'preview', errFiles.has(t.path) && 'err')}
          data-testid="editor-tab" data-name=${t.title} data-path=${t.path || ''} data-active=${String(t.id === active)}
          onClick=${() => ed.activate(t.id)} onDblClick=${() => ed.pinTab(t.id)} onMouseDown=${(e) => e.button === 1 && ed.closeTab(t.id)} onContextMenu=${(e) => menu(e, t)} title=${t.path || t.title}>
        ${icon}<span class="name">${t.title}</span>
        <span class="close" onClick=${(e) => { e.stopPropagation(); ed.closeTab(t.id); }}><${Icon} name="close" size=${12} /></span>
      </div>`;
    })}
  </div>`;
}

function Breadcrumbs() {
  const path = useStore((s) => {
    const t = s.editor.tabs.find((x) => x.id === s.editor.active);
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

function DiffView({ tab }) {
  useEffect(() => {
    ed.showDiffModels(tab.data);
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

export function EditorArea() {
  const tab = useStore((s) => s.editor.tabs.find((t) => t.id === s.editor.active) || null);
  const editorRef = useRef(null);
  const diffRef = useRef(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    ed.initEditor(editorRef.current, diffRef.current).then(({ editor }) => {
      if (!alive) return;
      registerLanguageFeatures(ed.getMonaco());
      setReady(true);
      window.__kilnEditorReady = true;
    });
    return () => {
      alive = false;
      ed.detachEditor();
    };
  }, []);
  useEffect(() => {
    if (ready && tab && tab.kind === 'file') {
      const e = ed.getEditor();
      if (e) e.layout();
    }
  }, [ready, tab && tab.id]);
  const kind = tab ? tab.kind : null;
  return html`<div class="editor-area">
    <${TabBar} />
    <div class="editor-host">
      <div class="mount" ref=${editorRef} style=${{ display: kind === 'file' ? 'block' : 'none' }}></div>
      <div class="mount" ref=${diffRef} data-testid=${kind === 'diff' ? 'diff-view' : undefined} style=${{ display: kind === 'diff' ? 'block' : 'none', top: '26px' }}></div>
      ${kind === 'diff' ? html`<${DiffView} tab=${tab} />` : null}
      ${kind === 'image' ? html`<${ImageView} path=${tab.path} />` : null}
      ${kind === 'binary' ? html`<div class="editor-empty"><div>${basename(tab.path)} is a binary or very large file and cannot be shown as text.</div></div>` : null}
      ${kind === 'markdown' ? html`<${MarkdownView} path=${tab.data.path} />` : null}
      ${kind === 'graph' ? html`<${KnowledgeGraphView} key=${tab.id} tab=${tab} />` : null}
      ${kind === 'flow' ? html`<${MessageFlowView} key=${tab.id} />` : null}
      ${kind === 'merge' ? html`<${MergeView} key=${tab.id} tab=${tab} />` : null}
      ${!tab ? html`<${EmptyEditor} />` : null}
    </div>
    ${kind === 'file' ? html`<${Breadcrumbs} />` : null}
  </div>`;
}
