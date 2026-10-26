// The request dialog of an endpoint (path / query / header parameters, JSON body, the app's address)
// and the Endpoints tool window listing every endpoint of the project.
import { html, useEffect, useMemo, useState } from '../lib/preact.js';
import { useStore } from '../lib/store.js';
import { Icon, FileIcon } from '../lib/icons.js';
import { invoke } from '../lib/ipc.js';
import { closeModal } from '../lib/ui.js';
import { cls, basename, relative, formatDuration } from '../lib/util.js';
import { Spinner, ToolWindow } from './ui.js';
import { Modal, registerModal } from './dialogs.js';
import * as ed from '../services/editor.js';
import { openRequest } from '../services/endpoints.js';

// What was entered per endpoint, kept while the IDE is open.
const remembered = new Map();

const pretty = (text) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

function Method({ m }) {
  return html`<span class=${cls('http-method', `m-${m.toLowerCase()}`)}>${m}</span>`;
}

function RequestDialog({ endpoint: e }) {
  const prev = remembered.get(e.id) || {};
  const [values, setValues] = useState(prev.values || {});
  const [headers, setHeaders] = useState(prev.headers || '');
  const [body, setBody] = useState(prev.body != null ? prev.body : e.body ? JSON.stringify(e.body.example, null, 2) : '');
  const [baseUrl, setBaseUrl] = useState(prev.baseUrl || '');
  const [server, setServer] = useState(null);
  const [state, setState] = useState({});
  useEffect(() => {
    invoke('endpoints:server', e).then(setServer).catch(() => setServer({}));
  }, []);
  const set = (name, v) => setValues((x) => ({ ...x, [name]: v }));
  const send = async () => {
    remembered.set(e.id, { values, headers, body, baseUrl });
    const pathValues = {};
    const query = {};
    const hdrs = {};
    for (const p of e.params) {
      const v = values[p.name];
      if (p.in === 'path') pathValues[p.name] = v;
      else if (p.in === 'query') query[p.name] = v;
      else if (p.in === 'header' && v) hdrs[p.name] = v;
    }
    for (const line of headers.split('\n')) {
      const m = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (m) hdrs[m[1]] = m[2].trim();
    }
    if (e.body && body.trim()) {
      try {
        JSON.parse(body);
      } catch (err) {
        return setState({ error: `The body is not valid JSON: ${err.message}` });
      }
    }
    setState({ sending: true, starting: !baseUrl && server && !server.server });
    try {
      const r = await invoke('endpoints:send', { endpoint: e, pathValues, query, headers: hdrs, body: e.body ? body : null, baseUrl: baseUrl.trim() });
      setState({ response: r });
      invoke('endpoints:server', e).then(setServer).catch(() => {});
    } catch (err) {
      setState({ error: err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    }
  };
  const r = state.response;
  const where = baseUrl.trim() ? baseUrl.trim() : server && server.server ? server.server.url : null;
  const params = e.params;
  return html`<${Modal} title=${html`<${Method} m=${e.method} /> <span class="mono">${e.path}</span>`} wide="x" testid="endpoint-dialog" onClose=${() => closeModal(null)}
      footer=${html`<span class="muted" style="font-size:12px" data-testid="endpoint-target">${where ? `Sends to ${where}` : server && server.config ? `The app is not running: Send starts "${server.config.name}" first` : server ? 'The app is not running; enter its address' : ''}</span><div class="spacer"></div>
        <button class="btn" onClick=${() => { closeModal(null); ed.openFile(e.file, { line: e.line }); }}>Go to Code</button>
        <button class="btn primary" data-testid="endpoint-send" disabled=${state.sending} onClick=${send}>${state.sending ? html`<${Spinner} />` : html`<${Icon} name="send" size=${13} />`}Send</button>`}>
    <div class="endpoint-req">
      <div class="col" style="gap:8px;min-width:0">
        <div class="field"><label>App address <span class="muted">(empty: the running app${server && server.server ? `, ${server.server.url}` : ''})</span></label><input class="input mono" data-testid="endpoint-base" placeholder=${server && server.server ? server.server.url : 'http://localhost:8000'} value=${baseUrl} onInput=${(ev) => setBaseUrl(ev.target.value)} /></div>
        ${params.length ? html`<div class="section-title">Parameters</div>` : null}
        ${params.map((p) => html`<div class="field endpoint-param"><label><span class="mono">${p.name}</span> <span class="badge">${p.in}</span> <span class="muted">${p.type || ''}${p.required ? ' · required' : ''}</span></label>
            <input class="input mono" data-testid=${`endpoint-param-${p.name}`} placeholder=${p.default != null ? String(p.default) : ''} value=${values[p.name] || ''} onInput=${(ev) => set(p.name, ev.target.value)} onKeyDown=${(ev) => ev.key === 'Enter' && send()} /></div>`)}
        ${e.body ? html`<div class="field"><label>Body <span class="muted">JSON${e.body.type && e.body.type !== 'json' ? ` · ${e.body.type}` : ''}</span></label><textarea class="input mono" rows="8" data-testid="endpoint-body" value=${body} onInput=${(ev) => setBody(ev.target.value)}></textarea></div>` : null}
        <div class="field"><label>Headers <span class="muted">one per line: Name: value</span></label><textarea class="input mono" rows="2" data-testid="endpoint-headers" placeholder="Authorization: Bearer …" value=${headers} onInput=${(ev) => setHeaders(ev.target.value)}></textarea></div>
      </div>
      <div class="col endpoint-res" data-testid="endpoint-response" data-status=${r ? String(r.status) : ''}>
        ${state.sending ? html`<div class="empty"><${Spinner} /> ${state.starting ? 'Starting the app, then sending…' : 'Sending…'}</div>` : null}
        ${state.error ? html`<div class="empty sev-error" data-testid="endpoint-error">${state.error}</div>` : null}
        ${r ? html`<div class="row" style="gap:8px;margin-bottom:6px">
              <span class=${cls('http-status', r.status < 300 ? 'ok' : r.status < 400 ? 'redirect' : 'fail')} data-testid="endpoint-status">${r.status} ${r.statusText}</span>
              <span class="muted" style="font-size:12px">${formatDuration(r.ms)} · ${r.size} bytes${r.started ? ` · started ${r.started}` : ''}</span>
            </div>
            <div class="muted mono ellipsis" style="font-size:11px;margin-bottom:6px" title=${r.request.url}>${r.request.method} ${r.request.url}</div>
            <details class="endpoint-headers"><summary>Response headers</summary><pre>${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre></details>
            <pre class="endpoint-body" data-testid="endpoint-response-body">${pretty(r.body)}${r.truncated ? '\n…' : ''}</pre>`
          : !state.sending && !state.error ? html`<div class="empty">Send the request to see the response.</div>` : null}
      </div>
    </div>
  <//>`;
}

registerModal('endpointRequest', RequestDialog);

export function EndpointsPanel({ onHide }) {
  const root = useStore((s) => s.project && s.project.root);
  const fsTick = useStore((s) => s.fsTick || 0);
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const load = () => invoke('endpoints:list').then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
  }, [fsTick]);
  const groups = useMemo(() => {
    const g = new Map();
    for (const e of (list || []).filter((x) => !q || `${x.method} ${x.path} ${x.handler}`.toLowerCase().includes(q.toLowerCase()))) {
      if (!g.has(e.file)) g.set(e.file, []);
      g.get(e.file).push(e);
    }
    return [...g];
  }, [list, q]);
  return html`<${ToolWindow} side="bottom" title="Endpoints" testid="endpoints-panel" onHide=${onHide}
      actions=${html`<input class="input" style="height:22px;width:200px" placeholder="Filter endpoints" value=${q} onInput=${(ev) => setQ(ev.target.value)} /><button class="icon-btn sm" title="Refresh" onClick=${load}><${Icon} name="refresh" /></button>`}>
    <div class="list">
      ${!list ? html`<div class="empty"><${Spinner} /></div>` : null}
      ${list && !list.length ? html`<div class="empty">No HTTP endpoints found (FastAPI / Flask, Express, ASP.NET Core minimal APIs and controllers).</div>` : null}
      ${groups.map(([file, items]) => html`<div>
          <div class="problem-file"><${FileIcon} name=${basename(file)} /><span>${basename(file)}</span><span class="muted" style="font-size:12px">${relative(root, file)}</span><span class="badge">${items.length}</span></div>
          ${items.map((e) => html`<div class="usage-row endpoint-row" data-testid="endpoint-row" data-method=${e.method} data-path=${e.path} onClick=${() => openRequest(e)} onDblClick=${() => ed.openFile(e.file, { line: e.line })} title="Click: send a request · Double-click: go to the code">
              <span class="ln">${e.line}</span><${Method} m=${e.method} /><span class="code">${e.path}</span><span class="kind">${e.handler || ''} · ${e.framework}</span>
            </div>`)}
        </div>`)}
    </div>
  <//>`;
}
