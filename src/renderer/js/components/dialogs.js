// Modal dialogs and pickers.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState, createContext, useContext } from '../lib/preact.js';
import { useStore, store } from '../lib/store.js';
import { Icon, FileIcon, KindIcon } from '../lib/icons.js';
import { invoke, on, isMac } from '../lib/ipc.js';
import { allCommands, run, SHORTCUTS } from '../lib/commands.js';
import { cls, fuzzy, highlight, basename, dirname, relative, timeAgo, formatDate, debounce, join } from '../lib/util.js';
import { closeModal, toast, errorToast, confirm } from '../lib/ui.js';
import { themes, themeById, cssVars } from '../lib/themes.js';
import { Spinner } from './ui.js';
import { KeymapSettings } from './Keymap.js';
import { ThemeEditor } from './ThemeEditor.js';
import { AgentSettings } from './AgentSettings.js';
import { GitHubSettings } from './GitHubSettings.js';
import * as ed from '../services/editor.js';
import { openProject } from '../services/project.js';

// Which modal layer a dialog belongs to; only the topmost one reacts to Escape.
const LayerContext = createContext({ key: null, top: true });

export function Modal({ title, children, footer, wide, testid, onClose, className = '' }) {
  const layer = useContext(LayerContext);
  const layerRef = useRef(layer);
  layerRef.current = layer;
  const close = onClose || (() => closeModal(null, layer.key));
  const closeRef = useRef(close);
  closeRef.current = close;
  const boxRef = useRef(null);
  // A layout effect: Escape pressed right after the dialog appears must close it.
  useLayoutEffect(() => {
    const k = (e) => {
      if (e.key !== 'Escape' || !layerRef.current.top || e.defaultPrevented) return;
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', k);
    // Take focus from the editor (which would swallow Escape and keep typing into the file), and keep
    // it: an editor focused later (a timer, a reveal) must not take the keyboard from the dialog.
    if (boxRef.current && !boxRef.current.contains(document.activeElement)) boxRef.current.focus({ preventScroll: true });
    const keep = (e) => {
      const box = boxRef.current;
      if (!layerRef.current.top || !box || box.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.popup, .context-menu, .toasts, .modal-backdrop')) return;
      box.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', keep);
    return () => {
      window.removeEventListener('keydown', k);
      document.removeEventListener('focusin', keep);
    };
  }, []);
  onClose = close;
  return html`<div class="modal-backdrop" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class=${cls('modal', wide === true && 'wide', wide === 'x' && 'xwide', className)} data-testid=${testid} ref=${boxRef} tabIndex="-1">
      <div class="modal-header">${title}<div class="spacer"></div><button class="icon-btn sm" onClick=${onClose}><${Icon} name="close" /></button></div>
      <div class="modal-body">${children}</div>
      ${footer ? html`<div class="modal-footer">${footer}</div>` : null}
    </div>
  </div>`;
}

export function ConfirmDialog({ title = 'Confirm', message, detail, extra, ok = 'OK', cancel = 'Cancel', danger, force }) {
  const okRef = useRef(null);
  useEffect(() => {
    setTimeout(() => okRef.current && okRef.current.focus(), 0);
  }, []);
  return html`<${Modal} title=${title} testid="confirm-dialog" onClose=${() => closeModal(false)}
      footer=${html`<button class="btn" data-testid="dialog-cancel" onClick=${() => closeModal(false)}>${cancel}</button><button ref=${okRef} class=${cls('btn', danger ? 'danger' : 'primary')} data-testid="dialog-confirm" data-force=${force ? 'true' : undefined} onClick=${() => closeModal(true)}>${ok}</button>`}>
    <div class="message">${message}</div>
    ${extra ? html`<div class="muted" style="margin-top:8px;font-size:12px">${extra}</div>` : null}
    ${detail ? html`<div class="detail mono">${detail}</div>` : null}
  <//>`;
}

export function PromptDialog({ title = 'Input', label, value = '', placeholder = '', ok = 'OK', checkbox, testid, selectBase }) {
  const [v, setV] = useState(value);
  const [checked, setChecked] = useState(checkbox ? !!checkbox.value : false);
  const ref = useRef(null);
  useEffect(() => {
    setTimeout(() => {
      if (!ref.current) return;
      ref.current.focus();
      if (selectBase && value.includes('.')) ref.current.setSelectionRange(0, value.lastIndexOf('.'));
      else ref.current.select();
    }, 0);
  }, []);
  const done = () => closeModal(checkbox ? { value: v, checked } : v);
  return html`<${Modal} title=${title} testid="prompt-dialog" onClose=${() => closeModal(null)}
      footer=${html`<button class="btn" onClick=${() => closeModal(null)}>Cancel</button><button class="btn primary" data-testid="dialog-confirm" onClick=${done}>${ok}</button>`}>
    <div class="field"><label>${label}</label><input class="input" ref=${ref} data-testid=${testid || 'prompt-input'} value=${v} placeholder=${placeholder} onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && done()} /></div>
    ${checkbox ? html`<label class="checkbox"><input type="checkbox" checked=${checked} onChange=${(e) => setChecked(e.target.checked)} />${checkbox.label}</label>` : null}
  <//>`;
}

// ------------------------------------------------------------ New Project

export function NewProjectDialog() {
  const info = useStore((s) => s.appInfo);
  const settings = useStore((s) => s.settings);
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [name, setName] = useState('');
  const [loc, setLoc] = useState(settings.lastProjectLocation || (info ? `${info.home}/KilnProjects` : ''));
  const [gitInit, setGitInit] = useState(true);
  const [venv, setVenv] = useState(true);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  useEffect(() => {
    invoke('templates:list').then((l) => {
      setList(l);
      setSel(l.find((t) => t.available) || l[0]);
    });
    return on('templates:progress', ({ text }) => setLog((x) => (x + text).slice(-6000)));
  }, []);
  useEffect(() => {
    if (sel && !name) setName(sel.lang === 'csharp' ? 'MyApp' : sel.lang === 'python' ? 'my_app' : 'my-app');
  }, [sel]);
  const create = async () => {
    if (!sel || !sel.available) return;
    setBusy(true);
    setLog('');
    try {
      if (!(await invoke('fs:exists', loc))) await invoke('fs:createDir', loc);
      const dir = await invoke('templates:create', { templateId: sel.id, name: name.trim(), location: loc, gitInit, venv });
      await invoke('app:updateSettings', { lastProjectLocation: loc });
      closeModal(dir);
      await openProject(dir);
    } catch (err) {
      setBusy(false);
      errorToast('Could not create the project', err);
    }
  };
  const groups = useMemo(() => {
    const g = new Map();
    for (const t of list) {
      if (!g.has(t.group)) g.set(t.group, []);
      g.get(t.group).push(t);
    }
    return [...g];
  }, [list]);
  const icon = (t) => (t.lang === 'csharp' ? 'x.cs' : t.lang === 'python' ? 'x.py' : t.lang === 'typescript' ? 'x.ts' : 'x.js');
  return html`<${Modal} title="New Solution" wide=${true} testid="new-project-dialog"
      footer=${html`<div class="left">${busy ? html`<${Spinner} /><span class="muted">Creating…</span>` : null}</div><button class="btn" onClick=${() => closeModal(null)} disabled=${busy}>Cancel</button><button class="btn primary" data-testid="new-project-create" disabled=${busy || !sel || !sel.available || !name.trim() || !loc} onClick=${create}>Create</button>`}>
    <div class="np">
      <div class="np-list">
        ${groups.map(([g, items]) => html`<div class="section-title">${g}</div>${items.map((t) => html`<div class=${cls('np-item', sel && sel.id === t.id && 'selected', !t.available && 'unavailable')} data-testid=${`template-${t.id}`} onClick=${() => setSel(t)} title=${t.reason || t.description}><${FileIcon} name=${icon(t)} /><span class="ellipsis">${t.name}</span></div>`)}`)}
      </div>
      <div class="np-form">
        ${sel
          ? html`<h3 style="margin:0 0 4px;font-size:15px">${sel.name}</h3><p class="desc">${sel.description}${!sel.available ? html`<br /><span class="sev-warning">${sel.reason}</span>` : null}</p>
              <div class="field"><label>Name</label><input class="input" data-testid="new-project-name" value=${name} onInput=${(e) => setName(e.target.value)} /></div>
              <div class="field"><label>Location</label><div class="row"><input class="input grow" data-testid="new-project-location" value=${loc} onInput=${(e) => setLoc(e.target.value)} /><button class="btn" onClick=${async () => { const d = await invoke('app:selectFolder', { title: 'Location', buttonLabel: 'Choose' }); if (d) setLoc(d); }}>…</button></div></div>
              <div class="muted" style="font-size:12px;margin:-6px 0 12px">The project is created in ${loc ? `${loc}/${name}` : '…'}</div>
              <label class="checkbox" style="margin-bottom:8px"><input type="checkbox" checked=${gitInit} onChange=${(e) => setGitInit(e.target.checked)} />Create Git repository</label>
              ${sel.venv ? html`<label class="checkbox"><input type="checkbox" checked=${venv} onChange=${(e) => setVenv(e.target.checked)} />Create a virtual environment (.venv)</label>` : null}
              ${log ? html`<div class="np-log">${log}</div>` : null}`
          : null}
      </div>
    </div>
  <//>`;
}

export function PublishGithubDialog() {
  const project = useStore((s) => s.project);
  const [name, setName] = useState((project && project.name) || '');
  const [priv, setPriv] = useState(true);
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const publish = async () => {
    setBusy(true);
    try {
      const r = await invoke('git:githubPublish', { name: name.trim(), isPrivate: priv, description: desc.trim() });
      closeModal(r);
      const web = (r.url || '').replace(/\.git$/, '');
      if (r.ok) toast({ kind: 'success', title: 'Published on GitHub', message: web, actions: [{ label: 'Open', run: () => invoke('app:openExternal', web) }] });
      else toast({ kind: 'warning', title: 'Repository created, push failed', message: r.error });
      import('../services/git.js').then((g) => g.refreshAll());
    } catch (err) {
      setBusy(false);
      errorToast('Could not publish', err);
    }
  };
  return html`<${Modal} title="Share Project on GitHub" testid="publish-github-dialog"
      footer=${html`<button class="btn" onClick=${() => closeModal(null)}>Cancel</button><button class="btn primary" data-testid="publish-confirm" disabled=${busy || !name.trim()} onClick=${publish}>${busy ? html`<${Spinner} size=${12} />` : null}Share</button>`}>
    <div class="field"><label>Repository name</label><input class="input" data-testid="publish-name" value=${name} onInput=${(e) => setName(e.target.value)} /></div>
    <label class="checkbox" style="margin-bottom:10px"><input type="checkbox" checked=${priv} onChange=${(e) => setPriv(e.target.checked)} />Private repository</label>
    <div class="field"><label>Description</label><input class="input" value=${desc} onInput=${(e) => setDesc(e.target.value)} /></div>
    <div class="muted" style="font-size:12px">Creates the repository with your GitHub connection (Settings › Version Control), adds it as "origin" and pushes the current branch.</div>
  <//>`;
}

export function CloneDialog() {
  const info = useStore((s) => s.appInfo);
  const [url, setUrl] = useState('');
  const [dir, setDir] = useState(info ? `${info.home}/KilnProjects` : '');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [repos, setRepos] = useState(null);
  const [rq, setRq] = useState('');
  useEffect(() => on('git:cloneProgress', ({ text }) => setLog((x) => (x + text).slice(-4000))), []);
  useEffect(() => {
    invoke('git:githubRepos').then(setRepos).catch((err) => setRepos({ error: err.message }));
  }, []);
  const clone = async () => {
    setBusy(true);
    try {
      if (!(await invoke('fs:exists', dir))) await invoke('fs:createDir', dir);
      const target = await invoke('git:clone', url.trim(), dir);
      closeModal(target);
      openProject(target);
    } catch (err) {
      setBusy(false);
      errorToast('Clone failed', err);
    }
  };
  return html`<${Modal} title="Get from Version Control" testid="clone-dialog" footer=${html`<button class="btn" onClick=${() => closeModal(null)}>Cancel</button><button class="btn primary" disabled=${busy || !url} onClick=${clone}>${busy ? html`<${Spinner} />` : null}Clone</button>`}>
    <div class="field"><label>Repository URL</label><input class="input" data-testid="clone-url" value=${url} placeholder="https://github.com/owner/repo.git" onInput=${(e) => setUrl(e.target.value)} /></div>
    <div class="field"><label>Your GitHub repositories</label>
      ${!repos
        ? html`<div class="muted" style="font-size:12px"><${Spinner} size=${12} /> Loading…</div>`
        : repos.error
          ? html`<div class="muted" style="font-size:12px">${repos.error}</div>`
          : html`<input class="input" placeholder="Filter" value=${rq} onInput=${(e) => setRq(e.target.value)} style="margin-bottom:6px" />
              <div class="list" style="max-height:180px;border:1px solid var(--border-inner);border-radius:6px">${repos.filter((r) => !rq || r.name.toLowerCase().includes(rq.toLowerCase())).slice(0, 100).map((r) => html`<div class=${cls('list-row', url === r.url && 'selected')} data-testid="github-repo" onClick=${() => setUrl(r.url)} title=${r.description}><${Icon} name=${r.private ? 'key' : 'globe'} size=${13} className="muted" /><span class="ellipsis">${r.name}</span><span class="muted" style="font-size:11px;margin-left:auto">${r.private ? 'private' : 'public'}</span></div>`)}</div>`}
    </div>
    <div class="field"><label>Directory</label><div class="row"><input class="input grow" value=${dir} onInput=${(e) => setDir(e.target.value)} /><button class="btn" onClick=${async () => { const d = await invoke('app:selectFolder', {}); if (d) setDir(d); }}>…</button></div></div>
    ${log ? html`<div class="np-log">${log}</div>` : null}
  <//>`;
}

// --------------------------------------------------------------- Settings

const AI_MODELS = [['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5'], ['claude-fable-5-1', 'Claude Fable 5.1']];

/** How the AI features reach Claude: the Anthropic API (API key) or Claude Code (your Claude login). */
function AiTransport() {
  const [st, setSt] = useState(null);
  useEffect(() => {
    invoke('ai:status').then(setSt).catch(() => setSt(null));
  }, []);
  if (!st) return null;
  const how = st.transport === 'api' ? 'the Anthropic API (ANTHROPIC_API_KEY is set)' : st.transport === 'stub' ? 'test answers (KILN_AI_STUB)' : 'Claude Code with your Claude login. Set ANTHROPIC_API_KEY for faster completions.';
  return html`<div class="muted" data-testid="ai-transport" data-transport=${st.transport} style="font-size:12px;margin-top:6px">AI features call Claude through ${how}</div>`;
}

const SECTIONS = [
  ['appearance', 'Appearance', 'palette'],
  ['themes', 'Theme Editor', 'wand'],
  ['editor', 'Editor', 'edit'],
  ['keymap', 'Keymap', 'keyboard'],
  ['build', 'Build & Packages', 'hammer'],
  ['languages', 'Languages', 'lightbulb'],
  ['runtimes', 'Python & .NET', 'package'],
  ['vcs', 'Version Control', 'git'],
  ['terminal', 'Terminal', 'terminal'],
  ['claude', 'Claude', 'claude'],
  ['agents', 'AI Agents', 'agent'],
  ['startup', 'Startup', 'settings'],
];

function ThemeSwatch({ t, on, onPick }) {
  const full = themeById(t.id);
  return html`<div class=${cls('theme-card', on && 'on')} onClick=${onPick} data-testid=${`theme-${t.id}`}>
    <div class="sw" style=${{ background: full.base.editor }}>
      <span><span style=${{ color: full.syntax.keyword }}>public class</span> <span style=${{ color: full.syntax.type }}>Order</span></span>
      <span><span style=${{ color: full.syntax.method }}>Place</span><span style=${{ color: full.syntax.fg }}>(</span><span style=${{ color: full.syntax.string }}>"id"</span><span style=${{ color: full.syntax.fg }}>)</span> <span style=${{ color: full.syntax.comment }}>// ok</span></span>
    </div>
    <div class="nm" style=${{ background: full.base.panel, color: full.base.text }}>${t.name}${t.custom ? html`<span class="custom-badge">custom</span>` : null}</div>
  </div>`;
}

export function SettingsDialog({ section: initial }) {
  const s = useStore((st) => st.settings);
  const [section, setSection] = useState(initial || 'appearance');
  const [tok, setTok] = useState(null);
  const [lsp, setLsp] = useState(null);
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    invoke('app:githubToken').then(setTok);
    invoke('lsp:info').then(setLsp).catch(() => setLsp(null));
  }, []);
  const set = (patch) => invoke('app:updateSettings', patch).then((next) => store.set({ settings: next }));
  const row = (label, hint, control) => html`<div class="setting"><div class="lbl">${label}${hint ? html`<div class="h">${hint}</div>` : null}</div>${control}</div>`;
  const check = (obj, key, sub) => html`<input type="checkbox" checked=${!!s[obj][key]} onChange=${(e) => set({ [obj]: { [key]: e.target.checked } })} />`;
  const text = (obj, key, ph = '', width = 320) => html`<input class="input" style=${{ width: `${width}px` }} value=${s[obj][key] || ''} placeholder=${ph} onChange=${(e) => set({ [obj]: { [key]: e.target.value } })} />`;
  const num = (obj, key, min, max) => html`<input class="input" type="number" style="width:90px" min=${min} max=${max} value=${s[obj][key]} onChange=${(e) => set({ [obj]: { [key]: Number(e.target.value) } })} />`;
  const select = (obj, key, opts, testid) => html`<select class="input" data-testid=${testid} value=${obj ? s[obj][key] : s[key]} onChange=${(e) => set(obj ? { [obj]: { [key]: e.target.value } } : { [key]: e.target.value })}>${opts.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>`;
  const body = {
    appearance: html`<h3>Appearance</h3>
      ${row('Theme', 'Editor colors, UI and terminal', html`<select class="input" data-testid="theme-select" value=${s.theme} onChange=${(e) => set({ theme: e.target.value })}>${themes.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select>`)}
      <div class="theme-grid">${themes.map((t) => html`<${ThemeSwatch} t=${t} on=${s.theme === t.id} onPick=${() => set({ theme: t.id })} />`)}</div>
      <div class="row" style="margin-top:12px;gap:8px"><button class="btn small" data-testid="theme-customize" onClick=${() => setSection('themes')}><${Icon} name="wand" size=${13} />Customize colors…</button><span class="muted" style="font-size:12px">Create your own theme from any of these, or import a VS Code theme.</span></div>`,
    editor: html`<h3>Editor</h3>
      ${row('Font family', null, text('editor', 'fontFamily'))}
      ${row('Font size', null, num('editor', 'fontSize', 8, 32))}
      ${row('Line height', null, num('editor', 'lineHeight', 12, 48))}
      ${row('Font ligatures', null, check('editor', 'ligatures'))}
      ${row('Tab size', null, num('editor', 'tabSize', 1, 8))}
      ${row('Insert spaces', null, check('editor', 'insertSpaces'))}
      ${row('Word wrap', null, select('editor', 'wordWrap', [['off', 'Off'], ['on', 'On'], ['bounded', 'Bounded']]))}
      ${row('Minimap', null, check('editor', 'minimap'))}
      ${row('Sticky scroll', 'Keep the enclosing class/method visible', check('editor', 'stickyScroll'))}
      ${row('Render whitespace', null, select('editor', 'renderWhitespace', [['none', 'None'], ['selection', 'Selection'], ['boundary', 'Boundary'], ['all', 'All']]))}
      ${row('Save automatically', 'When the editor loses focus, like Rider', check('editor', 'autosave'))}`,
    keymap: html`<${KeymapSettings} />`,
    themes: html`<${ThemeEditor} />`,
    agents: html`<${AgentSettings} />`,
    vcs: html`<${GitHubSettings} />`,
    build: html`<h3>Build & Packages</h3>
      ${row('Build automatically when a project opens', null, check('build', 'autoBuildOnLoad'))}
      ${row('Open the Build window when a build starts', null, check('build', 'openBuildWindow'))}
      ${row('Open Problems when a save introduces errors', null, check('build', 'openProblemsOnError'))}
      ${row('Check Python files on save', 'Syntax, missing modules, pyflakes', check('build', 'pythonCheckOnSave'))}
      ${row('Build .NET on save', null, check('build', 'buildOnSave'))}
      ${row('Rebuild after Claude edits files', null, check('build', 'rebuildAfterClaude'))}
      ${row('Create virtual environments automatically', 'For Python projects with dependencies', check('build', 'autoCreateVenv'))}
      ${row('Install dependencies automatically', 'Skipped when nothing changed', check('build', 'autoInstallDeps'))}
      ${row('Prefer uv for Python environments', null, check('build', 'preferUv'))}
      ${row('Lint Python with pyflakes', 'When installed in the interpreter', check('build', 'pythonLint'))}
      ${row('Agent environment checks', '.env keys, MCP and LangGraph configs', check('build', 'agentChecks'))}
      ${row('.NET configuration', null, select('build', 'dotnetConfiguration', [['Debug', 'Debug'], ['Release', 'Release']]))}
      ${row('Extra dotnet build arguments', null, text('build', 'dotnetExtraArgs', '-p:TreatWarningsAsErrors=false'))}
      ${row('Build Node packages', null, select('build', 'nodeBuild', [['auto', 'Agentic or Node-only projects'], ['always', 'Always'], ['never', 'Never']]))}
      <h3 style="margin-top:22px">GitHub packages</h3>
      ${row('Use a GitHub token for packages', 'GitHub Packages (NuGet, npm) and private git+https dependencies', check('build', 'useGithubToken'))}
      ${row('Token environment variable', 'Falls back to GITHUB_TOKEN, then GH_TOKEN', text('build', 'githubTokenVar', 'GITHUB_TOKEN', 200))}
      ${tok ? row('Status', null, html`<span class=${tok.found ? 'ok' : 'sev-warning'}>${tok.found ? `Found in $${tok.variable} (value hidden)` : `$${tok.variable} is not set`}</span>`) : null}`,
    languages: html`<h3>Languages</h3>
      ${row('Python language server (pyright)', 'Completion, type errors, precise navigation', html`<input type="checkbox" checked=${(s.languages || {}).pyright !== false} onChange=${(e) => set({ languages: { pyright: e.target.checked } })} />`)}
      ${row('Python type checking', null, select('languages', 'pythonTypeChecking', [['off', 'Off'], ['basic', 'Basic'], ['standard', 'Standard'], ['strict', 'Strict']]))}
      ${row('C# language server (csharp-ls)', lsp && lsp.csharpLs ? lsp.csharpLs : 'Not installed — the built-in code index is used', html`<div class="row"><input type="checkbox" checked=${(s.languages || {}).csharpLsEnabled !== false} onChange=${(e) => set({ languages: { csharpLsEnabled: e.target.checked } })} />${!lsp || !lsp.csharpLs ? html`<button class="btn small" disabled=${installing} onClick=${async () => { setInstalling(true); try { const r = await invoke('lsp:installCsharp'); toast({ kind: 'success', title: 'csharp-ls installed', message: r.path }); setLsp(await invoke('lsp:info')); } catch (err) { errorToast('Install failed', err); } setInstalling(false); }}>${installing ? html`<${Spinner} />` : null}Install</button>` : null}</div>`)}
      ${row('Usage counts above members', '“3 usages”, like Rider’s Code Vision', html`<input type="checkbox" checked=${(s.languages || {}).codeLens !== false} onChange=${(e) => set({ languages: { codeLens: e.target.checked } })} />`)}
      ${row('Inlay hints', 'Parameter names and inferred types', html`<input type="checkbox" checked=${(s.languages || {}).inlayHints !== false} onChange=${(e) => set({ languages: { inlayHints: e.target.checked } })} />`)}
      ${row('Semantic highlighting', 'Colors types, methods, fields and parameters', html`<input type="checkbox" checked=${(s.languages || {}).semanticHighlighting !== false} onChange=${(e) => set({ languages: { semanticHighlighting: e.target.checked } })} />`)}`,
    runtimes: html`<h3>Python & .NET</h3>
      ${row('Python interpreter', 'Leave empty to use the project .venv or python3', text('python', 'interpreter', '/path/to/python'))}
      ${row('dotnet executable', 'Leave empty to use dotnet from PATH', text('dotnet', 'path', '/usr/local/share/dotnet/dotnet'))}
      ${row('Load .env into run configurations', null, check('run', 'loadDotEnv'))}`,
    terminal: html`<h3>Terminal</h3>
      ${row('Shell', 'Leave empty for your login shell', text('terminal', 'shell', '/bin/zsh'))}
      ${row('Activate the project virtualenv', 'zsh and bash', check('terminal', 'activateVenv'))}
      ${row('Font size', null, num('terminal', 'fontSize', 8, 28))}`,
    claude: html`<h3>Claude</h3>
      ${row('Default model', null, select('claude', 'model', [['default', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']]))}
      ${row('Default permission mode', null, select('claude', 'permissionMode', [['default', 'Ask before edits'], ['acceptEdits', 'Accept edits'], ['plan', 'Plan mode'], ['auto', 'Auto mode'], ['bypassPermissions', 'Bypass permissions']]))}
      ${row('Default effort', null, select('claude', 'effort', [['default', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]))}
      ${row('Send the open file as context', null, check('claude', 'includeContext'))}
      ${row('Show thinking summaries', null, check('claude', 'showThinking'))}
      ${row('Claude Code executable', 'Empty: bundled with Kiln. "system": the claude on PATH', text('claude', 'executable', 'system'))}
      <h3 style="margin-top:18px">AI in the editor</h3>
      ${row('AI code completion', 'Ghost text as you type; Tab accepts, Alt+\\ asks at the caret', check('ai', 'inlineCompletion'))}
      ${row('Model for code completion', 'Claude Haiku 5.5 answers fastest', select('ai', 'completionModel', AI_MODELS))}
      ${row('Model for commit messages, reviews, docs and tests', null, select('ai', 'model', AI_MODELS))}
      <${AiTransport} />`,
    startup: html`<h3>Startup</h3>${row('Reopen the last project on startup', 'Otherwise the Welcome screen lists your recent solutions', check('startup', 'reopenLastProject'))}`,
  };
  return html`<${Modal} title="Settings" wide=${section === 'themes' || section === 'keymap' ? 'x' : true} className="settings-modal" testid="settings-dialog">
    <div class="settings">
      <div class="settings-nav">${SECTIONS.map(([id, label, icon]) => html`<div class=${cls('item', section === id && 'active')} data-testid=${`settings-nav-${id}`} onClick=${() => setSection(id)}><${Icon} name=${icon} />${label}</div>`)}</div>
      <div class="settings-body">${body[section]}</div>
    </div>
  <//>`;
}

// ------------------------------------------------------ Search Everywhere

const SE_TABS = [
  ['all', 'All'],
  ['files', 'Files'],
  ['classes', 'Classes'],
  ['symbols', 'Symbols'],
  ['actions', 'Actions'],
];
let fileCache = null;
let fileCacheRoot = null;

export function SearchEverywhere({ tab: initialTab = 'all' }) {
  const root = useStore((s) => s.project && s.project.root);
  const [tab, setTab] = useState(initialTab);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [syms, setSyms] = useState([]);
  const [files, setFiles] = useState(fileCacheRoot === root ? fileCache : null);
  const ref = useRef(null);
  useEffect(() => {
    setTimeout(() => ref.current && ref.current.focus(), 0);
    if (root && (fileCacheRoot !== root || !fileCache)) {
      invoke('fs:listFiles').then((r) => {
        fileCache = r.files;
        fileCacheRoot = root;
        setFiles(r.files);
      });
    }
  }, []);
  useEffect(() => {
    if (!root || !q || (tab !== 'all' && tab !== 'classes' && tab !== 'symbols')) return setSyms([]);
    const kinds = tab === 'classes' ? ['class', 'interface', 'struct', 'record', 'enum'] : undefined;
    const t = setTimeout(() => invoke('code:workspaceSymbols', q, kinds).then(setSyms).catch(() => setSyms([])), 80);
    return () => clearTimeout(t);
  }, [q, tab]);
  const results = useMemo(() => {
    const out = [];
    if (tab === 'all' || tab === 'files') {
      const recent = (store.get().project && store.get().project.recentFiles) || [];
      const list = !q ? recent.map((p) => relative(root, p)) : (files || []);
      const scored = [];
      for (const f of list) {
        const m = fuzzy(q, f);
        if (m) scored.push({ f, m });
        if (scored.length > 4000) break;
      }
      scored.sort((a, b) => b.m.score - a.m.score);
      for (const x of scored.slice(0, tab === 'files' ? 60 : 12)) out.push({ type: 'file', label: basename(x.f), hint: dirname(x.f) === '/' ? '' : dirname(x.f), path: `${root}/${x.f}`, positions: x.m.positions.map((p) => p - (x.f.length - basename(x.f).length)).filter((p) => p >= 0) });
    }
    if (tab === 'all' || tab === 'classes' || tab === 'symbols') for (const s of syms.slice(0, tab === 'all' ? 12 : 60)) out.push({ type: 'symbol', label: s.name, kind: s.kind, hint: `${s.container ? s.container + ' · ' : ''}${s.rel}:${s.line}`, path: s.file, line: s.line, col: s.col });
    if (tab === 'all' || tab === 'actions') {
      const acts = allCommands()
        .map((c) => ({ c, m: fuzzy(q, c.title) }))
        .filter((x) => x.m)
        .sort((a, b) => b.m.score - a.m.score)
        .slice(0, tab === 'actions' ? 60 : 8);
      for (const x of acts) out.push({ type: 'action', label: x.c.title, hint: SHORTCUTS[x.c.id] || '', id: x.c.id, positions: x.m.positions });
    }
    return out;
  }, [q, tab, files, syms]);
  const open = (r) => {
    if (!r) return;
    closeModal(null);
    if (r.type === 'action') run(r.id);
    else ed.openFile(r.path, r.line ? { line: r.line, col: r.col } : {});
  };
  const key = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') open(results[sel]);
    else if (e.key === 'Escape') closeModal(null);
    else if (e.key === 'Tab') {
      e.preventDefault();
      const i = SE_TABS.findIndex(([t]) => t === tab);
      setTab(SE_TABS[(i + (e.shiftKey ? SE_TABS.length - 1 : 1)) % SE_TABS.length][0]);
    }
  };
  return html`<div class="overlay" onMouseDown=${() => closeModal(null)}>
    <div class="picker" data-testid="search-everywhere" onMouseDown=${(e) => e.stopPropagation()}>
      <div class="picker-tabs">${SE_TABS.map(([t, l]) => html`<button class=${cls('tw-tab', tab === t && 'active')} onClick=${() => { setTab(t); ref.current.focus(); }}>${l}</button>`)}</div>
      <div class="picker-input"><${Icon} name="search" className="muted" /><input ref=${ref} value=${q} placeholder=${tab === 'actions' ? 'Type an action name' : 'Type to search files, classes, symbols and actions'} onInput=${(e) => { setQ(e.target.value); setSel(0); }} onKeyDown=${key} /></div>
      <div class="picker-results">
        ${results.map((r, i) => html`<div class=${cls('picker-row', i === sel && 'selected')} onMouseEnter=${() => setSel(i)} onClick=${() => open(r)}>
          ${r.type === 'file' ? html`<${FileIcon} name=${r.label} />` : r.type === 'symbol' ? html`<${KindIcon} kind=${r.kind} />` : html`<${Icon} name="terminal" className="muted" />`}
          <span class="ellipsis">${highlight(r.label, r.positions).map((p) => (typeof p === 'string' ? p : html`<span class="mark">${p.mark}</span>`))}</span>
          <span class="hint">${r.hint}</span>
        </div>`)}
        ${!results.length ? html`<div class="empty">${q ? 'Nothing found' : 'Recent files appear here'}</div>` : null}
      </div>
      <div class="picker-footer"><span>↑↓ navigate</span><span>↩ open</span><span>Tab switch category</span><span>Esc close</span></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------- Find in Files

export function FindInFiles({ dir, replace: replaceMode }) {
  const root = useStore((s) => s.project.root);
  const sel0 = store.get().editor.selection;
  const [q, setQ] = useState(sel0 && !sel0.includes('\n') ? sel0 : '');
  const [repl, setRepl] = useState('');
  const [opts, setOpts] = useState({ caseSensitive: false, wholeWord: false, regex: false, include: '' });
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const [preview, setPreview] = useState(null);
  const ref = useRef(null);
  useEffect(() => setTimeout(() => ref.current && ref.current.select(), 0), []);
  const search = useMemo(
    () =>
      debounce(async (query, o) => {
        if (!query) return setRes(null);
        setBusy(true);
        const r = await invoke('search:text', { query, ...o }).catch((err) => ({ error: err.message, groups: [] }));
        if (dir) r.groups = r.groups.filter((g) => g.file.startsWith(dir + '/'));
        setRes(r);
        setSel(0);
        setBusy(false);
      }, 180),
    [],
  );
  useEffect(() => search(q, opts), [q, opts]);
  const flat = useMemo(() => {
    const out = [];
    for (const g of (res && res.groups) || []) for (const m of g.matches) out.push({ g, m });
    return out;
  }, [res]);
  useEffect(() => {
    const x = flat[sel];
    if (!x) return setPreview(null);
    invoke('fs:readFile', x.g.file).then((r) => {
      const lines = (r.content || '').split('\n');
      const start = Math.max(0, x.m.line - 5);
      setPreview({ start, lines: lines.slice(start, x.m.line + 5), line: x.m.line, file: x.g.file });
    }).catch(() => setPreview(null));
  }, [sel, flat]);
  const open = (x) => {
    if (!x) return;
    closeModal(null);
    ed.openFile(x.g.file, { line: x.m.line, col: x.m.col, endLine: x.m.line, endCol: x.m.col + x.m.length });
  };
  const replaceAll = async () => {
    const total = flat.length;
    const ok = await confirm({ title: 'Replace All', message: `Replace ${total} occurrence${total === 1 ? '' : 's'} of '${q}' in ${res.groups.length} file${res.groups.length === 1 ? '' : 's'}?`, ok: 'Replace', danger: true });
    if (!ok) return;
    const re = new RegExp(opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi');
    let n = 0;
    for (const g of res.groups) {
      const d = await ed.openFile(g.file, { background: true });
      if (!d || !d.model) continue;
      const text = d.model.getValue();
      const next = text.replace(opts.wholeWord ? new RegExp(`\\b(?:${re.source})\\b`, re.flags) : re, () => {
        n++;
        return repl;
      });
      if (next !== text) {
        ed.setContent(g.file, next);
        await ed.save(g.file, { quiet: true });
      }
    }
    toast({ kind: 'success', title: `Replaced ${n} occurrence${n === 1 ? '' : 's'}` });
    search(q, opts);
  };
  const key = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') open(flat[sel]);
  };
  const toggle = (k, label, title) => html`<button class=${cls('icon-btn sm', opts[k] && 'active')} title=${title} onClick=${() => setOpts({ ...opts, [k]: !opts[k] })} style="width:auto;padding:0 6px;font-size:12px;font-family:JetBrains Mono">${label}</button>`;
  let idx = -1;
  return html`<${Modal} title=${html`${replaceMode ? 'Replace in Files' : 'Find in Files'}${dir ? html`<span class="muted" style="font-weight:400;font-size:12px;margin-left:8px">${relative(root, dir)}</span>` : null}`} wide="x" testid="find-in-files">
    <div class="col" style="height:100%;gap:8px">
      <div class="row"><input class="input grow" ref=${ref} placeholder="Text to find" value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${key} />${toggle('caseSensitive', 'Aa', 'Match case')}${toggle('wholeWord', 'W', 'Words')}${toggle('regex', '.*', 'Regex')}<input class="input" style="width:150px" placeholder="File mask: *.cs, *.py" value=${opts.include} onInput=${(e) => setOpts({ ...opts, include: e.target.value })} /></div>
      ${replaceMode ? html`<div class="row"><input class="input grow" placeholder="Replace with" value=${repl} onInput=${(e) => setRepl(e.target.value)} /><button class="btn" disabled=${!flat.length} onClick=${replaceAll}>Replace All</button></div>` : null}
      <div class="muted" style="font-size:12px">${busy ? html`<${Spinner} size=${12} />` : null}${res ? `${res.total} match${res.total === 1 ? '' : 'es'} in ${res.groups.length} file${res.groups.length === 1 ? '' : 's'}${res.truncated ? ' (limited)' : ''}` : 'Type to search the project'}${res && res.error ? ` · ${res.error}` : ''}</div>
      <div style="flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid var(--border-inner);border-radius:6px;overflow:hidden">
        <div class="list" style="flex:1">
          ${((res && res.groups) || []).map((g) => html`<div><div class="problem-file"><${FileIcon} name=${basename(g.file)} /><span>${basename(g.file)}</span><span class="muted" style="font-size:12px">${g.rel}</span><span class="badge">${g.matches.length}</span></div>
              ${g.matches.map((m) => {
                idx++;
                const i = idx;
                const pre = m.text.slice(Math.max(0, m.col - 60), m.col - 1);
                return html`<div class=${cls('usage-row', i === sel && 'selected')} onClick=${() => setSel(i)} onDblClick=${() => open({ g, m })}><span class="ln">${m.line}</span><span class="code">${pre.trimStart()}<span class="mark" style="background:var(--accent-soft)">${m.text.slice(m.col - 1, m.col - 1 + m.length)}</span>${m.text.slice(m.col - 1 + m.length, m.col + 160)}</span></div>`;
              })}</div>`)}
        </div>
        ${preview ? html`<div class="text-output" style="flex:none;max-height:170px;border-top:1px solid var(--border-inner);background:var(--bg-editor)">${preview.lines.map((l, i) => html`<div style=${preview.start + i + 1 === preview.line ? 'background:var(--accent-soft)' : ''}><span class="dim" style="display:inline-block;width:40px">${preview.start + i + 1}</span>${l}</div>`)}</div>` : null}
      </div>
    </div>
  <//>`;
}

// ----------------------------------------------------- Run configurations

export function RunConfigsDialog() {
  const runs = useStore((s) => s.runs);
  const [custom, setCustom] = useState(() => runs.configs.filter((c) => c.custom).map((c) => ({ ...c })));
  const [sel, setSel] = useState(0);
  const save = async () => {
    const configs = await invoke('run:saveCustom', custom);
    store.update('runs', { configs });
    closeModal(true);
  };
  const add = () => {
    setCustom([...custom, { id: `custom:${Date.now()}`, name: 'New configuration', commandLine: '', cwd: '', envText: '', usePython: false }]);
    setSel(custom.length);
  };
  const cur = custom[sel];
  const upd = (patch) => setCustom(custom.map((c, i) => (i === sel ? { ...c, ...patch } : c)));
  return html`<${Modal} title="Run/Debug Configurations" wide=${true} testid="run-configs-dialog" footer=${html`<button class="btn" onClick=${() => closeModal(null)}>Cancel</button><button class="btn primary" onClick=${save}>OK</button>`}>
    <div class="np" style="height:420px">
      <div class="np-list">
        <div class="section-title">Detected</div>
        ${runs.configs.filter((c) => !c.custom).map((c) => html`<div class="np-item" title=${c.detail}><${Icon} name="play" size=${14} className="muted" /><span class="ellipsis">${c.name}</span></div>`)}
        <div class="section-title row">Custom <span class="spacer"></span><button class="icon-btn sm" onClick=${add}><${Icon} name="plus" /></button></div>
        ${custom.map((c, i) => html`<div class=${cls('np-item', i === sel && 'selected')} onClick=${() => setSel(i)}><${Icon} name="play" size=${14} className="ok" /><span class="ellipsis grow">${c.name}</span><button class="icon-btn sm" onClick=${(e) => { e.stopPropagation(); setCustom(custom.filter((_, j) => j !== i)); }}><${Icon} name="trash" size=${13} /></button></div>`)}
      </div>
      <div class="np-form">
        ${cur
          ? html`<div class="field"><label>Name</label><input class="input" value=${cur.name} onInput=${(e) => upd({ name: e.target.value })} /></div>
              <div class="field"><label>Command line</label><input class="input mono" value=${cur.commandLine} placeholder="dotnet run --project src/Api   or   python -m mypkg --flag" onInput=${(e) => upd({ commandLine: e.target.value })} /></div>
              <div class="field"><label>Working directory (relative to the project)</label><input class="input" value=${cur.cwd} placeholder="." onInput=${(e) => upd({ cwd: e.target.value })} /></div>
              <div class="field"><label>Environment variables (KEY=value per line)</label><textarea class="input mono" rows="5" value=${cur.envText} onInput=${(e) => upd({ envText: e.target.value })}></textarea></div>
              <label class="checkbox"><input type="checkbox" checked=${cur.usePython} onChange=${(e) => upd({ usePython: e.target.checked })} />Run with the project's Python environment</label>`
          : html`<div class="empty">Detected configurations come from your projects. Add a custom one with +.</div>`}
      </div>
    </div>
  <//>`;
}

// ------------------------------------------------------------ Local History

export function LocalHistoryDialog({ file }) {
  const [list, setList] = useState(null);
  const [sel, setSel] = useState(null);
  const root = useStore((s) => s.project.root);
  useEffect(() => {
    invoke('history:list', file).then(setList).catch(() => setList([]));
  }, [file]);
  const showDiff = async (entry) => {
    const old = await invoke('history:read', file, entry.id);
    const d = ed.getDoc(file);
    const cur = d && d.model ? d.model.getValue() : (await invoke('fs:readFile', file)).content || '';
    closeModal(null);
    ed.openDiff({ path: file, original: old, modified: cur, labels: [`${entry.label} · ${formatDate(entry.at)}`, 'Current'], title: `${basename(file)} (local history)`, id: `diff:history:${file}:${entry.id}` });
  };
  const revert = async (entry) => {
    const ok = await confirm({ title: 'Revert', message: `Revert ${basename(file)} to the version from ${formatDate(entry.at)}?`, ok: 'Revert', danger: true });
    if (!ok) return;
    await invoke('history:revert', file, entry.id);
    closeModal(null);
    toast({ kind: 'success', title: 'Reverted', message: basename(file) });
  };
  return html`<${Modal} title=${html`Local History <span class="muted" style="font-weight:400;font-size:12px;margin-left:8px">${relative(root, file)}</span>`} testid="local-history"
      footer=${html`<div class="left muted" style="font-size:12px">Stored on this Mac, never committed.</div><button class="btn" disabled=${!sel} onClick=${() => showDiff(sel)}>Show Diff</button><button class="btn danger" disabled=${!sel} onClick=${() => revert(sel)}>Revert</button>`}>
    <div class="list" style="max-height:360px">
      ${!list ? html`<div class="empty"><${Spinner} /></div>` : null}
      ${list && !list.length ? html`<div class="empty">No history for this file yet. Versions are recorded before every save and before agents change it.</div>` : null}
      ${(list || []).map((e) => html`<div class=${cls('list-row', sel === e && 'selected')} data-testid="history-row" onClick=${() => setSel(e)} onDblClick=${() => showDiff(e)}><${Icon} name="history" size=${14} className="muted" /><span>${formatDate(e.at)}</span><span class="muted">${e.label}</span><span class="muted" style="margin-left:auto;font-size:12px">${timeAgo(e.at)}</span></div>`)}
    </div>
  <//>`;
}

export function ShortcutsDialog() {
  useStore((st) => st.keymap);
  const rows = allCommands()
    .filter((c) => SHORTCUTS[c.id])
    .sort((a, b) => a.title.localeCompare(b.title));
  return html`<${Modal} title="Keyboard Shortcuts" testid="shortcuts-dialog"
      footer=${html`<button class="btn" onClick=${() => { closeModal(null); setTimeout(() => run('view.settings', 'keymap'), 0); }}>Customize…</button><button class="btn primary" onClick=${() => closeModal(null)}>Close</button>`}>
    <div class="kv-list" style="grid-template-columns:1fr auto">${rows.map((c) => html`<span>${c.title}</span><kbd>${SHORTCUTS[c.id]}</kbd>`)}</div>
  <//>`;
}

export function ThemeSwitcher() {
  const current = useStore((s) => s.settings.theme);
  const [sel, setSel] = useState(Math.max(0, themes.findIndex((t) => t.id === current)));
  const original = useRef(current);
  const apply = (id) => invoke('app:updateSettings', { theme: id }).then((s) => store.set({ settings: s }));
  const key = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = Math.max(0, Math.min(themes.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      setSel(i);
      apply(themes[i].id);
    } else if (e.key === 'Enter') closeModal(true);
    else if (e.key === 'Escape') {
      apply(original.current);
      closeModal(null);
    }
  };
  const ref = useRef(null);
  useEffect(() => setTimeout(() => ref.current && ref.current.focus(), 0), []);
  return html`<div class="overlay" onMouseDown=${() => closeModal(null)}>
    <div class="picker" style="width:360px" onMouseDown=${(e) => e.stopPropagation()}>
      <div class="picker-input"><${Icon} name="palette" className="muted" /><input ref=${ref} readonly value="Color theme (↑↓ to preview, ↩ to keep)" onKeyDown=${key} /></div>
      <div class="picker-results">${themes.map((t, i) => html`<div class=${cls('picker-row', i === sel && 'selected')} onClick=${() => { apply(t.id); closeModal(true); }}><span style=${{ width: '12px', height: '12px', borderRadius: '3px', background: themeById(t.id).base.editor, border: '1px solid var(--border-strong)' }}></span>${t.name}<span class="hint">${t.type}</span></div>`)}</div>
    </div>
  </div>`;
}

export function GoToLineDialog() {
  const cursor = store.get().editor.cursor;
  return html`<${PromptDialog} title="Go to Line:Column" label="[Line] [:column]" value=${cursor ? `${cursor.line}:${cursor.col}` : ''} ok="OK" />`;
}

const MODALS = () => ({ publishGithub: PublishGithubDialog, confirm: ConfirmDialog, prompt: PromptDialog, newProject: NewProjectDialog, clone: CloneDialog, settings: SettingsDialog, searchEverywhere: SearchEverywhere, findInFiles: FindInFiles, runConfigs: RunConfigsDialog, localHistory: LocalHistoryDialog, shortcuts: ShortcutsDialog, theme: ThemeSwitcher, goToLine: GoToLineDialog, ...extraModals });
const extraModals = {};

/** Register a modal component from another module (e.g. the theme editor). */
export function registerModal(type, component) {
  extraModals[type] = component;
}

export function ModalHost() {
  const modals = useStore((s) => s.modals);
  if (!modals.length) return null;
  const types = MODALS();
  return html`${modals.map((m, i) => {
    const C = types[m.type];
    return C ? html`<${LayerContext.Provider} key=${m.key} value=${{ key: m.key, top: i === modals.length - 1 }}><${C} ...${m.props} /><//>` : null;
  })}`;
}
