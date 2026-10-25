'use strict';
// Skills, slash commands and subagents available to Claude in this project.
// Combines what Claude Code itself reports (built-in and loaded skills, commands, agents) with a scan
// of the files that define them: ~/.claude, <project>/.claude and installed plugins.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const YAML = require('yaml');

const CLAUDE_HOME = path.join(os.homedir(), '.claude');

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text || '');
  if (!m) return { data: {}, body: text || '' };
  let data = {};
  try {
    data = YAML.parse(m[1]) || {};
  } catch {
    data = {};
  }
  return { data, body: text.slice(m[0].length) };
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function findSkillFiles(dir, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const skill = path.join(dir, e.name, 'SKILL.md');
    if (fs.existsSync(skill)) out.push(skill);
    else await findSkillFiles(path.join(dir, e.name), depth + 1, out);
  }
  return out;
}

async function readSkill(file, source, extra = {}) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const { data } = frontmatter(text);
  return {
    kind: 'skill',
    name: String(data.name || path.basename(path.dirname(file))),
    description: String(data.description || '').trim(),
    argumentHint: data['argument-hint'] ? String(data['argument-hint']) : '',
    allowedTools: data['allowed-tools'] || null,
    model: data.model || null,
    userInvocable: data['user-invocable'] !== false,
    source,
    path: file,
    dir: path.dirname(file),
    ...extra,
  };
}

async function readMarkdownDir(dir, kind, source, extra = {}, prefix = '', depth = 0) {
  const out = [];
  if (depth > 3) return out;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && kind === 'command') {
      out.push(...(await readMarkdownDir(full, kind, source, extra, `${prefix}${e.name}:`, depth + 1)));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      let text = '';
      try {
        text = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      const { data, body } = frontmatter(text);
      const fallback = body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
      out.push({
        kind,
        name: kind === 'agent' ? String(data.name || e.name.replace(/\.md$/, '')) : prefix + e.name.replace(/\.md$/, ''),
        description: String(data.description || fallback).trim().slice(0, 500),
        argumentHint: data['argument-hint'] ? String(data['argument-hint']) : '',
        model: data.model || null,
        tools: data.tools || data['allowed-tools'] || null,
        source,
        path: full,
        ...extra,
      });
    }
  }
  return out;
}

async function plugins() {
  const installed = (await readJson(path.join(CLAUDE_HOME, 'plugins', 'installed_plugins.json'))) || {};
  const userSettings = (await readJson(path.join(CLAUDE_HOME, 'settings.json'))) || {};
  const enabled = userSettings.enabledPlugins || {};
  const out = [];
  for (const [key, value] of Object.entries(installed.plugins || {})) {
    const entry = Array.isArray(value) ? value[0] : value;
    if (!entry || !entry.installPath || !fs.existsSync(entry.installPath)) continue;
    const [name, marketplace] = key.split('@');
    out.push({ key, name, marketplace, dir: entry.installPath, version: entry.version || null, enabled: enabled[key] !== false });
  }
  return out;
}

async function scanFilesystem(root) {
  const items = [];
  for (const file of await findSkillFiles(path.join(CLAUDE_HOME, 'skills'))) {
    const synced = file.includes(`${path.sep}skills${path.sep}synced${path.sep}`);
    const s = await readSkill(file, synced ? 'synced' : 'user');
    if (s) items.push(s);
  }
  if (root) {
    for (const file of await findSkillFiles(path.join(root, '.claude', 'skills'))) {
      const s = await readSkill(file, 'project');
      if (s) items.push(s);
    }
    items.push(...(await readMarkdownDir(path.join(root, '.claude', 'commands'), 'command', 'project')));
    items.push(...(await readMarkdownDir(path.join(root, '.claude', 'agents'), 'agent', 'project')));
  }
  items.push(...(await readMarkdownDir(path.join(CLAUDE_HOME, 'commands'), 'command', 'user')));
  items.push(...(await readMarkdownDir(path.join(CLAUDE_HOME, 'agents'), 'agent', 'user')));
  const pluginList = await plugins();
  for (const p of pluginList) {
    const extra = { plugin: p.name, pluginEnabled: p.enabled };
    for (const file of await findSkillFiles(path.join(p.dir, 'skills'))) {
      const s = await readSkill(file, 'plugin', extra);
      if (s) items.push(s);
    }
    items.push(...(await readMarkdownDir(path.join(p.dir, 'commands'), 'command', 'plugin', extra)));
    items.push(...(await readMarkdownDir(path.join(p.dir, 'agents'), 'agent', 'plugin', extra)));
  }
  return { items, plugins: pluginList };
}

/** Merge the live list from Claude Code (probe) with the files found on disk. */
async function listSkills(root, probe) {
  const { items, plugins: pluginList } = await scanFilesystem(root);
  const find = (kind, name) => items.find((i) => i.kind === kind && (i.name === name || (i.plugin && `${i.plugin}:${i.name}` === name)));
  if (probe && probe.ok) {
    const skillNames = new Set();
    for (const s of probe.skills || []) {
      skillNames.add(s.name);
      const match = find('skill', s.name);
      if (match) {
        match.live = true;
        match.builtin = !!s.builtin;
        if (!match.description) match.description = s.description;
        if (!match.argumentHint) match.argumentHint = s.argumentHint || '';
      } else {
        items.push({ kind: 'skill', name: s.name, description: s.description || '', argumentHint: s.argumentHint || '', source: s.builtin ? 'builtin' : 'loaded', builtin: !!s.builtin, live: true });
      }
    }
    for (const c of probe.commands || []) {
      if (skillNames.has(c.name)) continue;
      const match = find('command', c.name) || find('skill', c.name);
      if (match) {
        match.live = true;
        continue;
      }
      items.push({ kind: 'command', name: c.name, description: c.description || '', argumentHint: c.argumentHint || '', aliases: c.aliases || [], source: c.builtin ? 'builtin' : 'loaded', builtin: !!c.builtin, live: true });
    }
    for (const a of probe.agents || []) {
      const match = find('agent', a.name);
      if (match) match.live = true;
      else items.push({ kind: 'agent', name: a.name, description: a.description || '', model: a.model || null, source: 'builtin', builtin: true, live: true });
    }
  }
  const order = { project: 0, user: 1, synced: 2, plugin: 3, loaded: 4, builtin: 5 };
  items.sort((a, b) => (order[a.source] ?? 9) - (order[b.source] ?? 9) || a.name.localeCompare(b.name));
  return {
    items,
    plugins: pluginList,
    probe: probe ? { ok: probe.ok, error: probe.error || null, detail: probe.detail || null, version: probe.version || null, account: probe.account || null, models: probe.models || [], mcpServers: probe.mcpServers || [], ms: probe.ms || null } : null,
  };
}

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

async function createSkill(root, { scope = 'project', name, description }) {
  const slug = slugify(name);
  if (!slug) throw new Error('Enter a skill name.');
  const base = scope === 'user' ? path.join(CLAUDE_HOME, 'skills') : path.join(root, '.claude', 'skills');
  const dir = path.join(base, slug);
  if (fs.existsSync(dir)) throw new Error(`A skill named "${slug}" already exists.`);
  await fsp.mkdir(dir, { recursive: true });
  const title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const desc = (description || `Use this skill when the user asks to ${title.toLowerCase()}.`).replace(/\n/g, ' ');
  const body = `---\nname: ${slug}\ndescription: ${JSON.stringify(desc)}\n---\n\n# ${title}\n\nExplain what this skill is for and when Claude should use it.\n\n## Steps\n\n1. First step Claude should take.\n2. Next step.\n3. How to verify the result.\n`;
  const file = path.join(dir, 'SKILL.md');
  await fsp.writeFile(file, body);
  return file;
}

module.exports = { listSkills, createSkill, frontmatter };
