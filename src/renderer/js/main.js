// Renderer entry: loads settings and the toolchain, applies the theme, wires the services and every
// command (menus, toolbar, Find Action, shortcuts) and mounts the app. window.__kiln exposes the
// command runner plus a few editor/terminal accessors for the end-to-end tests and KILN_SCRIPT.
import { html, render } from './lib/preact.js';
import { store } from './lib/store.js';
import { invoke, on } from './lib/ipc.js';
import { registerAll, run, installKeyHandlers, setKeymap } from './lib/commands.js';
import { openModal, openPopup, toast, closeAllModals } from './lib/ui.js';
import { applyThemeVars, setCustomThemes } from './lib/themes.js';
import { setMonacoTheme } from './lib/monaco.js';
import { basename, dirname, relative, sleep } from './lib/util.js';
import { App } from './components/App.js';
import { showFileDiff } from './components/panels/Git.js';
import { TOOL_WINDOWS, openTool } from './services/layout.js';
import * as ed from './services/editor.js';
import * as lang from './services/lang.js';
import * as git from './services/git.js';
import * as claude from './services/claude.js';
import { initBuild, startBuild, cancelBuild } from './services/build.js';
import * as sessions from './services/sessions.js';
import * as debug from './services/debug.js';
import * as refactor from './services/refactor.js';
import * as tests from './services/tests.js';
import './components/RefactorDialog.js';
import './components/ConflictsDialog.js';
import './components/GitDialogs.js';
import './components/AiDialogs.js';
import * as ai from './services/ai.js';
import { showConflicts } from './services/conflicts.js';
import { initProject, openProject, closeProject, newFileIn } from './services/project.js';

const hasProject = () => !!store.get().project;

function needProject(fn) {
  return (arg) => {
    if (!hasProject()) {
      toast({ title: 'Open a project first', timeout: 2500 });
      return undefined;
    }
    return fn(arg);
  };
}

const paused = () => !!(store.get().debug && store.get().debug.state === 'stopped');
const editorFocused = () => {
  const e = ed.getEditor();
  return !!(e && ed.activeFile() && e.hasTextFocus());
};

function focusEditor() {
  const e = ed.getEditor();
  if (e) setTimeout(() => e.focus(), 0);
}

function editorAction(id) {
  return () => {
    const e = ed.getEditor();
    if (e && ed.activeFile()) {
      e.focus();
      e.trigger('kiln', id, null);
    }
  };
}

async function goToLine() {
  if (!ed.activeFile()) return;
  const v = await openModal('goToLine');
  if (!v) return;
  const [line, col] = String(v).split(/[:,]/).map((x) => parseInt(x, 10));
  if (!line) return;
  ed.reveal(line, col || 1);
  focusEditor();
}

function showBookmarks() {
  const p = store.get().project;
  const marks = (p && p.state && p.state.bookmarks) || {};
  const items = [];
  for (const [file, lines] of Object.entries(marks)) for (const line of lines) items.push({ label: `${basename(file)}:${line}`, hint: relative(p.root, dirname(file)), icon: 'bookmark', run: () => ed.openFile(file, { line }) });
  openPopup({ type: 'list', title: 'Bookmarks', items });
}

function selectedRunConfig() {
  const r = store.get().runs;
  return r.configs.find((c) => c.id === r.selected) || null;
}

function activeRunId() {
  const r = store.get().runs;
  return r.active || (r.sessions.length ? r.sessions[r.sessions.length - 1].id : null);
}

function activeTerminalId() {
  const t = store.get().terminals;
  const list = t.list.filter((x) => !x.agent);
  return list.find((x) => x.id === t.active) ? t.active : list.length ? list[list.length - 1].id : null;
}

function openSpecialView(kind, arg) {
  if (kind === 'graph') {
    const focus = arg && arg.focus;
    const ref = arg && arg.source === 'main' ? 'main' : null;
    const title = focus ? `Graph: ${focus.split(/[.:]/).pop()}` : ref ? `Knowledge Graph (${(store.get().branchGraph || {}).branch || 'main'})` : 'Knowledge Graph';
    return ed.openSpecial({ id: `graph:code${ref ? ':main' : ''}${focus ? `:${focus}` : ''}`, kind: 'graph', title, data: { source: 'code', focus, ref } });
  }
  if (kind === 'artifacts') return ed.openSpecial({ id: 'graph:artifacts', kind: 'graph', title: 'Artifacts Graph', data: { source: 'artifacts' } });
  return ed.openSpecial({ id: 'flow', kind: 'flow', title: 'Message Flow' });
}

function registerCommands() {
  const tools = [];
  // "Show" semantics for menu/shortcut commands; the stripe buttons toggle.
  for (const [side, list] of Object.entries(TOOL_WINDOWS)) {
    for (const t of list) {
      if (!t.command.startsWith('view.')) continue;
      tools.push({ id: t.command, title: `${t.title} Tool Window`, run: needProject(() => openTool(side, t.id)) });
    }
  }
  const pickAndOpen = async () => {
    const dir = await invoke('app:selectFolder', { title: 'Open Solution or Folder', buttonLabel: 'Open' });
    if (dir) await openProject(dir);
  };
  registerAll([
    ...tools,
    // the Artifacts library is useful before a project is open (Welcome screen)
    { id: 'view.artifacts', title: 'Artifacts Knowledge Base', run: () => openTool('right', 'artifacts') },
    { id: 'view.claude', title: 'Claude', run: needProject(() => openTool('right', 'claude')) },
    { id: 'view.knowledgeGraph', title: 'Knowledge Graph', run: needProject((arg) => openSpecialView('graph', arg)) },
    { id: 'view.mainGraph', title: 'Knowledge Graph of the Main Branch', run: needProject(() => openSpecialView('graph', { source: 'main' })) },
    { id: 'graph.syncMain', title: 'Sync the Main-Branch Knowledge Graph Now', run: needProject(() => invoke('code:branchSync').then((st) => { store.set({ branchGraph: st }); toast({ title: st.state === 'ready' ? `Knowledge graph of ${st.branch} is at ${st.short}` : 'No main or master branch to follow', timeout: 3000 }); })) },
    { id: 'view.artifactGraph', title: 'Artifacts Knowledge Graph', run: needProject(() => openSpecialView('artifacts')) },
    { id: 'view.messageFlow', title: 'Message Flow (Kafka)', run: needProject(() => openSpecialView('flow')) },
    { id: 'view.settings', title: 'Settings…', run: (section) => openModal('settings', { section: typeof section === 'string' ? section : undefined }) },
    { id: 'view.theme', title: 'Quick Switch Theme…', run: () => openModal('theme') },
    { id: 'view.zen', title: 'Toggle Zen Mode', run: needProject(() => store.update('layout', (l) => ({ ...l, zen: !l.zen }))) },
    { id: 'view.zoomIn', title: 'Zoom In', run: () => invoke('app:zoom', 0.5) },
    { id: 'view.zoomOut', title: 'Zoom Out', run: () => invoke('app:zoom', -0.5) },
    { id: 'view.zoomReset', title: 'Actual Size', run: () => invoke('app:zoom', 0) },

    { id: 'project.new', title: 'New Solution…', run: () => openModal('newProject') },
    { id: 'project.open', title: 'Open…', run: pickAndOpen },
    { id: 'project.openPath', title: 'Open Project', hidden: true, run: (p) => openProject(p) },
    { id: 'project.openNewWindow', title: 'Open in New Window…', run: async () => { const dir = await invoke('app:selectFolder', { title: 'Open in New Window' }); if (dir) invoke('app:newWindow', dir); } },
    { id: 'project.clone', title: 'Get from Version Control…', run: () => openModal('clone') },
    { id: 'project.close', title: 'Close Project', run: needProject(() => closeProject()) },

    { id: 'file.newFile', title: 'New File…', run: needProject((dir) => newFileIn(typeof dir === 'string' ? dir : ed.activeFile() ? dirname(ed.activeFile()) : store.get().project.root)) },
    { id: 'file.save', title: 'Save', run: () => ed.save() },
    { id: 'file.saveAll', title: 'Save All', run: () => ed.saveAll() },
    { id: 'file.localHistory', title: 'Local History…', run: needProject((p) => { const file = typeof p === 'string' ? p : ed.activeFile(); if (file) openModal('localHistory', { file }); else toast({ title: 'Open a file to see its local history', timeout: 2500 }); }) },
    { id: 'file.markdownPreview', title: 'Markdown Preview', run: needProject((p) => { const file = typeof p === 'string' ? p : ed.activeFile(); if (file) ed.openSpecial({ id: `md:${file}`, kind: 'markdown', title: `${basename(file)} (preview)`, data: { path: file } }); }) },
    { id: 'file.closeTab', title: 'Close Tab', run: () => { const t = ed.activeTab(); if (t) ed.closeTab(t.id); } },
    { id: 'file.reopenClosed', title: 'Reopen Closed Tab', run: () => ed.reopenClosed() },
    { id: 'editor.splitRight', title: 'Split Right', run: needProject(() => ed.splitGroup('row')) },
    { id: 'editor.splitDown', title: 'Split Down', run: needProject(() => ed.splitGroup('column')) },
    { id: 'editor.moveToOppositeGroup', title: 'Move Tab to Opposite Group', run: needProject(() => ed.moveToOppositeGroup()) },
    { id: 'editor.nextSplit', title: 'Go to Next Splitter', run: needProject(() => ed.focusNextGroup()) },
    { id: 'editor.unsplit', title: 'Unsplit', run: needProject(() => ed.closeGroup(ed.activeGroup())) },
    { id: 'editor.unsplitAll', title: 'Unsplit All', run: needProject(() => ed.unsplitAll()) },
    { id: 'editor.pinTab', title: 'Pin / Unpin Tab', run: needProject(() => { const t = ed.activeTab(); if (t) ed.togglePinned(t.id); }) },
    { id: 'file.closeOtherTabs', title: 'Close Other Tabs', run: needProject(() => { const t = ed.activeTab(); if (t) ed.closeAll({ except: t.id, group: ed.activeGroup() }); }) },
    { id: 'file.closeAllTabs', title: 'Close All Tabs', run: needProject(() => ed.closeAll()) },

    { id: 'edit.findInFiles', title: 'Find in Files…', run: needProject((dir) => openModal('findInFiles', { dir: typeof dir === 'string' ? dir : undefined })) },
    { id: 'edit.replaceInFiles', title: 'Replace in Files…', run: needProject(() => openModal('findInFiles', { replace: true })) },
    { id: 'edit.toggleComment', title: 'Comment with Line Comment', run: editorAction('editor.action.commentLine'), when: editorFocused },
    { id: 'code.format', title: 'Reformat Code', run: needProject(() => lang.formatDocument()) },
    { id: 'code.quickFix', title: 'Show Context Actions', run: needProject(() => lang.quickFix()), when: editorFocused },
    { id: 'refactor.rename', title: 'Rename…', run: needProject(() => lang.renameSymbol()), when: editorFocused },
    { id: 'refactor.this', title: 'Refactor This…', run: needProject(() => refactor.refactorThis()) },
    { id: 'refactor.changeSignature', title: 'Change Signature…', run: needProject(() => refactor.refactorKind('changeSignature')) },
    { id: 'refactor.extractMethod', title: 'Extract Method…', run: needProject(() => refactor.refactorKind('extractMethod')) },
    { id: 'refactor.introduceVariable', title: 'Introduce Variable…', run: needProject(() => refactor.refactorKind('introduceVariable')) },
    { id: 'refactor.introduceConstant', title: 'Introduce Constant…', run: needProject(() => refactor.refactorKind('introduceConstant')) },
    { id: 'refactor.introduceField', title: 'Introduce Field…', run: needProject(() => refactor.refactorKind('introduceField')) },
    { id: 'refactor.introduceParameter', title: 'Introduce Parameter…', run: needProject(() => refactor.refactorKind('introduceParameter')) },
    { id: 'refactor.inline', title: 'Inline…', run: needProject(() => refactor.refactorKind('inline')) },
    { id: 'refactor.move', title: 'Move…', run: needProject(() => refactor.refactorKind('move')) },
    { id: 'refactor.safeDelete', title: 'Safe Delete…', run: needProject(() => refactor.refactorKind('safeDelete')) },
    { id: 'refactor.pullMembersUp', title: 'Pull Members Up…', run: needProject(() => refactor.refactorKind('pullMembersUp')) },

    { id: 'navigate.searchEverywhere', title: 'Search Everywhere', run: () => (hasProject() ? openModal('searchEverywhere', { tab: 'all' }) : openModal('searchEverywhere', { tab: 'actions' })) },
    { id: 'navigate.action', title: 'Find Action…', run: () => openModal('searchEverywhere', { tab: 'actions' }) },
    { id: 'navigate.file', title: 'Go to File…', run: needProject(() => openModal('searchEverywhere', { tab: 'files' })) },
    { id: 'navigate.class', title: 'Go to Class…', run: needProject(() => openModal('searchEverywhere', { tab: 'classes' })) },
    { id: 'navigate.symbol', title: 'Go to Symbol…', run: needProject(() => openModal('searchEverywhere', { tab: 'symbols' })) },
    { id: 'navigate.recent', title: 'Recent Files', run: needProject(() => openModal('searchEverywhere', { tab: 'files' })) },
    { id: 'navigate.line', title: 'Go to Line…', run: needProject(goToLine) },
    { id: 'navigate.definition', title: 'Go to Declaration', run: needProject(() => lang.goToDefinition('definition')), when: editorFocused },
    { id: 'navigate.implementation', title: 'Go to Implementation', run: needProject(() => lang.goToDefinition('implementation')), when: editorFocused },
    { id: 'navigate.usages', title: 'Find Usages', run: needProject(() => lang.findUsages()) },
    { id: 'navigate.back', title: 'Back', run: () => ed.navigateBack() },
    { id: 'navigate.forward', title: 'Forward', run: () => ed.navigateForward() },
    { id: 'navigate.toggleBookmark', title: 'Toggle Bookmark', run: needProject(() => ed.toggleBookmark()) },
    { id: 'navigate.bookmarks', title: 'Show Bookmarks', run: needProject(showBookmarks) },

    { id: 'build.build', title: 'Build Solution', run: needProject(() => startBuild({ reason: 'manual' })) },
    { id: 'build.rebuild', title: 'Rebuild Solution', run: needProject(() => startBuild({ reason: 'manual', mode: 'rebuild' })) },
    { id: 'build.cancel', title: 'Cancel Build', run: () => cancelBuild() },
    { id: 'run.run', title: 'Run', run: needProject(() => { const c = selectedRunConfig(); if (c) sessions.startRun(c); else run('run.editConfigurations'); }) },
    { id: 'run.stop', title: 'Stop', run: () => { for (const s of store.get().runs.sessions) if (s.running) sessions.stopRun(s.id); debug.stopDebug(); } },
    { id: 'run.editConfigurations', title: 'Edit Configurations…', run: needProject(() => openModal('runConfigs')) },
    { id: 'tests.runAll', title: 'Run All Tests', run: needProject(() => tests.runAll()) },
    { id: 'tests.runAllCoverage', title: 'Run All Tests with Coverage', run: needProject(() => tests.runAll({ coverage: true })) },
    { id: 'tests.rerunFailed', title: 'Rerun Failed Tests', run: needProject(() => tests.rerunFailed()) },
    { id: 'tests.rerunLast', title: 'Repeat Last Test Run', run: needProject(() => tests.rerunLast()) },
    { id: 'tests.runAtCaret', title: 'Run Test at Caret', run: needProject(() => tests.testAtCaretAction('run')) },
    { id: 'tests.debugAtCaret', title: 'Debug Test at Caret', run: needProject(() => tests.testAtCaretAction('debug')) },
    { id: 'tests.coverageAtCaret', title: 'Run Test at Caret with Coverage', run: needProject(() => tests.testAtCaretAction('coverage')) },
    { id: 'tests.toggleCoverage', title: 'Show / Hide Coverage in the Editor', run: needProject(() => tests.toggleCoverage()) },
    { id: 'tests.stop', title: 'Stop Test Run', run: () => tests.cancel() },

    { id: 'git.commit', title: 'Commit…', run: needProject(() => { openTool('left', 'commit'); store.set({ commitTab: { tab: 'commit', t: Date.now() } }); setTimeout(() => { const el = document.querySelector('[data-testid="commit-message"]'); if (el) el.focus(); }, 60); }) },
    { id: 'git.push', title: 'Push…', run: needProject(() => git.push()) },
    { id: 'git.pull', title: 'Update Project (Pull)', run: needProject(() => git.pull()) },
    { id: 'git.fetch', title: 'Fetch', run: needProject(() => git.fetch()) },
    { id: 'git.branches', title: 'Branches…', run: needProject(() => store.set({ toolbarPopup: { name: 'branch', t: Date.now() } })) },
    { id: 'git.newBranch', title: 'New Branch…', run: needProject(() => git.newBranch()) },
    { id: 'git.stash', title: 'Stash Changes…', run: needProject(() => git.stashChanges()) },
    { id: 'git.resolveConflicts', title: 'Resolve Conflicts…', run: needProject(() => showConflicts()) },
    { id: 'git.publishGithub', title: 'Share Project on GitHub…', run: needProject(() => openModal('publishGithub')) },
    { id: 'git.githubSettings', title: 'GitHub Connection…', run: () => openModal('settings', { section: 'vcs' }) },
    { id: 'git.branchChanges', title: 'Show Branch Changes', run: needProject((base) => { openTool('left', 'commit'); store.set({ commitTab: { tab: 'branch', base: typeof base === 'string' ? base : undefined, t: Date.now() } }); }) },
    { id: 'git.blame', title: 'Annotate with Git Blame', run: needProject(() => ed.toggleBlame()) },
    { id: 'git.diffFile', title: 'Show Diff with HEAD', run: needProject((p) => { const file = typeof p === 'string' ? p : ed.activeFile(); const root = store.get().project.git.root; if (file && root) showFileDiff({ kind: 'working', path: relative(root, file) }); }) },

    { id: 'claude.newChat', title: 'New Claude Chat', run: needProject(async () => { openTool('right', 'claude'); await claude.startNewChat(); }) },
    { id: 'claude.explain', title: 'Explain Selection with Claude', run: needProject(() => claude.explainSelection()) },
    { id: 'claude.fixBuild', title: 'Fix Build Problems with Claude', run: needProject(() => claude.fixBuildProblems()) },
    { id: 'ai.generateDocs', title: 'Generate Documentation with Claude', run: needProject(() => ai.generateDocs()) },
    { id: 'ai.generateTests', title: 'Generate Tests with Claude', run: needProject(() => ai.generateTests()) },
    { id: 'ai.explainException', title: 'Explain Exception with Claude', run: needProject((trace) => ai.explainException(trace)) },
    { id: 'ai.completeHere', title: 'AI Code Completion at Caret', run: needProject(() => ai.triggerInlineCompletion()), when: editorFocused },
    { id: 'ai.toggleCompletion', title: 'Turn AI Code Completion On / Off', run: () => ai.toggleInlineCompletion() },
    { id: 'git.generateCommitMessage', title: 'Generate Commit Message with Claude', run: needProject(() => { openTool('left', 'commit'); store.set({ commitTab: { tab: 'commit', generate: Date.now(), t: Date.now() } }); }) },

    { id: 'debug.start', title: 'Debug', run: needProject((cfg) => (paused() ? debug.resume() : debug.startDebug(cfg && typeof cfg === 'object' ? cfg : undefined))) },
    { id: 'debug.file', title: 'Debug Current File', run: needProject((p) => { const file = typeof p === 'string' ? p : ed.activeFile(); if (file) debug.debugFile(file); else toast({ title: 'Open a Python or JavaScript file to debug it', timeout: 2500 }); }) },
    { id: 'debug.stop', title: 'Stop Debugging', run: () => debug.stopDebug() },
    { id: 'debug.restart', title: 'Rerun Debug Session', run: needProject(() => debug.restartDebug()) },
    { id: 'debug.resume', title: 'Resume Program', run: () => debug.resume(), when: paused },
    { id: 'debug.pause', title: 'Pause Program', run: () => debug.pause() },
    { id: 'debug.stepOver', title: 'Step Over', run: () => debug.stepOver(), when: paused },
    { id: 'debug.stepInto', title: 'Step Into', run: () => debug.stepInto(), when: paused },
    { id: 'debug.stepOut', title: 'Step Out', run: () => debug.stepOut(), when: paused },
    { id: 'debug.runToCursor', title: 'Run to Cursor', run: () => debug.runToCursor(), when: paused },
    { id: 'debug.toggleBreakpoint', title: 'Toggle Line Breakpoint', run: needProject(() => { const f = ed.activeFile(); const e = ed.getEditor(); if (f && e) debug.toggleBreakpoint(f, e.getPosition().lineNumber); }) },
    { id: 'debug.editBreakpoint', title: 'Edit Breakpoint Condition…', run: needProject(() => { const f = ed.activeFile(); const e = ed.getEditor(); if (f && e) debug.editBreakpoint(f, e.getPosition().lineNumber); }) },
    { id: 'debug.viewBreakpoints', title: 'View Breakpoints…', run: needProject(() => openTool('bottom', 'debug')) },
    { id: 'debug.muteBreakpoints', title: 'Mute Breakpoints', run: needProject(() => debug.setMuted(!store.get().debugOptions.muted)) },
    { id: 'debug.evaluate', title: 'Evaluate Expression…', run: needProject(async () => {
      if (store.get().debug.state !== 'stopped') return toast({ title: 'Evaluate works while the program is paused', timeout: 2500 });
      openTool('bottom', 'debug');
      const sel = store.get().editor.selection;
      setTimeout(() => { const el = document.querySelector('[data-testid="debug-eval-input"]'); if (el) { if (sel && !sel.includes('\n')) { el.value = sel; el.dispatchEvent(new Event('input', { bubbles: true })); } el.focus(); el.select(); } }, 80);
    }) },
    { id: 'editor.duplicateLine', title: 'Duplicate Line or Selection', run: editorAction('editor.action.copyLinesDownAction'), when: editorFocused },
    { id: 'editor.deleteLine', title: 'Delete Line', run: editorAction('editor.action.deleteLines'), when: editorFocused },
    { id: 'editor.addNextOccurrence', title: 'Add Selection for Next Occurrence', run: editorAction('editor.action.addSelectionToNextFindMatch'), when: editorFocused },
    { id: 'editor.moveLineUp', title: 'Move Line Up', run: editorAction('editor.action.moveLinesUpAction'), when: editorFocused },
    { id: 'editor.moveLineDown', title: 'Move Line Down', run: editorAction('editor.action.moveLinesDownAction'), when: editorFocused },
    { id: 'editor.expandSelection', title: 'Extend Selection', run: editorAction('editor.action.smartSelect.expand'), when: editorFocused },
    { id: 'editor.shrinkSelection', title: 'Shrink Selection', run: editorAction('editor.action.smartSelect.shrink'), when: editorFocused },
    { id: 'edit.replace', title: 'Replace in File', run: editorAction('editor.action.startFindReplaceAction'), when: editorFocused },
    { id: 'help.shortcuts', title: 'Keyboard Shortcuts', run: () => openModal('shortcuts') },
    { id: 'dev.tools', title: 'Toggle Developer Tools', run: () => invoke('app:devtools') },
    { id: 'dev.reload', title: 'Reload Window', run: () => invoke('app:reload') },
  ]);
}

/** Theme and editor options follow the settings, whoever changed them (this window or another). */
async function loadKeymap() {
  try {
    const km = await invoke('app:keymap');
    setKeymap(km);
    store.set({ keymap: km });
  } catch (err) {
    console.error('[kiln] keymap', err);
  }
}

function applyTheme(id) {
  applyThemeVars(id);
  setMonacoTheme(id);
  sessions.applyTerminalTheme();
}

function followSettings() {
  let last = null;
  let customKey = '';
  store.subscribe((s) => {
    if (!s.settings || s.settings === last) return;
    const prev = last;
    last = s.settings;
    const key = JSON.stringify(s.settings.customThemes || []);
    const customChanged = key !== customKey;
    if (customChanged) {
      customKey = key;
      setCustomThemes(s.settings.customThemes);
    }
    if (!prev || prev.theme !== s.settings.theme || customChanged) applyTheme(s.settings.theme);
    if (prev) ed.applyEditorSettings();
  });
  on('app:settingsChanged', (settings) => {
    store.set({ settings });
    loadKeymap();
  });
}

/** Once per app run, offer to give detected AI agents the knowledge graph (unless dismissed). */
function offerAgentSetup() {
  let offered = false;
  store.subscribe((s) => {
    if (offered || !s.project || !s.settings || (s.settings.agents || {}).kgPromptDismissed) return;
    offered = true;
    setTimeout(async () => {
      const info = await invoke('agents:kgStatus').catch(() => null);
      if (!info || info.suppressPrompt || !info.node) return;
      const pending = info.agents.filter((a) => a.present && !a.installed);
      if (!pending.length) return;
      toast({
        title: 'Give your AI agents the knowledge graph?',
        message: `${pending.map((a) => a.name).join(', ')} can query this project's knowledge graph first, before grep or reading files.`,
        timeout: 0,
        actions: [
          { label: 'Set up…', run: () => run('view.settings', 'agents') },
          { label: 'Not now', run: () => invoke('app:updateSettings', { agents: { kgPromptDismissed: true } }).then((next) => store.set({ settings: next })) },
        ],
      });
    }, 4000);
  });
}

/** Main-branch knowledge graph status (background sync of main / master). */
function followBranchGraph() {
  on('index:branch', (s) => store.set({ branchGraph: s || { state: 'idle' } }));
  let root = null;
  store.subscribe((s) => {
    const r = s.project ? s.project.root : null;
    if (r === root) return;
    root = r;
    if (r) setTimeout(() => invoke('code:branchStatus').then((st) => store.set({ branchGraph: st })).catch(() => {}), 1500);
  });
}

function followTitle() {
  let last = '';
  store.subscribe((s) => {
    const t = s.project ? `${s.project.name} – Kiln IDE` : 'Kiln IDE';
    if (t !== last) document.title = last = t;
  });
}

function exposeTestApi() {
  window.__kiln = {
    store,
    closeAllModals,
    // Commands may wait on dialogs; tests only need them started, so cap the wait.
    run: async (id, arg) => {
      await Promise.race([run(id, arg), sleep(1500)]);
      return true;
    },
    test: {
      getActiveContent: () => {
        const e = ed.getEditor();
        const m = e && e.getModel();
        return m ? m.getValue() : null;
      },
      setActiveContent: (text) => {
        const f = ed.activeFile();
        if (!f) return false;
        ed.setContent(f, text);
        return true;
      },
      runText: () => sessions.runText(activeRunId()),
      terminalText: () => sessions.terminalText(activeTerminalId()),
      terminalSend: (text) => {
        const id = activeTerminalId();
        if (id) sessions.terminalSend(id, text);
        return !!id;
      },
      openFile: async (path, line, col, endLine, endCol) => {
        await ed.openFile(path, { line, col, endLine, endCol });
        return true;
      },
      // Text shown by each split's editor, in layout order.
      groupTexts: () => ed.layoutGroups().map((g) => {
        const t = store.get().editor.tabs.find((x) => x.id === (store.get().editor.groups.find((y) => y.id === g) || {}).active);
        const d = t && t.kind === 'file' ? ed.getDoc(t.path) : null;
        return d && d.model ? d.model.getValue() : null;
      }),
      // Client Y of the middle of a line in the active editor (after revealing it).
      lineY: (line) => {
        const e = ed.getEditor();
        if (!e || !e.getModel()) return null;
        e.revealLineInCenterIfOutsideViewport(line);
        const pos = e.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
        return pos ? e.getDomNode().getBoundingClientRect().top + pos.top + pos.height / 2 : null;
      },
      lspState: (lang) => ((store.get().lsp || {})[lang] || {}).state || null,
      cursor: () => {
        const e = ed.getEditor();
        const p = e && e.getPosition();
        return { file: ed.activeFile() || '', line: p ? p.lineNumber : 0, col: p ? p.column : 0 };
      },
      indexHas: (name) => invoke('code:indexHas', name),
      toggleBreakpoint: (file, line) => {
        debug.toggleBreakpoint(file, line);
        return debug.breakpointsIn(file).map((b) => b.line);
      },
      debugOutput: () => debug.debugOutputText(),
      debugState: () => store.get().debug.state,
      claudeConfigure: async (patch) => {
        await claude.configure(patch);
        return true;
      },
    },
  };
}

async function boot() {
  const [settings, appInfo, recent] = await Promise.all([invoke('app:settings'), invoke('app:info'), invoke('app:recent').catch(() => [])]);
  setCustomThemes(settings.customThemes);
  applyThemeVars(settings.theme);
  registerCommands();
  await loadKeymap();
  initBuild();
  git.initGit();
  sessions.initSessions();
  claude.initClaude();
  initProject();
  debug.initDebug();
  tests.initTests();
  installKeyHandlers();
  followSettings();
  followTitle();
  followBranchGraph();
  offerAgentSetup();
  exposeTestApi();
  store.set({ settings, appInfo, recent, ready: true });
  invoke('app:toolchain')
    .then((toolchain) => store.set({ toolchain }))
    .catch(() => store.set({ toolchain: {} }));
  render(html`<${App} />`, document.getElementById('app'));
  const open = new URLSearchParams(location.search).get('open');
  if (open) await openProject(open);
  else if (settings.startup && settings.startup.reopenLastProject && recent[0]) await openProject(recent[0].path);
  window.__kilnReady = true;
}

window.addEventListener('error', (e) => console.error('[kiln]', e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', (e) => console.error('[kiln] unhandled', e.reason && (e.reason.stack || e.reason.message || e.reason)));
boot().catch((err) => {
  console.error('[kiln] boot failed', err);
  document.getElementById('app').innerHTML = `<div class="boot" style="flex-direction:column;gap:8px"><div>Kiln IDE could not start</div><pre style="font-size:12px;opacity:.7">${String(err && (err.stack || err.message || err)).replace(/</g, '&lt;')}</pre></div>`;
});
