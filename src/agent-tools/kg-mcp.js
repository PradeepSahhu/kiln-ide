#!/usr/bin/env node
'use strict';
// Kiln knowledge graph MCP server (stdio). Gives Claude Code, Codex, Gemini CLI, Antigravity, Cursor
// and other MCP clients read-only tools over the project's knowledge graph: definitions, callers,
// callees, variable reads/writes, file outlines, impact analysis and call paths.
const path = require('path');
const { fileURLToPath } = require('url');
const kg = require('./kg-core');

const VERSION = '1.0.0';
const FIRST = 'Use this FIRST, before grep, find or reading whole files: it answers from Kiln IDE\'s structural knowledge graph of the codebase (files, classes, functions, variables, calls, reads/writes), which is precise and up to date.';
const PROJECT_PARAM = { type: 'string', description: 'Absolute path of the project (or any folder inside it). Optional: defaults to the workspace / current directory.' };

const TOOLS = [
  { name: 'kg_overview', title: 'Project overview', description: `Summary of the codebase: files per language, most-called functions, most connected files and variables shared by many functions. Start here to get oriented. ${FIRST}`, props: {}, required: [] },
  { name: 'kg_search', title: 'Find symbols', description: `Find classes, functions, methods, variables, fields and properties by (fuzzy) name, with file and line. ${FIRST}`, props: { query: { type: 'string', description: 'Name or part of it, e.g. "OrderServ" or "place_order".' }, kind: { type: 'string', description: 'Optional comma-separated kinds: class,interface,method,function,constructor,field,property,variable,constant.' }, limit: { type: 'number', description: 'Maximum results (default 20).' } }, required: ['query'] },
  { name: 'kg_symbol', title: 'Symbol details', description: `Everything about one definition: location, signature, who calls it, what it calls, which variables it reads and writes, its local variables and parameters, and members of a class. ${FIRST}`, props: { name: { type: 'string', description: 'Name, Class.Name, Namespace.Class.Name or path/file.py:Name.' } }, required: ['name'] },
  { name: 'kg_usages', title: 'Usages', description: `Every place a function is called / a type is used / a variable is read or written, with file, line and the enclosing function. Prefer this over grep for finding references. ${FIRST}`, props: { name: { type: 'string', description: 'Name, Class.Name or path/file.py:Name.' } }, required: ['name'] },
  { name: 'kg_impact', title: 'Change impact', description: `What depends on a definition, level by level (callers of callers, readers of a variable): use before changing a signature or behaviour to see what could break. ${FIRST}`, props: { name: { type: 'string', description: 'Name, Class.Name or path/file.py:Name.' }, depth: { type: 'number', description: 'Levels to follow (default 3, max 6).' } }, required: ['name'] },
  { name: 'kg_path', title: 'Call path', description: `Shortest chain of calls from one function to another, e.g. how a request handler reaches the database code. ${FIRST}`, props: { from: { type: 'string', description: 'Starting function.' }, to: { type: 'string', description: 'Target function or type.' } }, required: ['from', 'to'] },
  { name: 'kg_file', title: 'File outline', description: `Outline of a source file: its definitions and, for each, what it calls, reads and writes, plus which files it imports and which import it. Read this before opening a large file. ${FIRST}`, props: { path: { type: 'string', description: 'File path relative to the project (absolute paths work too).' } }, required: ['path'] },
  { name: 'kg_variable', title: 'Variable usage', description: `Which functions read and which write a module variable, constant, field or property (shared state analysis). ${FIRST}`, props: { name: { type: 'string', description: 'Variable, Class.field or path/file.py:NAME.' } }, required: ['name'] },
  { name: 'kg_index', title: 'Index a folder', description: 'Build the knowledge graph for a folder that Kiln IDE has not opened yet (C#, Python, JavaScript, TypeScript). Only needed when the other tools report that the folder is not indexed.', props: {}, required: [] },
];

let roots = [];
let clientCaps = {};
let seq = 0;
const pending = new Map();

function send(msg) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
}

function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: { type: 'object', properties: { ...t.props, project: PROJECT_PARAM }, required: t.required, additionalProperties: false },
    annotations: { title: t.title, readOnlyHint: t.name !== 'kg_index', destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }));
}

function projectDir(args) {
  if (args.project) return args.project;
  const argv = process.argv.indexOf('--project');
  if (argv > 0 && process.argv[argv + 1]) return process.argv[argv + 1];
  if (process.env.KILN_PROJECT) return process.env.KILN_PROJECT;
  for (const r of roots) {
    try {
      const p = r.uri && r.uri.startsWith('file:') ? fileURLToPath(r.uri) : r.uri;
      if (p && kg.findProject(p)) return p;
    } catch {
      /* not a file root */
    }
  }
  return process.cwd();
}

async function callTool(name, args = {}) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
  for (const r of t.required) if (args[r] == null || args[r] === '') return { isError: true, content: [{ type: 'text', text: `Missing required argument "${r}".` }] };
  const command = name.slice(3);
  try {
    const result = await kg.run(command, { ...args, project: projectDir(args) }, { maxAge: 1500 });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
}

async function handle(msg) {
  if (msg.method === undefined && msg.id != null) {
    // Response to a request we sent (roots/list).
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
    return;
  }
  const { id, method, params = {} } = msg;
  const reply = (result) => id != null && send({ id, result });
  const fail = (code, message) => id != null && send({ id, error: { code, message } });
  switch (method) {
    case 'initialize':
      clientCaps = params.capabilities || {};
      return reply({
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'kiln-knowledge-graph', title: 'Kiln knowledge graph', version: VERSION },
        instructions: 'Kiln knowledge graph of this codebase. Use these tools first for any question about code structure: where something is defined, who calls it, what it calls, which functions read or write a variable, what a change affects, and file outlines. Fall back to grep or reading files only for what the graph cannot answer (comments, string contents, non-code files).',
      });
    case 'notifications/initialized':
      if (clientCaps.roots) {
        const rid = `roots-${++seq}`;
        pending.set(rid, (m) => {
          if (m.result && Array.isArray(m.result.roots)) roots = m.result.roots;
        });
        send({ id: rid, method: 'roots/list', params: {} });
      }
      return undefined;
    case 'notifications/roots/list_changed':
      if (clientCaps.roots) {
        const rid = `roots-${++seq}`;
        pending.set(rid, (m) => {
          if (m.result && Array.isArray(m.result.roots)) roots = m.result.roots;
        });
        send({ id: rid, method: 'roots/list', params: {} });
      }
      return undefined;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolList() });
    case 'tools/call':
      return reply(await callTool(params.name, params.arguments || {}));
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      if (method && method.startsWith('notifications/')) return undefined;
      return fail(-32601, `Method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    handle(msg).catch((err) => msg.id != null && send({ id: msg.id, error: { code: -32603, message: err.message } }));
  }
});
process.stdin.on('end', () => process.exit(0));
void path;
