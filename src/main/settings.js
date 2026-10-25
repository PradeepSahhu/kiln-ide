'use strict';
// Persistent settings (userData/settings.json): global preferences, recent projects and
// per-project UI state such as layout, open tabs and the selected run configuration.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  theme: 'rider-dark',
  uiFontSize: 13,
  editor: {
    fontFamily: "'JetBrains Mono', Menlo, Monaco, monospace",
    fontSize: 13,
    lineHeight: 20,
    ligatures: true,
    minimap: true,
    wordWrap: 'off',
    tabSize: 4,
    insertSpaces: true,
    renderWhitespace: 'selection',
    autosave: true,
    stickyScroll: true,
  },
  build: {
    autoBuildOnLoad: true,
    buildOnSave: false,
    pythonCheckOnSave: true,
    autoCreateVenv: true,
    autoInstallDeps: true,
    preferUv: true,
    rebuildAfterClaude: true,
    openBuildWindow: true,
    openProblemsOnError: true,
    dotnetConfiguration: 'Debug',
    dotnetExtraArgs: '',
    pythonLint: true,
    agentChecks: true,
    nodeBuild: 'auto',
    useGithubToken: true,
    githubTokenVar: 'GITHUB_TOKEN',
  },
  languages: { pyright: true, pythonTypeChecking: 'basic', csharpLs: '', csharpLsEnabled: true, codeLens: true, inlayHints: true, semanticHighlighting: true },
  startup: { reopenLastProject: false },
  python: { interpreter: '' },
  dotnet: { path: '' },
  terminal: { shell: '', activateVenv: true, fontSize: 13 },
  run: { loadDotEnv: true },
  claude: {
    model: 'default',
    permissionMode: 'default',
    effort: 'default',
    includeContext: true,
    executable: '',
    showThinking: true,
  },
  agents: { kgInClaudeChat: true, kgPromptDismissed: false },
  github: { auth: 'auto', tokenVar: '' },
  knowledgeGraph: { fetchMinutes: 10 },
  keymapPreset: 'rider',
  keymap: {},
  customThemes: [],
  recentProjects: [],
  window: { bounds: null, maximized: false },
  projects: {},
};

let data = null;
let file = null;
let saveTimer = null;

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function load() {
  if (data) return data;
  file = path.join(app.getPath('userData'), 'settings.json');
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    stored = {};
  }
  data = merge(DEFAULTS, stored);
  return data;
}

function get() {
  return load();
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}

function flush() {
  if (!data || !file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[settings] save failed:', err.message);
  }
}

/** Deep-merge a partial update into the settings. Arrays are replaced, not merged. */
function update(partial) {
  data = merge(load(), partial);
  save();
  return data;
}

/** Replace one top-level setting wholesale (objects whose keys can be removed, like keymap). */
function replace(key, value) {
  data = { ...load(), [key]: value };
  save();
  return data;
}

function getProjectState(root) {
  return load().projects[root] || {};
}

function setProjectState(root, partial) {
  const projects = { ...load().projects };
  projects[root] = merge(projects[root] || {}, partial);
  data = { ...data, projects };
  save();
  return projects[root];
}

function addRecent(root, name, meta = {}) {
  const prev = load().recentProjects.find((p) => p.path === root) || {};
  const list = load().recentProjects.filter((p) => p.path !== root);
  list.unshift({ ...prev, ...meta, path: root, name, openedAt: Date.now() });
  data = { ...data, recentProjects: list.slice(0, 25) };
  save();
  return data.recentProjects;
}

/** Update stored metadata (branch, last build result, ...) of a recent project without reordering. */
function updateRecent(root, meta) {
  const list = load().recentProjects.map((p) => (p.path === root ? { ...p, ...meta } : p));
  data = { ...data, recentProjects: list };
  save();
  return list;
}

function removeRecent(root) {
  data = { ...load(), recentProjects: load().recentProjects.filter((p) => p.path !== root) };
  save();
  return data.recentProjects;
}

module.exports = { get, update, replace, flush, getProjectState, setProjectState, addRecent, updateRecent, removeRecent, DEFAULTS };
