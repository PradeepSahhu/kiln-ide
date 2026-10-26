'use strict';
// HTTP endpoints of the project - FastAPI / Flask (Python), Express (JavaScript / TypeScript) and
// ASP.NET Core minimal APIs and controllers (C#) - found in the code with their method, full path
// (router / group / controller prefixes applied) and parameters, so the editor can show a button above
// each one that sends a real request to the running app.
const fs = require('fs');
const path = require('path');
const { buildUrl, sendRequest } = require('./http-client');

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const lineAt = (src, index) => src.slice(0, index).split('\n').length;
const joinPath = (...parts) => {
  const p = parts.filter((x) => x != null && x !== '').map((x, i) => (i ? String(x).replace(/^\/?/, '/') : String(x))).join('').replace(/\/{2,}/g, '/');
  const out = p.startsWith('/') ? p : `/${p}`;
  return out.length > 1 ? out.replace(/\/$/, '') : out;
};

/** Split a parameter list at top-level commas (not inside (), [], {}, <> or strings). */
function splitParams(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (const c of s) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    if ('([{<'.includes(c)) depth++;
    if (')]}>'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The text between the parenthesis at `open` and its match. */
function balanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

const pathParams = (p) => [...p.matchAll(/\{(\w+)(?::[^}]*)?\}|:(\w+)/g)].map((m) => m[1] || m[2]);

// ---------------------------------------------------------- example bodies

/** An example JSON value for a type name (Python / C# / TypeScript spellings). */
function exampleFor(type, models, depth = 0) {
  const t = String(type || '').replace(/\s/g, '').replace(/^Optional\[(.*)\]$/, '$1').replace(/\?$/, '').replace(/\|None$/, '');
  if (/^(int|long|short|Int32|Int64|number)$/i.test(t)) return 0;
  if (/^(float|double|decimal|Decimal)$/i.test(t)) return 0.0;
  if (/^(bool|boolean|Boolean)$/i.test(t)) return false;
  if (/^(str|string|String|Guid|DateTime|date|datetime|EmailStr)$/i.test(t)) return t.toLowerCase() === 'guid' ? '00000000-0000-0000-0000-000000000000' : /date/i.test(t) ? new Date(0).toISOString() : 'string';
  const list = /^(?:list|List|IEnumerable|IList|ICollection|Array)\[?<?(.+?)>?\]?$/.exec(t) || /^(.+)\[\]$/.exec(t);
  if (list) return [exampleFor(list[1], models, depth + 1)];
  if (models[t] && depth < 3) return Object.fromEntries(models[t].map((f) => [f.name, f.example !== undefined ? f.example : exampleFor(f.type, models, depth + 1)]));
  return {};
}

// ---------------------------------------------------------- Python

const PY_SKIP_TYPES = /^(Request|Response|WebSocket|BackgroundTasks|Session|AsyncSession|HTTPConnection|SecurityScopes)$/;

function pythonModels(src) {
  const models = {};
  for (const m of src.matchAll(/^class\s+(\w+)\s*\(([^)]*)\)\s*:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/gm)) {
    if (!/BaseModel|SQLModel|TypedDict|Schema/.test(m[2])) continue;
    const fields = [];
    for (const f of m[3].matchAll(/^[ \t]+(\w+)\s*:\s*([^=\n#]+?)(?:\s*=\s*([^\n#]+))?\s*$/gm)) {
      if (f[1] === 'model_config' || f[1] === 'Config') continue;
      let example;
      if (f[3] && /^-?\d+(\.\d+)?$/.test(f[3].trim())) example = Number(f[3].trim());
      else if (f[3] && /^["'].*["']$/.test(f[3].trim())) example = f[3].trim().slice(1, -1);
      fields.push({ name: f[1], type: f[2].trim(), example });
    }
    models[m[1]] = fields;
  }
  return models;
}

function pythonParams(sig, routePath, method, models) {
  const inPath = new Set(pathParams(routePath));
  const params = [];
  let body = null;
  for (const raw of splitParams(sig)) {
    const m = /^\*{0,2}(\w+)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/.exec(raw);
    if (!m || m[1] === 'self' || m[1] === 'cls' || raw.startsWith('*')) continue;
    const [, name, typeRaw = '', def] = m;
    const type = typeRaw.replace(/^Annotated\[\s*([^,\]]+).*$/, '$1').trim();
    const marker = `${typeRaw} ${def || ''}`;
    if (/Depends\(|Security\(/.test(marker) || PY_SKIP_TYPES.test(type)) continue;
    if (inPath.has(name)) params.push({ name, in: 'path', type: type || 'str', required: true });
    else if (/Header\(/.test(marker)) params.push({ name: name.replace(/_/g, '-'), in: 'header', type, required: !def || /\.\.\./.test(def) });
    else if (/Body\(/.test(marker) || models[type] || (/^[A-Z]/.test(type) && !/^(Optional|List|Dict|Union|Literal)/.test(type) && BODY_METHODS.has(method))) body = { type, example: exampleFor(type, models) };
    else params.push({ name, in: 'query', type: type || 'str', required: !def || /Query\(\s*\.\.\./.test(def), default: def && !/Query\(/.test(def) ? def.replace(/^["']|["']$/g, '') : undefined });
  }
  return { params, body };
}

function scanPython(src, file) {
  const models = pythonModels(src);
  const routers = {}; // var -> prefix
  for (const m of src.matchAll(/^(\w+)\s*=\s*(APIRouter|Blueprint)\s*\(([^)]*)\)/gm)) {
    const prefix = /(?:prefix|url_prefix)\s*=\s*["']([^"']*)["']/.exec(m[3]);
    routers[m[1]] = prefix ? prefix[1] : '';
  }
  const includes = [];
  for (const m of src.matchAll(/(\w+)\.(include_router|register_blueprint)\(\s*([\w.]+)\s*(?:,([^)]*))?\)/g)) {
    const prefix = /(?:prefix|url_prefix)\s*=\s*["']([^"']*)["']/.exec(m[4] || '');
    includes.push({ target: m[3], prefix: prefix ? prefix[1] : '', file });
  }
  const endpoints = [];
  const deco = /^[ \t]*@(\w+)\.(get|post|put|patch|delete|head|options|route|api_route)\(\s*["']([^"']*)["']([^\n]*)/gm;
  for (const m of src.matchAll(deco)) {
    const [, owner, kind, routePath, rest] = m;
    const methods = kind === 'route' || kind === 'api_route' ? (/methods\s*=\s*\[([^\]]*)\]/.exec(rest) || [null, '"GET"'])[1].match(/\w+/g).map((x) => x.toUpperCase()) : [kind.toUpperCase()];
    const after = src.slice(m.index);
    const def = /\n[ \t]*(?:async\s+)?def\s+(\w+)\s*\(/.exec(after);
    if (!def) continue;
    const sig = balanced(after, def.index + def[0].length - 1);
    for (const method of methods) {
      const { params, body } = pythonParams(sig, routePath, method, models);
      endpoints.push({ framework: 'fastapi', owner, method, route: routePath, prefix: routers[owner] || '', handler: def[1], file, line: lineAt(src, m.index), params, body: body || (BODY_METHODS.has(method) && kind === 'route' ? { type: 'json', example: {} } : null) });
    }
  }
  const flask = /from\s+flask\b|import\s+flask\b/.test(src);
  for (const e of endpoints) {
    e.framework = flask ? 'flask' : 'fastapi';
    if (!flask) continue;
    // Flask: <int:id> path parameters (shown as {id}); a view's other arguments are not request parameters.
    e.route = e.route.replace(/<(?:\w+:)?(\w+)>/g, '{$1}');
    e.params = pathParams(e.route).map((name) => ({ name, in: 'path', type: 'str', required: true }));
  }
  return { endpoints, routers, includes };
}

// ---------------------------------------------------------- JavaScript

function scanExpress(src, file) {
  if (!/\b(express|Router)\b/.test(src)) return { endpoints: [], routers: {}, includes: [] };
  const routers = {};
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.Router|Router)\s*\(/g)) routers[m[1]] = '';
  const apps = new Set([...src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*express\s*\(\s*\)/g)].map((m) => m[1]));
  const includes = [];
  for (const m of src.matchAll(/(\w+)\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:require\(\s*['"`]([^'"`]+)['"`]\s*\)|(\w+))/g)) includes.push({ owner: m[1], prefix: m[2], requirePath: m[3] || null, target: m[4] || null, file });
  const endpoints = [];
  const re = new RegExp(`\\b(\\w+)\\.(${METHODS.join('|')}|all)\\(\\s*(['"\`])([^'"\`]+)\\3`, 'g');
  for (const m of src.matchAll(re)) {
    const [, owner, kind, , route] = m;
    if (!apps.has(owner) && !(owner in routers) && !/^(app|router|api|server)$/.test(owner)) continue;
    const handler = src.slice(m.index, m.index + 3000);
    const end = handler.search(/\n\}\);|\n(?:app|router|\w+)\.(?:get|post|put|patch|delete|use|listen)\(/);
    const body = end > 0 ? handler.slice(0, end) : handler.slice(0, 1500);
    const query = [...new Set([...body.matchAll(/req\.query\.(\w+)/g)].map((x) => x[1]))];
    const bodyKeys = new Set([...body.matchAll(/req\.body\.(\w+)/g)].map((x) => x[1]));
    for (const d of body.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*req\.body/g)) for (const k of d[1].split(',')) bodyKeys.add(k.split(':')[0].split('=')[0].trim());
    const method = kind === 'all' ? 'GET' : kind.toUpperCase();
    endpoints.push({
      framework: 'express',
      owner,
      method,
      route,
      prefix: '',
      handler: (/(?:function\s+(\w+)|,\s*(\w+)\s*\))/.exec(handler.split('\n')[0]) || [])[1] || '',
      file,
      line: lineAt(src, m.index),
      params: [...pathParams(route).map((name) => ({ name, in: 'path', type: 'string', required: true })), ...query.map((name) => ({ name, in: 'query', type: 'string', required: false }))],
      body: BODY_METHODS.has(method) ? { type: 'json', example: Object.fromEntries([...bodyKeys].filter(Boolean).map((k) => [k, 'string'])) } : null,
    });
  }
  return { endpoints, routers, includes };
}

// ---------------------------------------------------------- C#

const CS_SERVICE = /^(I[A-Z]\w*|\w*(Db|DbContext|Context|Service|Services|Repository|Logger|Options|Factory|Client|Manager|Provider|Mapper|Mediator)(<.*>)?|HttpContext|HttpRequest|HttpResponse|CancellationToken|ClaimsPrincipal|LinkGenerator)$/;
const CS_SIMPLE = /^(int|long|short|byte|bool|string|double|float|decimal|Guid|DateTime|DateOnly|TimeOnly|DateTimeOffset)\??$/;

function csModels(src) {
  const models = {};
  // records: record Todo(int Id, string Title, bool Done)
  for (const m of src.matchAll(/\brecord\s+(?:class\s+|struct\s+)?(\w+)\s*\(([^)]*)\)/g)) {
    models[m[1]] = splitParams(m[2]).map((p) => {
      const parts = p.replace(/\[[^\]]*\]\s*/g, '').trim().split(/\s+/);
      const name = parts[parts.length - 1].split('=')[0].trim();
      return { name: name[0].toLowerCase() + name.slice(1), type: parts.slice(0, -1).join(' ') };
    });
  }
  // classes with auto-properties
  for (const m of src.matchAll(/\bclass\s+(\w+)[^{;]*\{/g)) {
    // The class body, by matching braces (classes may be on one line or nested).
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}' && --depth === 0) break;
    }
    const classBody = src.slice(m.index + m[0].length, end);
    const props = [...classBody.matchAll(/public\s+(?:required\s+)?([\w<>\[\]?.,\s]+?)\s+(\w+)\s*\{\s*get;/g)].map((p) => ({ name: p[2][0].toLowerCase() + p[2].slice(1), type: p[1].trim() }));
    if (props.length && !models[m[1]]) models[m[1]] = props;
  }
  return models;
}

function csParams(sig, routePath, method, models) {
  const inPath = new Set(pathParams(routePath).map((x) => x.toLowerCase()));
  const params = [];
  let body = null;
  for (const raw of splitParams(sig)) {
    const attr = (/\[(From\w+)/.exec(raw) || [])[1] || '';
    const clean = raw.replace(/\[[^\]]*\]\s*/g, '').replace(/\s*=\s*[^,]+$/, '').trim();
    const parts = clean.split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[parts.length - 1];
    const type = parts.slice(0, -1).join(' ');
    const optional = /=/.test(raw) || /\?$/.test(type);
    if (attr === 'FromServices' || (!attr && CS_SERVICE.test(type))) continue;
    if (attr === 'FromRoute' || inPath.has(name.toLowerCase())) params.push({ name, in: 'path', type, required: true });
    else if (attr === 'FromHeader') params.push({ name, in: 'header', type, required: !optional });
    else if (attr === 'FromQuery' || (!attr && CS_SIMPLE.test(type))) params.push({ name, in: 'query', type, required: !optional });
    else if (attr === 'FromBody' || BODY_METHODS.has(method)) body = { type, example: exampleFor(type, models) };
  }
  return { params, body };
}

function scanCsharp(src, file) {
  const models = csModels(src);
  const endpoints = [];
  // Minimal APIs, with MapGroup prefixes: var todos = app.MapGroup("/todos");
  const groups = {};
  for (const m of src.matchAll(/(?:var\s+)?(\w+)\s*=\s*(\w+)\.MapGroup\(\s*"([^"]*)"\s*\)/g)) groups[m[1]] = joinPath(groups[m[2]] || '', m[3]);
  for (const m of src.matchAll(/(\w+)\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)"\s*,/g)) {
    const [, owner, verb, route] = m;
    const method = verb.toUpperCase();
    const after = src.slice(m.index + m[0].length);
    const lambda = /^\s*(?:async\s*)?\(([^)]*)\)\s*=>/.exec(after);
    const ref = !lambda && /^\s*([\w.]+)\s*\)/.exec(after);
    let sig = lambda ? lambda[1] : '';
    if (ref) {
      const name = ref[1].split('.').pop();
      const decl = new RegExp(`\\b${name}\\s*\\(([^)]*)\\)`).exec(src.slice(m.index + m[0].length));
      if (decl) sig = decl[1];
    }
    const { params, body } = csParams(sig, route, method, models);
    endpoints.push({ framework: 'aspnet', owner, method, route, prefix: groups[owner] || '', handler: ref ? ref[1] : '', file, line: lineAt(src, m.index), params, body });
  }
  // Controllers: [Route("api/[controller]")] class XController ... [HttpGet("{id}")] public ... Name(params)
  // Attributes may contain brackets themselves: [Route("api/[controller]")].
  const ATTR = String.raw`\[(?:[^\[\]]|\[[^\]]*\])*\]`;
  const CLASS = new RegExp(String.raw`((?:${ATTR}\s*)*)public\s+(?:sealed\s+|partial\s+)*class\s+(\w+?)(Controller)?\s*:\s*\w*Controller(?:Base)?\b[\s\S]*?\{`, 'g');
  const ACTION = new RegExp(String.raw`\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)"[^)]*\))?\]((?:\s*${ATTR})*)\s*public\s+[\w<>\[\]?,.\s]+?\s+(\w+)\s*\(`, 'g');
  for (const c of src.matchAll(CLASS)) {
    const attrs = c[1];
    const ctrl = c[2];
    const base = ((/\[Route\(\s*"([^"]*)"/.exec(attrs) || [])[1] || '').replace(/\[controller\]/gi, ctrl);
    const bodyStart = c.index + c[0].length;
    const next = src.slice(bodyStart).search(new RegExp(String.raw`\n\s*(?:${ATTR}\s*)*public\s+(?:sealed\s+|partial\s+)*class\s`));
    const classSrc = src.slice(bodyStart, next < 0 ? undefined : bodyStart + next);
    for (const a of classSrc.matchAll(ACTION)) {
      const method = a[1].toUpperCase();
      const own = a[2] != null ? a[2] : (/\[Route\(\s*"([^"]*)"/.exec(a[3] || '') || [])[1] || '';
      const route = own.startsWith('/') || own.startsWith('~/') ? own.replace(/^~/, '') : joinPath(base, own.replace(/\[action\]/gi, a[4]));
      const sig = balanced(classSrc, a.index + a[0].length - 1);
      const { params, body } = csParams(sig, route, method, models);
      endpoints.push({ framework: 'aspnet', owner: `${ctrl}Controller`, method, route, prefix: '', handler: a[4], file, line: lineAt(src, bodyStart + a.index), params, body });
    }
  }
  return { endpoints, routers: {}, includes: [] };
}

// ---------------------------------------------------------- project

const SCANNERS = [
  { test: /\.py$/, scan: scanPython },
  { test: /\.[cm]?[jt]sx?$/, scan: scanExpress },
  { test: /\.cs$/, scan: scanCsharp },
];
const SKIP_DIR = /[\\/](node_modules|\.git|\.venv|venv|bin|obj|dist|build|__pycache__|\.next|coverage|site-packages)[\\/]/;
const LOOKS_LIKE = /@\w+\.(get|post|put|patch|delete|route|api_route)\(|\.(get|post|put|patch|delete|all)\(\s*['"`]\/|\.Map(Get|Post|Put|Patch|Delete)\(|\[Http(Get|Post|Put|Patch|Delete)/;

/** Endpoints of one file, as found on its own (prefixes from other files are not applied). */
function scanFile(file, src) {
  const s = SCANNERS.find((x) => x.test.test(file));
  if (!s || !LOOKS_LIKE.test(src) && !/include_router|register_blueprint|\.use\(/.test(src)) return { endpoints: [], routers: {}, includes: [] };
  return s.scan(src, file);
}

/** Full paths: a router's own prefix plus the prefix it is mounted with (include_router / app.use). */
function applyPrefixes(scans) {
  const all = [];
  for (const [file, r] of scans) {
    for (const e of r.endpoints) {
      let mount = '';
      if (e.framework === 'fastapi' || e.framework === 'flask') {
        const mod = path.basename(file, '.py');
        const inc = scans.flatMap(([, x]) => x.includes).find((i) => i.target === `${mod}.${e.owner}` || (i.target === e.owner && i.file === file));
        if (inc) mount = inc.prefix;
      } else if (e.framework === 'express') {
        const inc = scans.flatMap(([, x]) => x.includes).find((i) => (i.target === e.owner && i.file === file) || (i.requirePath && path.resolve(path.dirname(i.file), i.requirePath).replace(/\.[cm]?[jt]s$/, '') === file.replace(/\.[cm]?[jt]s$/, '')));
        if (inc) mount = inc.prefix;
      }
      const full = joinPath(mount, e.prefix, e.route);
      all.push({ ...e, path: full, id: `${e.method} ${full} ${file}:${e.line}` });
    }
  }
  return all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

class EndpointService {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = new Map(); // file -> { mtime, scan }
  }

  files() {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 8 || out.length > 3000) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && !SKIP_DIR.test(`${p}/`)) walk(p, depth + 1);
        } else if (SCANNERS.some((s) => s.test.test(e.name))) out.push(p);
      }
    };
    if (this.ctx.root) walk(this.ctx.root, 0);
    return out;
  }

  scans(overrides = {}) {
    const out = [];
    for (const file of this.files()) {
      if (overrides[file] != null) {
        out.push([file, scanFile(file, overrides[file])]);
        continue;
      }
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const c = this.cache.get(file);
      if (c && c.mtime === st.mtimeMs) {
        out.push([file, c.scan]);
        continue;
      }
      let src = '';
      try {
        src = st.size < 1024 * 1024 ? fs.readFileSync(file, 'utf8') : '';
      } catch {
        continue;
      }
      const scan = scanFile(file, src);
      this.cache.set(file, { mtime: st.mtimeMs, scan });
      out.push([file, scan]);
    }
    return out;
  }

  list() {
    return applyPrefixes(this.scans());
  }

  /** Endpoints in one file (its unsaved text when given), with prefixes from the rest of the project. */
  forFile(file, text) {
    return applyPrefixes(this.scans(text != null ? { [file]: text } : {})).filter((e) => e.file === file);
  }

  // ------------------------------------------------------- the running app

  /** The running app an endpoint belongs to: the run session whose folder contains its file. */
  server(endpoint) {
    const inside = (dir) => dir && (endpoint.file === dir || endpoint.file.startsWith(dir + path.sep));
    const list = this.ctx.runs.servers().filter((s) => inside(s.cwd) || inside(this.ctx.root));
    list.sort((a, b) => (inside(b.cwd) ? b.cwd.length : 0) - (inside(a.cwd) ? a.cwd.length : 0));
    const s = list[0];
    if (!s) return null;
    // Prefer plain http locally (no certificate prompts); https when that is all the app listens on.
    return { sessionId: s.id, name: s.cfg.name, url: s.urls.find((u) => u.startsWith('http:')) || s.urls[0] };
  }

  /** The run configuration that starts the app serving an endpoint. */
  configFor(endpoint) {
    const root = this.ctx.root;
    const dirOf = (c) => {
      const d = c.pyRoot || c.cwd || root;
      return path.isAbsolute(d) ? d : path.join(root, d);
    };
    const fits = (c) => {
      const dir = dirOf(c);
      if (!(endpoint.file === dir || endpoint.file.startsWith(dir + path.sep))) return 0;
      const line = `${c.detail || ''} ${c.commandLine || ''} ${(c.args || []).join(' ')} ${c.command || ''}`;
      if (endpoint.framework === 'fastapi') {
        const mod = path.relative(dir, endpoint.file).replace(/\.py$/, '').split(path.sep).join('.');
        return /uvicorn|fastapi|hypercorn/.test(line) ? (line.includes(`${mod}:`) ? 3 : 2) : 0;
      }
      if (endpoint.framework === 'flask') return /flask/.test(line) ? 2 : /\.py\b/.test(line) ? 1 : 0;
      if (endpoint.framework === 'express') return /\b(start|dev|serve)\b/.test(line) && /npm|pnpm|yarn|bun|node/.test(line) ? 2 : /node\s/.test(line) ? 1 : 0;
      if (endpoint.framework === 'aspnet') return /dotnet/.test(line) && /\brun\b/.test(line) ? 2 : 0;
      return 0;
    };
    const scored = this.ctx.runs.configs().map((c) => ({ c, score: fits(c), depth: dirOf(c).length })).filter((x) => x.score > 0);
    scored.sort((a, b) => b.score - a.score || b.depth - a.depth);
    return scored.length ? scored[0].c : null;
  }

  /** The app's URL; with `start`, the app is started first when it is not running. */
  async ensureServer(endpoint, { start = true, timeout = 120000 } = {}) {
    const running = this.server(endpoint);
    if (running || !start) return running;
    const cfg = this.configFor(endpoint);
    if (!cfg) throw new Error('The app is not running, and no run configuration starts it. Start it, or enter its address.');
    const r = this.ctx.runs.start(cfg);
    if (r.error) throw new Error(r.error);
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const s = this.server(endpoint);
      if (s) return { ...s, started: cfg.name };
      const sess = this.ctx.runs.sessions.get(r.id);
      if (sess && !sess.running) throw new Error(`${cfg.name} stopped before it listened on an address; see the Run tool window.`);
      await new Promise((res) => setTimeout(res, 300));
    }
    throw new Error(`${cfg.name} did not print the address it listens on in ${Math.round(timeout / 1000)} s.`);
  }

  /**
   * Call an endpoint of the running app (started when needed): { endpoint, pathValues, query, headers,
   * body, baseUrl } -> the response. The app does the work - with its own database connection.
   */
  async send({ endpoint, pathValues = {}, query = {}, headers = {}, body = null, baseUrl = '', start = true }) {
    let base = baseUrl;
    let started = null;
    if (!base) {
      const s = await this.ensureServer(endpoint, { start });
      if (!s) throw new Error('The app is not running.');
      base = s.url;
      started = s.started || null;
    }
    const url = buildUrl(base, endpoint.path, pathValues, query);
    const req = { method: endpoint.method, url, headers, body: body == null || body === '' ? null : body };
    // A server that has just printed its address may need a moment before it accepts connections.
    const end = Date.now() + (started ? 15000 : 0);
    for (;;) {
      try {
        return { ...(await sendRequest(req)), request: { method: req.method, url }, started };
      } catch (err) {
        if (Date.now() > end || !/Nothing is listening/.test(err.message)) throw err;
        await new Promise((res) => setTimeout(res, 400));
      }
    }
  }
}

module.exports = { EndpointService, scanPython, scanExpress, scanCsharp, applyPrefixes, exampleFor, joinPath, splitParams };
