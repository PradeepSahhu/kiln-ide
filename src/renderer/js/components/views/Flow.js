// Message flow diagram: services -> Kafka topics -> consuming services -> databases, from static analysis,
// with an optional live connection to the broker for message counts, lag, peeking and test messages.
import { html, useEffect, useMemo, useRef, useState } from '../../lib/preact.js';
import { useStore, store } from '../../lib/store.js';
import { Icon } from '../../lib/icons.js';
import { invoke } from '../../lib/ipc.js';
import { cls, timeAgo, escapeHtml } from '../../lib/util.js';
import { toast, errorToast } from '../../lib/ui.js';
import * as ed from '../../services/editor.js';
import { register } from '../../lib/commands.js';
import { Spinner } from '../ui.js';

const SIZE = { service: [196, 54], topic: [178, 40], db: [158, 58] };

function layout(flow) {
  const nodes = [
    ...flow.services.map((s) => ({ id: s.id, type: 'service', label: s.name, sub: s.lang === 'dotnet' ? '.NET service' : s.lang === 'python' ? 'Python service' : 'Node service', data: s })),
    ...flow.topics.map((t) => ({ id: t.id, type: 'topic', label: t.name, sub: t.resolved ? (t.via && t.via.length ? `from ${t.via[0]}` : 'Kafka topic') : 'unresolved name', data: t })),
    ...flow.databases.map((d) => ({ id: d.id, type: 'db', label: d.name, sub: d.type, data: d })),
  ];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = flow.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of edges) {
      const r = rank.get(e.from) + 1;
      if (r > rank.get(e.to) && r < nodes.length) {
        rank.set(e.to, r);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Databases go in the last column of their writers.
  const cols = new Map();
  for (const n of nodes) {
    const r = rank.get(n.id);
    if (!cols.has(r)) cols.set(r, []);
    cols.get(r).push(n);
  }
  const order = [...cols.keys()].sort((a, b) => a - b);
  const preds = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) preds.get(e.to).push(e.from);
  const pos = new Map();
  order.forEach((r, ci) => {
    const list = cols.get(r);
    if (ci > 0) list.sort((a, b) => bary(a) - bary(b));
    list.forEach((n, i) => pos.set(n.id, i));
  });
  function bary(n) {
    const p = preds.get(n.id).map((id) => pos.get(id)).filter((x) => x != null);
    return p.length ? p.reduce((s, x) => s + x, 0) / p.length : 0;
  }
  const colGap = 270;
  const rowGap = 92;
  const maxRows = Math.max(...order.map((r) => cols.get(r).length), 1);
  order.forEach((r, ci) => {
    const list = cols.get(r);
    const offset = ((maxRows - list.length) * rowGap) / 2;
    list.forEach((n, i) => {
      const [w, h] = SIZE[n.type];
      n.w = w;
      n.h = h;
      n.x = 40 + ci * colGap;
      n.y = 40 + offset + i * rowGap;
    });
  });
  return { nodes, edges, byId, width: 80 + order.length * colGap, height: 80 + maxRows * rowGap };
}

function edgePath(a, b) {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  if (x2 > x1) {
    const dx = Math.max(40, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }
  const yb = Math.max(a.y + a.h, b.y + b.h) + 40;
  return `M${x1},${y1} C${x1 + 80},${yb} ${x2 - 80},${yb} ${x2},${y2}`;
}

function NodeShape({ n, live, dim, selected }) {
  const fill = n.type === 'service' ? 'var(--bg-elevated)' : n.type === 'topic' ? 'var(--accent-soft)' : 'color-mix(in srgb, var(--warning) 14%, var(--bg-elevated))';
  const stroke = selected ? 'var(--accent)' : n.type === 'service' ? 'var(--border-strong)' : n.type === 'topic' ? 'var(--accent)' : 'var(--warning)';
  const icon = n.type === 'service' ? '⚙' : n.type === 'topic' ? '≋' : '⛁';
  let sub = n.sub;
  if (live && n.type === 'topic' && live.topics) {
    const t = live.topics.find((x) => x.name === n.label);
    sub = t ? `${t.messages.toLocaleString()} msgs · ${t.partitions} part.` : 'not on broker';
  }
  return html`<g class=${cls('flow-node', dim && 'dim')} transform=${`translate(${n.x},${n.y})`} data-testid="flow-node" data-type=${n.type} data-label=${n.label}>
    ${n.type === 'topic'
      ? html`<rect width=${n.w} height=${n.h} rx=${n.h / 2} fill=${fill} stroke=${stroke} stroke-width=${selected ? 2 : 1.2} />`
      : n.type === 'db'
        ? html`<path d=${`M0,10 C0,-3 ${n.w},-3 ${n.w},10 L${n.w},${n.h - 10} C${n.w},${n.h + 3} 0,${n.h + 3} 0,${n.h - 10} Z`} fill=${fill} stroke=${stroke} stroke-width=${selected ? 2 : 1.2} /><path d=${`M0,10 C0,23 ${n.w},23 ${n.w},10`} fill="none" stroke=${stroke} stroke-width="1" />`
        : html`<rect width=${n.w} height=${n.h} rx="8" fill=${fill} stroke=${stroke} stroke-width=${selected ? 2 : 1.2} />`}
    <text x="14" y=${n.type === 'db' ? 30 : n.h / 2 - 3} font-size="13" font-weight="600">${icon} ${n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label}</text>
    <text class="sub" x="14" y=${n.type === 'db' ? 46 : n.h / 2 + 12}>${sub}</text>
  </g>`;
}

export function MessageFlowView() {
  const [flow, setFlow] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(null);
  const [hover, setHover] = useState(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [live, setLive] = useState(null);
  const [brokers, setBrokers] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [peek, setPeek] = useState(null);
  const drag = useRef(null);
  const svgRef = useRef(null);
  const load = async () => {
    setLoading(true);
    try {
      const f = await invoke('flow:analyze');
      setFlow(f);
      if (!brokers && f.brokers.length) setBrokers(f.brokers.join(','));
    } catch (err) {
      setFlow({ services: [], topics: [], databases: [], edges: [], brokers: [], error: err.message });
    }
    setLoading(false);
  };
  useEffect(() => {
    load();
    register('flow.refresh', 'Refresh Message Flow', load, { hidden: true });
  }, []);
  const L = useMemo(() => (flow ? layout(flow) : null), [flow]);
  const connect = async () => {
    setConnecting(true);
    try {
      await invoke('kafka:connect', { brokers });
      setLive(await invoke('kafka:overview'));
      toast({ kind: 'success', title: 'Connected to Kafka', message: brokers, timeout: 2500 });
    } catch (err) {
      errorToast('Could not connect to Kafka', err);
      setLive(null);
    }
    setConnecting(false);
  };
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => invoke('kafka:overview').then(setLive).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [!!live]);
  const focusId = sel || hover;
  const near = new Set();
  if (L && focusId) {
    near.add(focusId);
    for (const e of L.edges) {
      if (e.from === focusId) near.add(e.to);
      if (e.to === focusId) near.add(e.from);
    }
  }
  const selNode = L && sel ? L.byId.get(sel) : null;
  const selEdges = L && sel ? L.edges.filter((e) => e.from === sel || e.to === sel) : [];
  const wheel = (e) => {
    e.preventDefault();
    const rect = svgRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((v) => {
      const k = Math.max(0.25, Math.min(3, v.k * Math.exp(-e.deltaY * 0.0015)));
      return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k };
    });
  };
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [svgRef.current]);
  const topicLag = (name) => (live && live.groups ? live.groups.filter((g) => g.lag[name] != null).map((g) => `${g.groupId}: lag ${g.lag[name]}`) : []);
  return html`<div class="graph-view" data-testid="message-flow">
    <div class="graph-canvas">
      <div class="graph-toolbar">
        <span class="badge accent">Message flow</span>
        <span class="muted" style="font-size:12px">${flow ? `${flow.services.length} services · ${flow.topics.length} topics · ${flow.databases.length} databases · scanned ${flow.scanned} files in ${flow.ms} ms` : ''}</span>
        <div class="spacer"></div>
        <input class="input" style="width:200px" placeholder="Bootstrap servers" value=${brokers} onInput=${(e) => setBrokers(e.target.value)} />
        <button class="btn small" style="background:var(--bg-elevated)" disabled=${connecting || !brokers} onClick=${connect}>${connecting ? html`<${Spinner} />` : html`<${Icon} name="link" size=${13} />`}${live ? 'Refresh live' : 'Connect live'}</button>
        <button class="icon-btn" style="background:var(--bg-elevated)" title="Re-scan code" onClick=${load}>${loading ? html`<${Spinner} />` : html`<${Icon} name="refresh" />`}</button>
      </div>
      ${L && L.nodes.length
        ? html`<svg class=${cls('flow-svg', drag.current && 'dragging')} ref=${svgRef}
            onMouseDown=${(e) => { if (e.target.closest('.flow-node')) return; drag.current = { x: e.clientX, y: e.clientY, v: view }; }}
            onMouseMove=${(e) => { const d = drag.current; if (d) setView({ ...d.v, x: d.v.x + e.clientX - d.x, y: d.v.y + e.clientY - d.y }); }}
            onMouseUp=${() => (drag.current = null)} onMouseLeave=${() => (drag.current = null)} onClick=${(e) => { if (!e.target.closest('.flow-node')) setSel(null); }}>
            <defs>
              ${['produce', 'consume', 'write'].map((k) => html`<marker id=${`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill=${k === 'produce' ? 'var(--accent)' : k === 'consume' ? 'var(--success)' : 'var(--warning)'} /></marker>`)}
            </defs>
            <g transform=${`translate(${view.x + 20},${view.y + 50}) scale(${view.k})`}>
              ${L.edges.map((e) => {
                const a = L.byId.get(e.from);
                const b = L.byId.get(e.to);
                const dim = focusId && !(e.from === focusId || e.to === focusId);
                const label = e.kind === 'write' ? (e.tables.length ? e.tables.slice(0, 3).join(', ') : 'writes') : e.kind === 'consume' && e.groups.length ? `group ${e.groups[0]}` : '';
                const mx = (a.x + a.w + b.x) / 2;
                const my = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
                return html`<g><path class=${cls('flow-edge', e.kind, dim && 'dim')} d=${edgePath(a, b)} marker-end=${`url(#arrow-${e.kind})`} />${label ? html`<text class=${cls('flow-edge-label', dim && 'dim')} x=${mx} y=${my - 6} text-anchor="middle">${label}</text>` : null}</g>`;
              })}
              ${L.nodes.map((n) => html`<g onMouseEnter=${() => setHover(n.id)} onMouseLeave=${() => setHover(null)} onClick=${(e) => { e.stopPropagation(); setSel(n.id); setPeek(null); }}><${NodeShape} n=${n} live=${live} dim=${focusId && !near.has(n.id)} selected=${sel === n.id} /></g>`)}
            </g>
          </svg>`
        : html`<div class="editor-empty"><div style="text-align:center;max-width:460px;line-height:1.6">${loading ? html`<${Spinner} /> Scanning the code…` : flow && flow.error ? flow.error : html`<div style="font-size:15px;color:var(--text);margin-bottom:6px">No Kafka producers or consumers found</div>Kiln looks for Confluent.Kafka, MassTransit, KafkaFlow and Dapr in C#, and kafka-python, confluent-kafka, aiokafka, Faust and FastStream in Python (plus kafkajs), along with EF Core, SQL, MongoDB, Redis and SQLAlchemy writes.`}</div></div>`}
      <div class="graph-legend"><span><i style="background:var(--accent)"></i>publishes</span><span><i style="background:var(--success)"></i>consumes</span><span><i style="background:var(--warning)"></i>writes to database</span></div>
    </div>
    <div class="graph-side">
      ${selNode
        ? html`<div>
            <h4>${selNode.type === 'service' ? 'Service' : selNode.type === 'topic' ? 'Topic' : 'Database'} · ${selNode.label}</h4>
            <div class="muted" style="padding:0 12px 6px;font-size:12px">${selNode.sub}</div>
            ${selNode.type === 'topic' && live ? html`<div class="kv-list">${topicLag(selNode.label).map((t) => html`<span class="k">Consumer</span><span>${t}</span>`)}</div>
                <div class="row" style="padding:0 12px 8px;gap:6px"><button class="btn small" onClick=${async () => setPeek(await invoke('kafka:peek', selNode.label, 25).catch((err) => { errorToast('Peek failed', err); return null; }))}><${Icon} name="eye" size=${13} />Peek messages</button>
                <button class="btn small" onClick=${async () => { const { prompt } = await import('../../lib/ui.js'); const v = await prompt({ title: `Publish to ${selNode.label}`, label: 'Message value (JSON or text):', value: '{"test": true}', ok: 'Publish' }); if (v) { await invoke('kafka:publish', selNode.label, { value: typeof v === 'string' ? v : v.value }).then(() => toast({ kind: 'success', title: 'Message published' })).catch((err) => errorToast('Publish failed', err)); } }}><${Icon} name="upload" size=${13} />Publish test message</button></div>` : null}
            ${peek ? html`<div class="section-title">Latest messages (${peek.length})</div>${peek.map((m) => html`<div style="padding:4px 12px;border-bottom:1px solid var(--border-inner);font-size:12px"><div class="muted">p${m.partition} · offset ${m.offset} · ${timeAgo(m.timestamp)}${m.key ? ` · key ${m.key}` : ''}</div><pre class="mono" style="margin:2px 0;white-space:pre-wrap;user-select:text">${prettyJson(m.value)}</pre></div>`)}` : null}
            <div class="section-title">Where in the code</div>
            ${selEdges.map((e) => html`<div style="padding:4px 12px"><div style="font-size:12px;font-weight:600">${e.kind === 'produce' ? `publishes to ${L.byId.get(e.to).label}` : e.kind === 'consume' ? `${L.byId.get(e.to).label} consumes ${L.byId.get(e.from).label}` : `writes to ${L.byId.get(e.to).label}${e.tables.length ? ` (${e.tables.join(', ')})` : ''}`}</div>
                ${e.refs.slice(0, 12).map((r) => html`<div class="list-row" style="padding:2px 0;min-height:22px" onClick=${() => ed.openFile(r.file, { line: r.line })} title=${r.snippet}><${Icon} name="file" size=${13} className="muted" /><span style="font-size:12px">${r.rel}:${r.line}</span><span class="muted ellipsis" style="font-size:11px">${r.framework}</span></div>`)}</div>`)}
          </div>`
        : html`<div><h4>Message flow</h4>
            <div class="muted" style="padding:4px 12px;font-size:12px;line-height:1.5">Which service publishes to which Kafka topic, who consumes it, and which databases they write to. Click a node to see the code; connect to a broker for live message counts, consumer lag and message peeking.</div>
            ${live ? html`<div class="section-title">Broker</div><div class="kv-list">${live.topics.slice(0, 30).map((t) => html`<span class="k">${t.name}</span><span>${t.messages.toLocaleString()} msgs</span>`)}</div>` : null}
          </div>`}
    </div>
  </div>`;
}

function prettyJson(v) {
  if (v == null) return 'null';
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}
