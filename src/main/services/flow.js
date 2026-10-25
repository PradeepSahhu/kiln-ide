'use strict';
// Message-flow analysis: which services publish to which Kafka topics, which services consume them,
// and which databases each service writes to. Static analysis over C#, Python and JS/TS sources,
// with topic names resolved from string constants, appsettings*.json, .env files and docker-compose.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const YAML = require('yaml');
const { parseDotEnv } = require('./detect');
const fsSvc = require('./fs');

const CODE = /\.(cs|py|ts|tsx|js|mjs|cjs)$/i;
const SKIP = /(^|\/)(node_modules|bin|obj|\.venv|venv|dist|build|\.git|__pycache__|tests?|__tests__|specs?|migrations)\//i;
const TEST_FILE = /(Tests?\.cs|_test\.py|test_[^/]*\.py|\.test\.[jt]sx?|\.spec\.[jt]sx?)$/i;

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
  return body
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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

  // ------------------------------------------------ configuration sources
  const config = {}; // "Kafka:Topic" -> value (appsettings)
  const env = {}; // .env + compose environment
  const connStrings = {};
  const brokers = new Set();
  for (const f of files.filter((x) => /(^|\/)appsettings[\w.]*\.json$/i.test(x))) {
    try {
      const flat = flatten(JSON.parse(stripJsonComments((await readText(path.join(root, f))) || '{}')));
      Object.assign(config, flat);
      for (const [k, v] of Object.entries(flat)) {
        if (/^ConnectionStrings:/i.test(k)) connStrings[k.split(':')[1]] = v;
        if (/bootstrap|brokers?$/i.test(k) && /:\d+/.test(v)) v.split(',').forEach((b) => brokers.add(b.trim()));
      }
    } catch {
      /* invalid json */
    }
  }
  for (const f of files.filter((x) => /(^|\/)\.env(\.[\w-]+)?$/.test(x) && !/example|sample|template/i.test(x))) Object.assign(env, parseDotEnv((await readText(path.join(root, f))) || ''));
  const composeServices = [];
  for (const f of files.filter((x) => /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/i.test(x))) {
    try {
      const doc = YAML.parse((await readText(path.join(root, f))) || '') || {};
      for (const [name, svc] of Object.entries(doc.services || {})) {
        const build = typeof svc.build === 'string' ? svc.build : svc.build && svc.build.context;
        const dir = build ? path.posix.normalize(path.posix.join(path.posix.dirname(f), build)).replace(/^\.\/?/, '') : null;
        const envList = Array.isArray(svc.environment) ? Object.fromEntries(svc.environment.map((e) => String(e).split(/=(.*)/s).slice(0, 2))) : svc.environment || {};
        composeServices.push({ name, dir, env: envList, image: svc.image || null });
        if (/kafka|redpanda/i.test(svc.image || name)) {
          for (const p of svc.ports || []) {
            const m = /(\d+):(\d+)/.exec(String(p));
            if (m && /9092|19092|29092|9093/.test(m[2])) brokers.add(`localhost:${m[1]}`);
          }
        }
        for (const v of Object.values(envList)) if (typeof v === 'string' && /^[\w.-]+:\d{4,5}(,[\w.-]+:\d{4,5})*$/.test(v) && /KAFKA|BOOTSTRAP|BROKER/i.test(JSON.stringify(envList))) v.split(',').forEach((b) => /localhost|127\.0\.0\.1/.test(b) && brokers.add(b));
      }
    } catch {
      /* invalid yaml */
    }
  }
  for (const [k, v] of Object.entries(env)) if (/BOOTSTRAP|BROKERS?$/i.test(k) && /:\d+/.test(v)) v.split(',').forEach((b) => brokers.add(b.trim()));

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
    if (!services.has(id)) services.set(id, { id, name, lang: project ? project.kind : lang, dir: compose ? compose.dir : project ? project.dir : '', env: compose ? compose.env : {}, packages: (project && (project.packages || project.deps)) || [], files: new Set() });
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
    else if (rel.endsWith('.py')) for (const m of src.matchAll(/^\s*([A-Za-z_][\w]*)\s*(?::\s*str\s*)?=\s*(?:os\.getenv\(\s*["'](\w+)["']\s*,\s*)?["']([^"'\n]+)["']/gm)) constants[m[1]] = m[2] ? { env: m[2], fallback: m[3] } : m[3];
    else for (const m of src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*["'`]([^"'`\n]+)["'`]/g)) constants[m[1]] = m[2];
  }

  const resolve = (expr, svc) => {
    let e = String(expr || '').trim().replace(/^(topic|topics|name)\s*[=:]\s*/, '');
    if (!e) return null;
    let m;
    if ((m = /^@?\$?"([^"{}]*)"$/.exec(e)) || (m = /^[rbuf]?["']([^"']*)["']$/.exec(e)) || (m = /^`([^`$]*)`$/.exec(e))) return { name: m[1], resolved: true };
    if ((m = /(?:configuration|config|_config|_configuration|Configuration)\s*\[\s*"([^"]+)"\s*\]/.exec(e)) || (m = /GetValue<\w+>\s*\(\s*"([^"]+)"/.exec(e)) || (m = /GetSection\s*\(\s*"([^"]+)"\s*\)\s*\[\s*"([^"]+)"\s*\]/.exec(e))) {
      const key = m[2] ? `${m[1]}:${m[2]}` : m[1];
      const hit = Object.keys(config).find((k) => k.toLowerCase() === key.toLowerCase());
      return hit ? { name: config[hit], resolved: true, via: key } : { name: key, resolved: false };
    }
    if ((m = /os\.(?:getenv|environ\.get)\s*\(\s*["'](\w+)["'](?:\s*,\s*["']([^"']*)["'])?/.exec(e)) || (m = /os\.environ\s*\[\s*["'](\w+)["']\s*\]/.exec(e)) || (m = /process\.env\.(\w+)(?:\s*(?:\|\||\?\?)\s*["'`]([^"'`]+)["'`])?/.exec(e)) || (m = /Environment\.GetEnvironmentVariable\s*\(\s*"(\w+)"\s*\)(?:\s*\?\?\s*"([^"]+)")?/.exec(e))) {
      const v = (svc.env && svc.env[m[1]]) || env[m[1]] || m[2];
      return v ? { name: v, resolved: true, via: `$${m[1]}` } : { name: `$${m[1]}`, resolved: false };
    }
    const ident = e.split(/[.\s]/).filter(Boolean).pop();
    if (ident && constants[ident] != null) {
      const c = constants[ident];
      if (typeof c === 'string') return { name: c, resolved: true, via: ident };
      const v = (svc.env && svc.env[c.env]) || env[c.env] || c.fallback;
      return { name: v, resolved: true, via: `$${c.env}` };
    }
    if (/^[\w.[\]"']+$/.test(e)) return { name: e.length > 40 ? e.slice(0, 40) + '…' : e, resolved: false };
    return null;
  };

  // ----------------------------------------------------------- scanning
  const edges = new Map();
  const topics = new Map();
  const dbs = new Map();
  const addEdge = (from, to, kind, ref) => {
    const key = `${from}|${to}|${kind}`;
    if (!edges.has(key)) edges.set(key, { id: key, from, to, kind, refs: [], tables: new Set(), groups: new Set() });
    const e = edges.get(key);
    if (e.refs.length < 50) e.refs.push(ref);
    if (ref.table) e.tables.add(ref.table);
    if (ref.group) e.groups.add(ref.group);
  };
  const topicNode = (t) => {
    const id = `topic:${t.name}`;
    if (!topics.has(id)) topics.set(id, { id, name: t.name, resolved: t.resolved, via: new Set() });
    if (t.via) topics.get(id).via.add(t.via);
    if (t.resolved) topics.get(id).resolved = true;
    return id;
  };
  const dbNode = (svc, type, name) => {
    const label = name || type;
    const id = `db:${type}:${label}`;
    if (!dbs.has(id)) dbs.set(id, { id, type, name: label });
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
    for (const v of [...Object.values(env), ...Object.values(svc.env || {}), ...Object.values(connStrings)]) {
      const t = dbFromUrl(String(v));
      if (t) types.add(t);
    }
    return [...types];
  };
  const dbName = () => {
    const names = Object.values(connStrings).map((cs) => (/(?:Database|Initial Catalog)\s*=\s*([^;]+)/i.exec(cs) || [])[1]).filter(Boolean);
    if (names.length === 1) return names[0];
    const url = Object.values(env).find((v) => dbFromUrl(String(v)));
    if (url) {
      const m = /\/([\w-]+)(\?|$)/.exec(String(url).replace(/^[a-z+]+:\/\/[^/]*/i, ''));
      if (m) return m[1];
    }
    const keys = Object.keys(connStrings);
    return keys.length === 1 ? keys[0] : null;
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
      for (const item of listItems(expr)) {
        const t = resolve(item, svc);
        if (!t || !t.name) continue;
        addEdge(topicNode(t), svc.id, 'consume', { file, rel, line: lineAt(src, idx), snippet: snippet(src, idx), framework, group });
      }
    };
    const write = (type, table, idx, framework) => {
      addEdge(svc.id, dbNode(svc, type, dbName() && type !== 'Redis' ? dbName() : null), 'write', { file, rel, line: lineAt(src, idx), snippet: snippet(src, idx), framework, table });
    };
    let m;
    if (rel.endsWith('.cs')) {
      const kafka = /Confluent\.Kafka|IProducer<|IConsumer<|ProducerBuilder|ConsumerBuilder/.test(src);
      const group = (/GroupId\s*=\s*([^,;\n}]+)/.exec(src) || [])[1];
      const groupName = group ? (resolve(group, svc) || {}).name : undefined;
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
      const group = (/group_id\s*=\s*([^,)\n]+)|['"]group\.id['"]\s*:\s*([^,}\n]+)/.exec(src) || []).slice(1).find(Boolean);
      const groupName = group ? (resolve(group, svc) || {}).name : undefined;
      if (/kafka|aiokafka|confluent_kafka/i.test(src)) {
        for (m of src.matchAll(/(\w*producer\w*)\s*\.\s*(?:send|send_and_wait)\s*\(\s*([^,)]+)/gi)) produce(m[2], m.index, /aiokafka/.test(src) ? 'aiokafka' : 'kafka-python');
        if (/confluent_kafka/.test(src)) for (m of src.matchAll(/\.\s*produce\s*\(\s*([^,)]+)/g)) produce(m[1], m.index, 'confluent-kafka');
        for (m of src.matchAll(/(?:KafkaConsumer|AIOKafkaConsumer)\s*\(\s*([^)]*)\)/g)) {
          const positional = m[1].split(/,(?![^[(]*[\])])/).map((s) => s.trim()).filter((s) => s && !/^\w+\s*=/.test(s) && !/^\*\*/.test(s));
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
        for (m of src.matchAll(/\.subscribe\s*\(\s*\{[^}]*?topics?\s*:\s*(\[[^\]]*\]|[^,}\n]+)/g)) consume(m[1], m.index, 'kafkajs', (/groupId\s*:\s*([^,}\n]+)/.exec(src) || [])[1]);
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
  const serviceList = [...services.values()].filter((s) => used.has(s.id)).map((s) => ({ id: s.id, name: s.name, lang: s.lang, dir: s.dir, files: s.files.size }));
  return {
    services: serviceList,
    topics: [...topics.values()].map((t) => ({ id: t.id, name: t.name, resolved: t.resolved, via: [...t.via] })),
    databases: [...dbs.values()],
    edges: [...edges.values()].map((e) => ({ ...e, tables: [...e.tables], groups: [...e.groups] })),
    brokers: [...brokers],
    scanned: sources.size,
    ms: Date.now() - started,
  };
}

module.exports = { analyzeFlow };
