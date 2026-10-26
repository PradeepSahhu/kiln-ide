// IDE frame: toolbar, tool window stripes, left/right/bottom tool windows with splitters, the editor
// area, status bar and the overlay hosts (modals, popups, context menu, toasts).
import { html } from '../lib/preact.js';
import { useStore, store } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { cls } from '../lib/util.js';
import { TOOL_WINDOWS, toggleTool } from '../services/layout.js';
import { Splitter, Toasts, ContextMenu, PopupHost } from './ui.js';
import { ModalHost } from './dialogs.js';
import { Welcome } from './Welcome.js';
import { Toolbar } from './Toolbar.js';
import { Explorer } from './Explorer.js';
import { EditorArea } from './EditorArea.js';
import { StatusBar } from './StatusBar.js';
import { BuildPanel, ProblemsPanel } from './panels/Build.js';
import { TerminalPanel, RunPanel, AgentsPanel } from './panels/Console.js';
import { CommitPanel, GitPanel } from './panels/Git.js';
import { ClaudePanel } from './panels/Claude.js';
import { SkillsPanel } from './panels/Skills.js';
import { ArtifactsPanel } from './panels/Artifacts.js';
import { DebugPanel } from './panels/Debug.js';
import { StructurePanel, TodoPanel, UsagesPanel, TestsPanel, PackagesPanel } from './panels/Tools.js';
import { EndpointsPanel } from './EndpointsView.js';

const PANELS = {
  project: Explorer,
  commit: CommitPanel,
  structure: StructurePanel,
  build: BuildPanel,
  problems: ProblemsPanel,
  terminal: TerminalPanel,
  run: RunPanel,
  debug: DebugPanel,
  git: GitPanel,
  tests: TestsPanel,
  usages: UsagesPanel,
  todo: TodoPanel,
  packages: PackagesPanel,
  endpoints: EndpointsPanel,
  claude: ClaudePanel,
  agents: AgentsPanel,
  skills: SkillsPanel,
  artifacts: ArtifactsPanel,
};

// Rider's new UI: the left stripe holds the left tool windows at the top and the bottom tool
// windows at the bottom; the right stripe holds the AI tool windows.
function Stripe({ side, top, bottom }) {
  const layout = useStore((s) => s.layout);
  const problems = useStore((s) => s.build.errors);
  const debugging = useStore((s) => !!(s.debug && s.debug.state && s.debug.state !== 'terminated'));
  const group = (g) => html`<div class="group">
    ${TOOL_WINDOWS[g].map(
      (t) => html`<button class=${cls('stripe-btn', layout[g] === t.id && 'active')} title=${t.title} data-testid=${`stripe-${t.id}`} onClick=${() => toggleTool(g, t.id)}>
        <${Icon} name=${t.icon} />${(t.id === 'problems' && problems) || (t.id === 'debug' && debugging) ? html`<span class=${cls('dot', t.id === 'problems' && 'err')}></span>` : null}
      </button>`,
    )}
  </div>`;
  return html`<div class=${cls('stripe', side)}>${group(top)}${bottom ? html`<div style="flex:1"></div>${group(bottom)}` : null}</div>`;
}

function Pane({ side, id }) {
  const P = PANELS[id];
  if (!P) return null;
  // Keep each tool window mounted by id so terminals and chats keep their state while visible.
  return html`<${P} key=${id} onHide=${() => store.update('layout', { [side]: null })} />`;
}

function resize(key, delta, min, max, invert = false) {
  const cur = store.get().layout[key];
  store.update('layout', { [key]: Math.max(min, Math.min(max, cur + (invert ? -delta : delta))) });
}

function Frame() {
  const layout = useStore((s) => s.layout);
  const zen = layout.zen;
  return html`<div class=${cls('ide', zen && 'zen')} data-testid="ide">
    <${Toolbar} />
    <div class="frame">
      ${zen ? null : html`<${Stripe} side="left" top="left" bottom="bottom" />`}
      ${!zen && layout.left
        ? html`<div class="tool-window left" style=${{ width: `${layout.leftWidth}px` }}><${Pane} side="left" id=${layout.left} /></div>
            <${Splitter} dir="v" onResize=${(d) => resize('leftWidth', d, 180, 900)} />`
        : null}
      <div class="center">
        <div class="workspace"><${EditorArea} /></div>
        ${!zen && layout.bottom
          ? html`<${Splitter} dir="h" onResize=${(d) => resize('bottomHeight', d, 100, window.innerHeight - 200, true)} />
              <div class="tool-window bottom" style=${{ height: `${layout.bottomHeight}px` }}><${Pane} side="bottom" id=${layout.bottom} /></div>`
          : null}
      </div>
      ${!zen && layout.right
        ? html`<${Splitter} dir="v" onResize=${(d) => resize('rightWidth', d, 280, 1100, true)} />
            <div class="tool-window right" style=${{ width: `${layout.rightWidth}px` }}><${Pane} side="right" id=${layout.right} /></div>`
        : null}
      ${zen ? null : html`<${Stripe} side="right" top="right" />`}
    </div>
    <${StatusBar} />
  </div>`;
}

/** Without a project: the Welcome screen, with the Artifacts library docked on the right on demand. */
function WelcomeShell() {
  const right = useStore((s) => s.layout.right);
  const width = useStore((s) => s.layout.rightWidth);
  const showKb = right === 'artifacts';
  return html`<div style="display:flex;height:100%">
    <div style="flex:1;min-width:0"><${Welcome} /></div>
    ${showKb
      ? html`<${Splitter} dir="v" onResize=${(d) => resize('rightWidth', d, 280, 1100, true)} />
          <div class="tool-window right" style=${{ width: `${width}px` }}><${ArtifactsPanel} onHide=${() => store.update('layout', { right: null })} /></div>`
      : null}
  </div>`;
}

export function App() {
  const ready = useStore((s) => s.ready);
  const hasProject = useStore((s) => !!s.project);
  if (!ready) return html`<div class="boot">Kiln IDE</div>`;
  return html`${hasProject ? html`<${Frame} />` : html`<${WelcomeShell} />`}
    <${ModalHost} /><${PopupHost} /><${ContextMenu} /><${Toasts} />`;
}
