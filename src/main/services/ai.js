'use strict';
// AI features in the editor and the Commit window: inline completion (ghost text), commit messages
// written from the diff, Generate Documentation / Generate Tests, and a review of the changes before
// they are committed. "Explain an exception" goes to the Claude chat (renderer services/claude.js).
//
// Claude is called through the Anthropic API when ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is set -
// fast, which inline completion needs - and otherwise through Claude Code (the Agent SDK) with the
// user's Claude login. KILN_AI_STUB (a JSON file { kind: reply }) answers without calling Claude, for
// the end-to-end tests.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const settings = require('../settings');
const lineDiff = require('./line-diff');

const DEFAULT_MODEL = 'claude-opus-5-5';
// Models with server-side refusal fallbacks ("default" routing by refusal category).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const MAX_DIFF = 400000;

function config() {
  return { inlineCompletion: true, model: DEFAULT_MODEL, completionModel: DEFAULT_MODEL, ...(settings.get().ai || {}) };
}

// ------------------------------------------------------------- prompts

const COMPLETION_SYSTEM = [
  'You are a code completion engine inside an IDE.',
  'The user message has the code before the cursor between <prefix> tags and the code after it between <suffix> tags.',
  'Reply with only the text to insert at the cursor: no explanation, no Markdown, no code fences, and do not repeat the prefix or the suffix.',
  'Complete the current line, or the current statement or small block (at most 12 lines), the way the surrounding code would.',
  'If there is nothing useful to insert, reply with an empty message.',
].join(' ');

function completionPrompt({ file, language, prefix, suffix }) {
  return `File: ${file}\nLanguage: ${language}\n<prefix>${prefix}</prefix><suffix>${suffix}</suffix>`;
}

/** The completion text as it should be inserted: no fences, nothing the suffix already has. */
function cleanCompletion(text, { prefix = '', suffix = '' } = {}) {
  let t = String(text || '');
  const fence = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(t);
  if (fence) t = fence[1];
  t = t.replace(/^<\/?(prefix|suffix|cursor)>/g, '').replace(/<\/?(prefix|suffix|cursor)>$/g, '');
  // The model sometimes repeats the line before the cursor (or just its indentation).
  const lineStart = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (lineStart && t.startsWith(lineStart)) t = t.slice(lineStart.length);
  // ... or runs on into the code after the cursor.
  const after = suffix.replace(/^[ \t]*/, '');
  // Short overlaps only when they are closing brackets / quotes / punctuation (a real ")" or "];").
  for (let n = Math.min(after.length, t.length); n >= 1; n--) {
    const piece = after.slice(0, n);
    if (t.endsWith(piece) && (n >= 3 || /^[)\]}"'`;,]+$/.test(piece))) {
      t = t.slice(0, t.length - n);
      break;
    }
  }
  return t.replace(/\s+$/, (ws) => (ws.includes('\n') && !suffix.startsWith('\n') ? '' : ws.replace(/\n+$/, '')));
}

const COMMIT_SYSTEM = [
  'You write git commit messages.',
  'Write a subject line of at most 72 characters in the imperative mood ("Add", "Fix", not "Added"), then, when the change is not obvious from the subject, a blank line and a short body that says what changed and why, wrapped at 72 characters.',
  'Follow the style of the recent commit subjects you are given.',
  'Reply with only the commit message.',
].join(' ');

function commitPrompt({ diff, recent = [], truncated = false }) {
  return `${recent.length ? `Recent commit subjects in this repository:\n${recent.map((s) => `- ${s}`).join('\n')}\n\n` : ''}${truncated ? 'The diff is long; only its beginning is included.\n\n' : ''}Diff of the changes to commit:\n\n${diff}`;
}

function cleanCommitMessage(text) {
  let t = String(text || '').trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  return t.replace(/^(commit message|subject):\s*/i, '');
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['error', 'warning', 'info'] },
          message: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['file', 'line', 'severity', 'message', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'findings'],
  additionalProperties: false,
};

const REVIEW_SYSTEM = [
  'You review code changes before they are committed, like a careful senior engineer.',
  'Report real problems only: bugs, missing error handling, security issues, broken edge cases, leftover debug code, secrets, and changes that do not match what the code around them expects.',
  'Do not comment on style unless it hides a bug. Use "error" for bugs and security issues, "warning" for likely problems, "info" for minor points.',
  'Give each finding the file path as it appears in the diff and the line number in the new version of the file.',
  'If the changes look correct, return no findings and say so in the summary.',
].join(' ');

const CODE_SCHEMA = {
  type: 'object',
  properties: { code: { type: 'string' } },
  required: ['code'],
  additionalProperties: false,
};

const DOCS_SYSTEM = [
  'You add documentation comments to code.',
  'You get a file and the declaration to document. Return that declaration with a documentation comment in the language\'s usual style (a docstring for Python, /** */ JSDoc for JavaScript and TypeScript, /// XML comments for C#, and so on): what it does, its parameters, what it returns and what it throws when that is not obvious.',
  'Keep every other line of the declaration exactly as it is, with its indentation. Return only the declaration, without the rest of the file.',
].join(' ');

const TESTS_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' }, content: { type: 'string' } },
  required: ['path', 'content'],
  additionalProperties: false,
};

const TESTS_SYSTEM = [
  'You write unit tests.',
  'You get the file with the code to test, the declaration to focus on, the test framework, and where tests go in this project.',
  'Write focused tests for the normal cases, the edge cases and the error cases, using only the framework and helpers the project already uses.',
  'When the test file already exists you get its content: return all of it with the new tests added, keeping the existing tests unchanged.',
  'Return the test file path relative to the project root and the full file content.',
].join(' ');

/** Paths in a diff for review findings: "a/x" / "b/x" prefixes are dropped. */
function normalizeFindings(result) {
  const findings = ((result && result.findings) || []).map((f) => ({ ...f, file: String(f.file || '').replace(/^[ab]\//, ''), line: Math.max(1, Number(f.line) || 1) }));
  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3) || a.file.localeCompare(b.file) || a.line - b.line);
  return { summary: (result && result.summary) || '', findings };
}

/** Where a test file for `file` usually goes. */
function suggestedTestPath(root, file, framework) {
  const rel = path.relative(root, file);
  const dir = path.dirname(rel);
  const ext = path.extname(rel);
  const base = path.basename(rel, ext);
  if (framework === 'python') return path.join('tests', `test_${base}.py`);
  if (framework === 'dotnet') return path.join(`${dir.split(path.sep)[0] || base}.Tests`, `${base}Tests.cs`);
  if (fs.existsSync(path.join(root, 'test'))) return path.join('test', `${base}.test${ext}`);
  return path.join(dir, `${base}.test${ext}`);
}

// ------------------------------------------------------------- service

class AiService {
  constructor(ctx) {
    this.ctx = ctx;
    this.client = null;
  }

  stub(kind) {
    const file = process.env.KILN_AI_STUB;
    if (!file) return undefined;
    try {
      const all = JSON.parse(fs.readFileSync(file, 'utf8'));
      return kind in all ? all[kind] : undefined;
    } catch {
      return undefined;
    }
  }

  apiAvailable() {
    return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  }

  async api() {
    if (!this.client) {
      const mod = require('@anthropic-ai/sdk');
      const Anthropic = mod.default || mod.Anthropic || mod;
      this.client = new Anthropic();
    }
    return this.client;
  }

  /**
   * One request to Claude: { text } or, with `schema`, { json }. `kind` names the feature (stubs, logs).
   */
  async ask({ kind, system, prompt, model = config().model, effort = 'low', maxTokens = 16000, schema = null }) {
    const stubbed = this.stub(kind);
    if (stubbed !== undefined) return schema ? { json: stubbed } : { text: typeof stubbed === 'string' ? stubbed : JSON.stringify(stubbed) };
    if (this.apiAvailable()) return this.askApi({ system, prompt, model, effort, maxTokens, schema });
    return this.askClaudeCode({ system, prompt, model, schema });
  }

  async askApi({ system, prompt, model, effort, maxTokens, schema }) {
    const client = await this.api();
    const params = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
    };
    // On a policy decline the API re-runs the request on a fallback model (routed by category).
    if (FALLBACK_MODELS.has(model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    const response = FALLBACK_MODELS.has(model) ? await client.beta.messages.create(params) : await client.messages.create(params);
    if (response.stop_reason === 'refusal') throw new Error(`Claude declined this request${response.stop_details && response.stop_details.category ? ` (${response.stop_details.category})` : ''}.`);
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!schema) return { text };
    try {
      return { json: JSON.parse(text) };
    } catch {
      throw new Error('Claude returned an answer that is not valid JSON.');
    }
  }

  async askClaudeCode({ system, prompt, model, schema }) {
    const claude = this.ctx.claude;
    const sdk = await claude.sdk();
    const options = {
      cwd: this.ctx.root || app.getPath('home'),
      env: claude.env(),
      tools: [],
      maxTurns: 1,
      persistSession: false,
      settingSources: [],
      systemPrompt: system,
      model,
    };
    if (schema) options.outputFormat = { type: 'json_schema', schema };
    const exe = claude.executable();
    if (exe) options.pathToClaudeCodeExecutable = exe;
    let result = null;
    for await (const msg of sdk.query({ prompt, options })) {
      if (msg.type === 'result') {
        result = msg;
        break;
      }
    }
    if (!result) throw new Error('Claude Code ended without an answer.');
    if (result.subtype && result.subtype !== 'success') throw new Error((result.errors && result.errors.join('\n')) || `Claude Code stopped (${result.subtype}).`);
    if (!schema) return { text: result.result || '' };
    if (result.structured_output) return { json: result.structured_output };
    try {
      return { json: JSON.parse(/\{[\s\S]*\}/.exec(result.result || '')[0]) };
    } catch {
      throw new Error('Claude returned an answer that is not valid JSON.');
    }
  }

  // ------------------------------------------------------- features

  status() {
    const c = config();
    return { ...c, transport: process.env.KILN_AI_STUB ? 'stub' : this.apiAvailable() ? 'api' : 'claude-code' };
  }

  async inlineCompletion({ file, language, prefix, suffix }) {
    const c = config();
    if (!c.inlineCompletion) return { text: '' };
    const p = String(prefix || '').slice(-6000);
    const s = String(suffix || '').slice(0, 2000);
    const r = await this.ask({ kind: 'inlineCompletion', system: COMPLETION_SYSTEM, prompt: completionPrompt({ file: this.ctx.root ? path.relative(this.ctx.root, file) : file, language, prefix: p, suffix: s }), model: c.completionModel, effort: 'low', maxTokens: 1024 });
    return { text: cleanCompletion(r.text, { prefix: p, suffix: s }) };
  }

  /** The diff of the files to commit (HEAD -> working tree), new files included. */
  async diffOf(files) {
    const git = this.ctx.git;
    const tracked = files.filter((f) => f.kind !== 'untracked').flatMap((f) => (f.origPath ? [f.origPath, f.path] : [f.path]));
    let diff = '';
    if (tracked.length) {
      const hasHead = (await git.raw(['rev-parse', '--verify', '-q', 'HEAD'], { quiet: true })).code === 0;
      diff += (await git.raw(hasHead ? ['diff', '--no-color', '-M', 'HEAD', '--', ...tracked] : ['diff', '--no-color', '--cached', '--', ...tracked], { quiet: true })).stdout;
    }
    for (const f of files.filter((x) => x.kind === 'untracked')) {
      const w = await git.working(f.path);
      if (w.binary) diff += `\nnew binary file ${f.path}\n`;
      else diff += `\ndiff --git a/${f.path} b/${f.path}\nnew file\n--- /dev/null\n+++ b/${f.path}\n${w.text.split('\n').map((l) => `+${l}`).join('\n')}\n`;
    }
    const truncated = diff.length > MAX_DIFF;
    return { diff: truncated ? diff.slice(0, MAX_DIFF) : diff, truncated };
  }

  async commitMessage({ files }) {
    if (!files || !files.length) throw new Error('Select the files to commit first.');
    const { diff, truncated } = await this.diffOf(files);
    if (!diff.trim()) throw new Error('The selected files have no changes.');
    const log = await this.ctx.git.raw(['log', '-12', '--format=%s'], { quiet: true });
    const recent = log.code === 0 ? log.stdout.split('\n').filter(Boolean) : [];
    const r = await this.ask({ kind: 'commitMessage', system: COMMIT_SYSTEM, prompt: commitPrompt({ diff, recent, truncated }), effort: 'low', maxTokens: 2048 });
    return { message: cleanCommitMessage(r.text), truncated };
  }

  async reviewChanges({ files }) {
    if (!files || !files.length) throw new Error('Select the files to review first.');
    const { diff, truncated } = await this.diffOf(files);
    if (!diff.trim()) throw new Error('The selected files have no changes.');
    const r = await this.ask({ kind: 'review', system: REVIEW_SYSTEM, prompt: `${truncated ? 'The diff is long; only its beginning is included.\n\n' : ''}Review these changes:\n\n${diff}`, schema: REVIEW_SCHEMA, effort: 'medium' });
    const out = normalizeFindings(r.json);
    for (const f of out.findings) f.abs = this.ctx.root ? path.resolve(this.ctx.git.root || this.ctx.root, f.file) : f.file;
    return { ...out, truncated };
  }

  /** A declaration with a documentation comment, and the edit that puts it in the file. */
  async generateDocs({ file, text, symbol }) {
    const lines = text.split('\n');
    const decl = lines.slice(symbol.start - 1, symbol.end).join('\n');
    const prompt = `File ${this.ctx.root ? path.relative(this.ctx.root, file) : file}:\n\n${text}\n\nDocument this declaration (lines ${symbol.start}-${symbol.end}, ${symbol.kind} ${symbol.name}):\n\n${decl}`;
    const r = await this.ask({ kind: 'generateDocs', system: DOCS_SYSTEM, prompt, schema: CODE_SCHEMA, effort: 'low' });
    const code = String((r.json && r.json.code) || '').replace(/\n$/, '');
    if (!code.trim()) throw new Error('Claude returned no documentation.');
    const next = [...lines.slice(0, symbol.start - 1), code, ...lines.slice(symbol.end)].join('\n');
    return { file, before: text, after: next, hunks: lineDiff.hunks(text, next) };
  }

  /** A test file for a file / declaration: { path, before, after, hunks }. */
  async generateTests({ file, text, symbol }) {
    const root = this.ctx.root;
    const project = this.ctx.tests.projects().filter((p) => file.startsWith(p.dir + path.sep) || p.kind !== 'dotnet').find((p) => (p.kind === 'python' ? file.endsWith('.py') : p.kind === 'node' ? /\.[cm]?[jt]sx?$/.test(file) : file.endsWith('.cs')));
    const framework = project ? (project.kind === 'node' ? project.framework : project.kind) : file.endsWith('.py') ? 'python' : file.endsWith('.cs') ? 'dotnet' : 'node';
    const label = { python: 'pytest', dotnet: 'xUnit', node: 'node:test', jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha' }[framework] || framework;
    const suggested = suggestedTestPath(root, file, framework === 'python' || framework === 'dotnet' ? framework : 'node');
    const existingPath = path.join(root, suggested);
    const existing = fs.existsSync(existingPath) ? fs.readFileSync(existingPath, 'utf8') : null;
    const focus = symbol ? `Focus on ${symbol.kind} ${symbol.name} (lines ${symbol.start}-${symbol.end}).` : 'Test the public functions of the file.';
    const prompt = `Test framework: ${label}\nSuggested test file: ${suggested}\n${existing != null ? `\nThe test file exists:\n\n${existing}\n` : ''}\nCode to test (${path.relative(root, file)}):\n\n${text}\n\n${focus}`;
    const r = await this.ask({ kind: 'generateTests', system: TESTS_SYSTEM, prompt, schema: TESTS_SCHEMA, effort: 'medium' });
    const rel = String((r.json && r.json.path) || suggested).replace(/^\/+/, '');
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) throw new Error('Claude suggested a test file outside the project.');
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const after = String((r.json && r.json.content) || '');
    if (!after.trim()) throw new Error('Claude returned no tests.');
    return { file: target, framework: label, created: !before, before, after, hunks: lineDiff.hunks(before, after) };
  }
}

module.exports = { AiService, completionPrompt, cleanCompletion, commitPrompt, cleanCommitMessage, normalizeFindings, suggestedTestPath, REVIEW_SCHEMA, DEFAULT_MODEL };
