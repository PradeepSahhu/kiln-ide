'use strict';
// Message-flow analysis: which services publish to which Kafka topics, which services consume them,
// and which databases each service writes to. Static analysis over C#, Python and JS/TS sources,
// with topic names resolved from string constants, appsettings*.json, .env files and docker-compose.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const YAML = require('yaml');
const { parseDotEnv } = require('./detect');
const { readDeployment, environmentOf, parseConnection, rankSources, DB_KEY, DB_NAME_KEY, ENV_RANK } = require('./deploy-config');
const fsSvc = require('./fs');

const CODE = /\.(cs|py|ts|tsx|js|mjs|cjs)$/i;
const SKIP = /(^|\/)(node_modules|bin|obj|\.venv|venv|dist|build|\.git|__pycache__|tests?|__tests__|specs?|migrations)\//i;
const TEST_FILE = /(Tests?\.cs|_test\.py|test_[^/]*\.py|\.test\.[jt]sx?|\.spec\.[jt]sx?)$/i;

/** The text between the parenthesis at `open` and its match. */
function callArgs(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** Split call arguments at commas that are not inside (), [], {} or strings. */
function topLevelArgs(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const lineOfText = (text, needle) => {
  const i = needle ? String(text || '').indexOf(needle) : -1;
  return i < 0 ? null : String(text).slice(0, i).split('\n').length;
};

const lineAt = (src, idx) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
};

function flatten(obj, prefix = '', out = {}) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}:${k}` : k, out);
  } else if (typeof obj === 'string' || typeof obj === 'number') {
    out[prefix] = String(obj);
  }
  return out;
}

function stripJsonComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}

/** Split an argument list like `new[] { "a", Topics.B }` or `["a", "b"]` into expressions. */
function listItems(expr) {
  const m = /[{[(]([\s\S]*)[}\])]\s*$/.exec(expr.trim());
  const body = m && /^(new\b|\[|\(|\{)/.test(expr.trim()) ? m[1] : expr;
  return topLevelArgs(body).filter(Boolean);
}

const DB_BY_DOTNET_PACKAGE = [
  [/Npgsql/i, 'PostgreSQL'],
  [/EntityFrameworkCore\.SqlServer|Microsoft\.Data\.SqlClient|System\.Data\.SqlClient/i, 'SQL Server'],
  [/Sqlite/i, 'SQLite'],
  [/MySql|Pomelo/i, 'MySQL'],
  [/Cosmos/i, 'Cosmos DB'],
  [/MongoDB/i, 'MongoDB'],
  [/StackExchange\.Redis|Redis/i, 'Redis'],
  [/Oracle/i, 'Oracle'],
  [/Cassandra/i, 'Cassandra'],
  [/Elastic|NEST/i, 'Elasticsearch'],
];
const DB_BY_PY_PACKAGE = [
  [/^(psycopg2|psycopg2-binary|psycopg|asyncpg|pg8000)$/, 'PostgreSQL'],
  [/^(pymysql|mysqlclient|aiomysql|mysql-connector-python)$/, 'MySQL'],
  [/^(pyodbc|pymssql)$/, 'SQL Server'],
  [/^(pymongo|motor|beanie|mongoengine)$/, 'MongoDB'],
  [/^(redis|aioredis)$/, 'Redis'],
  [/^(elasticsearch)$/, 'Elasticsearch'],
  [/^(cassandra-driver)$/, 'Cassandra'],
  [/^(boto3)$/, 'DynamoDB'],
  [/^(aiosqlite)$/, 'SQLite'],
];

function dbFromUrl(url) {
  const m = /^([a-z0-9+]+):\/\//i.exec(url || '');
  if (!m) return null;
  const s = m[1].toLowerCase();
  if (s.startsWith('postgres')) return 'PostgreSQL';
  if (s.startsWith('mysql') || s.startsWith('mariadb')) return 'MySQL';
  if (s.startsWith('sqlite')) return 'SQLite';
  if (s.startsWith('mssql')) return 'SQL Server';
  if (s.startsWith('mongodb')) return 'MongoDB';
  if (s.startsWith('redis') || s.startsWith('rediss')) return 'Redis';
  return null;
}

async function readText(file) {
  try {
    const st = await fsp.stat(file);
    if (st.size > 2 * 1024 * 1024) return null;
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function analyzeFlow(ctx) {
  const root = ctx.root;
  const det = ctx.detection || {};
  const started = Date.now();
  const { files } = await fsSvc.listFiles(root, ctx.git.root);
  const code = files.filter((f) => CODE.test(f) && !SKIP.test('/' + f) && !TEST_FILE.test(f));
  const readRel = (f) => readText(path.join(root, f));

  // ------------------------------------------------ configuration sources
  // appsettings*.json per file (a service reads the ones in its folder), .env files, docker-compose
  // environments, and the deployment files (Kubernetes, Helm, Kustomize, Terraform) - every value
  // with the file it comes from.
  const appsettings = []; // { rel, dir, environment, flat }
  const connStrings = {};
  const brokers = new Set();
  for (const f of files.filter((x) => /(^|\/)appsettings[\w.]*\.json$/i.test(x) && !SKIP.test('/' + x))) {
    try {
      const text = (await readRel(f)) || '{}';
      const flat = flatten(JSON.parse(stripJsonComments(text)));
      const envName = (/appsettings\.(\w+)\.json$/i.exec(f) || [])[1];
      appsettings.push({ rel: f, text, dir: path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f), environment: envName ? environmentOf(envName) : 'default', flat });
      for (const [k, v] of Object.entries(flat)) {
        if (/^ConnectionStrings:/i.test(k)) connStrings[k.split(':')[1]] = v;
        if (/bootstrap|brokers?$/i.test(k) && /:\d+/.test(v)) v.split(',').forEach((b) => brokers.add(b.trim()));
      }
    } catch {
      /* invalid json */
    }
  }
  appsettings.sort((a, b) => (ENV_RANK[a.environment] ?? 2) - (ENV_RANK[b.environment] ?? 2));
  const dotenv = {}; // KEY -> { value, rel, line }
  for (const f of files.filter((x) => /(^|\/)\.env(\.[\w-]+)?$/.test(x) && !/example|sample|template/i.test(x))) {
    const text = (await readRel(f)) || '';
    for (const [k, v] of Object.entries(parseDotEnv(text))) if (!dotenv[k]) dotenv[k] = { value: v, rel: f, line: lineOfText(text, `${k}=`), key: k, source: 'dotenv', environment: environmentOf(f) };
  }
  const env = Object.fromEntries(Object.entries(dotenv).map(([k, e]) => [k, e.value]));
  const composeServices = [];
  for (const f of files.filter((x) => /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/i.test(x))) {
    try {
      const text = (await readRel(f)) || '';
      const doc = YAML.parse(text) || {};
      for (const [name, svc] of Object.entries(doc.services || {})) {
        const build = typeof svc.build === 'string' ? svc.build : svc.build && svc.build.context;
        const dir = build ? path.posix.normalize(path.posix.join(path.posix.dirname(f), build)).replace(/^\.\/?/, '') : null;
        const envList = Array.isArray(svc.environment) ? Object.fromEntries(svc.environment.map((e) => String(e).split(/=(.*)/s).slice(0, 2))) : svc.environment || {};
        const envFile = {};
        for (const ef of [].concat(svc.env_file || [])) Object.assign(envFile, parseDotEnv((await readRel(path.posix.join(path.posix.dirname(f), typeof ef === 'string' ? ef : ef.path))) || ''));
        const all = { ...envFile, ...envList };
        const entries = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { value: String(v), rel: f, line: lineOfText(text, k), key: k, source: 'compose', environment: environmentOf(f) }]));
        composeServices.push({ name, dir, env: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, String(v)])), entries, image: svc.image || null, rel: f });
        if (/kafka|redpanda/i.test(svc.image || name)) {
          for (const p of svc.ports || []) {
            const m = /(\d+):(\d+)/.exec(String(p));
            if (m && /9092|19092|29092|9093/.test(m[2])) brokers.add(`localhost:${m[1]}`);
          }
        }
        for (const v of Object.values(all)) if (typeof v === 'string' && /^[\w.-]+:\d{4,5}(,[\w.-]+:\d{4,5})*$/.test(v) && /KAFKA|BOOTSTRAP|BROKER/i.test(JSON.stringify(all))) v.split(',').forEach((b) => /localhost|127\.0\.0\.1/.test(b) && brokers.add(b));
      }
    } catch {
      /* invalid yaml */
    }
  }
  for (const [k, v] of Object.entries(env)) if (/BOOTSTRAP|BROKERS?$/i.test(k) && /:\d+/.test(v)) v.split(',').forEach((b) => brokers.add(b.trim()));
  const deploy = await readDeployment(files, readRel);

  // ---------------------------------------------------------- services
  const services = new Map();
  const dotnetProjects = ((det.dotnet && det.dotnet.projects) || []).map((p) => ({ dir: path.relative(root, p.dir).split(path.sep).join('/'), name: p.name, kind: 'dotnet', packages: p.packages.map((x) => x.name) }));
  const pyRoots = ((det.python && det.python.roots) || []).map((r) => ({ dir: path.relative(root, r.dir).split(path.sep).join('/'), name: r.name, kind: 'python', deps: r.deps }));
  const nodeRoots = ((det.node && det.node.roots) || []).map((r) => ({ dir: path.relative(root, r.dir).split(path.sep).join('/'), name: r.name, kind: 'node', deps: r.deps }));
  const owners = [...composeServices.filter((c) => c.dir != null).map((c) => ({ dir: c.dir, name: c.name, kind: 'compose', env: c.env })), ...dotnetProjects, ...pyRoots, ...nodeRoots].sort((a, b) => b.dir.length - a.dir.length);
  const covers = (dir, rel) => dir === '' || dir === '.' || rel === dir || rel.startsWith(dir + '/');
  const serviceFor = (rel) => {
    const lang = rel.endsWith('.cs') ? 'dotnet' : rel.endsWith('.py') ? 'python' : 'node';
    // Name: the docker-compose service that builds this folder, else the project, else the top folder.
    // Packages (used to tell which database is written to) always come from the language project.
    const project = owners.find((x) => x.kind !== 'compose' && covers(x.dir, rel));
    const compose = composeServices.find((c) => c.dir != null && c.dir !== '' && covers(c.dir, rel));
    let name;
    if (compose) name = compose.name;
    else if (project && project.dir !== '' && project.dir !== '.') name = project.name;
    else name = rel.includes('/') ? rel.split('/')[0] : project ? project.name : path.basename(root);
    const id = `svc:${name}`;
    if (!services.has(id)) {
      const dir = compose ? compose.dir : project ? project.dir : '';
      // What the service is deployed with: the Kubernetes / Helm workloads that run it.
      const deployed = deploy.envFor({ name, dirName: dir ? path.posix.basename(dir) : '', projectName: project && project.name });
      services.set(id, { id, name, lang: project ? project.kind : lang, dir, env: compose ? compose.env : {}, composeEntries: compose ? compose.entries : {}, deployEnv: deployed.env, deployments: deployed.workloads, packages: (project && (project.packages || project.deps)) || [], files: new Set() });
    }
    const s = services.get(id);
    s.files.add(rel);
    return s;
  };

  // ------------------------------------------------- constants per file
  const constants = {};
  const sources = new Map();
  for (const rel of code) {
    const src = await readText(path.join(root, rel));
    if (!src) continue;
    sources.set(rel, src);
    if (rel.endsWith('.cs')) for (const m of src.matchAll(/\b(?:const|static\s+readonly)\s+string\s+(\w+)\s*=\s*"([^"]*)"/g)) constants[m[1]] = m[2];
    else if (rel.endsWith('.py')) {
      for (const m of src.matchAll(/^\s*([A-Za-z_][\w]*)\s*(?::\s*str\s*)?=\s*(?:os\.(?:getenv|environ\.get)\(\s*["'](\w+)["']\s*,\s*)?["']([^"'\n]+)["']/gm)) constants[m[1]] = m[2] ? { env: m[2], fallback: m[3] } : m[3];
      // pydantic settings: each field is read from the env var of its name (with env_prefix).
      for (const c of src.matchAll(/^class\s+\w+\s*\(\s*(?:pydantic_settings\.)?BaseSettings\s*\)\s*:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/gm)) {
        const prefix = (/env_prefix\s*=\s*["']([^"']*)["']/.exec(c[1]) || [])[1] || '';
        for (const f of c[1].matchAll(/^[ \t]+(\w+)\s*:\s*str\s*=\s*["']([^"'\n]*)["']/gm)) constants[f[1]] = { env: `${prefix}${f[1]}`.toUpperCase(), fallback: f[2] };
      }
    } else for (const m of src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*["'`]([^"'`\n]+)["'`]/g)) constants[m[1]] = m[2];
  }

  // ------------------------------------------------- resolving names
  const sourceLabel = (e) => (e.rel ? `${e.rel}${e.line ? `:${e.line}` : ''}` : e.key || '');
  const sourceOf = (e) => ({ value: e.secret ? undefined : e.value, rel: e.rel || null, file: e.rel ? path.join(root, e.rel) : null, line: e.line || null, key: e.key, from: e.from || null, fromKey: e.fromKey || null, environment: e.environment || 'default', source: e.source, workload: e.workload || null, secret: !!e.secret });
  /** Candidates for an env var of a service: deployment (best environment first), compose, .env. */
  const envCandidates = (svc, name) => {
    const ci = (obj) => Object.keys(obj || {}).find((k) => k.toLowerCase() === String(name).toLowerCase());
    const out = [];
    const dk = ci(svc.deployEnv);
    if (dk) out.push(...svc.deployEnv[dk]);
    const ck = ci(svc.composeEntries);
    if (ck) out.push(svc.composeEntries[ck]);
    const ek = ci(dotenv);
    if (ek) out.push(dotenv[ek]);
    return out;
  };
  /** Candidates for a .NET configuration key: env (Kafka__Topic), then the service's appsettings. */
  const configCandidates = (svc, key) => {
    const out = envCandidates(svc, key.replace(/:/g, '__'));
    const lower = key.toLowerCase();
    const mine = appsettings.filter((a) => svc.dir === '' || a.dir === svc.dir || a.dir.startsWith(svc.dir + '/') || (svc.dir && svc.dir.startsWith(a.dir + '/')));
    for (const a of mine.length ? mine : appsettings) {
      const hit = Object.keys(a.flat).find((k) => k.toLowerCase() === lower);
      if (hit) out.push({ value: a.flat[hit], rel: a.rel, line: lineOfText(a.text, `"${hit.split(':').pop()}"`), key: hit, source: 'appsettings', environment: a.environment });
    }
    return out;
  };
  /** Options classes bound from configuration: `_options.OrdersTopic` -> a key ending in OrdersTopic. */
  const memberCandidates = (svc, ident) => {
    const forms = new Set([ident.toLowerCase(), ident.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()]);
    const last = (k) => k.split(/__|:|\./).pop().toLowerCase();
    const out = [];
    for (const [k, list] of Object.entries(svc.deployEnv || {})) if (forms.has(last(k)) || [...forms].some((f) => k.toLowerCase().endsWith(`_${f}`) || k.toLowerCase() === f)) out.push(...list);
    for (const [k, e] of Object.entries(svc.composeEntries || {})) if (forms.has(last(k)) || forms.has(k.toLowerCase())) out.push(e);
    for (const a of appsettings.filter((x) => svc.dir === '' || x.dir === svc.dir || x.dir.startsWith(svc.dir + '/'))) for (const [k, v] of Object.entries(a.flat)) if (forms.has(last(k))) out.push({ value: v, rel: a.rel, line: lineOfText(a.text, `"${k.split(':').pop()}"`), key: k, source: 'appsettings', environment: a.environment });
    return out.sort(rankSources);
  };
  const pick = (candidates, fallback, via) => {
    const list = candidates.filter((c) => c && c.value != null && c.value !== '');
    if (!list.length) return fallback != null ? { name: fallback, resolved: true, via: via ? `${via} (default in code)` : 'code', sources: [{ value: fallback, source: 'code', environment: 'default' }] } : null;
    const best = list[0];
    return { name: best.value, resolved: true, via: sourceLabel(best), sources: list.map(sourceOf) };
  };

  const resolve = (expr, svc) => {
    let e = String(expr || '').trim().replace(/^(topic|topics|name)\s*[=:]\s*/, '');
    if (!e) return null;
    let m;
    if ((m = /^@?\$?"([^"{}]*)"$/.exec(e)) || (m = /^[rbuf]?["']([^"']*)["']$/.exec(e)) || (m = /^`([^`$]*)`$/.exec(e))) return { name: m[1], resolved: true, via: 'code', sources: [{ value: m[1], source: 'code', environment: 'default' }] };
    if ((m = /(?:configuration|config|_config|_configuration|Configuration)\s*\[\s*"([^"]+)"\s*\]/.exec(e)) || (m = /GetValue<\w+>\s*\(\s*"([^"]+)"/.exec(e)) || (m = /GetSection\s*\(\s*"([^"]+)"\s*\)\s*\[\s*"([^"]+)"\s*\]/.exec(e))) {
      const key = m[2] ? `${m[1]}:${m[2]}` : m[1];
      return pick(configCandidates(svc, key)) || { name: key, resolved: false, sources: [] };
    }
    if ((m = /os\.(?:getenv|environ\.get)\s*\(\s*["'](\w+)["'](?:\s*,\s*["']([^"']*)["'])?/.exec(e)) || (m = /os\.environ\s*\[\s*["'](\w+)["']\s*\]/.exec(e)) || (m = /process\.env\.(\w+)(?:\s*(?:\|\||\?\?)\s*["'`]([^"'`]+)["'`])?/.exec(e)) || (m = /Environment\.GetEnvironmentVariable\s*\(\s*"(\w+)"\s*\)(?:\s*\?\?\s*"([^"]+)")?/.exec(e))) {
      return pick(envCandidates(svc, m[1]), m[2], `$${m[1]}`) || { name: `$${m[1]}`, resolved: false, sources: [] };
    }
    const ident = e.split(/[.\s]/).filter(Boolean).pop();
    if (ident && constants[ident] != null) {
      const c = constants[ident];
      if (typeof c === 'string') return { name: c, resolved: true, via: ident, sources: [{ value: c, source: 'code', environment: 'default' }] };
      return pick(envCandidates(svc, c.env), c.fallback, `$${c.env}`);
    }
    // A member of an options / settings object: the configuration key or env var of the same name.
    if (ident && /\./.test(e)) {
      const r = pick(memberCandidates(svc, ident));
      if (r) return r;
    }
    if (/^[\w.[\]"']+$/.test(e)) return { name: e.length > 40 ? e.slice(0, 40) + '…' : e, resolved: false, sources: [] };
    return null;
  };

  /** A consumer group the code does not name: the group the deployment configures for the service. */
  const deployedGroup = (svc) => {
    const keys = Object.keys(svc.deployEnv || {}).concat(Object.keys(svc.composeEntries || {}));
    const key = keys.find((k) => /(group_?id|consumer_?group|groupid|__group)$/i.test(k) && /kafka|consumer|group/i.test(k));
    return key ? pick(envCandidates(svc, key)) : null;
  };

  // ----------------------------------------------------------- scanning
  const edges = new Map();
  const topics = new Map();
  const dbs = new Map();
  const addSources = (into, list) => {
    for (const x of list || []) if (!into.some((y) => y.rel === x.rel && y.line === x.line && y.key === x.key && y.value === x.value)) into.push(x);
  };
  const addEdge = (from, to, kind, ref) => {
    const key = `${from}|${to}|${kind}`;
    if (!edges.has(key)) edges.set(key, { id: key, from, to, kind, refs: [], tables: new Set(), groups: new Set(), groupSources: [] });
    const e = edges.get(key);
    if (e.refs.length < 50) e.refs.push(ref);
    if (ref.table) e.tables.add(ref.table);
    if (ref.group) e.groups.add(ref.group);
    if (ref.groupSources) addSources(e.groupSources, ref.groupSources);
  };
  const topicNode = (t) => {
    const id = `topic:${t.name}`;
    if (!topics.has(id)) topics.set(id, { id, name: t.name, resolved: t.resolved, via: new Set(), sources: [] });
    if (t.via) topics.get(id).via.add(t.via);
    if (t.resolved) topics.get(id).resolved = true;
    addSources(topics.get(id).sources, t.sources);
    return id;
  };
  const dbNode = (svc, type, info) => {
    const label = (info && info.name) || type;
    const id = `db:${type}:${label}`;
    if (!dbs.has(id)) dbs.set(id, { id, type, name: label, hosts: new Set(), sources: [] });
    const d = dbs.get(id);
    if (info && info.host) d.hosts.add(info.host);
    if (info) addSources(d.sources, info.sources);
    return id;
  };
  const snippet = (src, idx) => {
    const s = src.lastIndexOf('\n', idx) + 1;
    const e = src.indexOf('\n', idx);
    return src.slice(s, e < 0 ? undefined : e).trim().slice(0, 200);
  };

  const dbTypesFor = (svc, src, rel) => {
    const types = new Set();
    for (const p of svc.packages || []) {
      for (const [re, t] of rel.endsWith('.cs') ? DB_BY_DOTNET_PACKAGE : DB_BY_PY_PACKAGE) if (re.test(p)) types.add(t);
    }
    if (/import sqlite3|sqlite3\.connect/.test(src)) types.add('SQLite');
    const deployed = [...Object.values(svc.deployEnv || {}).flat(), ...Object.values(svc.composeEntries || {})].map((e) => e.value);
    for (const v of [...deployed, ...Object.values(env), ...Object.values(svc.env || {}), ...Object.values(connStrings)]) {
      const t = dbFromUrl(String(v));
      if (t) types.add(t);
    }
    return [...types];
  };
  /**
   * The database a service really uses: the connection string / URL / database name in its
   * deployment (production first), compose environment or .env, then its appsettings. Credentials
   * in connection strings are never kept.
   */
  const dbInfo = (svc, type) => {
    const candidates = [];
    const consider = (key, e) => {
      if (DB_KEY.test(key)) {
        const c = parseConnection(e.value);
        if (c && (!type || !c.type || c.type === type || type === 'SQL')) candidates.push({ ...e, value: c.name, host: c.host, dbType: c.type });
      } else if (DB_NAME_KEY.test(key) && e.value) candidates.push({ ...e, value: e.value });
    };
    for (const [k, list] of Object.entries(svc.deployEnv || {})) for (const e of list) consider(k, e);
    for (const [k, e] of Object.entries(svc.composeEntries || {})) consider(k, e);
    for (const [k, e] of Object.entries(dotenv)) consider(k, e);
    for (const a of appsettings.filter((x) => svc.dir === '' || x.dir === svc.dir || x.dir.startsWith(svc.dir + '/'))) {
      for (const [k, v] of Object.entries(a.flat)) if (/^ConnectionStrings:/i.test(k)) consider(`ConnectionStrings__${k.split(':')[1]}`, { value: v, rel: a.rel, line: lineOfText(a.text, `"${k.split(':')[1]}"`), key: k, source: 'appsettings', environment: a.environment });
    }
    const named = candidates.filter((c) => c.value).sort(rankSources);
    if (!named.length) {
      const keys = Object.keys(connStrings);
      return keys.length === 1 ? { name: keys[0], sources: [] } : null;
    }
    return { name: named[0].value, host: named[0].host || null, sources: named.map((c) => ({ ...sourceOf({ ...c, secret: false }), value: c.value, host: c.host || null, secret: !!c.secret })) };
  };

  for (const [rel, src] of sources) {
    const svc = serviceFor(rel);
    const file = path.join(root, rel);
    const produce = (expr, idx, framework, group) => {
      const t = resolve(expr, svc);
      if (!t || !t.name) return;
      addEdge(svc.id, topicNode(t), 'produce', { file, rel, line: lineAt(src, idx), snippet: snippet(src, idx), framework, group });
    };
    const consume = (expr, idx, framework, group) => {
      // The consumer group: as the code names it (resolved like topic names), else as deployed.
      const g = group && typeof group === 'object' ? group : group ? { name: group, sources: [] } : deployedGroup(svc);
      for (const item of listItems(expr)) {
        const t = resolve(item, svc);
        if (!t || !t.name) continue;
        addEdge(topicNode(t), svc.id, 'consume', { file, rel, line: lineAt(src, idx), snippet: snippet(src, idx), framework, group: g ? g.name : undefined, groupSources: g ? g.sources : [] });
      }
    };
    const write = (type, table, idx, framework) => {
      const info = type === 'Redis' ? null : dbInfo(svc, type);
      addEdge(svc.id, dbNode(svc, type, info), 'write', { file, rel, line: lineAt(src, idx), snippet: snippet(src, idx), framework, table });
    };
    let m;
    if (rel.endsWith('.cs')) {
      const kafka = /Confluent\.Kafka|IProducer<|IConsumer<|ProducerBuilder|ConsumerBuilder/.test(src);
      const group = (/GroupId\s*=\s*([^,;\n}]+)/.exec(src) || [])[1];
      const groupName = group ? resolve(group, svc) || undefined : undefined;
      if (kafka) {
        for (m of src.matchAll(/\.Produce(?:Async)?\s*\(\s*([^,()]+(?:\([^()]*\))?[^,()]*?)\s*,/g)) produce(m[1].replace(/^new\s+TopicPartition\s*\(\s*([^,]+),.*$/, '$1'), m.index, 'Confluent.Kafka');
        for (m of src.matchAll(/\.Subscribe\s*\(\s*([^;]+?)\)\s*;/g)) consume(m[1], m.index, 'Confluent.Kafka', groupName);
        for (m of src.matchAll(/\.Assign\s*\(\s*new\s+TopicPartition(?:Offset)?\s*\(\s*([^,]+),/g)) consume(m[1], m.index, 'Confluent.Kafka', groupName);
      }
      for (m of src.matchAll(/\.AddProducer<[^>]+>\s*\(\s*([^,)]+)/g)) produce(m[1], m.index, 'MassTransit');
      for (m of src.matchAll(/\.TopicEndpoint<[^>]+>\s*\(\s*([^,)]+)(?:\s*,\s*([^,)]+))?/g)) consume(m[1], m.index, 'MassTransit', m[2] ? (resolve(m[2], svc) || {}).name : undefined);
      if (/KafkaFlow/.test(src)) {
        for (m of src.matchAll(/\.DefaultTopic\s*\(\s*([^)]+)\)/g)) produce(m[1], m.index, 'KafkaFlow');
        for (m of src.matchAll(/\.Topics?\s*\(\s*([^)]+)\)/g)) consume(m[1], m.index, 'KafkaFlow', groupName);
      }
      for (m of src.matchAll(/\[Topic\s*\(\s*"[^"]+"\s*,\s*([^,)\]]+)/g)) consume(m[1], m.index, 'Dapr pub/sub');
      for (m of src.matchAll(/PublishEventAsync\s*\(\s*"[^"]+"\s*,\s*([^,)]+)/g)) produce(m[1], m.index, 'Dapr pub/sub');
      // Databases
      const types = dbTypesFor(svc, src, rel);
      const relational = types.find((t) => !['MongoDB', 'Redis', 'Elasticsearch', 'Cassandra'].includes(t)) || 'SQL';
      if (/SaveChanges(Async)?\s*\(|DbContext/.test(src)) {
        let any = false;
        for (m of src.matchAll(/\b\w+\.(\w+)\.(Add|AddRange|AddAsync|AddRangeAsync|Update|UpdateRange|Remove|RemoveRange|ExecuteUpdate|ExecuteDelete|ExecuteUpdateAsync|ExecuteDeleteAsync)\s*\(/g)) {
          if (/^(Items|Headers|Properties|Values|Keys|Services)$/.test(m[1])) continue;
          write(types.find((t) => t === 'Cosmos DB' || t === 'MongoDB') || relational, m[1], m.index, 'EF Core');
          any = true;
        }
        if (!any && (m = /SaveChanges(Async)?\s*\(/.exec(src))) write(relational, null, m.index, 'EF Core');
      }
      for (m of src.matchAll(/"\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+\[?([\w.]+)\]?/gi)) write(relational, m[2], m.index, 'SQL');
      if (/MongoDB\.Driver|IMongoCollection/.test(src)) {
        const coll = (/GetCollection<\w+>\s*\(\s*([^)]+)\)/.exec(src) || [])[1];
        const collName = coll ? (resolve(coll, svc) || {}).name : null;
        for (m of src.matchAll(/\.(InsertOne|InsertMany|ReplaceOne|UpdateOne|UpdateMany|BulkWrite|DeleteOne|DeleteMany)(Async)?\s*\(/g)) write('MongoDB', collName, m.index, 'MongoDB.Driver');
      }
      if (/StackExchange\.Redis|IDatabase/.test(src)) for (m of src.matchAll(/\.(StringSet|HashSet|ListRightPush|ListLeftPush|SetAdd|SortedSetAdd|StreamAdd)(Async)?\s*\(/g)) write('Redis', null, m.index, 'StackExchange.Redis');
    } else if (rel.endsWith('.py')) {
      const group = (/group_id\s*=\s*((?:os\.(?:getenv|environ\.get)\s*\([^)]*\))|[^,)\n]+)|['"]group\.id['"]\s*:\s*((?:os\.(?:getenv|environ\.get)\s*\([^)]*\))|[^,}\n]+)/.exec(src) || []).slice(1).find(Boolean);
      const groupName = group ? resolve(group, svc) || undefined : undefined;
      if (/kafka|aiokafka|confluent_kafka/i.test(src)) {
        for (m of src.matchAll(/(\w*producer\w*)\s*\.\s*(?:send|send_and_wait)\s*\(\s*([^,)]+)/gi)) produce(m[2], m.index, /aiokafka/.test(src) ? 'aiokafka' : 'kafka-python');
        if (/confluent_kafka/.test(src)) for (m of src.matchAll(/\.\s*produce\s*\(\s*([^,)]+)/g)) produce(m[1], m.index, 'confluent-kafka');
        for (m of src.matchAll(/(?:KafkaConsumer|AIOKafkaConsumer)\s*\(/g)) {
          // Positional arguments are topics: split at top-level commas (not inside getenv(...) etc.).
          const args = topLevelArgs(callArgs(src, m.index + m[0].length - 1));
          const positional = args.filter((s) => s && !/^\w+\s*=/.test(s) && !/^\*\*?/.test(s));
          for (const p of positional) consume(p, m.index, /AIO/.test(m[0]) ? 'aiokafka' : 'kafka-python', groupName);
        }
        for (m of src.matchAll(/\.\s*subscribe\s*\(\s*(?:topics\s*=\s*)?(\[[^\]]*\]|\([^)]*\)|[^,)]+)/g)) consume(m[1], m.index, /confluent_kafka/.test(src) ? 'confluent-kafka' : 'kafka-python', groupName);
      }
      if (/faust/.test(src)) {
        const topicVars = {};
        for (m of src.matchAll(/(\w+)\s*=\s*\w+\.topic\s*\(\s*([^,)]+)/g)) topicVars[m[1]] = m[2];
        for (m of src.matchAll(/@\w+\.agent\s*\(\s*(\w+)/g)) if (topicVars[m[1]]) consume(topicVars[m[1]], m.index, 'Faust');
        for (m of src.matchAll(/(\w+)\.send\s*\(/g)) if (topicVars[m[1]]) produce(topicVars[m[1]], m.index, 'Faust');
      }
      if (/faststream/.test(src)) {
        for (m of src.matchAll(/@\w+\.subscriber\s*\(\s*([^,)]+)/g)) consume(m[1], m.index, 'FastStream', groupName);
        for (m of src.matchAll(/@\w+\.publisher\s*\(\s*([^,)]+)/g)) produce(m[1], m.index, 'FastStream');
        for (m of src.matchAll(/\bbroker\.publish\s*\([^,]+,\s*(?:topic\s*=\s*)?([^,)]+)/g)) produce(m[1], m.index, 'FastStream');
      }
      // Databases
      const types = dbTypesFor(svc, src, rel);
      const relational = types.find((t) => !['MongoDB', 'Redis', 'Elasticsearch', 'Cassandra', 'DynamoDB'].includes(t)) || 'SQL';
      const tables = {};
      for (m of src.matchAll(/class\s+(\w+)\s*\([^)]*\)\s*:[\s\S]{0,400}?__tablename__\s*=\s*["']([^"']+)["']/g)) tables[m[1]] = m[2];
      for (m of src.matchAll(/\b\w*session\w*\.(add|add_all|merge|bulk_save_objects)\s*\(\s*(\w+)?/g)) write(relational, tables[m[2]] || (m[2] && /^[A-Z]/.test(m[2]) ? m[2] : null), m.index, 'SQLAlchemy');
      for (m of src.matchAll(/(\w+)\.objects\.(create|bulk_create|update_or_create|get_or_create|update)\s*\(/g)) write(relational, m[1], m.index, 'Django ORM');
      for (m of src.matchAll(/["'`]\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|UPSERT\s+INTO)\s+["`]?([\w.]+)/gi)) write(relational, m[2], m.index, 'SQL');
      if (/pymongo|motor|MongoClient/.test(src)) {
        for (m of src.matchAll(/\[\s*["']([\w.-]+)["']\s*\]\s*\.(insert_one|insert_many|update_one|update_many|replace_one|delete_one|delete_many|bulk_write)\s*\(/g)) write('MongoDB', m[1], m.index, 'pymongo');
        for (m of src.matchAll(/\.(\w+)\.(insert_one|insert_many|update_one|update_many|replace_one|bulk_write)\s*\(/g)) write('MongoDB', m[1], m.index, 'pymongo');
      }
      if (/import redis|from redis|aioredis/.test(src)) for (m of src.matchAll(/\b\w*(?:redis|cache|r)\w*\.(set|hset|lpush|rpush|xadd|sadd|zadd)\s*\(/gi)) write('Redis', null, m.index, 'redis-py');
      if (/boto3/.test(src)) for (m of src.matchAll(/\.put_item\s*\(/g)) write('DynamoDB', (/Table\s*\(\s*["']([^"']+)["']/.exec(src) || [])[1] || null, m.index, 'boto3');
    } else {
      if (/kafkajs|producer|consumer/i.test(src)) {
        for (m of src.matchAll(/\.send\s*\(\s*\{[^}]*?topic\s*:\s*([^,}\n]+)/g)) produce(m[1], m.index, 'kafkajs');
        const jsGroup = (/groupId\s*:\s*([^,}\n]+)/.exec(src) || [])[1];
        for (m of src.matchAll(/\.subscribe\s*\(\s*\{[^}]*?topics?\s*:\s*(\[[^\]]*\]|[^,}\n]+)/g)) consume(m[1], m.index, 'kafkajs', jsGroup ? resolve(jsGroup, svc) || undefined : undefined);
      }
      for (m of src.matchAll(/\bprisma\.(\w+)\.(create|createMany|update|updateMany|upsert|delete)\s*\(/g)) write('SQL', m[1], m.index, 'Prisma');
    }
  }

  // Only services that take part in the flow are drawn.
  const used = new Set();
  for (const e of edges.values()) {
    used.add(e.from);
    used.add(e.to);
  }
  const serviceList = [...services.values()].filter((s) => used.has(s.id)).map((s) => ({ id: s.id, name: s.name, lang: s.lang, dir: s.dir, files: s.files.size, deployments: s.deployments || [] }));
  // Topics the deployment declares (Strimzi KafkaTopic, Terraform, Helm values): partitions and
  // replicas for the topics in the graph, and the declared topics no code uses.
  const declared = new Map();
  for (const t of deploy.topics) {
    if (!declared.has(t.name)) declared.set(t.name, []);
    declared.get(t.name).push({ ...t, file: path.join(root, t.rel) });
  }
  const topicList = [...topics.values()].map((t) => ({ id: t.id, name: t.name, resolved: t.resolved, via: [...t.via], sources: t.sources.filter((x) => x.source !== 'code' || t.sources.length === 1), declared: declared.get(t.name) || [], variants: variantsOf(t.sources) }));
  return {
    services: serviceList,
    topics: topicList,
    databases: [...dbs.values()].map((d) => ({ ...d, hosts: [...d.hosts], variants: variantsOf(d.sources) })),
    edges: [...edges.values()].map((e) => ({ ...e, tables: [...e.tables], groups: [...e.groups], groupVariants: variantsOf(e.groupSources) })),
    declaredTopics: [...declared].filter(([name]) => !topics.has(`topic:${name}`)).map(([name, list]) => ({ name, declared: list })),
    deploymentFiles: [...new Set(deploy.files)].sort(),
    brokers: [...brokers],
    scanned: sources.size,
    ms: Date.now() - started,
  };
}

/** The value per environment when environments differ ({ prod: 'orders', dev: 'orders-dev' }). */
function variantsOf(sources) {
  const by = {};
  for (const x of sources || []) if (x.value != null && x.source !== 'code' && !(x.environment in by)) by[x.environment] = x.value;
  return new Set(Object.values(by)).size > 1 ? by : null;
}

module.exports = { analyzeFlow };
