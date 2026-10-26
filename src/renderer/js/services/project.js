// Project lifecycle in the renderer: open/close, restoring tabs and layout, run configurations,
// auto-build on load, and reacting to file-system changes.
import { store } from '../lib/store.js';
import { invoke, on } from '../lib/ipc.js';
import { toast, errorToast } from '../lib/ui.js';
import { debounce } from '../lib/util.js';
import * as ed from './editor.js';
import * as git from './git.js';
import { startBuild, restoreBuildState } from './build.js';
import { disposeAll } from './sessions.js';
import { loadProbe } from './claude.js';

export async function loadRecent() {
  const recent = await invoke('app:recent').catch(() => []);
  store.set({ recent });
  return recent;
}

export async function refreshRunConfigs() {
  const configs = await invoke('run:configs').catch(() => []);
  const r = store.get().runs;
  const st = (store.get().project && store.get().project.state) || {};
  const selected = configs.find((c) => c.id === r.selected) ? r.selected : configs.find((c) => c.id === st.runConfig) ? st.runConfig : configs.length ? configs[0].id : null;
  store.update('runs', { configs, selected });
}

export async function openProject(path) {
  if (!path) return;
  store.set({ projectLoading: path });
  let p;
  try {
    await ed.saveAll({ quiet: true });
    p = await invoke('project:open', path);
  } catch (err) {
    store.set({ projectLoading: null });
    errorToast('Could not open the project', err);
    return;
  }
  disposeAll();
  ed.resetEditor();
  const state = p.state || {};
  store.set((s) => ({
    projectLoading: null,
    project: { ...p, recentFiles: state.recentFiles || [] },
    problems: { build: [], live: {} },
    usages: null,
    build: { running: false, id: null, steps: [], status: null, errors: 0, warnings: 0 },
    git: { status: null, branches: null, stashes: [], log: [], loading: false, console: [] },
    runs: { configs: [], selected: state.runConfig || null, sessions: [], active: null },
    layout: { ...s.layout, ...(state.layout || {}), zen: false },
    index: { state: 'indexing' },
    branchGraph: { state: 'idle' },
    claude: { ...s.claude, probe: null },
  }));
  await refreshRunConfigs();
  git.refreshAll();
  await restoreBuildState();
  // Restore editor tabs from the last session.
  // Splits and pinned tabs when they were saved; otherwise the plain list of open tabs.
  if (!(await ed.restoreGroups(state.editorGroups).catch(() => false))) {
    const tabs = (state.openTabs || []).slice(0, 20);
    for (const t of tabs) await ed.openFile(t, { focus: false, background: false }).catch(() => {});
    if (state.activeTab) ed.activate(`file:${state.activeTab}`);
  }
  const s = store.get().settings;
  if (s.build.autoBuildOnLoad && (p.detection.kinds.length || p.detection.python || p.detection.dotnet)) startBuild({ reason: 'load' });
  loadRecent();
  // Start Claude Code in the background so the Skills panel and slash commands are ready.
  setTimeout(() => loadProbe(), 1500);
}

export async function closeProject() {
  await ed.saveAll({ quiet: true });
  persist.cancel();
  await saveState();
  await invoke('project:close');
  disposeAll();
  ed.resetEditor();
  store.set({ project: null, problems: { build: [], live: {} }, usages: null });
  loadRecent();
}

async function saveState() {
  const s = store.get();
  if (!s.project) return;
  const tabs = s.editor.tabs.filter((t) => t.kind === 'file').map((t) => t.path);
  const active = ed.activeFile();
  const { zen, ...layout } = s.layout;
  await invoke('app:setProjectState', { openTabs: tabs, activeTab: active, editorGroups: ed.groupsState(), layout, runConfig: s.runs.selected, recentFiles: (s.project.recentFiles || []).slice(0, 40) }).catch(() => {});
}

const persist = debounce(saveState, 1500);

export function initProject() {
  store.subscribe((s) => {
    if (s.project) persist();
  });
  on('project:detected', (detection) => {
    store.update('project', { detection });
    refreshRunConfigs();
  });
  on('fs:changed', ({ paths, overflow }) => {
    store.set((s) => ({ fsTick: (s.fsTick || 0) + 1, fsChanged: overflow ? null : paths }));
    const agents = store.get().agents || {};
    // Follow files agents change: a CLI agent active in a terminal, or a Claude chat that is working
    // (it may write files with Bash as well as with its edit tools).
    const chats = Object.values((store.get().claude || {}).chats || {});
    const claudeWorking = chats.some((c) => c.status === 'busy' && c.follow !== false);
    const follow = !!((agents.follow !== false && agents.lastActivity && Date.now() - agents.lastActivity < 20000) || claudeWorking);
    ed.onFsChanged(paths, { follow });
    for (const p of paths) ed.invalidateBlame(p);
  });
  on('app:beforeClose', async () => {
    await ed.saveAll({ quiet: true });
    await saveState();
    window.kiln.send('app:closeReady');
  });
  ed.onEditorEvent(async (type, data) => {
    if (type !== 'saved') return;
    const s = store.get().settings;
    if (data.path.endsWith('.py') && s.build.pythonCheckOnSave) import('./build.js').then((b) => b.checkPythonFile(data.path));
    if (data.path.endsWith('.cs') && s.build.buildOnSave) startBuild({ reason: 'save', only: ['dotnet'] });
    ed.rescanTests(data.path);
  });
}

export async function newFileIn(dir) {
  const { prompt } = await import('../lib/ui.js');
  const name = await prompt({ title: 'New File', label: 'File name (folders are created as needed):', placeholder: 'Services/OrderService.cs', ok: 'Create' });
  if (!name) return;
  const target = `${dir}/${name}`;
  const content = templateFor(target);
  try {
    await invoke('fs:createFile', target, content);
    await ed.openFile(target);
  } catch (err) {
    errorToast('Could not create the file', err);
  }
}

function templateFor(file) {
  const base = file.split('/').pop();
  const name = base.replace(/\.[^.]+$/, '');
  if (file.endsWith('.cs')) {
    const isInterface = /^I[A-Z]/.test(name);
    return `namespace ${(store.get().project.name || 'App').replace(/[^\w.]/g, '_')};\n\npublic ${isInterface ? 'interface' : 'class'} ${name}\n{\n}\n`;
  }
  if (file.endsWith('.py')) return /^test_/.test(base) ? `def test_${name.replace(/^test_/, '')}():\n    assert True\n` : `"""${name}."""\n`;
  return '';
}

export async function newFolderIn(dir) {
  const { prompt } = await import('../lib/ui.js');
  const name = await prompt({ title: 'New Directory', label: 'Directory name:', ok: 'Create' });
  if (!name) return;
  await invoke('fs:createDir', `${dir}/${name}`).catch((err) => errorToast('Could not create the directory', err));
}

export function notify(message) {
  toast({ title: message, timeout: 2500 });
}
