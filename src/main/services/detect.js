'use strict';
// Project detection: finds .NET solutions/projects, Python roots, Node packages and agentic-AI
// signals (frameworks, MCP/LangGraph/CrewAI/Claude configs, .env keys), and derives run configurations.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const TOML = require('smol-toml');
const YAML = require('yaml');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', 'bin', 'obj', 'dist', 'build', '.idea', '.vs', '.vscode', '.next', 'target', 'packages', 'TestResults', '.gradle', 'site-packages', '.eggs', 'Pods', 'DerivedData', '.terraform', 'coverage', '.cache', '.turbo', 'out']);
const MAX_ENTRIES = 40000;
const MAX_DEPTH = 6;

// Package -> framework label, per ecosystem.
const PY_AGENT_LIBS = [
  [/^anthropic$/, 'Anthropic SDK'],
  [/^claude-agent-sdk$|^claude-code-sdk$/, 'Claude Agent SDK'],
  [/^openai-agents$/, 'OpenAI Agents SDK'],
  [/^openai$/, 'OpenAI SDK'],
  [/^langgraph($|-)/, 'LangGraph'],
  [/^langchain($|-)/, 'LangChain'],
  [/^langsmith$/, 'LangSmith'],
  [/^crewai($|-)/, 'CrewAI'],
  [/^(autogen-agentchat|autogen-core|autogen-ext|pyautogen|ag2)$/, 'AutoGen'],
  [/^llama-index($|-)/, 'LlamaIndex'],
  [/^semantic-kernel$/, 'Semantic Kernel'],
  [/^smolagents$/, 'smolagents'],
  [/^pydantic-ai($|-)/, 'Pydantic AI'],
  [/^google-adk$/, 'Google ADK'],
  [/^google-genai$|^google-generativeai$/, 'Google GenAI'],
  [/^(mcp|fastmcp)$/, 'MCP'],
  [/^dspy(-ai)?$/, 'DSPy'],
  [/^haystack-ai$/, 'Haystack'],
  [/^agno$|^phidata$/, 'Agno'],
  [/^letta$/, 'Letta'],
  [/^strands-agents($|-)/, 'Strands Agents'],
  [/^litellm$/, 'LiteLLM'],
  [/^instructor$/, 'Instructor'],
  [/^browser-use$/, 'browser-use'],
  [/^camel-ai$/, 'CAMEL'],
  [/^groq$/, 'Groq'],
  [/^mistralai$/, 'Mistral'],
  [/^cohere$/, 'Cohere'],
];
const DOTNET_AGENT_LIBS = [
  [/^Microsoft\.SemanticKernel/i, 'Semantic Kernel'],
  [/^Microsoft\.Agents\.AI/i, 'Microsoft Agent Framework'],
  [/^Microsoft\.Extensions\.AI/i, 'Microsoft.Extensions.AI'],
  [/^(Microsoft\.)?AutoGen/i, 'AutoGen .NET'],
  [/^Anthropic(\.SDK)?$/i, 'Anthropic SDK'],
  [/^OpenAI$/i, 'OpenAI SDK'],
  [/^Azure\.AI\.OpenAI$/i, 'Azure OpenAI'],
  [/^Azure\.AI\.(Projects|Agents)/i, 'Azure AI Agents'],
  [/^ModelContextProtocol/i, 'MCP'],
  [/^LangChain/i, 'LangChain .NET'],
  [/^Microsoft\.KernelMemory/i, 'Kernel Memory'],
  [/^OllamaSharp$/i, 'Ollama'],
];
const NODE_AGENT_LIBS = [
  [/^@anthropic-ai\/sdk$/, 'Anthropic SDK'],
  [/^@anthropic-ai\/claude-agent-sdk$|^@anthropic-ai\/claude-code$/, 'Claude Agent SDK'],
  [/^@openai\/agents/, 'OpenAI Agents SDK'],
  [/^openai$/, 'OpenAI SDK'],
  [/^@langchain\/langgraph/, 'LangGraph'],
  [/^langchain$|^@langchain\//, 'LangChain'],
  [/^ai$|^@ai-sdk\//, 'Vercel AI SDK'],
  [/^@modelcontextprotocol\/sdk$/, 'MCP'],
  [/^@mastra\//, 'Mastra'],
  [/^llamaindex$/, 'LlamaIndex'],
  [/^@google\/genai$/, 'Google GenAI'],
];

// API keys each framework usually needs; reported as hints when missing.
const FRAMEWORK_KEYS = {
  'Anthropic SDK': ['ANTHROPIC_API_KEY'],
  'OpenAI SDK': ['OPENAI_API_KEY'],
  'OpenAI Agents SDK': ['OPENAI_API_KEY'],
  'Google GenAI': ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  'Google ADK': ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI'],
  'Azure OpenAI': ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'],
  Groq: ['GROQ_API_KEY'],
  Mistral: ['MISTRAL_API_KEY'],
  Cohere: ['COHERE_API_KEY'],
};

const normPy = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

async function readText(file, max = 2 * 1024 * 1024) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > max) return null;
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Breadth-first walk collecting the files detection cares about. */
async function scan(root) {
  const found = { sln: [], slnx: [], proj: [], pyproject: [], requirements: [], setupPy: [], pipfile: [], envYml: [], packageJson: [], langgraph: [], mcp: [], crewYaml: [], claudeDirs: [], agentDocs: [], envFiles: [], envExamples: [], pyFiles: [], csFiles: 0, tsconfig: [] };
  const queue = [[root, 0]];
  let seen = 0;
  while (queue.length && seen < MAX_ENTRIES) {
    const [dir, depth] = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.claude') found.claudeDirs.push(full);
        if (SKIP_DIRS.has(e.name) || depth >= MAX_DEPTH) continue;
        if (e.name === 'env' && exists(path.join(full, 'pyvenv.cfg'))) continue;
        if (e.name.startsWith('.') && e.name !== '.claude' && e.name !== '.github') continue;
        queue.push([full, depth + 1]);
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const n = e.name;
      const lower = n.toLowerCase();
      if (lower.endsWith('.sln')) found.sln.push(full);
      else if (lower.endsWith('.slnx')) found.slnx.push(full);
      else if (/\.(cs|fs|vb)proj$/.test(lower)) found.proj.push(full);
      else if (lower.endsWith('.cs')) found.csFiles++;
      else if (n === 'pyproject.toml') found.pyproject.push(full);
      else if (/^requirements[\w.-]*\.(txt|in)$/i.test(n)) found.requirements.push(full);
      else if (n === 'setup.py') found.setupPy.push(full);
      else if (n === 'Pipfile') found.pipfile.push(full);
      else if (n === 'environment.yml' || n === 'environment.yaml') found.envYml.push(full);
      else if (n === 'package.json') found.packageJson.push(full);
      else if (n === 'tsconfig.json') found.tsconfig.push(full);
      else if (n === 'langgraph.json') found.langgraph.push(full);
      else if (n === '.mcp.json' || n === 'mcp.json') found.mcp.push(full);
      else if ((n === 'agents.yaml' || n === 'tasks.yaml') && path.basename(dir) === 'config') found.crewYaml.push(full);
      else if (n === 'CLAUDE.md' || n === 'AGENTS.md') found.agentDocs.push(full);
      else if (n === '.env') found.envFiles.push(full);
      else if (/^\.env\.(example|sample|template|dist)$/i.test(n)) found.envExamples.push(full);
      if (lower.endsWith('.py') && found.pyFiles.length < 3000) found.pyFiles.push(full);
    }
  }
  return found;
}

// ------------------------------------------------------------------ .NET

function parseSln(file, text) {
  const out = [];
  for (const m of text.matchAll(/^Project\("\{([^}]+)\}"\)\s*=\s*"([^"]*)",\s*"([^"]*)"/gm)) {
    if (m[1].toUpperCase() === '2150E333-8FDC-42A3-9474-1A3956D46DE8') continue; // solution folder
    const rel = m[3].replace(/\\/g, '/');
    if (/\.(cs|fs|vb)proj$/i.test(rel)) out.push(path.resolve(path.dirname(file), rel));
  }
  return out;
}

function parseSlnx(file, text) {
  return [...text.matchAll(/<Project\s+[^>]*Path\s*=\s*"([^"]+)"/gi)].map((m) => path.resolve(path.dirname(file), m[1].replace(/\\/g, '/')));
}

function parseProject(file, text) {
  const sdk = (/<Project\s[^>]*Sdk\s*=\s*"([^"]+)"/i.exec(text) || [])[1] || null;
  const outputType = (/<OutputType>\s*([^<]+?)\s*<\/OutputType>/i.exec(text) || [])[1] || null;
  const tfm = (/<TargetFrameworks?>\s*([^<]+?)\s*<\/TargetFrameworks?>/i.exec(text) || [])[1];
  const packages = [];
  for (const m of text.matchAll(/<PackageReference\s+([^>]*?)(\/>|>([\s\S]*?)<\/PackageReference>)/gi)) {
    const attrs = m[1];
    const name = (/Include\s*=\s*"([^"]+)"/i.exec(attrs) || [])[1];
    if (!name) continue;
    const version = (/Version\s*=\s*"([^"]+)"/i.exec(attrs) || [])[1] || (/<Version>([^<]+)<\/Version>/i.exec(m[3] || '') || [])[1] || null;
    packages.push({ name, version });
  }
  const references = [...text.matchAll(/<ProjectReference\s+[^>]*Include\s*=\s*"([^"]+)"/gi)].map((m) => path.resolve(path.dirname(file), m[1].replace(/\\/g, '/')));
  const isTest = /<IsTestProject>\s*true/i.test(text) || /MSTest\.Sdk/i.test(sdk || '') || packages.some((p) => /^(Microsoft\.NET\.Test\.Sdk|xunit|xunit\.v3|NUnit|MSTest\.TestFramework|MSTest|TUnit)$/i.test(p.name));
  const isWeb = /Microsoft\.NET\.Sdk\.(Web|BlazorWebAssembly|Razor)/i.test(sdk || '');
  const isWorker = /Microsoft\.NET\.Sdk\.Worker/i.test(sdk || '');
  const isExe = !isTest && (/exe/i.test(outputType || '') || isWeb || isWorker);
  return {
    name: path.basename(file).replace(/\.(cs|fs|vb)proj$/i, ''),
    path: file,
    dir: path.dirname(file),
    language: /\.fsproj$/i.test(file) ? 'F#' : /\.vbproj$/i.test(file) ? 'VB' : 'C#',
    sdk,
    legacy: !sdk,
    outputType,
    targetFrameworks: tfm ? tfm.split(';').map((s) => s.trim()).filter(Boolean) : [],
    packages,
    references,
    isTest,
    isWeb,
    isExe,
  };
}

async function detectDotnet(root, found) {
  if (!found.sln.length && !found.slnx.length && !found.proj.length) return null;
  const projects = [];
  for (const file of found.proj) {
    const text = await readText(file);
    if (text) projects.push(parseProject(file, text));
  }
  const solutions = [];
  for (const file of [...found.sln, ...found.slnx]) {
    const text = await readText(file);
    if (!text) continue;
    const list = file.toLowerCase().endsWith('.slnx') ? parseSlnx(file, text) : parseSln(file, text);
    solutions.push({ path: file, name: path.basename(file).replace(/\.slnx?$/i, ''), projects: list, depth: path.relative(root, file).split(path.sep).length });
  }
  const folder = path.basename(root).toLowerCase();
  solutions.sort((a, b) => a.depth - b.depth || (b.name.toLowerCase() === folder) - (a.name.toLowerCase() === folder) || a.name.localeCompare(b.name));
  const solution = solutions[0] || null;
  let buildTargets;
  if (solution) {
    buildTargets = [solution.path];
    // Projects outside the solution still get built on their own.
    const inSln = new Set(solution.projects.map((p) => path.normalize(p)));
    const orphans = projects.filter((p) => !inSln.has(path.normalize(p.path)));
    const referenced = new Set(projects.flatMap((p) => p.references.map((r) => path.normalize(r))));
    for (const p of orphans) if (!referenced.has(path.normalize(p.path))) buildTargets.push(p.path);
  } else {
    const referenced = new Set(projects.flatMap((p) => p.references.map((r) => path.normalize(r))));
    buildTargets = projects.filter((p) => !referenced.has(path.normalize(p.path))).map((p) => p.path);
  }
  return { solutions, solution: solution ? solution.path : null, projects, buildTargets, csFiles: found.csFiles };
}

// ---------------------------------------------------------------- Python

function reqName(spec) {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec || '');
  return m ? normPy(m[1]) : null;
}

async function parseRequirements(file, depth = 0) {
  const text = await readText(file);
  const out = [];
  if (!text) return out;
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const inc = /^-(r|c)\s+(.+)$/.exec(line) || /^--requirement[=\s]+(.+)$/.exec(line);
    if (inc && depth < 2) {
      out.push(...(await parseRequirements(path.resolve(path.dirname(file), inc[inc.length - 1].trim()), depth + 1)));
      continue;
    }
    if (line.startsWith('-')) continue;
    const name = reqName(line);
    if (name) out.push(name);
  }
  return out;
}

function findVenv(dir) {
  for (const name of ['.venv', 'venv', 'env', '.env']) {
    const base = path.join(dir, name);
    const py = process.platform === 'win32' ? path.join(base, 'Scripts', 'python.exe') : path.join(base, 'bin', 'python');
    if (exists(py) && (name !== 'env' && name !== '.env' ? true : exists(path.join(base, 'pyvenv.cfg')))) return { dir: base, python: py };
  }
  return null;
}

async function analyzePythonRoot(dir, root, found) {
  const r = { dir, name: path.basename(dir), manifests: {}, deps: [], devDeps: [], depSpecs: [], requiresPython: null, hasBuildSystem: false, scripts: {}, tool: {}, entries: [], hasTests: false };
  const deps = new Set();
  const specs = [];
  const dev = new Set();
  const pyproject = path.join(dir, 'pyproject.toml');
  if (exists(pyproject)) {
    r.manifests.pyproject = pyproject;
    try {
      const doc = TOML.parse((await readText(pyproject)) || '');
      const project = doc.project || {};
      if (project.name) r.name = project.name;
      for (const d of project.dependencies || []) {
        deps.add(reqName(d));
        specs.push(d);
      }
      for (const list of Object.values(project['optional-dependencies'] || {})) for (const d of list) dev.add(reqName(d));
      for (const list of Object.values(doc['dependency-groups'] || {})) for (const d of list) if (typeof d === 'string') dev.add(reqName(d));
      r.requiresPython = project['requires-python'] || null;
      r.scripts = project.scripts || {};
      r.hasBuildSystem = !!doc['build-system'];
      const tool = doc.tool || {};
      r.tool = { uv: !!tool.uv, poetry: !!tool.poetry, crewai: !!tool.crewai, pytest: !!(tool.pytest || {}).ini_options, ruff: !!tool.ruff, hatch: !!tool.hatch, pdm: !!tool.pdm };
      if (tool.poetry) {
        for (const k of Object.keys(tool.poetry.dependencies || {})) if (k !== 'python') deps.add(normPy(k));
        for (const g of Object.values((tool.poetry.group || {}))) for (const k of Object.keys(g.dependencies || {})) dev.add(normPy(k));
        for (const k of Object.keys(tool.poetry['dev-dependencies'] || {})) dev.add(normPy(k));
        if (!project.name && tool.poetry.name) r.name = tool.poetry.name;
        if (tool.poetry.scripts) r.scripts = { ...r.scripts, ...tool.poetry.scripts };
        r.hasBuildSystem = true;
      }
    } catch (err) {
      r.manifests.pyprojectError = err.message;
    }
  }
  const reqs = found.requirements.filter((f) => path.dirname(f) === dir);
  if (reqs.length) {
    r.manifests.requirements = reqs.sort((a, b) => (path.basename(a) === 'requirements.txt' ? -1 : path.basename(b) === 'requirements.txt' ? 1 : a.localeCompare(b)));
    for (const f of reqs) {
      const target = /dev|test|lint|doc/i.test(path.basename(f)) ? dev : deps;
      for (const d of await parseRequirements(f)) target.add(d);
    }
  }
  const setupPy = path.join(dir, 'setup.py');
  if (exists(setupPy)) {
    r.manifests.setupPy = setupPy;
    r.hasBuildSystem = true;
    const text = (await readText(setupPy)) || '';
    const block = /install_requires\s*=\s*\[([\s\S]*?)\]/.exec(text);
    if (block) for (const m of block[1].matchAll(/["']([^"']+)["']/g)) deps.add(reqName(m[1]));
  }
  const pipfile = path.join(dir, 'Pipfile');
  if (exists(pipfile)) {
    r.manifests.pipfile = pipfile;
    try {
      const doc = TOML.parse((await readText(pipfile)) || '');
      for (const [k, v] of Object.entries(doc.packages || {})) {
        deps.add(normPy(k));
        specs.push(typeof v === 'string' && v !== '*' ? `${k}${v}` : k);
      }
      for (const k of Object.keys(doc['dev-packages'] || {})) dev.add(normPy(k));
    } catch {
      /* ignore malformed Pipfile */
    }
  }
  for (const name of ['environment.yml', 'environment.yaml']) {
    const f = path.join(dir, name);
    if (!exists(f)) continue;
    r.manifests.envYml = f;
    try {
      const doc = YAML.parse((await readText(f)) || '') || {};
      for (const d of doc.dependencies || []) {
        if (typeof d === 'string') deps.add(reqName(d.split('=')[0]));
        else if (d && Array.isArray(d.pip)) for (const p of d.pip) deps.add(reqName(p));
      }
    } catch {
      /* ignore malformed environment file */
    }
  }
  if (exists(path.join(dir, 'uv.lock'))) r.manifests.uvLock = path.join(dir, 'uv.lock');
  if (exists(path.join(dir, 'poetry.lock'))) r.manifests.poetryLock = path.join(dir, 'poetry.lock');
  if (exists(path.join(dir, 'Pipfile.lock'))) r.manifests.pipfileLock = path.join(dir, 'Pipfile.lock');
  deps.delete(null);
  dev.delete(null);
  deps.delete('python');
  r.deps = [...deps];
  r.devDeps = [...dev];
  r.depSpecs = specs.length ? specs : r.deps;
  r.venv = findVenv(dir) || (dir !== root ? findVenv(root) : null);
  r.hasManifest = !!(r.manifests.pyproject || r.manifests.requirements || r.manifests.setupPy || r.manifests.pipfile || r.manifests.envYml);

  // Entry points and frameworks.
  const all = new Set([...r.deps, ...r.devDeps]);
  const pyHere = found.pyFiles.filter((f) => f.startsWith(dir + path.sep));
  const topLevel = pyHere.filter((f) => path.dirname(f) === dir || path.dirname(f) === path.join(dir, 'src') || path.dirname(path.dirname(f)) === path.join(dir, 'src'));
  // Modules of a top-level package (app/main.py) import their siblings absolutely: run them with -m.
  const pkgModules = pyHere.filter((f) => path.dirname(path.dirname(f)) === dir && path.basename(f) !== '__init__.py' && exists(path.join(path.dirname(f), '__init__.py')) && !/(^|[\\/])(tests?|test_[^\\/]*)$/.test(path.dirname(f)));
  r.hasTests = all.has('pytest') || pyHere.some((f) => /(^|[\\/])(test_[^\\/]*|[^\\/]*_test)\.py$/.test(f)) || exists(path.join(dir, 'tests'));
  const entries = [];
  const relTo = (f) => path.relative(dir, f).split(path.sep).join('/');
  for (const f of topLevel.slice(0, 80)) {
    const base = path.basename(f);
    const text = (await readText(f, 300 * 1024)) || '';
    const moduleName = relTo(f).replace(/^src\//, '').replace(/\.py$/, '').replace(/\//g, '.');
    if (base === '__main__.py' && path.dirname(f) !== dir) {
      entries.push({ kind: 'module', module: moduleName.replace(/\.__main__$/, ''), file: f });
      continue;
    }
    if (base === 'manage.py' && /django/i.test(text)) {
      entries.push({ kind: 'django', file: f });
      continue;
    }
    const fastapi = /^(\w+)\s*(?::\s*\w+\s*)?=\s*FastAPI\(/m.exec(text);
    if (fastapi) entries.push({ kind: 'uvicorn', file: f, app: `${moduleName}:${fastapi[1]}` });
    const flask = /^(\w+)\s*=\s*Flask\(/m.exec(text);
    if (flask) entries.push({ kind: 'flask', file: f, module: moduleName });
    if (/^\s*import streamlit|^\s*from streamlit/m.test(text) && all.has('streamlit')) entries.push({ kind: 'streamlit', file: f });
    if (/^\s*import chainlit|^\s*from chainlit/m.test(text) && all.has('chainlit')) entries.push({ kind: 'chainlit', file: f });
    if (/if\s+__name__\s*==\s*["']__main__["']/.test(text) || /^(main|app|run|server|agent|bot|cli)\.py$/.test(base)) {
      if (!fastapi && !flask) entries.push({ kind: 'script', file: f, main: /^(main|app|agent)\.py$/.test(base) });
    }
  }
  for (const f of pkgModules.slice(0, 80)) {
    const text = (await readText(f, 300 * 1024)) || '';
    if (path.basename(f) === '__main__.py' || !/if\s+__name__\s*==\s*["']__main__["']/.test(text)) continue;
    entries.push({ kind: 'module', module: relTo(f).replace(/\.py$/, '').replace(/\//g, '.'), file: f });
  }
  r.entries = entries;
  return r;
}

async function detectPython(root, found) {
  const dirs = new Set();
  for (const f of [...found.pyproject, ...found.requirements, ...found.setupPy, ...found.pipfile, ...found.envYml]) dirs.add(path.dirname(f));
  if (!dirs.size && found.pyFiles.length) dirs.add(root);
  if (!dirs.size) return null;
  // Requirements files inside a manifest root's subfolders (e.g. docs/requirements.txt) don't make new roots.
  let list = [...dirs].sort((a, b) => a.length - b.length);
  list = list.filter((d, i) => !list.slice(0, i).some((p) => d.startsWith(p + path.sep) && !exists(path.join(d, 'pyproject.toml')) && !exists(path.join(d, 'setup.py'))));
  const roots = [];
  for (const d of list.slice(0, 8)) roots.push(await analyzePythonRoot(d, root, found));
  return { roots, fileCount: found.pyFiles.length };
}

// ------------------------------------------------------------------ Node

async function detectNode(root, found) {
  const roots = [];
  for (const file of found.packageJson.slice(0, 10)) {
    try {
      const pkg = JSON.parse((await readText(file)) || '{}');
      const dir = path.dirname(file);
      const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
      const pm = exists(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : exists(path.join(dir, 'yarn.lock')) ? 'yarn' : exists(path.join(dir, 'bun.lockb')) || exists(path.join(dir, 'bun.lock')) ? 'bun' : 'npm';
      roots.push({ dir, name: pkg.name || path.basename(dir), deps, scripts: pkg.scripts || {}, packageManager: pm, hasTsconfig: exists(path.join(dir, 'tsconfig.json')), hasTypescript: deps.includes('typescript'), lockfile: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].map((n) => path.join(dir, n)).find(exists) || null });
    } catch {
      /* unreadable package.json */
    }
  }
  return roots.length ? { roots } : null;
}

// --------------------------------------------------------------- Agentic

function parseDotEnv(text) {
  const vars = {};
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    vars[m[1]] = v;
  }
  return vars;
}

async function detectAgentic(root, found, dotnet, python, node) {
  const frameworks = new Map();
  const add = (name, lang, via) => {
    if (!frameworks.has(name)) frameworks.set(name, { name, langs: new Set(), via: new Set() });
    frameworks.get(name).langs.add(lang);
    frameworks.get(name).via.add(via);
  };
  for (const r of python ? python.roots : []) {
    for (const d of [...r.deps, ...r.devDeps]) for (const [re, label] of PY_AGENT_LIBS) if (re.test(d)) add(label, 'Python', d);
  }
  for (const p of dotnet ? dotnet.projects : []) {
    for (const pkg of p.packages) for (const [re, label] of DOTNET_AGENT_LIBS) if (re.test(pkg.name)) add(label, '.NET', pkg.name);
  }
  for (const r of node ? node.roots : []) {
    r.agentic = false;
    for (const d of r.deps) {
      for (const [re, label] of NODE_AGENT_LIBS) {
        if (re.test(d)) {
          add(label, 'Node', d);
          r.agentic = true;
        }
      }
    }
  }
  const configs = [];
  for (const f of found.langgraph) configs.push({ type: 'langgraph', path: f });
  for (const f of found.mcp) configs.push({ type: 'mcp', path: f });
  for (const f of found.crewYaml) configs.push({ type: 'crewai', path: f });
  for (const d of found.claudeDirs) configs.push({ type: 'claude', path: d });
  for (const f of found.agentDocs) configs.push({ type: 'doc', path: f });
  if (found.langgraph.length) add('LangGraph', 'Config', 'langgraph.json');
  if (found.crewYaml.length) add('CrewAI', 'Config', 'config/*.yaml');
  if (found.mcp.length) add('MCP', 'Config', path.basename(found.mcp[0]));

  const isAgentic = frameworks.size > 0;
  if (!isAgentic && !found.claudeDirs.length) return null;

  // Environment variables: keys promised by .env.example and keys the frameworks typically need.
  const envFile = found.envFiles.find((f) => path.dirname(f) === root) || found.envFiles[0] || null;
  const envVars = envFile ? parseDotEnv(await readText(envFile)) : {};
  const example = found.envExamples.find((f) => path.dirname(f) === root) || found.envExamples[0] || null;
  const exampleVars = example ? parseDotEnv(await readText(example)) : {};
  const isSet = (k) => (envVars[k] != null && envVars[k] !== '') || (process.env[k] != null && process.env[k] !== '');
  const missingKeys = Object.keys(exampleVars).filter((k) => !isSet(k));
  const hints = [];
  for (const fw of frameworks.keys()) {
    const keys = FRAMEWORK_KEYS[fw];
    if (keys && !keys.some(isSet) && !keys.some((k) => k in exampleVars)) hints.push({ framework: fw, keys });
  }
  return {
    frameworks: [...frameworks.values()].map((f) => ({ name: f.name, langs: [...f.langs], via: [...f.via] })),
    configs,
    env: { file: envFile, example, missingKeys, hints, definedKeys: Object.keys(envVars) },
    isAgentic,
  };
}

// ----------------------------------------------------------- run configs

function runConfigs(root, dotnet, python, node) {
  const out = [];
  const rel = (p) => path.relative(root, p).split(path.sep).join('/') || '.';
  if (dotnet) {
    for (const p of dotnet.projects.filter((x) => x.isExe)) {
      out.push({ id: `dotnet:run:${rel(p.path)}`, name: p.name, group: '.NET', icon: p.isWeb ? 'web' : 'csharp', command: 'dotnet', args: ['run', '--project', p.path], cwd: p.dir, detail: `dotnet run --project ${rel(p.path)}` });
    }
    for (const p of dotnet.projects.filter((x) => x.isTest)) {
      out.push({ id: `dotnet:test:${rel(p.path)}`, name: `Test: ${p.name}`, group: 'Tests', icon: 'test', command: 'dotnet', args: ['test', p.path], cwd: p.dir, detail: `dotnet test ${rel(p.path)}` });
    }
    if (dotnet.solution && dotnet.projects.some((p) => p.isTest)) {
      out.push({ id: 'dotnet:test:solution', name: 'Test: All (solution)', group: 'Tests', icon: 'test', command: 'dotnet', args: ['test', dotnet.solution], cwd: path.dirname(dotnet.solution), detail: `dotnet test ${rel(dotnet.solution)}` });
    }
  }
  if (python) {
    for (const r of python.roots) {
      const rr = rel(r.dir);
      const prefix = python.roots.length > 1 ? `${r.name}: ` : '';
      const all = new Set([...r.deps, ...r.devDeps]);
      const scripts = r.entries.filter((e) => e.kind === 'script').sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0));
      for (const e of scripts.slice(0, 8)) {
        const f = path.relative(r.dir, e.file).split(path.sep).join('/');
        out.push({ id: `py:file:${rr}:${f}`, name: prefix + f, group: 'Python', icon: 'python', python: true, pyRoot: r.dir, args: [f], cwd: r.dir, detail: `python ${f}` });
      }
      for (const e of r.entries.filter((x) => x.kind === 'module')) {
        out.push({ id: `py:module:${rr}:${e.module}`, name: `${prefix}python -m ${e.module}`, group: 'Python', icon: 'python', python: true, pyRoot: r.dir, args: ['-m', e.module], cwd: r.dir, detail: `python -m ${e.module}` });
      }
      for (const e of r.entries.filter((x) => x.kind === 'uvicorn')) {
        out.push({ id: `py:uvicorn:${rr}:${e.app}`, name: `${prefix}uvicorn ${e.app}`, group: 'Python', icon: 'web', python: true, pyRoot: r.dir, args: ['-m', 'uvicorn', e.app, '--reload'], cwd: r.dir, detail: `uvicorn ${e.app} --reload` });
      }
      for (const e of r.entries.filter((x) => x.kind === 'flask')) {
        out.push({ id: `py:flask:${rr}:${e.module}`, name: `${prefix}flask ${e.module}`, group: 'Python', icon: 'web', python: true, pyRoot: r.dir, args: ['-m', 'flask', '--app', e.module, 'run', '--debug'], cwd: r.dir, detail: `flask --app ${e.module} run` });
      }
      for (const e of r.entries.filter((x) => x.kind === 'streamlit' || x.kind === 'chainlit')) {
        const f = path.relative(r.dir, e.file).split(path.sep).join('/');
        out.push({ id: `py:${e.kind}:${rr}:${f}`, name: `${prefix}${e.kind} ${f}`, group: 'Python', icon: 'web', python: true, pyRoot: r.dir, args: ['-m', e.kind, 'run', f], cwd: r.dir, detail: `${e.kind} run ${f}` });
      }
      for (const e of r.entries.filter((x) => x.kind === 'django')) {
        out.push({ id: `py:django:${rr}`, name: `${prefix}Django runserver`, group: 'Python', icon: 'web', python: true, pyRoot: r.dir, args: ['manage.py', 'runserver'], cwd: r.dir, detail: 'python manage.py runserver' });
      }
      if (all.has('langgraph-cli') || (all.has('langgraph') && exists(path.join(r.dir, 'langgraph.json')))) {
        out.push({ id: `py:langgraph:${rr}`, name: `${prefix}LangGraph dev server`, group: 'Agents', icon: 'agent', python: true, pyRoot: r.dir, script: 'langgraph', args: ['dev'], cwd: r.dir, detail: 'langgraph dev' });
      }
      if (r.tool.crewai || (all.has('crewai') && exists(path.join(r.dir, 'src')))) {
        out.push({ id: `py:crewai:${rr}`, name: `${prefix}CrewAI run`, group: 'Agents', icon: 'agent', python: true, pyRoot: r.dir, script: 'crewai', args: ['run'], cwd: r.dir, detail: 'crewai run' });
      }
      if (all.has('google-adk')) {
        out.push({ id: `py:adk:${rr}`, name: `${prefix}ADK web UI`, group: 'Agents', icon: 'agent', python: true, pyRoot: r.dir, script: 'adk', args: ['web'], cwd: r.dir, detail: 'adk web' });
      }
      for (const name of Object.keys(r.scripts || {}).slice(0, 6)) {
        out.push({ id: `py:script:${rr}:${name}`, name: prefix + name, group: 'Python', icon: 'python', python: true, pyRoot: r.dir, script: name, args: [], cwd: r.dir, detail: `${name} (project script)` });
      }
      if (r.hasTests) {
        out.push({ id: `py:pytest:${rr}`, name: `${prefix}Test: pytest`, group: 'Tests', icon: 'test', python: true, pyRoot: r.dir, args: ['-m', 'pytest'], cwd: r.dir, detail: 'python -m pytest' });
      }
    }
  }
  if (node) {
    for (const r of node.roots) {
      for (const s of Object.keys(r.scripts).filter((k) => ['start', 'dev', 'serve', 'test', 'build', 'agent'].includes(k) || r.agentic)) {
        if (!['start', 'dev', 'serve', 'test', 'build', 'agent', 'watch'].includes(s) && Object.keys(r.scripts).length > 8) continue;
        out.push({ id: `node:${rel(r.dir)}:${s}`, name: `${node.roots.length > 1 ? r.name + ': ' : ''}${r.packageManager} run ${s}`, group: s === 'test' ? 'Tests' : 'Node', icon: 'node', command: r.packageManager, args: ['run', s], cwd: r.dir, detail: r.scripts[s] });
      }
    }
  }
  return out;
}

function summarize(d) {
  const parts = [];
  if (d.dotnet) {
    const sln = d.dotnet.solution ? path.basename(d.dotnet.solution) : null;
    const n = d.dotnet.projects.length;
    parts.push(sln ? `${sln} (${n} project${n === 1 ? '' : 's'})` : `.NET (${n} project${n === 1 ? '' : 's'})`);
  }
  if (d.python) parts.push(`Python${d.python.roots.length > 1 ? ` (${d.python.roots.length} roots)` : ''}`);
  if (d.node && (!d.dotnet && !d.python || d.node.roots.some((r) => r.agentic))) parts.push('Node');
  if (d.agentic && d.agentic.frameworks.length) parts.push('Agentic: ' + d.agentic.frameworks.slice(0, 3).map((f) => f.name).join(', '));
  return parts.join(' · ') || 'Generic project';
}

async function detectProject(root) {
  const started = Date.now();
  const found = await scan(root);
  const dotnet = await detectDotnet(root, found);
  const python = await detectPython(root, found);
  const node = await detectNode(root, found);
  const agentic = await detectAgentic(root, found, dotnet, python, node);
  const kinds = [];
  if (dotnet) kinds.push('dotnet');
  if (python) kinds.push('python');
  if (node) kinds.push('node');
  if (agentic && agentic.isAgentic) kinds.push('agentic');
  const result = { root, name: path.basename(root), kinds, dotnet, python, node, agentic, runConfigs: runConfigs(root, dotnet, python, node), ms: Date.now() - started };
  result.summary = summarize(result);
  return result;
}

module.exports = { detectProject, parseDotEnv, findVenv };
