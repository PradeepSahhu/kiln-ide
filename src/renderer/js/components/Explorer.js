// Project tool window: file system and Solution views with git status colors, problems and a context menu.
import { html, useState, useEffect, useMemo, useRef, useCallback } from '../lib/preact.js';
import { useStore, store } from '../lib/store.js';
import { Icon, FileIcon } from '../lib/icons.js';
import { invoke } from '../lib/ipc.js';
import { run } from '../lib/commands.js';
import { cls, basename, dirname, relative, extname } from '../lib/util.js';
import { showContextMenu, prompt, confirm, errorToast, toast } from '../lib/ui.js';
import { VirtualList, ToolWindow } from './ui.js';
import * as ed from '../services/editor.js';
import { newFileIn, newFolderIn } from '../services/project.js';
import { startRun, newTerminal, terminalSend } from '../services/sessions.js';
import { startBuild } from '../services/build.js';
import { openTool } from '../services/layout.js';

const children = new Map(); // dir -> entries
const loading = new Set();

export function Explorer({ onHide }) {
  const project = useStore((s) => s.project);
  const gitFiles = useStore((s) => (s.git.status && s.git.status.files) || null);
  const problems = useStore((s) => s.problems);
  const fsTick = useStore((s) => s.fsTick || 0);
  const activePath = useStore((s) => {
    const t = s.editor.tabs.find((x) => x.id === s.editor.active);
    return t && t.path;
  });
  const [mode, setMode] = useState(project.detection.dotnet ? 'solution' : 'files');
  const [expanded, setExpanded] = useState(() => new Set([project.root, ...((project.state && project.state.expanded) || [])]));
  const [selected, setSelected] = useState(null);
  const [focused, setFocused] = useState(false);
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const load = useCallback(async (dir, force = false) => {
    if (loading.has(dir) || (children.has(dir) && !force)) return;
    loading.add(dir);
    try {
      children.set(dir, await invoke('fs:readDir', dir));
    } catch {
      children.set(dir, []);
    }
    loading.delete(dir);
    bump();
  }, []);

  useEffect(() => {
    children.clear();
    load(project.root, true);
    for (const d of expanded) load(d);
  }, [project.root]);

  // Reload folders whose content changed on disk.
  useEffect(() => {
    if (!fsTick) return;
    const changed = store.get().fsChanged;
    const dirs = new Set(changed ? changed.map(dirname) : [...children.keys()]);
    for (const d of dirs) if (children.has(d)) load(d, true);
  }, [fsTick]);

  useEffect(() => {
    const t = setTimeout(() => invoke('app:setProjectState', { expanded: [...expanded].filter((d) => d !== project.root).slice(0, 300) }).catch(() => {}), 800);
    return () => clearTimeout(t);
  }, [expanded]);

  const status = useMemo(() => {
    const m = new Map();
    if (!gitFiles || !project.git.root) return m;
    for (const f of gitFiles) m.set(`${project.git.root}/${f.path}`, f.kind);
    return m;
  }, [gitFiles]);
  const errFiles = useMemo(() => {
    const s = new Set();
    for (const p of problems.build) if (p.severity === 'error' && p.file) s.add(p.file);
    for (const [f, list] of Object.entries(problems.live)) if (list.some((p) => p.severity === 'error')) s.add(f);
    return s;
  }, [problems]);

  const toggle = (dir) => {
    const next = new Set(expanded);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      load(dir);
    }
    setExpanded(next);
  };

  // Flatten the visible tree.
  const rows = useMemo(() => {
    const out = [];
    const walk = (dir, depth) => {
      const list = children.get(dir);
      if (!list) {
        if (expanded.has(dir)) out.push({ loading: true, depth, path: dir + '/…' });
        return;
      }
      for (const e of list) {
        out.push({ ...e, depth });
        if (e.dir && expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    if (mode === 'solution') {
      const det = project.detection;
      const projects = [];
      if (det.dotnet) for (const p of det.dotnet.projects) projects.push({ name: p.name, path: p.dir, file: p.path, dir: true, kind: 'dotnet', detail: (p.targetFrameworks || []).join(', ') || (p.isTest ? 'tests' : '') });
      if (det.python) for (const r of det.python.roots) if (r.dir !== project.root) projects.push({ name: r.name, path: r.dir, dir: true, kind: 'python', detail: 'Python' });
      if (det.node) for (const r of det.node.roots) if (r.dir !== project.root) projects.push({ name: r.name, path: r.dir, dir: true, kind: 'node', detail: 'Node' });
      const sln = det.dotnet && det.dotnet.solution ? basename(det.dotnet.solution) : project.name;
      out.push({ name: sln, path: project.root, dir: true, depth: 0, solutionRoot: true, detail: `${projects.length} project${projects.length === 1 ? '' : 's'}` });
      if (expanded.has(project.root)) {
        for (const p of projects) {
          out.push({ ...p, depth: 1, projectNode: true });
          if (expanded.has(p.path)) walk(p.path, 2);
        }
        const covered = new Set(projects.map((p) => p.path));
        const rootFiles = (children.get(project.root) || []).filter((e) => !covered.has(e.path) && !projects.some((p) => p.path.startsWith(e.path + '/')));
        for (const e of rootFiles) {
          out.push({ ...e, depth: 1 });
          if (e.dir && expanded.has(e.path)) walk(e.path, 2);
        }
      }
    } else {
      out.push({ name: project.name, path: project.root, dir: true, depth: 0, isRoot: true, detail: project.root.replace(/^\/Users\/[^/]+/, '~') });
      if (expanded.has(project.root)) walk(project.root, 1);
    }
    return out;
  }, [expanded, mode, project, version]);

  const selIndex = rows.findIndex((r) => r.path === selected);
  const open = (r) => {
    if (r.dir) toggle(r.path);
    else ed.openFile(r.path);
  };
  const onKey = (e) => {
    const i = selIndex;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const r = rows[Math.min(i + 1, rows.length - 1)];
      if (r) setSelected(r.path);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const r = rows[Math.max(i - 1, 0)];
      if (r) setSelected(r.path);
    } else if (e.key === 'ArrowRight') {
      const r = rows[i];
      if (r && r.dir && !expanded.has(r.path)) toggle(r.path);
    } else if (e.key === 'ArrowLeft') {
      const r = rows[i];
      if (r && r.dir && expanded.has(r.path)) toggle(r.path);
      else if (r) setSelected(dirname(r.path));
    } else if (e.key === 'Enter') {
      const r = rows[i];
      if (r) open(r);
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && (e.metaKey || e.key === 'Delete')) {
      const r = rows[i];
      if (r && !r.isRoot && !r.solutionRoot) deleteEntry(r);
    }
  };

  const locate = async () => {
    if (!activePath) return;
    const next = new Set(expanded);
    let d = dirname(activePath);
    const chain = [];
    while (d.startsWith(project.root) && d !== project.root) {
      chain.unshift(d);
      d = dirname(d);
    }
    next.add(project.root);
    for (const c of chain) {
      next.add(c);
      await load(c);
    }
    setExpanded(next);
    setSelected(activePath);
  };

  const menu = (e, r) => {
    setSelected(r.path);
    const dir = r.dir ? r.path : dirname(r.path);
    const rel = relative(project.root, r.path);
    const isPy = !r.dir && r.path.endsWith('.py');
    const det = project.detection;
    const proj = r.projectNode || (det.dotnet && det.dotnet.projects.find((p) => p.dir === r.path || p.path === r.path));
    showContextMenu(e, [
      { label: 'New File…', icon: 'file', run: () => newFileIn(dir) },
      { label: 'New Directory…', icon: 'folder', run: () => newFolderIn(dir) },
      { separator: true },
      isPy ? { label: `Run '${r.name}'`, icon: 'play', run: () => startRun({ id: `adhoc:${r.path}`, name: r.name, python: true, pyRoot: pythonRootFor(r.path), args: [r.path], cwd: dirname(r.path) }) } : null,
      proj ? { label: 'Build Project', icon: 'hammer', run: () => startBuild({ reason: 'manual', only: ['dotnet'] }) } : null,
      r.dir && (r.isRoot || r.solutionRoot) ? { label: 'Build Solution', icon: 'hammer', run: () => startBuild({ reason: 'manual' }) } : null,
      { label: 'Find in Directory…', icon: 'search', disabled: !r.dir, run: () => run('edit.findInFiles', { dir: r.path }) },
      { separator: true },
      { label: 'Rename…', icon: 'edit', disabled: r.isRoot || r.solutionRoot, run: () => renameEntry(r) },
      { label: 'Delete', icon: 'trash', danger: true, disabled: r.isRoot || r.solutionRoot, run: () => deleteEntry(r) },
      { separator: true },
      { label: 'Copy Path', icon: 'copy', run: () => navigator.clipboard.writeText(r.path) },
      { label: 'Copy Relative Path', icon: 'copy', run: () => navigator.clipboard.writeText(rel) },
      { label: 'Reveal in Finder', icon: 'folder', run: () => invoke('app:showItemInFolder', r.path) },
      { label: 'Open in Terminal', icon: 'terminal', run: async () => { openTool('bottom', 'terminal'); const id = await newTerminal(); setTimeout(() => terminalSend(id, `cd ${JSON.stringify(dir)}\r`), 400); } },
      !r.dir ? { label: 'Local History…', icon: 'history', run: () => run('file.localHistory', r.path) } : null,
      { separator: true },
      { label: 'Ask Claude About This', icon: 'claude', run: () => import('../services/claude.js').then((c) => { openTool('right', 'claude'); c.sendMessage(`Explain what ${rel} ${r.dir ? 'contains and how its files fit together' : 'does'}.`); }) },
      { label: 'Show in Knowledge Graph', icon: 'graph', disabled: r.dir, run: () => run('view.knowledgeGraph', { focus: `f:${rel}` }) },
    ]);
  };

  const renameEntry = async (r) => {
    const name = await prompt({ title: 'Rename', label: `New name for ${r.name}:`, value: r.name, ok: 'Rename', selectBase: true });
    if (!name || name === r.name) return;
    try {
      await ed.saveAll({ quiet: true });
      await invoke('fs:rename', r.path, `${dirname(r.path)}/${name}`);
    } catch (err) {
      errorToast('Rename failed', err);
    }
  };
  const deleteEntry = async (r) => {
    const ok = await confirm({ title: 'Delete', message: `Move ${r.dir ? 'directory' : 'file'} '${r.name}' to the Trash?`, ok: 'Delete', danger: true });
    if (!ok) return;
    try {
      for (const t of store.get().editor.tabs) if (t.path && (t.path === r.path || t.path.startsWith(r.path + '/'))) await ed.closeTab(t.id, { force: true });
      await invoke('fs:trash', r.path);
      toast({ title: `Moved ${r.name} to the Trash`, timeout: 2500 });
    } catch (err) {
      errorToast('Delete failed', err);
    }
  };

  const special = (r) => (r.dir ? (/^(src|source)$/i.test(r.name) ? 'source' : /^tests?$/i.test(r.name) || /\.Tests?$/.test(r.name) ? 'test' : null) : null);

  return html`<${ToolWindow} side="left" title="Project" testid="explorer" onHide=${onHide}
      tabs=${html`<button class=${cls('tw-tab', mode === 'files' && 'active')} onClick=${() => setMode('files')}>Files</button><button class=${cls('tw-tab', mode === 'solution' && 'active')} onClick=${() => { setMode('solution'); setExpanded(new Set([...expanded, project.root])); }}>Solution</button>`}
      actions=${html`
        <button class="icon-btn sm" title="Select Opened File" onClick=${locate}><${Icon} name="locate" /></button>
        <button class="icon-btn sm" title="Collapse All" onClick=${() => setExpanded(new Set([project.root]))}><${Icon} name="collapseAll" /></button>
        <button class="icon-btn sm" title="New File" onClick=${() => newFileIn(selected ? (rows.find((r) => r.path === selected) || {}).dir ? selected : dirname(selected) : project.root)}><${Icon} name="plus" /></button>`}>
    <div class=${cls('col grow', focused && 'focused')} onFocusCapture=${() => setFocused(true)} onBlurCapture=${() => setFocused(false)}>
      <${VirtualList} items=${rows} rowHeight=${24} onKeyDown=${onKey} scrollTo=${selIndex}
        render=${(r, i, style) => {
          if (r.loading) return html`<div class="tree-row" style=${{ ...style, paddingLeft: `${8 + r.depth * 16}px` }}><span class="muted">Loading…</span></div>`;
          const st = status.get(r.path);
          const isOpen = r.dir && expanded.has(r.path);
          return html`<div key=${r.path + (r.projectNode ? ':p' : '')} class=${cls('tree-row', selected === r.path && 'selected', r.excluded && 'excluded', st && `st-${st}`, errFiles.has(r.path) && 'has-errors')} style=${{ ...style, paddingLeft: `${4 + r.depth * 16}px` }}
              data-testid="tree-row" data-name=${r.name} data-path=${r.path}
              onClick=${() => setSelected(r.path)} onDblClick=${() => open(r)} onMouseDown=${(e) => e.button === 1 && !r.dir && ed.openFile(r.path)} onContextMenu=${(e) => menu(e, r)}>
            <span class="twisty" onClick=${(e) => { e.stopPropagation(); if (r.dir) toggle(r.path); }}>${r.dir ? html`<${Icon} name=${isOpen ? 'chevronDown' : 'chevronRight'} size=${12} />` : null}</span>
            ${r.solutionRoot ? html`<${FileIcon} name="x.sln" />` : r.projectNode ? html`<${FileIcon} name=${r.kind === 'dotnet' ? 'x.csproj' : r.kind === 'python' ? 'x.py' : 'x.js'} />` : html`<${FileIcon} name=${r.name} dir=${r.dir} open=${isOpen} excluded=${r.excluded} special=${special(r)} />`}
            <span class="name" style=${r.isRoot || r.solutionRoot || r.projectNode ? 'font-weight:600' : ''}>${r.name}</span>
            ${r.detail ? html`<span class="hint">${r.detail}</span>` : null}
          </div>`;
        }} />
    </div>
  <//>`;
}

function pythonRootFor(file) {
  const det = store.get().project.detection;
  const roots = (det.python && det.python.roots) || [];
  const r = roots.filter((x) => file.startsWith(x.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0];
  return r ? r.dir : store.get().project.root;
}

export { pythonRootFor };
