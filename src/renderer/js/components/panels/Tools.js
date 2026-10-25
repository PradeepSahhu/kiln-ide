// Structure, TODO, Find Usages, Tests and Packages tool windows.
import { html, useEffect, useState, useMemo, useRef } from '../../lib/preact.js';
import { useStore, store } from '../../lib/store.js';
import { Icon, FileIcon, KindIcon } from '../../lib/icons.js';
import { invoke, on } from '../../lib/ipc.js';
import { cls, basename, relative, debounce, formatDuration } from '../../lib/util.js';
import { toast, errorToast, confirm, showContextMenu } from '../../lib/ui.js';
import { ToolWindow, Spinner, VirtualList } from '../ui.js';
import * as ed from '../../services/editor.js';
import * as tests from '../../services/tests.js';
import { explainException } from '../../services/ai.js';

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

const OUTCOME_ICON = { passed: ['success', 'ok'], failed: ['error', 'sev-error'], skipped: ['minus', 'dim'] };
const FRAMEWORK = { dotnet: '.NET', python: 'pytest', jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', node: 'node:test' };

function TestRow({ p, x, selected, onSelect, busy }) {
  const r = tests.resultFor(p.id, x);
  const [icon, tone] = r ? OUTCOME_ICON[r.outcome] || ['minus', 'dim'] : ['dot', 'dim'];
  const open = () => x.file && ed.openFile(x.file, { line: x.line || 1 });
  const menu = (e) => showContextMenu(e, [
    { label: `Run '${x.name}'`, icon: 'play', disabled: busy, run: () => tests.runTests(p.id, { filter: [x.id] }) },
    { label: `Debug '${x.name}'`, icon: 'debug', run: () => tests.debugTest(p.id, x.id, x.name) },
    { label: `Run '${x.name}' with Coverage`, icon: 'coverage', disabled: busy, run: () => tests.runTests(p.id, { filter: [x.id], coverage: true }) },
    x.file ? { separator: true } : null,
    x.file ? { label: 'Jump to Source', icon: 'file', run: open } : null,
  ]);
  return html`<div class=${cls('test-row', selected && 'selected')} style="padding-left:30px" data-testid="test-row" data-name=${x.name} data-outcome=${r ? r.outcome : ''} onClick=${onSelect} onDblClick=${open} onContextMenu=${menu} title=${x.id}>
    <${Icon} name=${icon} size=${r ? 13 : 9} className=${tone} />
    <span class="ellipsis">${x.name}</span>${r && r.durationMs != null ? html`<span class="dur">${formatDuration(r.durationMs)}</span>` : html`<span class="dur"></span>`}
    <span class="row-actions"><button class="icon-btn sm" title="Run" data-testid="test-run" disabled=${busy} onClick=${(e) => { e.stopPropagation(); tests.runTests(p.id, { filter: [x.id] }); }}><${Icon} name="play" size=${12} className="ok" /></button><button class="icon-btn sm" title="Debug" data-testid="test-debug" onClick=${(e) => { e.stopPropagation(); tests.debugTest(p.id, x.id, x.name); }}><${Icon} name="debug" size=${12} /></button></span>
  </div>`;
}

function CoverageView({ coverage, root }) {
  if (!coverage) return html`<div class="empty">Run tests with coverage (the shield button) to see which lines they run.</div>`;
  const files = Object.entries(coverage.files).filter(([f]) => !root || f.startsWith(`${root}/`)).sort((a, b) => a[1].percent - b[1].percent || a[0].localeCompare(b[0]));
  const bar = (pct) => html`<span class="cov-bar"><span style=${{ width: `${pct}%` }}></span></span>`;
  return html`<div class="list" data-testid="coverage-view">
    <div class="section-title" data-testid="coverage-summary" data-percent=${coverage.summary.percent}>${coverage.summary.percent}% of ${coverage.summary.lines} lines covered in ${files.length} file${files.length === 1 ? '' : 's'}</div>
    ${files.map(([f, c]) => html`<div class="list-row cov-row" data-testid="coverage-row" data-path=${f} data-percent=${c.percent} onClick=${() => ed.openFile(f, { line: c.uncovered[0] || 1 })} title=${`${c.covered.length} of ${c.covered.length + c.uncovered.length} lines covered`}>
        <${FileIcon} name=${basename(f)} /><span class="ellipsis">${relative(root, f)}</span><div class="spacer"></div>${bar(c.percent)}<span class="cov-pct">${c.percent}%</span>
      </div>`)}
  </div>`;
}

export function TestsPanel({ onHide }) {
  const t = useStore((s) => s.tests || {});
  const root = useStore((s) => s.project && s.project.root);
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState('results');
  const outRef = useRef(null);
  const { projects, discovered = {}, running, output = '', coverage, showCoverage } = t;
  useEffect(() => {
    tests.loadProjects({ discoverTests: true });
  }, []);
  useEffect(() => {
    if (outRef.current && !sel) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output]);
  const failed = Object.values(tests.failedIds()).reduce((n, ids) => n + ids.length, 0);
  const selected = (() => {
    for (const p of projects || []) {
      const x = ((discovered[p.id] && discovered[p.id].tests) || []).find((y) => y.id === sel);
      if (x) return { p, x, r: tests.resultFor(p.id, x) };
    }
    return null;
  })();
  const none = !projects || !projects.length;
  return html`<${ToolWindow} side="bottom" title="Tests" testid="tests-panel" onHide=${onHide}
      tabs=${html`<button class=${cls('tw-tab', tab === 'results' && 'active')} onClick=${() => setTab('results')}>Results</button><button class=${cls('tw-tab', tab === 'coverage' && 'active')} data-testid="tests-coverage-tab" onClick=${() => setTab('coverage')}>Coverage${coverage ? html`<span class="badge">${coverage.summary.percent}%</span>` : null}</button>`}
      actions=${html`<button class="btn small" data-testid="tests-run-all" disabled=${!!running || none} onClick=${() => tests.runAll()}><${Icon} name="play" size=${12} className="ok" />Run All</button>
        <button class="icon-btn sm" title="Run All with Coverage" data-testid="tests-run-coverage" disabled=${!!running || none} onClick=${() => { setTab('coverage'); tests.runAll({ coverage: true }); }}><${Icon} name="coverage" /></button>
        <button class="icon-btn sm" title=${failed ? `Rerun ${failed} Failed Test${failed === 1 ? '' : 's'}` : 'Rerun Failed Tests'} data-testid="tests-rerun-failed" disabled=${!!running || !failed} onClick=${() => tests.rerunFailed()}><${Icon} name="refresh" className=${failed ? 'sev-error' : ''} /></button>
        <button class="icon-btn sm" title="Stop" disabled=${!running} onClick=${() => tests.cancel()}><${Icon} name="stop" className=${running ? 'sev-error' : ''} /></button>
        ${coverage ? html`<button class=${cls('icon-btn sm', showCoverage && 'active')} title=${showCoverage ? 'Hide Coverage in the Editor' : 'Show Coverage in the Editor'} data-testid="tests-toggle-coverage" onClick=${() => tests.toggleCoverage()}><${Icon} name="eye" /></button>` : null}`}>
    <div class="build-panel" data-running=${running ? 'true' : 'false'}>
      <div class="build-steps" style="width:440px">
        ${!projects ? html`<div class="empty"><${Spinner} /></div>` : null}
        ${projects && !projects.length ? html`<div class="empty">No test projects found (xUnit / NUnit / MSTest projects, pytest tests, or JavaScript tests with node:test, Jest, Vitest or Mocha).</div>` : null}
        ${(projects || []).map((p) => {
          const d = discovered[p.id];
          const list = (d && d.tests) || [];
          const res = Object.values(t.results[p.id] || {});
          const nFailed = res.filter((x) => x.outcome === 'failed').length;
          return html`<div data-testid="test-project" data-kind=${p.kind}>
            <div class="build-step" onClick=${() => setSel(null)}>
              ${running === p.id ? html`<${Spinner} size=${14} />` : res.length ? html`<${Icon} name=${nFailed ? 'error' : 'success'} size=${14} className=${nFailed ? 'sev-error' : 'ok'} />` : html`<${Icon} name="test" size=${14} className="muted" />`}
              <span class="title" style="font-weight:600">${p.name}</span><span class="detail">${FRAMEWORK[p.framework || p.kind] || p.kind} · ${d ? `${list.length} tests` : 'finding tests…'}${res.length ? ` · ${res.length - nFailed}/${res.length} passed` : ''}</span>
              <span class="time"><button class="icon-btn sm" title="Run" disabled=${!!running} onClick=${(e) => { e.stopPropagation(); tests.runTests(p.id); }}><${Icon} name="play" size=${13} className="ok" /></button><button class="icon-btn sm" title="Run with Coverage" disabled=${!!running} onClick=${(e) => { e.stopPropagation(); setTab('coverage'); tests.runTests(p.id, { coverage: true }); }}><${Icon} name="coverage" size=${13} /></button><button class="icon-btn sm" title="Find Tests Again" onClick=${(e) => { e.stopPropagation(); tests.discover(p.id); }}><${Icon} name="refresh" size=${13} /></button></span>
            </div>
            ${d && d.error ? html`<div class="empty sev-warning" style="font-size:12px;text-align:left">${d.error}</div>` : null}
            ${list.map((x) => html`<${TestRow} key=${x.id} p=${p} x=${x} busy=${!!running} selected=${sel === x.id} onSelect=${() => setSel(x.id)} />`)}
          </div>`;
        })}
      </div>
      ${tab === 'coverage'
        ? html`<div class="col grow" style="min-width:0"><${CoverageView} coverage=${coverage} root=${root} /></div>`
        : selected && selected.r && selected.r.outcome === 'failed'
          ? html`<div class="col grow" style="min-width:0"><div class="tw-toolbar"><span class="sev-error" style="font-size:12px">${selected.x.name} failed</span><div class="spacer"></div><button class="btn small" data-testid="test-explain" onClick=${() => explainException(`${selected.r.message || ''}\n${selected.r.stack || ''}`)}><${Icon} name="claude" size=${12} />Explain with Claude</button></div><div class="text-output" data-testid="tests-output">${`${selected.r.outcome.toUpperCase()}  ${selected.r.id}\n\n${selected.r.message || ''}\n${selected.r.stack || ''}\n${selected.r.output || ''}`}</div></div>`
          : html`<div class="text-output" ref=${outRef} data-testid="tests-output">${selected && selected.r ? `${selected.r.outcome.toUpperCase()}  ${selected.r.id}\n\n${selected.r.message || ''}\n${selected.r.stack || ''}\n${selected.r.output || ''}` : output.replace(/\x1b\[[0-9;]*m/g, '') || 'Test output appears here.'}</div>`}
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
