'use strict';
// Makes the Kiln knowledge graph available to AI agents and tells them to use it first:
//  - a skill (SKILL.md + CLI) for Claude Code and Codex,
//  - the MCP server for Claude Code (claude mcp add), Codex (config.toml), Gemini CLI
//    (settings.json), Antigravity (mcp_config.json) and Cursor (mcp.json),
//  - a short "use the knowledge graph first" block in CLAUDE.md, AGENTS.md and GEMINI.md.
// Everything lives in the user's home folder (never in a repository); blocks are marked so they can be
// updated or removed without touching the user's own content, and files are backed up once.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { which, run } = require('../util/proc');

const SERVER = 'kiln-knowledge-graph';
const MD_START = '<!-- kiln-knowledge-graph:start -->';
const MD_END = '<!-- kiln-knowledge-graph:end -->';
const TOML_START = '# kiln-knowledge-graph:start';
const TOML_END = '# kiln-knowledge-graph:end';
const MD_BLOCK = /\n?<!-- kiln-knowledge-graph:start -->[\s\S]*?<!-- kiln-knowledge-graph:end -->\n?/;
const TOML_BLOCK = /\n?# kiln-knowledge-graph:start[\s\S]*?# kiln-knowledge-graph:end\n?/;

const AGENTS = [
  { id: 'claude', name: 'Claude Code', dir: '.claude', cli: 'claude', skills: '.claude/skills', instructions: '.claude/CLAUDE.md', mcp: { type: 'claude' } },
  { id: 'codex', name: 'Codex CLI', dir: '.codex', cli: 'codex', skills: '.codex/skills', instructions: '.codex/AGENTS.md', mcp: { type: 'toml', file: '.codex/config.toml' } },
  { id: 'gemini', name: 'Gemini CLI', dir: '.gemini', cli: 'gemini', instructions: '.gemini/GEMINI.md', mcp: { type: 'json', file: '.gemini/settings.json' } },
  { id: 'antigravity', name: 'Antigravity', dir: '.gemini/antigravity', instructions: '.gemini/GEMINI.md', mcp: { type: 'json', file: '.gemini/antigravity/mcp_config.json' } },
  { id: 'cursor', name: 'Cursor', dir: '.cursor', cli: 'cursor', mcp: { type: 'json', file: '.cursor/mcp.json' } },
];

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

function backupOnce(file) {
  if (exists(file) && !exists(`${file}.kiln-backup`)) fs.copyFileSync(file, `${file}.kiln-backup`);
}

function writeIfChanged(file, content) {
  const prev = exists(file) ? fs.readFileSync(file, 'utf8') : null;
  if (prev === content) return false;
  backupOnce(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

function cliCommand(node, toolsDir) {
  return `"${node}" "${path.join(toolsDir, 'kg-cli.js')}"`;
}

function skillMarkdown({ node, toolsDir }) {
  const kg = cliCommand(node, toolsDir);
  return `---
name: kiln-knowledge-graph
description: Use FIRST, before grep, find or reading files, for any question about this codebase's structure - where a class, function or variable is defined, who calls a function, what it calls, which functions read or write a variable/field, what a change would affect, or how files depend on each other. Answers instantly from Kiln IDE's knowledge graph (C#, Python, JavaScript, TypeScript).
---

# Kiln knowledge graph

Kiln IDE keeps a knowledge graph of every project it opens: files, classes, functions, methods and
variables (module variables, constants, fields, properties), with calls, type use, inheritance,
imports, which functions read and write each variable, and each function's locals and parameters.
It is stored in Kiln's app data (never in the repository) and refreshed from disk on every query.

**Priority: use this before grep, find or opening whole files.** It understands code structure
(no false matches in comments or strings) and shows relationships text search cannot. Fall back to
text search only for what the graph cannot answer (comments, string contents, config, docs).

Run from the project folder (or add \`--project <path>\`); output is JSON:

\`\`\`bash
${kg} overview                    # orientation: languages, most-called functions, shared variables
${kg} search <text>               # find symbols by (fuzzy) name; --kind method,class,field,...
${kg} symbol <name>               # definition, signature, callers, calls, reads, writes, locals, members
${kg} usages <name>               # every call site / read / write with file:line and enclosing function
${kg} impact <name> --depth 3     # what depends on it (callers of callers, readers of a variable)
${kg} path <from> <to>            # call chain between two functions
${kg} file <path>                 # outline: definitions and what each calls / reads / writes; imports
${kg} variable <name>             # which functions read and which write a variable / field / property
${kg} index                       # build the graph for a folder Kiln has not opened yet
\`\`\`

Names can be \`Name\`, \`Class.Name\`, \`Namespace.Class.Name\` or \`path/file.py:Name\`.

Typical flow: \`overview\` to get oriented, \`symbol\` / \`file\` instead of reading files, \`usages\` instead of
grep for references, and \`impact\` before changing a signature or shared state.
`;
}

const instructionsBlock = () => `${MD_START}
## Code navigation: use the Kiln knowledge graph first
For projects opened in Kiln IDE, the Kiln knowledge graph is the primary source for code structure.
Before grep, find or reading whole files, use the \`kiln-knowledge-graph\` skill or the \`kg_*\` tools of
the \`${SERVER}\` MCP server to find definitions, callers and callees, which functions read or write a
variable, file outlines, and the impact of a change. Fall back to text search only when the graph
cannot answer (comments, string contents, non-code files).
${MD_END}`;

function upsertMarkdown(file) {
  const prev = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  const base = prev.replace(MD_BLOCK, '');
  const next = base ? `${base}${base.endsWith('\n') ? '' : '\n'}\n${instructionsBlock()}\n` : `${instructionsBlock()}\n`;
  return writeIfChanged(file, next);
}

function removeMarkdown(file) {
  if (!exists(file)) return false;
  const prev = fs.readFileSync(file, 'utf8');
  if (!MD_BLOCK.test(prev)) return false;
  const next = prev.replace(MD_BLOCK, '');
  if (!next.trim()) fs.rmSync(file);
  else fs.writeFileSync(file, next);
  return true;
}

function upsertToml(file, { node, toolsDir }) {
  const prev = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  const q = (s) => JSON.stringify(s);
  const block = `${TOML_START}\n[mcp_servers.${SERVER}]\ncommand = ${q(node)}\nargs = [${q(path.join(toolsDir, 'kg-mcp.js'))}]\n${TOML_END}`;
  const base = prev.replace(TOML_BLOCK, '');
  const next = base ? `${base}${base.endsWith('\n') ? '' : '\n'}\n${block}\n` : `${block}\n`;
  return writeIfChanged(file, next);
}

function removeToml(file) {
  if (!exists(file)) return false;
  const prev = fs.readFileSync(file, 'utf8');
  if (!TOML_BLOCK.test(prev)) return false;
  const next = prev.replace(TOML_BLOCK, '');
  if (!next.trim()) fs.rmSync(file);
  else fs.writeFileSync(file, next);
  return true;
}

function readJson(file) {
  if (!exists(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not plain JSON (comments?); add the "${SERVER}" MCP server there manually.`);
  }
}

function upsertJson(file, { node, toolsDir }) {
  const obj = readJson(file);
  obj.mcpServers = obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : {};
  obj.mcpServers[SERVER] = { command: node, args: [path.join(toolsDir, 'kg-mcp.js')] };
  return writeIfChanged(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function removeJson(file) {
  if (!exists(file)) return false;
  const obj = readJson(file);
  if (!obj.mcpServers || !obj.mcpServers[SERVER]) return false;
  delete obj.mcpServers[SERVER];
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  return true;
}

function writeSkill(dir, opts) {
  const file = path.join(dir, 'kiln-knowledge-graph', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = skillMarkdown(opts);
  if (exists(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.writeFileSync(file, content);
  return true;
}

async function defaultClaudeMcp(action, { node, toolsDir }) {
  const claude = which('claude');
  if (!claude) return { ok: false, reason: 'claude CLI not found' };
  if (action === 'add') {
    await run(claude, ['mcp', 'remove', '--scope', 'user', SERVER], { timeout: 30000 });
    const r = await run(claude, ['mcp', 'add', '--scope', 'user', SERVER, '--', node, path.join(toolsDir, 'kg-mcp.js')], { timeout: 30000 });
    return { ok: r.code === 0, reason: r.stderr.trim() };
  }
  const r = await run(claude, ['mcp', 'remove', '--scope', 'user', SERVER], { timeout: 30000 });
  return { ok: r.code === 0, reason: r.stderr.trim() };
}

function detectAgents({ home = os.homedir() } = {}) {
  return AGENTS.map((a) => ({ id: a.id, name: a.name, present: exists(path.join(home, a.dir)) || (a.cli ? !!which(a.cli) : false) }));
}

function status({ home = os.homedir() } = {}) {
  return detectAgents({ home }).map((d) => {
    const a = AGENTS.find((x) => x.id === d.id);
    let installed = false;
    if (a.skills && exists(path.join(home, a.skills, 'kiln-knowledge-graph', 'SKILL.md'))) installed = true;
    if (a.mcp.type === 'json') {
      try {
        installed = installed || !!(readJson(path.join(home, a.mcp.file)).mcpServers || {})[SERVER];
      } catch {
        /* unreadable */
      }
    }
    if (a.mcp.type === 'toml' && exists(path.join(home, a.mcp.file))) installed = installed || TOML_BLOCK.test(fs.readFileSync(path.join(home, a.mcp.file), 'utf8'));
    return { ...d, installed };
  });
}

/**
 * @param opts { home, agents: [ids], node (absolute node path), toolsDir (folder with kg-cli.js and
 *   kg-mcp.js), runClaudeMcpAdd? (injected for tests) }
 */
async function install({ home = os.homedir(), agents, node, toolsDir, runClaudeMcpAdd = defaultClaudeMcp }) {
  const results = [];
  for (const id of agents) {
    const a = AGENTS.find((x) => x.id === id);
    if (!a) {
      results.push({ id, ok: false, error: 'Unknown agent' });
      continue;
    }
    const changes = [];
    try {
      if (a.skills && writeSkill(path.join(home, a.skills), { node, toolsDir })) changes.push(`skill in ~/${a.skills}`);
      if (a.instructions && upsertMarkdown(path.join(home, a.instructions))) changes.push(`instructions in ~/${a.instructions}`);
      if (a.mcp.type === 'json' && upsertJson(path.join(home, a.mcp.file), { node, toolsDir })) changes.push(`MCP server in ~/${a.mcp.file}`);
      if (a.mcp.type === 'toml' && upsertToml(path.join(home, a.mcp.file), { node, toolsDir })) changes.push(`MCP server in ~/${a.mcp.file}`);
      let note;
      if (a.mcp.type === 'claude') {
        const r = await runClaudeMcpAdd('add', { node, toolsDir });
        if (r.ok) changes.push('MCP server (claude mcp add --scope user)');
        else note = `Skill installed; MCP server not registered (${r.reason || 'claude CLI unavailable'}).`;
      }
      results.push({ id, name: a.name, ok: true, changes, note });
    } catch (err) {
      results.push({ id, name: a.name, ok: false, error: err.message, changes });
    }
  }
  return results;
}

async function uninstall({ home = os.homedir(), agents, runClaudeMcpAdd = defaultClaudeMcp, node, toolsDir }) {
  const results = [];
  for (const id of agents) {
    const a = AGENTS.find((x) => x.id === id);
    if (!a) continue;
    try {
      if (a.skills) fs.rmSync(path.join(home, a.skills, 'kiln-knowledge-graph'), { recursive: true, force: true });
      if (a.instructions) removeMarkdown(path.join(home, a.instructions));
      if (a.mcp.type === 'json') removeJson(path.join(home, a.mcp.file));
      if (a.mcp.type === 'toml') removeToml(path.join(home, a.mcp.file));
      if (a.mcp.type === 'claude') await runClaudeMcpAdd('remove', { node, toolsDir });
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = { AGENTS, SERVER, detectAgents, status, install, uninstall, skillMarkdown, instructionsBlock };
