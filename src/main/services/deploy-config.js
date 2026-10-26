'use strict';
// The configuration a project is really deployed with, read from the deployment files anywhere in the
// repository: Kubernetes manifests (Deployment / StatefulSet / Job / CronJob / DaemonSet env and envFrom,
// ConfigMaps, Secrets), Helm charts (values*.yaml applied to the templates' env), Kustomize
// configMapGenerator literals, docker-compose environments, .env files, appsettings.{Environment}.json,
// and the Kafka topics they declare (Strimzi KafkaTopic resources, Terraform kafka_topic).
//
// Every value keeps where it came from (file, line, key, environment) so the message-flow graph can
// show the real topic names, consumer groups and database names, and why.
const path = require('path');
const YAML = require('yaml');

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet', 'Pod', 'DeploymentConfig', 'Rollout', 'KafkaConnector']);
const ENV_WORDS = [
  ['prod', /(^|[\\/._-])(prod|production|prd|live)([\\/._-]|$)/i],
  ['staging', /(^|[\\/._-])(staging|stage|stg|preprod|uat)([\\/._-]|$)/i],
  ['qa', /(^|[\\/._-])(qa|test|testing)([\\/._-]|$)/i],
  ['dev', /(^|[\\/._-])(dev|development|local)([\\/._-]|$)/i],
];
// Which environment wins when values differ: what production runs is the "real" value.
const ENV_RANK = { prod: 0, staging: 1, default: 2, qa: 3, dev: 4 };
const SOURCE_RANK = { k8s: 0, helm: 0, kustomize: 0, terraform: 1, compose: 2, appsettings: 3, dotenv: 4 };

/** The environment a deployment file is for, from its path (overlays/prod, values-staging.yaml, ...). */
function environmentOf(rel) {
  for (const [name, re] of ENV_WORDS) if (re.test(rel)) return name;
  return 'default';
}

const lineOf = (text, needle, from = 0) => {
  const i = needle ? text.indexOf(needle, from) : -1;
  return i < 0 ? null : text.slice(0, i).split('\n').length;
};

/** "orders-api", "OrdersApi", "registry.io/shop/orders-api:1.4" -> "ordersapi" (for matching). */
function normName(s) {
  const base = String(s || '').split('/').pop().split('@')[0].split(':')[0];
  return base.toLowerCase().replace(/[^a-z0-9]/g, '');
}
const STRIP = /(service|svc|api|app|worker|consumer|producer|server|deployment|deploy|chart)$/;

/** Does a deployed workload run a service of the code? */
function matchesService(workload, service) {
  const names = [workload.name, workload.app, ...(workload.containers || []).flatMap((c) => [c.name, c.image])].filter(Boolean).map(normName);
  const wanted = [service.name, service.dirName, service.projectName].filter(Boolean).map(normName);
  for (const n of names) {
    for (const w of wanted) {
      if (!n || !w) continue;
      if (n === w || n.replace(STRIP, '') === w.replace(STRIP, '')) return 3;
      if (n.length > 3 && w.length > 3 && (n.includes(w) || w.includes(n))) return 1;
    }
  }
  return 0;
}

function flatten(obj, prefix = '', out = {}, sep = '.') {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}${sep}${k}` : k, out, sep);
  else if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') out[prefix] = String(obj);
  return out;
}

class DeployConfig {
  constructor() {
    this.workloads = []; // { name, app, kind, file, rel, env, containers, environment, source }
    this.configMaps = new Map(); // name -> { data, rel, text }
    this.secrets = new Map(); // name -> { data, rel, text }  (values are used for database names only)
    this.topics = []; // declared topics: { name, partitions, replicas, rel, line, source, environment }
    this.files = []; // deployment files that were read
  }

  // ------------------------------------------------------------- readers

  /** A YAML file (one or more documents): Kubernetes resources, compose files, Helm values. */
  addYaml(rel, text) {
    let docs;
    try {
      docs = YAML.parseAllDocuments(text).map((d) => d.toJS({ maxAliasCount: 50 }));
    } catch {
      return;
    }
    let used = false;
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object') continue;
      if (doc.kind && doc.apiVersion) used = this.addK8s(rel, text, doc) || used;
      else if (doc.services && typeof doc.services === 'object' && /compose/i.test(path.basename(rel))) used = true; // compose is read by flow.js itself
    }
    if (used) this.files.push(rel);
  }

  addK8s(rel, text, doc) {
    const environment = environmentOf(rel);
    const meta = doc.metadata || {};
    if (doc.kind === 'List' && Array.isArray(doc.items)) {
      let any = false;
      for (const item of doc.items) any = this.addK8s(rel, text, item) || any;
      return any;
    }
    if (doc.kind === 'ConfigMap' || doc.kind === 'Secret') {
      const data = { ...(doc.data || {}) };
      if (doc.kind === 'Secret') {
        for (const [k, v] of Object.entries(data)) {
          try {
            data[k] = Buffer.from(String(v), 'base64').toString('utf8');
          } catch {
            /* not base64 */
          }
        }
        Object.assign(data, doc.stringData || {});
      }
      (doc.kind === 'ConfigMap' ? this.configMaps : this.secrets).set(meta.name, { data, rel, text, environment, secret: doc.kind === 'Secret' });
      return true;
    }
    if (doc.kind === 'KafkaTopic') {
      const spec = doc.spec || {};
      const name = spec.topicName || meta.name;
      this.topics.push({ name, partitions: spec.partitions, replicas: spec.replicas, rel, line: lineOf(text, `name: ${meta.name}`), source: 'Strimzi KafkaTopic', environment });
      return true;
    }
    if (!WORKLOAD_KINDS.has(doc.kind)) return false;
    const spec = doc.spec || {};
    const podSpec = doc.kind === 'CronJob' ? (((spec.jobTemplate || {}).spec || {}).template || {}).spec : doc.kind === 'Pod' ? spec : (spec.template || {}).spec;
    if (!podSpec) return false;
    const labels = { ...((meta.labels) || {}), ...((((spec.template || {}).metadata || {}).labels) || {}) };
    const containers = [...(podSpec.containers || []), ...(podSpec.initContainers || [])];
    const env = {};
    const put = (key, value, line, from) => {
      if (value == null) return;
      env[key] = { value: String(value), rel, line, key, environment, source: 'k8s', from };
    };
    for (const c of containers) {
      for (const ref of c.envFrom || []) {
        const cm = ref.configMapRef && ref.configMapRef.name;
        const sec = ref.secretRef && ref.secretRef.name;
        const prefix = ref.prefix || '';
        if (cm) env[`$configMap:${cm}`] = { pending: { kind: 'configMap', name: cm, prefix } };
        if (sec) env[`$secret:${sec}`] = { pending: { kind: 'secret', name: sec, prefix } };
      }
      for (const e of c.env || []) {
        if (!e || !e.name) continue;
        const line = lineOf(text, `name: ${e.name}`);
        if (e.value != null) put(e.name, e.value, line);
        else if (e.valueFrom && e.valueFrom.configMapKeyRef) env[e.name] = { pending: { kind: 'configMapKey', name: e.valueFrom.configMapKeyRef.name, key: e.valueFrom.configMapKeyRef.key }, line, rel, environment };
        else if (e.valueFrom && e.valueFrom.secretKeyRef) env[e.name] = { pending: { kind: 'secretKey', name: e.valueFrom.secretKeyRef.name, key: e.valueFrom.secretKeyRef.key }, line, rel, environment };
      }
    }
    this.workloads.push({ name: meta.name, app: labels['app.kubernetes.io/name'] || labels.app || labels.component || null, kind: doc.kind, rel, env, containers: containers.map((c) => ({ name: c.name, image: c.image })), environment, source: 'k8s' });
    return true;
  }

  /**
   * A Helm chart: values*.yaml files and the templates' env entries (`value: {{ .Values.kafka.topic }}`,
   * with `| default "x"`). One workload per chart and values file (values-prod.yaml -> prod).
   */
  addHelmChart(chartRel, chartText, valuesFiles, templates) {
    let chart = {};
    try {
      chart = YAML.parse(chartText) || {};
    } catch {
      return;
    }
    const dir = path.posix.dirname(chartRel);
    const base = valuesFiles.find((v) => /(^|\/)values\.ya?ml$/.test(v.rel));
    const parse = (t) => {
      try {
        return YAML.parse(t) || {};
      } catch {
        return {};
      }
    };
    const baseValues = base ? parse(base.text) : {};
    const sets = valuesFiles.length ? valuesFiles.map((v) => ({ v, values: v === base ? baseValues : deepMerge(baseValues, parse(v.text)) })) : [{ v: { rel: chartRel, text: chartText }, values: {} }];
    const baseFlat = flatten(baseValues);
    for (const { v, values } of sets) {
      const flat = flatten(values);
      // Which file sets a key: this values file, or the chart's values.yaml it overrides.
      const own = v === base ? baseFlat : flatten((() => {
        try {
          return YAML.parse(v.text) || {};
        } catch {
          return {};
        }
      })());
      const definedIn = (key) => (own[key] != null ? v : base && baseFlat[key] != null ? base : v);
      const env = {};
      for (const t of templates) {
        for (const m of t.text.matchAll(/-\s*name:\s*["']?([\w.-]+)["']?\s*\n\s*value:\s*(.+)/g)) {
          const raw = m[2].trim();
          let value = raw.replace(/^["']|["']$/g, '');
          const ref = /\{\{-?\s*(?:quote\s+)?\.Values\.([\w.]+)(?:\s*\|\s*default\s+["']?([^"'}]+)["']?)?[^}]*\}\}/.exec(raw);
          let vrel = t.rel;
          let line = lineOf(t.text, `name: ${m[1]}`);
          if (ref) {
            value = flat[ref[1]] != null ? flat[ref[1]] : ref[2];
            if (flat[ref[1]] != null) {
              const src = definedIn(ref[1]);
              vrel = src.rel;
              line = lineOf(src.text, ref[1].split('.').pop() + ':') || line;
            }
          } else if (/\{\{/.test(raw)) continue;
          if (value != null) env[m[1]] = { value: String(value), rel: vrel, line, key: m[1], environment: environmentOf(v.rel), source: 'helm' };
        }
      }
      // Env maps right in the values (env: { KAFKA_TOPIC: orders }, extraEnv: [...]).
      for (const key of ['env', 'extraEnv', 'environment', 'config', 'configmap', 'configMap']) {
        const block = values[key];
        if (Array.isArray(block)) for (const e of block) if (e && e.name && e.value != null) env[e.name] = env[e.name] || { value: String(e.value), rel: v.rel, line: lineOf(v.text, `name: ${e.name}`), key: e.name, environment: environmentOf(v.rel), source: 'helm' };
        if (block && typeof block === 'object' && !Array.isArray(block)) for (const [k, val] of Object.entries(flatten(block, '', {}, '__'))) env[k] = env[k] || { value: val, rel: v.rel, line: lineOf(v.text, `${k.split('__').pop()}:`), key: k, environment: environmentOf(v.rel), source: 'helm' };
      }
      // Topics a chart declares in its values (topics: [orders, payments] or [{ name: orders }]).
      for (const [k, val] of Object.entries(values)) {
        if (!/topics?$/i.test(k) || !Array.isArray(val)) continue;
        for (const t of val) {
          const name = typeof t === 'string' ? t : t && (t.name || t.topicName);
          if (name) this.topics.push({ name, partitions: t && t.partitions, replicas: t && (t.replicas || t.replicationFactor), rel: v.rel, line: lineOf(v.text, name), source: 'Helm values', environment: environmentOf(v.rel) });
        }
      }
      const image = values.image && (values.image.repository || values.image.name);
      this.workloads.push({ name: values.nameOverride || values.fullnameOverride || chart.name || path.posix.basename(dir), app: chart.name, kind: 'Helm chart', rel: v.rel, env, containers: image ? [{ name: chart.name, image }] : [], environment: environmentOf(v.rel), source: 'helm' });
    }
    this.files.push(chartRel, ...valuesFiles.map((v) => v.rel));
  }

  /** kustomization.yaml: configMapGenerator literals and env files become ConfigMaps. */
  addKustomization(rel, text, readRel) {
    let k;
    try {
      k = YAML.parse(text) || {};
    } catch {
      return;
    }
    const environment = environmentOf(rel);
    for (const g of k.configMapGenerator || []) {
      const data = {};
      for (const lit of g.literals || []) {
        const i = String(lit).indexOf('=');
        if (i > 0) data[String(lit).slice(0, i)] = String(lit).slice(i + 1);
      }
      for (const envFile of g.envs || (g.env ? [g.env] : [])) {
        const t = readRel(path.posix.join(path.posix.dirname(rel), envFile));
        for (const line of (t || '').split(/\r?\n/)) {
          const m = /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(line);
          if (m) data[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
      // An overlay's generator replaces the base's ConfigMap of the same name in that environment.
      const existing = this.configMaps.get(g.name);
      if (!existing || ENV_RANK[environment] <= ENV_RANK[existing.environment]) this.configMaps.set(g.name, { data, rel, text, environment });
    }
    this.files.push(rel);
  }

  /** Terraform kafka_topic resources (Mongey/kafka and Confluent providers). */
  addTerraform(rel, text) {
    let any = false;
    for (const m of text.matchAll(/resource\s+"(?:kafka_topic|confluent_kafka_topic)"\s+"[\w-]+"\s*\{([\s\S]*?)\n\}/g)) {
      const name = (/(?:^|\n)\s*(?:name|topic_name)\s*=\s*"([^"]+)"/.exec(m[1]) || [])[1];
      if (!name) continue;
      any = true;
      this.topics.push({ name, partitions: +((/partitions(?:_count)?\s*=\s*(\d+)/.exec(m[1]) || [])[1]) || undefined, replicas: +((/replication_factor\s*=\s*(\d+)/.exec(m[1]) || [])[1]) || undefined, rel, line: lineOf(text, name), source: 'Terraform', environment: environmentOf(rel) });
    }
    if (any) this.files.push(rel);
  }

  // ----------------------------------------------------------- resolving

  /** Fill in env values that come from ConfigMaps and Secrets. */
  finish() {
    for (const w of this.workloads) {
      for (const [k, e] of Object.entries({ ...w.env })) {
        if (!e.pending) continue;
        delete w.env[k];
        const p = e.pending;
        const store = p.kind.startsWith('secret') ? this.secrets : this.configMaps;
        const src = store.get(p.name);
        if (!src) continue;
        if (p.kind === 'configMap' || p.kind === 'secret') {
          for (const [dk, dv] of Object.entries(src.data)) if (!w.env[p.prefix + dk]) w.env[p.prefix + dk] = { value: String(dv), rel: src.rel, line: lineOf(src.text, `${dk}:`) || lineOf(src.text, `${dk}=`), key: p.prefix + dk, environment: src.environment, source: 'k8s', secret: !!src.secret, from: p.name, fromKey: dk };
        } else if (src.data[p.key] != null) {
          w.env[k] = { value: String(src.data[p.key]), rel: src.rel, line: lineOf(src.text, `${p.key}:`) || lineOf(src.text, `${p.key}=`) || e.line, key: k, environment: src.environment, source: 'k8s', secret: !!src.secret, from: p.name, fromKey: p.key };
        }
      }
    }
    return this;
  }

  /**
   * Env for a service of the code: every deployed workload that runs it, best environment first.
   * Returns { KEY: [entries, best first] }.
   */
  envFor(service) {
    const out = {};
    const ws = this.workloads.map((w) => ({ w, score: matchesService(w, service) })).filter((x) => x.score > 0);
    const best = Math.max(0, ...ws.map((x) => x.score));
    for (const { w } of ws.filter((x) => x.score === best)) {
      for (const [k, e] of Object.entries(w.env)) (out[k] = out[k] || []).push({ ...e, workload: w.name, kind: w.kind });
    }
    for (const list of Object.values(out)) list.sort(rankSources);
    return { env: out, workloads: ws.filter((x) => x.score === best).map(({ w }) => ({ name: w.name, kind: w.kind, rel: w.rel, environment: w.environment })) };
  }
}

/** Production before staging before dev; Kubernetes / Helm before compose before .env. */
function rankSources(a, b) {
  return (ENV_RANK[a.environment] ?? 2) - (ENV_RANK[b.environment] ?? 2) || (SOURCE_RANK[a.source] ?? 5) - (SOURCE_RANK[b.source] ?? 5);
}

function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...(a && typeof a === 'object' && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
  return out;
}

const DEPLOY_YAML = /\.(ya?ml)$/i;
const SKIP = /(^|\/)(node_modules|bin|obj|\.venv|venv|dist|build|\.git|__pycache__|\.github|\.gitlab|\.idea|\.vscode|charts\/[^/]+\/charts)\//i;

/** Read the deployment files of a repository (`files`: paths relative to the root). */
async function readDeployment(files, readRel) {
  const cfg = new DeployConfig();
  const yamls = files.filter((f) => DEPLOY_YAML.test(f) && !SKIP.test(`/${f}`));
  const charts = yamls.filter((f) => /(^|\/)Chart\.ya?ml$/.test(f));
  const chartDirs = charts.map((c) => path.posix.dirname(c));
  const inChart = (f) => chartDirs.some((d) => f === d || f.startsWith(d === '.' ? '' : `${d}/`));
  for (const c of charts) {
    const dir = path.posix.dirname(c);
    const under = (f) => (dir === '.' ? !f.includes('/') : path.posix.dirname(f) === dir);
    const values = [];
    for (const f of yamls.filter((x) => under(x) && /(^|\/)values[\w.-]*\.ya?ml$/.test(x))) values.push({ rel: f, text: (await readRel(f)) || '' });
    const templates = [];
    for (const f of yamls.filter((x) => x.startsWith(dir === '.' ? 'templates/' : `${dir}/templates/`))) templates.push({ rel: f, text: (await readRel(f)) || '' });
    cfg.addHelmChart(c, (await readRel(c)) || '', values, templates);
  }
  const plainYaml = yamls.filter((f) => !inChart(f) && !/(^|\/)kustomization\.ya?ml$/.test(f));
  const syncCache = new Map();
  for (const f of plainYaml) {
    const text = await readRel(f);
    if (!text || text.length > 1024 * 1024 || !/\bkind:\s*\w+|\bservices:/.test(text)) continue;
    syncCache.set(f, text);
    cfg.addYaml(f, text);
  }
  for (const f of yamls.filter((x) => /(^|\/)kustomization\.ya?ml$/.test(x))) {
    const text = (await readRel(f)) || '';
    const envFiles = {};
    for (const m of text.matchAll(/(?:envs?:\s*\n(?:\s*-\s*([^\n]+)\n?)+|env:\s*([^\n]+))/g)) {
      for (const e of (m[0].match(/-\s*([^\n]+)/g) || []).map((x) => x.replace(/^-\s*/, '').trim()).concat(m[2] ? [m[2].trim()] : [])) {
        const p = path.posix.join(path.posix.dirname(f), e);
        envFiles[p] = await readRel(p);
      }
    }
    cfg.addKustomization(f, text, (p) => envFiles[p] || syncCache.get(p) || null);
  }
  for (const f of files.filter((x) => /\.tf$/.test(x) && !SKIP.test(`/${x}`))) {
    const text = await readRel(f);
    if (text && /kafka_topic/.test(text)) cfg.addTerraform(f, text);
  }
  return cfg.finish();
}

// --------------------------------------------------------- databases

/** The database (type, name, host) a connection string or URL points at; credentials are dropped. */
function parseConnection(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/?#]*)\/?([^?#]*)/i.exec(v);
  if (url) {
    const s = url[1].toLowerCase();
    const type = s.startsWith('postgres') ? 'PostgreSQL' : s.startsWith('mysql') || s.startsWith('mariadb') ? 'MySQL' : s.startsWith('sqlite') ? 'SQLite' : s.startsWith('mssql') || s.startsWith('sqlserver') ? 'SQL Server' : s.startsWith('mongodb') ? 'MongoDB' : s.startsWith('redis') ? 'Redis' : s.startsWith('cassandra') ? 'Cassandra' : null;
    if (!type) return null;
    const name = type === 'SQLite' ? path.basename(url[3] || url[2]) : type === 'Redis' ? (url[3] ? `db ${url[3]}` : null) : decodeURIComponent((url[3] || '').split('/')[0]) || null;
    return { type, name, host: url[2].split(',')[0] || null };
  }
  if (/[;=]/.test(v)) {
    const kv = {};
    for (const part of v.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
    const name = kv.database || kv['initial catalog'] || kv.dbname || null;
    const host = kv.host || kv.server || kv['data source'] || kv.address || null;
    if (!name && !host) return null;
    // Npgsql uses Host=, SQL Server Initial Catalog= / User Id= / Trusted_Connection=, MySQL Uid=.
    const type = kv['data source'] && /\.db$|\.sqlite/i.test(kv['data source']) ? 'SQLite' : 'host' in kv ? 'PostgreSQL' : 'initial catalog' in kv || 'user id' in kv || 'trusted_connection' in kv || 'integrated security' in kv ? 'SQL Server' : 'uid' in kv ? 'MySQL' : null;
    return { type, name: name || (type === 'SQLite' ? path.basename(kv['data source']) : null), host };
  }
  return null;
}

/** Env / config keys that hold a database connection. */
const DB_KEY = /^(ConnectionStrings(__|:)\w+|(\w+_)?DATABASE_URL|(\w+_)?DB_URL|(\w+_)?(DSN|CONNECTION_STRING|CONN_STR)|MONGO(DB)?_(URL|URI)|REDIS_URL|SQLALCHEMY_DATABASE_URI|POSTGRES_URL)$/i;
const DB_NAME_KEY = /^(POSTGRES_DB|MYSQL_DATABASE|MONGO_INITDB_DATABASE|(\w+_)?DB_NAME|DATABASE_NAME)$/i;

module.exports = { readDeployment, DeployConfig, environmentOf, matchesService, parseConnection, rankSources, normName, DB_KEY, DB_NAME_KEY, ENV_RANK };
