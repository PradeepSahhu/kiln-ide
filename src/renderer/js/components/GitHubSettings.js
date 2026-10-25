// Settings › Version Control: how Kiln connects to GitHub (GitHub CLI login or an access token), its
// live status and a connection test; plus the "Share Project on GitHub" dialog.
import { html, useEffect, useState } from '../lib/preact.js';
import { useStore, store } from '../lib/store.js';
import { Icon } from '../lib/icons.js';
import { invoke } from '../lib/ipc.js';
import { cls } from '../lib/util.js';
import { closeModal, toast, errorToast } from '../lib/ui.js';
import { Spinner } from './ui.js';

const MODES = [
  ['auto', 'Automatic', 'GitHub CLI login when available, otherwise the access token'],
  ['gh', 'GitHub CLI', 'Use the account you are logged in to with "gh auth login"'],
  ['token', 'Access token', 'A personal access token from an environment variable'],
  ['system', 'System credentials', 'Leave it to git (Keychain / credential manager)'],
];
const MODE_LABEL = { gh: 'the GitHub CLI login', token: 'the access token', system: 'the system git credentials', none: 'nothing (not connected)' };

export async function loginWithGh() {
  const { openTool } = await import('../services/layout.js');
  const sessions = await import('../services/sessions.js');
  if (!store.get().project) {
    toast({ title: 'Run "gh auth login" in a terminal', message: 'Open a project to use the built-in terminal, or run it in your own terminal.', timeout: 8000 });
    return;
  }
  closeModal(null);
  openTool('bottom', 'terminal');
  const id = await sessions.newTerminal();
  setTimeout(() => sessions.terminalSend(id, 'gh auth login --hostname github.com --git-protocol https --web\r'), 600);
}

export function GitHubSettings() {
  const s = useStore((st) => st.settings);
  const [st, setSt] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => invoke('git:githubStatus').then(setSt).catch(() => setSt(null));
  useEffect(() => {
    load();
  }, []);
  const gh = s.github || {};
  const set = (patch) => invoke('app:updateSettings', { github: patch }).then((next) => {
    store.set({ settings: next });
    setCheck(null);
    load();
  });
  const test = async () => {
    setBusy(true);
    setCheck(null);
    try {
      setCheck(await invoke('git:githubVerify'));
    } catch (err) {
      setCheck({ ok: false, message: err.message });
    }
    setBusy(false);
    load();
  };
  return html`<div data-testid="vcs-section">
    <h3>Version Control</h3>
    <div class="section-title" style="padding-left:0">GitHub connection</div>
    <div class="muted" style="font-size:12px;margin:-2px 0 10px;line-height:1.5">Used for clone, fetch, pull, push and publishing to GitHub. Credentials are handed to git through its environment only; Kiln never writes them to git config, remote URLs or logs.</div>
    <div class="radio-list">
      ${MODES.map(([id, label, hint]) => html`<label class=${cls('radio-row', (gh.auth || 'auto') === id && 'on')} data-testid=${`github-auth-${id}`}>
          <input type="radio" name="gh-auth" checked=${(gh.auth || 'auto') === id} onChange=${() => set({ auth: id })} />
          <span><b>${label}</b><span class="muted"> · ${hint}</span></span>
        </label>`)}
    </div>
    <div class="setting" style="margin-top:10px"><div class="lbl">Token environment variable<div class="h">Falls back to GITHUB_TOKEN, then GH_TOKEN</div></div><input class="input" style="width:200px" value=${gh.tokenVar || ''} placeholder="GITHUB_TOKEN" onChange=${(e) => set({ tokenVar: e.target.value.trim() })} /></div>
    <div class="gh-status" data-testid="github-status">
      ${!st
        ? html`<${Spinner} />`
        : html`<div class="row"><${Icon} name="git" size=${14} /><b>GitHub CLI</b><span class="spacer"></span>
              ${!st.gh.installed
                ? html`<span class="muted">Not installed · <a onClick=${() => invoke('app:openExternal', 'https://cli.github.com')}>cli.github.com</a></span>`
                : st.gh.loggedIn
                  ? html`<span class="ok">Logged in as ${st.gh.user}</span>`
                  : html`<span class="sev-warning">Not logged in</span><button class="btn small" data-testid="github-login" onClick=${loginWithGh}>Log in…</button>`}
            </div>
            ${st.gh.loggedIn && st.gh.scopes.length ? html`<div class="muted gh-scopes">Scopes: ${st.gh.scopes.join(', ')}</div>` : null}
            <div class="row"><${Icon} name="key" size=${14} /><b>Access token</b><span class="spacer"></span>
              ${st.token.found ? html`<span class="ok">Found in $${st.token.variable} (value hidden)</span>` : html`<span class="muted">$${st.token.variable} is not set</span>`}
            </div>
            <div class="row"><${Icon} name="link" size=${14} /><b>Kiln uses</b><span class="spacer"></span><span class=${st.effective === 'none' ? 'sev-warning' : ''} data-testid="github-effective">${MODE_LABEL[st.effective]}</span></div>`}
    </div>
    <div class="row" style="gap:8px;margin-top:10px">
      <button class="btn small primary" data-testid="github-test" disabled=${busy} onClick=${test}>${busy ? html`<${Spinner} size=${12} />` : html`<${Icon} name="refresh" size=${13} />`}Test connection</button>
      ${check
        ? html`<span data-testid="github-result" class=${check.ok ? 'ok' : 'sev-error'} style="font-size:12px">${check.ok ? (check.user ? `Connected as ${check.user} via ${MODE_LABEL[check.mode]}` : check.message) : check.message}${check.remote ? html` · <span class=${check.remote.ok ? 'ok' : 'sev-error'}>${check.remote.ok ? 'origin is reachable' : `origin: ${check.remote.message}`}</span>` : null}</span>`
        : null}
    </div>
  </div>`;
}
