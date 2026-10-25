'use strict';
// Application menu with Rider (macOS keymap) shortcuts. Items send command ids to the focused window.
const path = require('path');
const { Menu, app } = require('electron');
const { menuAccelerator } = require('./keymap');

/**
 * Menu template; shortcuts come from the effective keymap (see keymap.js). Each item carries its
 * command id in `commandId`; a command listed twice registers its shortcut on the first item only.
 */
function buildMenuTemplate({ recent = [], send, keymap = {} }) {
  const isMac = process.platform === 'darwin';
  const used = new Set();
  const c = (label, id) => {
    const acc = used.has(id) ? undefined : menuAccelerator(keymap, id);
    used.add(id);
    return { label, accelerator: acc, commandId: id, click: () => send(id) };
  };
  const template = [
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              c('Settings…', 'view.settings'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        c('New Project…', 'project.new'),
        c('New File…', 'file.newFile'),
        c('Open…', 'project.open'),
        c('Get from Version Control…', 'project.clone'),
        {
          label: 'Open Recent',
          submenu: recent.length ? recent.slice(0, 15).map((r) => ({ label: `${r.name}  —  ${path.dirname(r.path)}`, click: () => send('project.openPath', r.path) })) : [{ label: 'No recent projects', enabled: false }],
        },
        c('Open in New Window…', 'project.openNewWindow'),
        { type: 'separator' },
        c('Save', 'file.save'),
        c('Save All', 'file.saveAll'),
        c('Local History…', 'file.localHistory'),
        { type: 'separator' },
        c('Close Tab', 'file.closeTab'),
        c('Reopen Closed Tab', 'file.reopenClosed'),
        c('Close Project', 'project.close'),
        ...(isMac ? [] : [{ type: 'separator' }, c('Settings…', 'view.settings'), { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        c('Find in Files…', 'edit.findInFiles'),
        c('Replace in Files…', 'edit.replaceInFiles'),
        c('Reformat Code', 'code.format'),
      ],
    },
    {
      label: 'View',
      submenu: [
        c('Search Everywhere', 'navigate.searchEverywhere'),
        c('Find Action…', 'navigate.action'),
        { type: 'separator' },
        {
          label: 'Tool Windows',
          submenu: [
            c('Project', 'view.project'),
            c('Commit', 'view.commit'),
            c('Git', 'view.git'),
            c('Structure', 'view.structure'),
            c('Problems', 'view.problems'),
            c('Run', 'view.run'),
            c('Debug', 'view.debug'),
            c('Build', 'view.build'),
            c('Terminal', 'view.terminal'),
            c('Tests', 'view.tests'),
            c('TODO', 'view.todo'),
            c('Packages', 'view.packages'),
            { type: 'separator' },
            c('Claude', 'view.claude'),
            c('AI Agents', 'view.agents'),
            c('Skills', 'view.skills'),
            c('Artifacts Knowledge Base', 'view.artifacts'),
          ],
        },
        c('Knowledge Graph', 'view.knowledgeGraph'),
        c('Message Flow (Kafka)', 'view.messageFlow'),
        { type: 'separator' },
        c('Quick Switch Theme…', 'view.theme'),
        c('Zen Mode', 'view.zen'),
        c('Zoom In', 'view.zoomIn'),
        c('Zoom Out', 'view.zoomOut'),
        c('Actual Size', 'view.zoomReset'),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        c('Go to File…', 'navigate.file'),
        c('Go to Symbol…', 'navigate.symbol'),
        c('Go to Class…', 'navigate.class'),
        c('Recent Files', 'navigate.recent'),
        c('Go to Line…', 'navigate.line'),
        { type: 'separator' },
        c('Go to Declaration', 'navigate.definition'),
        c('Go to Implementation', 'navigate.implementation'),
        c('Find Usages', 'navigate.usages'),
        { type: 'separator' },
        c('Back', 'navigate.back'),
        c('Forward', 'navigate.forward'),
        c('Toggle Bookmark', 'navigate.toggleBookmark'),
        c('Show Bookmarks', 'navigate.bookmarks'),
      ],
    },
    {
      label: 'Code',
      submenu: [
        c('Reformat Code', 'code.format'),
        c('Show Context Actions', 'code.quickFix'),
        c('Comment with Line Comment', 'edit.toggleComment'),
        { type: 'separator' },
        c('Generate Documentation with Claude', 'ai.generateDocs'),
        c('Generate Tests with Claude', 'ai.generateTests'),
        c('AI Code Completion at Caret', 'ai.completeHere'),
      ],
    },
    {
      label: 'Refactor',
      submenu: [
        c('Refactor This…', 'refactor.this'),
        { type: 'separator' },
        c('Rename…', 'refactor.rename'),
        c('Change Signature…', 'refactor.changeSignature'),
        c('Safe Delete…', 'refactor.safeDelete'),
        { type: 'separator' },
        c('Extract Method…', 'refactor.extractMethod'),
        c('Introduce Variable…', 'refactor.introduceVariable'),
        c('Introduce Constant…', 'refactor.introduceConstant'),
        c('Introduce Field…', 'refactor.introduceField'),
        c('Introduce Parameter…', 'refactor.introduceParameter'),
        c('Inline…', 'refactor.inline'),
        { type: 'separator' },
        c('Move…', 'refactor.move'),
        c('Pull Members Up…', 'refactor.pullMembersUp'),
      ],
    },
    {
      label: 'Build',
      submenu: [c('Build Solution', 'build.build'), c('Rebuild Solution', 'build.rebuild'), c('Cancel Build', 'build.cancel')],
    },
    {
      label: 'Run',
      submenu: [
        c('Run', 'run.run'),
        c('Debug', 'debug.start'),
        c('Debug Current File', 'debug.file'),
        c('Stop', 'run.stop'),
        c('Edit Configurations…', 'run.editConfigurations'),
        { type: 'separator' },
        c('Resume Program', 'debug.resume'),
        c('Pause Program', 'debug.pause'),
        c('Step Over', 'debug.stepOver'),
        c('Step Into', 'debug.stepInto'),
        c('Step Out', 'debug.stepOut'),
        c('Run to Cursor', 'debug.runToCursor'),
        c('Evaluate Expression…', 'debug.evaluate'),
        { type: 'separator' },
        c('Toggle Line Breakpoint', 'debug.toggleBreakpoint'),
        c('Edit Breakpoint Condition…', 'debug.editBreakpoint'),
        c('View Breakpoints…', 'debug.viewBreakpoints'),
        c('Mute Breakpoints', 'debug.muteBreakpoints'),
        { type: 'separator' },
        c('Run All Tests', 'tests.runAll'),
        c('Run All Tests with Coverage', 'tests.runAllCoverage'),
        c('Rerun Failed Tests', 'tests.rerunFailed'),
        c('Run Test at Caret', 'tests.runAtCaret'),
        c('Debug Test at Caret', 'tests.debugAtCaret'),
        c('Show / Hide Coverage', 'tests.toggleCoverage'),
      ],
    },
    {
      label: 'Git',
      submenu: [
        c('Commit…', 'git.commit'),
        c('Push…', 'git.push'),
        c('Update Project (Pull)', 'git.pull'),
        c('Fetch', 'git.fetch'),
        { type: 'separator' },
        c('Branches…', 'git.branches'),
        c('New Branch…', 'git.newBranch'),
        c('Stash Changes…', 'git.stash'),
        c('Resolve Conflicts…', 'git.resolveConflicts'),
        c('Show Branch Changes', 'git.branchChanges'),
        { type: 'separator' },
        c('Share Project on GitHub…', 'git.publishGithub'),
        c('GitHub Connection…', 'git.githubSettings'),
        c('Annotate with Git Blame', 'git.blame'),
      ],
    },
    {
      label: 'Claude',
      submenu: [c('Open Claude', 'view.claude'), c('New Chat', 'claude.newChat'), c('Explain Selection', 'claude.explain'), c('Fix Build Problems with Claude', 'claude.fixBuild'), c('Explain Exception', 'ai.explainException'), c('Generate Documentation', 'ai.generateDocs'), c('Generate Tests', 'ai.generateTests'), c('Generate Commit Message', 'git.generateCommitMessage'), c('Turn AI Code Completion On / Off', 'ai.toggleCompletion'), { type: 'separator' }, c('Ask the Artifacts Knowledge Base…', 'view.artifacts')],
    },
    {
      label: 'Window',
      role: 'windowMenu',
      submenu: [
        { role: 'minimize' },
        ...(isMac ? [{ role: 'zoom' }] : []),
        { type: 'separator' },
        {
          label: 'Editor Tabs',
          submenu: [
            c('Split Right', 'editor.splitRight'),
            c('Split Down', 'editor.splitDown'),
            c('Move Tab to Opposite Group', 'editor.moveToOppositeGroup'),
            c('Go to Next Splitter', 'editor.nextSplit'),
            c('Unsplit', 'editor.unsplit'),
            c('Unsplit All', 'editor.unsplitAll'),
            { type: 'separator' },
            c('Pin / Unpin Tab', 'editor.pinTab'),
            c('Close Other Tabs', 'file.closeOtherTabs'),
            c('Close All Tabs', 'file.closeAllTabs'),
            c('Reopen Closed Tab', 'file.reopenClosed'),
          ],
        },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
      ],
    },
    {
      role: 'help',
      submenu: [c('Keyboard Shortcuts', 'help.shortcuts'), { type: 'separator' }, c('Toggle Developer Tools', 'dev.tools'), c('Reload Window', 'dev.reload')],
    },
  ];
  return template;
}

function stripIds(items) {
  return items.map(({ commandId, ...it }) => (Array.isArray(it.submenu) ? { ...it, submenu: stripIds(it.submenu) } : it));
}

function buildMenu(opts) {
  Menu.setApplicationMenu(Menu.buildFromTemplate(stripIds(buildMenuTemplate(opts))));
}

module.exports = { buildMenu, buildMenuTemplate };
