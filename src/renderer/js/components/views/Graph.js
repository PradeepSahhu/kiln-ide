// Knowledge graph visualizer: force-directed canvas graph (Barnes-Hut) for the code graph
// (files -> classes/functions -> calls/uses/inherits/imports) and the artifacts graph.
import { html, useEffect, useRef, useState, useMemo } from '../../lib/preact.js';
import { useStore, store } from '../../lib/store.js';
import { Icon, KindIcon } from '../../lib/icons.js';
import { invoke, on } from '../../lib/ipc.js';
import { cls, debounce, timeAgo, basename } from '../../lib/util.js';
import * as ed from '../../services/editor.js';
import { Spinner } from '../ui.js';

// ---------------------------------------------------------- simulation

function quadtree(nodes) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of nodes) {
    if (n.x < x0) x0 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.x > x1) x1 = n.x;
    if (n.y > y1) y1 = n.y;
  }
  const size = Math.max(x1 - x0, y1 - y0, 1) + 1;
  const root = { x0, y0, size, mass: 0, cx: 0, cy: 0, kids: null, body: null };
  const insert = (cell, n, depth) => {
    if (!cell.kids && !cell.body) {
      cell.body = n;
    } else {
      if (!cell.kids) {
        if (depth > 40) return;
        cell.kids = [null, null, null, null];
        const b = cell.body;
        cell.body = null;
        insertKid(cell, b, depth);
      }
      insertKid(cell, n, depth);
    }
  };
  const insertKid = (cell, n, depth) => {
    const h = cell.size / 2;
    const i = (n.x >= cell.x0 + h ? 1 : 0) + (n.y >= cell.y0 + h ? 2 : 0);
    if (!cell.kids[i]) cell.kids[i] = { x0: cell.x0 + (i & 1 ? h : 0), y0: cell.y0 + (i & 2 ? h : 0), size: h, mass: 0, cx: 0, cy: 0, kids: null, body: null };
    insert(cell.kids[i], n, depth + 1);
  };
  for (const n of nodes) insert(root, n, 0);
  const accumulate = (cell) => {
    if (cell.body) {
      cell.mass = cell.body.mass;
      cell.cx = cell.body.x;
      cell.cy = cell.body.y;
      return;
    }
    let m = 0;
    let cx = 0;
    let cy = 0;
    for (const k of cell.kids || []) {
      if (!k) continue;
      accumulate(k);
      m += k.mass;
      cx += k.cx * k.mass;
      cy += k.cy * k.mass;
    }
    cell.mass = m;
    cell.cx = m ? cx / m : 0;
    cell.cy = m ? cy / m : 0;
  };
  accumulate(root);
  return root;
}

class Simulation {
  constructor() {
    this.nodes = [];
    this.links = [];
    this.alpha = 1;
    this.byId = new Map();
  }
  setData(nodes, edges, keep = new Map()) {
    this.byId = new Map();
    this.nodes = nodes.map((n, i) => {
      const prev = keep.get(n.id);
      const angle = i * 2.39996;
      const r = 12 * Math.sqrt(i + 1);
      const node = { ...n, x: prev ? prev.x : Math.cos(angle) * r, y: prev ? prev.y : Math.sin(angle) * r, vx: 0, vy: 0, mass: 1 + Math.min(8, (n.degree || 0) / 4) + (n.kind === 'file' || n.kind === 'artifact' ? 2 : 0) };
      this.byId.set(n.id, node);
      return node;
    });
    const count = new Map();
    this.links = [];
    for (const e of edges) {
      const s = this.byId.get(e.source);
      const t = this.byId.get(e.target);
      if (!s || !t || s === t) continue;
      this.links.push({ s, t, kind: e.kind, weight: e.weight || 1 });
      count.set(s, (count.get(s) || 0) + 1);
      count.set(t, (count.get(t) || 0) + 1);
    }
    for (const l of this.links) {
      const cs = count.get(l.s);
      const ct = count.get(l.t);
      l.strength = 1 / Math.min(cs, ct);
      l.bias = cs / (cs + ct);
      l.distance = l.kind === 'contains' || l.kind === 'requires' ? 26 : l.kind === 'mentions' ? 40 : 60;
    }
    this.alpha = keep.size ? 0.4 : 1;
  }
  tick() {
    const alpha = this.alpha;
    const nodes = this.nodes;
    if (!nodes.length) return;
    // Links
    for (const l of this.links) {
      let x = l.t.x + l.t.vx - l.s.x - l.s.vx || 1e-6;
      let y = l.t.y + l.t.vy - l.s.y - l.s.vy || 1e-6;
      let d = Math.sqrt(x * x + y * y);
      d = ((d - l.distance) / d) * alpha * l.strength;
      x *= d;
      y *= d;
      l.t.vx -= x * l.bias;
      l.t.vy -= y * l.bias;
      l.s.vx += x * (1 - l.bias);
      l.s.vy += y * (1 - l.bias);
    }
    // Many-body repulsion (Barnes-Hut)
    const root = quadtree(nodes);
    const strength = -60;
    const theta2 = 0.81;
    for (const n of nodes) {
      const stack = [root];
      while (stack.length) {
        const c = stack.pop();
        if (!c || !c.mass) continue;
        const x = c.cx - n.x;
        const y = c.cy - n.y;
        let l = x * x + y * y;
        if (c.body === n) continue;
        if (c.body || (c.size * c.size) / theta2 < l) {
          if (l < 1) l = 1;
          const w = (strength * c.mass * alpha) / l;
          n.vx += x * w;
          n.vy += y * w;
        } else if (c.kids) for (const k of c.kids) if (k) stack.push(k);
      }
    }
    // Centering
    let sx = 0;
    let sy = 0;
    for (const n of nodes) {
      sx += n.x;
      sy += n.y;
    }
    sx /= nodes.length;
    sy /= nodes.length;
    for (const n of nodes) {
      n.vx -= n.x * 0.002 * alpha;
      n.vy -= n.y * 0.002 * alpha;
      if (n.fx != null) {
        n.x = n.fx;
        n.y = n.fy;
        n.vx = 0;
        n.vy = 0;
      } else {
        n.x += n.vx *= 0.6;
        n.y += n.vy *= 0.6;
        n.x -= sx * 0.1;
        n.y -= sy * 0.1;
      }
    }
    this.alpha += (0 - this.alpha) * 0.0228;
  }
}

// ------------------------------------------------------------- canvas

const KIND_VAR = { file: '--graph-file', class: '--graph-class', record: '--graph-class', struct: '--graph-class', interface: '--graph-interface', enum: '--graph-class', delegate: '--graph-class', method: '--graph-method', function: '--graph-function', constructor: '--graph-method', property: '--syn-field', field: '--syn-field', variable: '--warning', constant: '--syn-number', artifact: '--accent', section: '--graph-file', concept: '--syn-type', requirement: '--warning' };

export function ForceGraph({ data, selected, onSelect, onOpen, highlightRecent = true }) {
  const canvasRef = useRef(null);
  const simRef = useRef(new Simulation());
  const view = useRef({ k: 1, x: 0, y: 0 });
  const hover = useRef(null);
  const raf = useRef(0);
  const theme = useStore((s) => s.settings.theme);
  const colors = useRef({});
  const selRef = useRef(selected);
  selRef.current = selected;

  useEffect(() => {
    const st = getComputedStyle(document.documentElement);
    const c = {};
    for (const [k, v] of Object.entries(KIND_VAR)) c[k] = st.getPropertyValue(v).trim() || '#888';
    c.edge = st.getPropertyValue('--graph-edge').trim();
    c.text = st.getPropertyValue('--text').trim();
    c.textDim = st.getPropertyValue('--text-secondary').trim();
    c.bg = st.getPropertyValue('--bg-editor').trim();
    c.accent = st.getPropertyValue('--accent').trim();
    c.success = st.getPropertyValue('--success').trim();
    c.error = st.getPropertyValue('--error').trim();
    colors.current = c;
    kick();
  }, [theme]);

  useEffect(() => {
    if (!data) return;
    const keep = new Map(simRef.current.nodes.map((n) => [n.id, n]));
    simRef.current.setData(data.nodes, data.edges, keep);
    if (!keep.size) {
      // Pre-settle so the first frame is already readable.
      for (let i = 0; i < Math.min(160, 30000 / Math.max(1, data.nodes.length)); i++) simRef.current.tick();
      fit();
    }
    kick();
  }, [data]);

  useEffect(() => kick(), [selected]);

  const kick = () => {
    if (!raf.current) raf.current = requestAnimationFrame(frame);
  };

  const fit = () => {
    const canvas = canvasRef.current;
    const nodes = simRef.current.nodes;
    if (!canvas || !nodes.length) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x);
      y1 = Math.max(y1, n.y);
    }
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const k = Math.min(2.2, 0.9 * Math.min(w / Math.max(1, x1 - x0), h / Math.max(1, y1 - y0)));
    view.current = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
    kick();
  };

  const frame = () => {
    raf.current = 0;
    const sim = simRef.current;
    if (sim.alpha > 0.005) sim.tick();
    draw();
    if (sim.alpha > 0.005 || dragging.current) raf.current = requestAnimationFrame(frame);
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    const { k, x: tx, y: ty } = view.current;
    const c = colors.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(tx, ty);
    ctx.scale(k, k);
    const sim = simRef.current;
    const sel = selRef.current;
    const hov = hover.current;
    const focus = sel || hov;
    const near = new Set();
    if (focus) {
      near.add(focus);
      for (const l of sim.links) {
        if (l.s.id === focus) near.add(l.t.id);
        if (l.t.id === focus) near.add(l.s.id);
      }
    }
    // Edges
    ctx.lineWidth = 1 / k;
    for (const l of sim.links) {
      const lit = focus && (l.s.id === focus || l.t.id === focus);
      ctx.strokeStyle = lit ? (l.kind === 'calls' ? c.accent : l.kind === 'inherits' ? c.class : l.kind === 'writes' ? c.error : l.kind === 'reads' ? c.variable : c.success) : c.edge;
      ctx.globalAlpha = focus && !lit ? 0.12 : lit ? 0.95 : l.kind === 'contains' ? 0.35 : 0.6;
      ctx.lineWidth = (lit ? 1.6 : 1) / k;
      ctx.beginPath();
      ctx.moveTo(l.s.x, l.s.y);
      ctx.lineTo(l.t.x, l.t.y);
      ctx.stroke();
      if (lit && l.kind !== 'contains') {
        const ang = Math.atan2(l.t.y - l.s.y, l.t.x - l.s.x);
        const r = radius(l.t) + 2;
        const ax = l.t.x - Math.cos(ang) * r;
        const ay = l.t.y - Math.sin(ang) * r;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(ang - 0.4) * (7 / k), ay - Math.sin(ang - 0.4) * (7 / k));
        ctx.lineTo(ax - Math.cos(ang + 0.4) * (7 / k), ay - Math.sin(ang + 0.4) * (7 / k));
        ctx.closePath();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const now = Date.now();
    // Nodes
    for (const n of sim.nodes) {
      const r = radius(n);
      const dim = focus && !near.has(n.id);
      ctx.globalAlpha = dim ? 0.18 : 1;
      if (highlightRecent && n.modifiedAt && now - n.modifiedAt < 24 * 3600 * 1000) {
        const fresh = now - n.modifiedAt < 15 * 60 * 1000;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + (fresh ? 5 : 3.5), 0, Math.PI * 2);
        ctx.fillStyle = fresh ? 'rgba(95,184,101,0.45)' : 'rgba(95,184,101,0.22)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = c[n.kind] || c.method;
      ctx.fill();
      if (n.id === sel || n.id === hov) {
        ctx.lineWidth = 2 / k;
        ctx.strokeStyle = c.text;
        ctx.stroke();
      }
      if (n.inCode) {
        ctx.lineWidth = 1.5 / k;
        ctx.strokeStyle = c.success;
        ctx.stroke();
      }
    }
    // Labels
    ctx.textBaseline = 'middle';
    for (const n of sim.nodes) {
      const r = radius(n);
      const important = n.kind === 'file' || n.kind === 'artifact' || (n.degree || 0) > 6;
      if (!(near.has(n.id) || (k > 1.4) || (important && k > 0.55))) continue;
      if (focus && !near.has(n.id)) continue;
      const size = Math.max(9, Math.min(13, 11 / Math.sqrt(k))) / k;
      ctx.font = `${n.kind === 'file' || n.kind === 'artifact' ? 600 : 400} ${size}px Inter, sans-serif`;
      ctx.fillStyle = n.id === sel ? c.text : c.textDim;
      ctx.globalAlpha = 1;
      ctx.fillText(n.label, n.x + r + 3 / k, n.y);
    }
    ctx.globalAlpha = 1;
  };

  const radius = (n) => (n.kind === 'file' || n.kind === 'artifact' ? 6.5 : n.kind === 'class' || n.kind === 'interface' || n.kind === 'record' || n.kind === 'section' ? 5 : 3.5) + Math.min(6, Math.sqrt(n.degree || 0));

  // ---------------------------------------------------- interaction
  const dragging = useRef(null);
  const toWorld = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const { k, x, y } = view.current;
    return { x: (e.clientX - rect.left - x) / k, y: (e.clientY - rect.top - y) / k };
  };
  const pick = (e) => {
    const p = toWorld(e);
    let best = null;
    let bd = Infinity;
    for (const n of simRef.current.nodes) {
      const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
      const r = radius(n) + 4 / view.current.k;
      if (d < r * r && d < bd) {
        best = n;
        bd = d;
      }
    }
    return best;
  };
  const down = (e) => {
    const n = pick(e);
    const start = { x: e.clientX, y: e.clientY, view: { ...view.current } };
    dragging.current = n ? { node: n, moved: false } : { pan: start, moved: false };
    if (n) {
      n.fx = n.x;
      n.fy = n.y;
      simRef.current.alpha = Math.max(simRef.current.alpha, 0.25);
    }
    kick();
  };
  const move = (e) => {
    const d = dragging.current;
    if (!d) {
      const n = pick(e);
      const id = n ? n.id : null;
      if (id !== hover.current) {
        hover.current = id;
        canvasRef.current.style.cursor = n ? 'pointer' : 'grab';
        kick();
      }
      return;
    }
    d.moved = true;
    if (d.node) {
      const p = toWorld(e);
      d.node.fx = p.x;
      d.node.fy = p.y;
    } else {
      view.current = { ...d.pan.view, x: d.pan.view.x + e.clientX - d.pan.x, y: d.pan.view.y + e.clientY - d.pan.y };
    }
    kick();
  };
  const up = (e) => {
    const d = dragging.current;
    dragging.current = null;
    if (!d) return;
    if (d.node) {
      d.node.fx = null;
      d.node.fy = null;
      if (!d.moved) onSelect && onSelect(d.node);
    } else if (!d.moved) onSelect && onSelect(null);
    kick();
  };
  const wheel = (e) => {
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const v = view.current;
    const k = Math.max(0.05, Math.min(8, v.k * Math.exp(-e.deltaY * 0.0015)));
    view.current = { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k };
    kick();
  };
  const dbl = (e) => {
    const n = pick(e);
    if (n && onOpen) onOpen(n);
  };
  useEffect(() => {
    const el = canvasRef.current;
    el.addEventListener('wheel', wheel, { passive: false });
    const ro = new ResizeObserver(() => kick());
    ro.observe(el);
    window.addEventListener('mouseup', up);
    return () => {
      el.removeEventListener('wheel', wheel);
      ro.disconnect();
      window.removeEventListener('mouseup', up);
      cancelAnimationFrame(raf.current);
    };
  }, []);
  ForceGraph.fit = fit;
  return html`<canvas ref=${canvasRef} onMouseDown=${down} onMouseMove=${move} onDblClick=${dbl} style="cursor:grab"></canvas>`;
}

// --------------------------------------------------- code knowledge graph

export function KnowledgeGraphView({ tab }) {
  const source = (tab.data && tab.data.source) || 'code';
  const root = useStore((s) => s.project && s.project.root);
  const [mode, setMode] = useState(tab.data && tab.data.focus ? 'focus' : source === 'code' ? 'files' : 'all');
  const [focus, setFocus] = useState((tab.data && tab.data.focus) || null);
  const [depth, setDepth] = useState(2);
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [details, setDetails] = useState(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showVars, setShowVars] = useState(true);
  const bg = useStore((s) => s.branchGraph);
  const mainReady = !!bg && bg.state === 'ready';
  const [ref, setRef] = useState(tab.data && tab.data.ref === 'main' ? 'main' : 'work');
  const src = ref === 'main' && mainReady ? 'main' : undefined;
  const load = async () => {
    setLoading(true);
    try {
      if (source === 'artifacts') setData(await invoke('kb:graph'));
      else setData(await invoke('code:graph', { mode: mode === 'functions' ? 'all' : mode, focus, depth, limit: 2500, variables: showVars, source: src }));
    } catch (err) {
      setData({ nodes: [], edges: [], error: err.message });
    }
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, [mode, focus, depth, source, showVars, src, src ? bg.commit : null]);
  useEffect(() => {
    if (source !== 'code') return undefined;
    const reload = debounce(load, 800);
    const offs = [on('index:changed', reload), on('index:status', (s) => s.state === 'ready' && reload())];
    return () => offs.forEach((f) => f());
  }, [mode, focus, depth]);
  useEffect(() => {
    if (!selected || source !== 'code') return setDetails(null);
    invoke('code:neighbors', selected.id, src).then(setDetails).catch(() => setDetails(null));
  }, [selected && selected.id]);
  useEffect(() => {
    if (!q || source !== 'code') return setFound([]);
    const t = setTimeout(() => invoke('code:findNodes', q, src).then(setFound).catch(() => setFound([])), 150);
    return () => clearTimeout(t);
  }, [q]);
  const openNode = (n) => {
    if (source === 'code' && n.file) ed.openFile(`${root}/${n.file}`, { line: n.line || 1 });
  };
  const focusOn = (id) => {
    setFocus(id);
    setMode('focus');
    setQ('');
    setFound([]);
  };
  const nodeCount = data ? data.nodes.length : 0;
  const varList = (title, list) => (list && list.length ? html`<div class="section-title">${title} (${list.length})</div>${list.map((n) => html`<div class="list-row" data-testid="graph-var-link" onClick=${() => focusOn(n.id)}><${KindIcon} kind=${n.kind} /><span class="ellipsis">${n.container ? html`<span class="muted">${n.container.split('.').pop()}.</span>` : null}${n.label}</span><span class="muted" style="font-size:11px;margin-left:auto">${n.weight > 1 ? `×${n.weight}` : ''}</span></div>`)}` : null);
  return html`<div class="graph-view" data-testid=${source === 'code' ? 'knowledge-graph' : 'artifact-graph'} data-node-count=${String(nodeCount)} data-source=${src || 'work'}>
    <div class="graph-canvas">
      <div class="graph-toolbar">
        ${source === 'code'
          ? html`${mainReady
                ? html`<div class="seg" title=${`The ${bg.branch} graph follows ${bg.ref} in the background (now at ${bg.short || ''})`}><button class=${cls(ref === 'work' && 'on')} data-testid="graph-source-work" onClick=${() => setRef('work')}>Working tree</button><button class=${cls(ref === 'main' && 'on')} data-testid="graph-source-main" onClick=${() => setRef('main')}>${bg.branch}<span class="dim" style="margin-left:4px;font-size:11px">${bg.short || ''}</span></button></div>`
                : null}
              <div class="seg">${[['files', 'Files'], ['functions', 'Functions'], ['focus', 'Focus']].map(([m, l]) => html`<button class=${cls(mode === m && 'on')} onClick=${() => setMode(m)} disabled=${m === 'focus' && !focus}>${l}</button>`)}</div>
              ${mode === 'focus' ? html`<div class="seg">${[1, 2, 3].map((d) => html`<button class=${cls(depth === d && 'on')} onClick=${() => setDepth(d)}>${d} level${d > 1 ? 's' : ''}</button>`)}</div>` : null}
              ${mode !== 'files' ? html`<div class="seg"><button class=${cls(showVars && 'on')} data-testid="graph-variables" title="Show variables, fields and constants with the functions that read and write them" onClick=${() => setShowVars(!showVars)}>Variables</button></div>` : null}
              <div style="position:relative"><input class="input" style="width:240px" placeholder="Find a file, class, function or variable" value=${q} onInput=${(e) => setQ(e.target.value)} />
                ${found.length ? html`<div class="popup" style="position:absolute;top:32px;left:0;width:340px">${found.map((n) => html`<div class="popup-item" onClick=${() => focusOn(n.id)}><${KindIcon} kind=${n.kind} /><span class="ellipsis">${n.container ? n.container.split('.').pop() + '.' : ''}${n.label}</span><span class="hint" style="margin-left:auto">${n.file}</span></div>`)}</div>` : null}
              </div>`
          : html`<span class="badge accent">Artifacts knowledge graph</span>`}
        <div class="spacer"></div>
        ${loading ? html`<${Spinner} />` : null}
        <button class="icon-btn" style="background:var(--bg-elevated)" title="Fit" onClick=${() => ForceGraph.fit && ForceGraph.fit()}><${Icon} name="fit" /></button>
        <button class="icon-btn" style="background:var(--bg-elevated)" title="Refresh" onClick=${load}><${Icon} name="refresh" /></button>
      </div>
      <${ForceGraph} data=${data} selected=${selected && selected.id} onSelect=${setSelected} onOpen=${openNode} />
      <div class="graph-legend">
        ${(source === 'code' ? [['file', 'File'], ['class', 'Class'], ['interface', 'Interface'], ['method', 'Method / function'], ['field', 'Field / property'], ['variable', 'Variable'], ['constant', 'Constant']] : [['artifact', 'Artifact'], ['section', 'Section'], ['concept', 'Concept'], ['requirement', 'Requirement']]).map(([k, l]) => html`<span><i style=${{ background: `var(${KIND_VAR[k]})` }}></i>${l}</span>`)}
        ${source === 'code' ? html`<span><i style="background:rgba(95,184,101,.5)"></i>Changed in the last day</span>` : html`<span><i style="border:2px solid var(--success);background:transparent"></i>Also a code symbol</span>`}
      </div>
      <div class="graph-stats">${data && data.error ? data.error : `${nodeCount} nodes · ${data ? data.edges.length : 0} edges${data && data.totalNodes && data.totalNodes > nodeCount ? ` (of ${data.totalNodes})` : ''}`}</div>
    </div>
    <div class="graph-side">
      ${selected
        ? html`<div>
            <h4 class="row"><${KindIcon} kind=${selected.kind} />${selected.container ? html`<span class="muted">${selected.container.split('.').pop()}.</span>` : null}${selected.label}</h4>
            <div class="kv-list">
              <span class="k">Kind</span><span>${selected.kind}</span>
              ${selected.file ? html`<span class="k">File</span><a onClick=${() => openNode(selected)}>${selected.file}${selected.line ? `:${selected.line}` : ''}</a>` : null}
              ${selected.signature ? html`<span class="k">Signature</span><span class="mono" style="font-size:11px">${selected.signature}</span>` : null}
              ${selected.modifiedAt ? html`<span class="k">Changed</span><span>${timeAgo(selected.modifiedAt)}</span>` : null}
              ${selected.text ? html`<span class="k">Text</span><span>${selected.text}</span>` : null}
            </div>
            ${source === 'code' ? html`<div class="row" style="padding:0 12px 8px;gap:6px"><button class="btn small" onClick=${() => openNode(selected)}>Open</button><button class="btn small" onClick=${() => focusOn(selected.id)}>Focus</button><button class="btn small" onClick=${() => import('../../services/claude.js').then((c) => { import('../../services/layout.js').then((l) => l.openTool('right', 'claude')); c.sendMessage(`Explain ${selected.label} in ${selected.file}: what it does, who calls it and what it calls.`); })}><${Icon} name="claude" size=${12} />Ask Claude</button></div>` : null}
            ${details ? html`
              <div class="section-title">Called / used by (${details.callers.length})</div>
              ${details.callers.map((n) => html`<div class="list-row" onClick=${() => focusOn(n.id)}><${KindIcon} kind=${n.kind} /><span class="ellipsis">${n.label}</span><span class="muted" style="font-size:11px;margin-left:auto">${n.edge}</span></div>`)}
              <div class="section-title">Calls / uses (${details.callees.length})</div>
              ${details.callees.map((n) => html`<div class="list-row" onClick=${() => focusOn(n.id)}><${KindIcon} kind=${n.kind} /><span class="ellipsis">${n.label}</span><span class="muted" style="font-size:11px;margin-left:auto">${n.edge}</span></div>`)}
              ${details.members.length ? html`<div class="section-title">Contains (${details.members.length})</div>${details.members.slice(0, 80).map((n) => html`<div class="list-row" onClick=${() => focusOn(n.id)}><${KindIcon} kind=${n.kind} /><span class="ellipsis">${n.label}</span></div>`)}` : null}
              ${varList('Reads', details.reads)}${varList('Writes', details.writes)}
              ${varList('Read by', details.readers)}${varList('Written by', details.writers)}
              ${details.locals && details.locals.length
                ? html`<div class="section-title">Local variables (${details.locals.length})</div>${details.locals.map((l) => html`<div class="list-row" data-testid="graph-local" onClick=${() => openNode({ ...selected, line: l.line })}><${KindIcon} kind=${l.kind === 'parameter' ? 'parameter' : 'variable'} /><span class="ellipsis">${l.name}</span><span class="muted" style="font-size:11px;margin-left:auto">${l.kind === 'parameter' ? 'param · ' : ''}${l.reads} read${l.reads === 1 ? '' : 's'} · ${l.writes} write${l.writes === 1 ? '' : 's'}</span></div>`)}`
                : null}` : null}
          </div>`
        : html`<div>
            <h4>${source === 'code' ? 'Knowledge graph' : 'Artifacts'}</h4>
            <div class="muted" style="padding:4px 12px 10px;font-size:12px;line-height:1.5">${source === 'code' ? 'Files, classes, functions and variables with their calls, inheritance, imports and which functions read and write each variable, updated as you or an agent edit code. Agents query it through the Kiln knowledge-graph skill and MCP server. Stored locally in Kiln’s app data, never in the repository.' : 'Documents, sections, concepts and requirements from your Claude artifacts. Stored locally and separate from the code graph.'}</div>
            ${data && data.recent && data.recent.length ? html`<div class="section-title">Recently changed</div>${data.recent.map((n) => html`<div class="list-row" onClick=${() => focusOn(n.id)}><${KindIcon} kind=${n.kind} /><span class="ellipsis">${n.label}</span><span class="muted" style="font-size:11px;margin-left:auto">${timeAgo(n.modifiedAt)}</span></div>`)}` : null}
            ${data && data.stats ? html`<div class="kv-list"><span class="k">Files</span><span>${data.stats.files}</span><span class="k">Definitions</span><span>${data.stats.defs}</span><span class="k">Call sites</span><span>${data.stats.calls}</span>${data.stats.variables != null ? html`<span class="k">Variables</span><span>${data.stats.variables}</span>` : null}</div>` : null}
          </div>`}
    </div>
  </div>`;
}
