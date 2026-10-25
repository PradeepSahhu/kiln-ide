// Structure, TODO, Find Usages, Tests and Packages tool windows.
import { html, useEffect, useState, useMemo, useRef } from '../../lib/preact.js';
import { useStore, store } from '../../lib/store.js';
import { Icon, FileIcon, KindIcon } from '../../lib/icons.js';
import { invoke, on } from '../../lib/ipc.js';
import { cls, basename, relative, debounce, formatDuration } from '../../lib/util.js';
import { toast, errorToast, confirm } from '../../lib/ui.js';
import { ToolWindow, Spinner, VirtualList } from '../ui.js';
import * as ed from '../../services/editor.js';

// ------------------------------------------------------------ Structure

export function StructurePanel({ onHide }) {
  const path = useStore((s) => {
    const t = s.editor.tabs.find((x) => x.id === s.editor.active);
    return t && t.kind === 'file' ? t.path : null;
  });
  const cursor = useStore((s) => s.editor.cursor);
  const [syms, setSyms] = useState([]);
  const [q, setQ] = useState('');
  const load = async () => {
    if (!path) return setSyms([]);
    const d = ed.getDoc(path);
    const text = d && d.model ? d.model.getValue() : null;
    setSyms(await invoke('code:documentSymbols', path, text).catch(() => []));
  };
  useEffect(() => {
    load();
  }, [path]);
  useEffect(() => {
    const off = ed.onEditorEvent((t, d) => t === 'saved' && d.path === path && load());
    return off;
  }, [path]);
  const depthOf = (s) => (s.container ? s.container.split('.').length : 0);
  const minDepth = syms.length ? Math.min(...syms.map(depthOf)) : 0;
  const list = syms.filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()));
  const current = cursor ? [...syms].reverse().find((s) => cursor.line >= s.start && cursor.line <= s.end) : null;
  return html`<${ToolWindow} side="left" title="Structure" testid="structure-panel" onHide=${onHide}>
    <div style="padding:6px 8px"><input class="input" style="width:100%" placeholder="Filter members" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
    <div class="list">
      ${!path ? html`<div class="empty">Open a file to see its structure.</div>` : null}
      ${list.map((s) => html`<div class=${cls('list-row', current === s && 'selected')} style=${{ paddingLeft: `${10 + (depthOf(s) - minDepth) * 16}px` }} onClick=${() => ed.openFile(path, { line: s.line, col: s.col })} title=${s.signature || s.name}>
          <${KindIcon} kind=${s.kind} /><span class="ellipsis">${s.name}</span><span class="muted ellipsis" style="font-size:12px">${s.signature && s.signature !== s.name ? s.signature.replace(/^.*?(\(|:)/, '$1').slice(0, 60) : ''}</span>
        </div>`)}
      ${path && !syms.length ? html`<div class="empty">No symbols found.</div>` : null}
    </div>
  <//>`;
}

// ---------------------------------------------------------------- TODO

export function TodoPanel({ onHide }) {
  const root = useStore((s) => s.project.root);
  const [items, setItems] = useState(null);
  const load = async () => setItems(await invoke('search:todos').catch(() => []));
  useEffect(() => {
    load();
  }, []);
  const groups = useMemo(() => {
    const g = new Map();
    for (const i of items || []) {
      if (!g.has(i.file)) g.set(i.file, []);
      g.get(i.file).push(i);
    }
    return [...g];
  }, [items]);
  return html`<${ToolWindow} side="bottom" title="TODO" testid="todo-panel" onHide=${onHide} actions=${html`<button class="icon-btn sm" title="Refresh" onClick=${load}><${Icon} name="refresh" /></button>`}>
    <div class="list">
      ${!items ? html`<div class="empty"><${Spinner} /></div>` : null}
      ${items ? html`<div class="section-title">${items.length} item${items.length === 1 ? '' : 's'} in ${groups.length} file${groups.length === 1 ? '' : 's'}</div>` : null}
      ${groups.map(([file, list]) => html`<div><div class="problem-file"><${FileIcon} name=${basename(file)} /><span>${basename(file)}</span><span class="muted" style="font-size:12px">${relative(root, file)}</span></div>
          ${list.map((i) => html`<div class="usage-row" onClick=${() => ed.openFile(file, { line: i.line, col: i.col })}><span class="ln">${i.line}</span><span class=${cls('badge', i.tag === 'FIXME' || i.tag === 'BUG' ? 'err' : i.tag === 'HACK' || i.tag === 'XXX' ? 'warn' : 'accent')}>${i.tag}</span><span class="code">${i.text.replace(/^(TODO|FIXME|HACK|XXX|BUG)[:\s]*/, '')}</span></div>`)}</div>`)}
      ${items && !items.length ? html`<div class="empty">No TODO, FIXME or HACK comments.</div>` : null}
    </div>
  <//>`;
}

// ---------------------------------------------------------- Find Usages

export function UsagesPanel({ onHide }) {
  const usages = useStore((s) => s.usages);
  const root = useStore((s) => s.project.root);
  const [sel, setSel] = useState(null);
  const groups = useMemo(() => {
    const g = new Map();
    for (const r of (usages && usages.refs) || []) {
      if (!g.has(r.file)) g.set(r.file, []);
      g.get(r.file).push(r);
    }
    return [...g];
  }, [usages]);
  const counts = (usages && usages.refs) ? { total: usages.refs.length, calls: usages.refs.filter((r) => r.kind === 'call').length } : null;
  return html`<${ToolWindow} side="bottom" title=${usages && usages.name ? `Usages of ${usages.name}` : 'Find Usages'} testid="usages-panel" onHide=${onHide}
      actions=${counts ? html`<span class="muted" style="font-size:12px">${counts.total} result${counts.total === 1 ? '' : 's'}${usages.source ? ` · ${usages.source === 'lsp' ? 'language server' : 'code index'}` : ''}</span>` : null}>
    <div class="list">
      ${!usages ? html`<div class="empty">Put the caret on a symbol and press Alt+F7 (Find Usages).</div>` : null}
      ${usages && usages.loading ? html`<div class="empty"><${Spinner} /> Searching…</div>` : null}
      ${usages && usages.error ? html`<div class="empty sev-error">${usages.error}</div>` : null}
      ${groups.map(([file, refs]) => html`<div>
          <div class="problem-file"><${FileIcon} name=${basename(file)} /><span>${basename(file)}</span><span class="muted" style="font-size:12px">${relative(root, file)}</span><span class="badge">${refs.length}</span></div>
          ${refs.map((r) => html`<div class=${cls('usage-row', sel === r && 'selected')} data-testid="usage-row" onClick=${() => { setSel(r); ed.openFile(file, { line: r.line, col: r.col, endLine: r.line, endCol: r.endCol, focus: false }); }} onDblClick=${() => ed.openFile(file, { line: r.line, col: r.col })}>
              <span class="ln">${r.line}</span><span class="code">${(r.text || '').trim()}</span><span class="kind">${r.kind || ''}${r.container ? ` · ${r.container}` : ''}</span>
            </div>`)}
        </div>`)}
      ${usages && !usages.loading && usages.refs && !usages.refs.length ? html`<div class="empty">No usages found.</div>` : null}
    </div>
  <//>`;
}

// ---------------------------------------------------------------- Tests

export function TestsPanel({ onHide }) {
  const [projects, setProjects] = useState(null);
  const [tests, setTests] = useState({});
  const [results, setResults] = useState({});
  const [running, setRunning] = useState(null);
  const [output, setOutput] = useState('');
  const [sel, setSel] = useState(null);
  const outRef = useRef(null);
  useEffect(() => {
    invoke('tests:projects').then((p) => {
      setProjects(p);
      for (const x of p) discover(x.id);
    });
    return on('tests:output', ({ text }) => setOutput((o) => (o + text).slice(-200000)));
  }, []);
  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output]);
  useEffect(() => {
    const h = async (e) => {
      if (e.detail.projectId !== '*') return runTests(e.detail.projectId, e.detail.filter);
      const list = projects || (await invoke('tests:projects').catch(() => []));
      for (const p of list) await runTests(p.id);
    };
    window.addEventListener('kiln:run-tests', h);
    return () => window.removeEventListener('kiln:run-tests', h);
  }, [projects]);
  const discover = async (id) => {
    const r = await invoke('tests:discover', id).catch((err) => ({ error: err.message, tests: [] }));
    setTests((t) => ({ ...t, [id]: r }));
  };
  const runTests = async (id, filter = []) => {
    setRunning(id);
    setOutput('');
    await ed.saveAll({ quiet: true });
    try {
      const r = await invoke('tests:run', id, filter);
      const map = {};
      for (const x of r.results) map[x.id] = x;
      setResults((old) => ({ ...old, [id]: { ...(filter.length ? (old[id] || {}).map || {} : {}), ...map, map: { ...(filter.length ? ((old[id] || {}).map || {}) : {}), ...map } } }));
      const failed = r.results.filter((x) => x.outcome === 'failed').length;
      const passed = r.results.filter((x) => x.outcome === 'passed').length;
      toast({ kind: failed ? 'error' : 'success', title: failed ? `${failed} test${failed === 1 ? '' : 's'} failed` : `${passed} test${passed === 1 ? '' : 's'} passed`, timeout: 4000 });
    } catch (err) {
      errorToast('Test run failed', err);
    }
    setRunning(null);
  };
  const resultFor = (pid, t) => {
    const r = results[pid] && results[pid].map;
    if (!r) return null;
    return r[t.id] || Object.values(r).find((x) => x.name === t.name || t.id.endsWith(x.name) || (x.className && t.id === `${x.className}.${x.method}`));
  };
  return html`<${ToolWindow} side="bottom" title="Tests" testid="tests-panel" onHide=${onHide}
      actions=${html`<button class="btn small" disabled=${!!running || !projects || !projects.length} onClick=${async () => { for (const p of projects) await runTests(p.id); }}><${Icon} name="play" size=${12} className="ok" />Run All</button>`}>
    <div class="build-panel">
      <div class="build-steps" style="width:420px">
        ${!projects ? html`<div class="empty"><${Spinner} /></div>` : null}
        ${projects && !projects.length ? html`<div class="empty">No test projects found (xUnit/NUnit/MSTest projects or pytest tests).</div>` : null}
        ${(projects || []).map((p) => {
          const t = tests[p.id];
          const list = (t && t.tests) || [];
          const res = Object.values((results[p.id] && results[p.id].map) || {});
          const failed = res.filter((x) => x.outcome === 'failed').length;
          return html`<div>
            <div class="build-step" onClick=${() => setSel(null)}>
              ${running === p.id ? html`<${Spinner} size=${14} />` : res.length ? html`<${Icon} name=${failed ? 'error' : 'success'} size=${14} className=${failed ? 'sev-error' : 'ok'} />` : html`<${Icon} name="test" size=${14} className="muted" />`}
              <span class="title" style="font-weight:600">${p.name}</span><span class="detail">${p.kind === 'dotnet' ? '.NET' : 'pytest'} · ${list.length} tests</span>
              <span class="time"><button class="icon-btn sm" title="Run" disabled=${!!running} onClick=${(e) => { e.stopPropagation(); runTests(p.id); }}><${Icon} name="play" size=${13} className="ok" /></button><button class="icon-btn sm" title="Rediscover" onClick=${(e) => { e.stopPropagation(); discover(p.id); }}><${Icon} name="refresh" size=${13} /></button></span>
            </div>
            ${t && t.error ? html`<div class="empty sev-warning" style="font-size:12px;text-align:left">${t.error}</div>` : null}
            ${list.map((x) => {
              const r = resultFor(p.id, x);
              return html`<div class=${cls('test-row', sel === x.id && 'selected')} style="padding-left:30px" onClick=${() => setSel(x.id)} onDblClick=${() => runTests(p.id, [x.id])} title=${x.id}>
                <${Icon} name=${!r ? 'dot' : r.outcome === 'passed' ? 'success' : r.outcome === 'failed' ? 'error' : 'minus'} size=${r ? 13 : 9} className=${!r ? 'dim' : r.outcome === 'passed' ? 'ok' : r.outcome === 'failed' ? 'sev-error' : 'dim'} />
                <span class="ellipsis">${x.name}</span>${r && r.durationMs != null ? html`<span class="dur">${formatDuration(r.durationMs)}</span>` : null}
              </div>`;
            })}
          </div>`;
        })}
      </div>
      <div class="text-output" ref=${outRef}>${(() => {
        if (sel) {
          for (const p of projects || []) {
            const t = ((tests[p.id] && tests[p.id].tests) || []).find((x) => x.id === sel);
            const r = t && resultFor(p.id, t);
            if (r) return `${r.outcome.toUpperCase()}  ${r.id}\n\n${r.message || ''}\n${r.stack || ''}\n${r.output || ''}`;
          }
        }
        return output.replace(/\x1b\[[0-9;]*m/g, '') || 'Test output appears here.';
      })()}</div>
    </div>
  <//>`;
}

// ------------------------------------------------------------- Packages

export function PackagesPanel({ onHide }) {
  const project = useStore((s) => s.project);
  const det = project.detection;
  const [tab, setTab] = useState(det.dotnet ? 'nuget' : 'python');
  return html`<${ToolWindow} side="bottom" title="Packages" testid="packages-panel" onHide=${onHide}
      tabs=${html`${det.dotnet ? html`<button class=${cls('tw-tab', tab === 'nuget' && 'active')} onClick=${() => setTab('nuget')}>NuGet</button>` : null}${det.python ? html`<button class=${cls('tw-tab', tab === 'python' && 'active')} onClick=${() => setTab('python')}>Python</button>` : null}`}>
    ${tab === 'nuget' && det.dotnet ? html`<${NuGet} projects=${det.dotnet.projects} />` : tab === 'python' && det.python ? html`<${PyPackages} roots=${det.python.roots} />` : html`<div class="empty">No .NET or Python projects detected.</div>`}
  <//>`;
}

function NuGet({ projects }) {
  const [proj, setProj] = useState(projects[0] && projects[0].path);
  const [installed, setInstalled] = useState(null);
  const [outdated, setOutdated] = useState({});
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = async () => {
    setInstalled(null);
    const r = await invoke('pkg:nugetInstalled', proj).catch((err) => ({ packages: [], warning: err.message }));
    setInstalled(r);
    invoke('pkg:nugetOutdated', proj).then(setOutdated).catch(() => {});
  };
  useEffect(() => {
    if (proj) load();
  }, [proj]);
  const search = debounce(async (text) => setFound(text ? await invoke('pkg:nugetSearch', text).catch(() => []) : null), 300);
  const add = async (id, version) => {
    setBusy(id);
    try {
      await invoke('pkg:nugetAdd', proj, id, version);
      toast({ kind: 'success', title: `Added ${id}${version ? ` ${version}` : ''}` });
      load();
    } catch (err) {
      errorToast(`Could not add ${id}`, err);
    }
    setBusy(null);
  };
  return html`<div class="build-panel">
    <div class="build-steps" style="width:50%">
      <div class="tw-toolbar"><select class="input" style="height:24px" value=${proj} onChange=${(e) => setProj(e.target.value)}>${projects.map((p) => html`<option value=${p.path}>${p.name}</option>`)}</select><div class="spacer"></div><button class="icon-btn sm" onClick=${load}><${Icon} name="refresh" /></button></div>
      ${!installed ? html`<div class="empty"><${Spinner} /></div>` : null}
      ${installed && installed.packages.map((p) => html`<div class="pkg-row"><${Icon} name="package" className="muted" /><div class="grow"><span class="nm">${p.id}</span> <span class="ver">${p.resolved || p.requested}</span>${outdated[p.id] ? html` <span class="badge warn">${outdated[p.id]} available</span>` : null}</div>
          ${outdated[p.id] ? html`<button class="btn small" disabled=${busy === p.id} onClick=${() => add(p.id, outdated[p.id])}>Update</button>` : null}
          <button class="icon-btn sm" title="Remove" onClick=${async () => { if (await confirm({ title: 'Remove package', message: `Remove ${p.id} from the project?`, ok: 'Remove', danger: true })) { await invoke('pkg:nugetRemove', proj, p.id).catch((err) => errorToast('Remove failed', err)); load(); } }}><${Icon} name="trash" /></button></div>`)}
      ${installed && !installed.packages.length ? html`<div class="empty">No package references.</div>` : null}
    </div>
    <div class="col grow">
      <div class="tw-toolbar"><input class="input" style="height:24px;width:100%" placeholder="Search nuget.org" value=${q} onInput=${(e) => { setQ(e.target.value); search(e.target.value); }} /></div>
      <div class="list">${(found || []).map((p) => html`<div class="pkg-row"><div class="grow" style="min-width:0"><div><span class="nm">${p.id}</span> <span class="ver">${p.version}</span>${p.verified ? html` <span class="badge ok">verified</span>` : null}</div><div class="desc">${p.description}</div></div><button class="btn small primary" disabled=${busy === p.id} onClick=${() => add(p.id)}>${busy === p.id ? html`<${Spinner} />` : 'Add'}</button></div>`)}
        ${!found ? html`<div class="empty">Search NuGet to add packages to the selected project.</div>` : null}
      </div>
    </div>
  </div>`;
}

function PyPackages({ roots }) {
  const [dir, setDir] = useState(roots[0] && roots[0].dir);
  const [data, setData] = useState(null);
  const [outdated, setOutdated] = useState({});
  const [spec, setSpec] = useState('');
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setData(null);
    setData(await invoke('pkg:pyInstalled', dir).catch((err) => ({ packages: [], error: err.message })));
    invoke('pkg:pyOutdated', dir).then(setOutdated).catch(() => {});
  };
  useEffect(() => {
    if (dir) load();
  }, [dir]);
  const lookup = debounce(async (name) => setInfo(name && /^[\w.-]+$/.test(name) ? await invoke('pkg:pyInfo', name).catch(() => null) : null), 400);
  const install = async (s) => {
    setBusy(true);
    try {
      await invoke('pkg:pyInstall', dir, s, { addToRequirements: true });
      toast({ kind: 'success', title: `Installed ${s}` });
      setSpec('');
      setInfo(null);
      load();
    } catch (err) {
      errorToast(`Could not install ${s}`, err);
    }
    setBusy(false);
  };
  return html`<div class="build-panel">
    <div class="build-steps" style="width:50%">
      <div class="tw-toolbar"><select class="input" style="height:24px" value=${dir} onChange=${(e) => setDir(e.target.value)}>${roots.map((r) => html`<option value=${r.dir}>${r.name}</option>`)}</select><span class="muted ellipsis" style="font-size:11px;margin-left:6px">${data && data.interpreter ? data.interpreter.python : ''}</span><div class="spacer"></div><button class="icon-btn sm" onClick=${load}><${Icon} name="refresh" /></button></div>
      ${!data ? html`<div class="empty"><${Spinner} /></div>` : null}
      ${data && data.error ? html`<div class="empty sev-warning">${data.error}</div>` : null}
      ${data && data.packages.map((p) => html`<div class="pkg-row"><${Icon} name="package" className="muted" /><div class="grow"><span class="nm">${p.name}</span> <span class="ver">${p.version}</span>${outdated[p.name] ? html` <span class="badge warn">${outdated[p.name]} available</span>` : null}</div>
          ${outdated[p.name] ? html`<button class="btn small" onClick=${() => install(`${p.name}==${outdated[p.name]}`)}>Update</button>` : null}
          <button class="icon-btn sm" title="Uninstall" onClick=${async () => { if (await confirm({ title: 'Uninstall', message: `Uninstall ${p.name}?`, ok: 'Uninstall', danger: true })) { await invoke('pkg:pyUninstall', dir, p.name).catch((err) => errorToast('Uninstall failed', err)); load(); } }}><${Icon} name="trash" /></button></div>`)}
    </div>
    <div class="col grow" style="padding:10px 12px">
      <div class="row"><input class="input grow" placeholder="Package (for example: httpx or httpx==0.27)" value=${spec} onInput=${(e) => { setSpec(e.target.value); lookup(e.target.value.split(/[=<>!~ ]/)[0]); }} onKeyDown=${(e) => e.key === 'Enter' && spec && install(spec)} /><button class="btn primary" disabled=${!spec || busy} onClick=${() => install(spec)}>${busy ? html`<${Spinner} />` : 'Install'}</button></div>
      ${info ? html`<div style="margin-top:12px"><div class="nm" style="font-weight:600">${info.name} <span class="muted">${info.version}</span></div><div class="muted" style="margin:4px 0">${info.summary}</div>${info.requiresPython ? html`<div class="muted" style="font-size:12px">Requires Python ${info.requiresPython}</div>` : null}</div>` : html`<div class="empty" style="text-align:left;padding:12px 0">Installs into the project's virtual environment and adds the package to requirements.txt.</div>`}
    </div>
  </div>`;
}
