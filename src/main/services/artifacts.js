'use strict';
// Artifacts knowledge base: Claude artifacts (from claude.ai via Claude Code's Artifact tool) and
// imported documents are parsed into an isolated knowledge graph (documents -> sections -> concepts
// and requirements). Questions are answered from the most relevant excerpts, and the code can be
// checked against the requirements. Stored in Kiln's app-data folder, separate from the code graph.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const settings = require('../settings');

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const STOP = new Set('a an and are as at be been but by can do does for from has have how i if in into is it its may more most must no not of on or our shall should so such than that the their them then there these they this to too use used uses using via was we were what when where which while who why will with would you your also each other only same some any all both few many much very just like well new one two first last make made see etc e.g i.e'.split(' '));

// --------------------------------------------------------------- parsing

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n${'#'.repeat(+n)} ${t.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d|\/section|\/article|\/pre)[^>]*>/gi, '\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => '`' + t.replace(/<[^>]+>/g, '') + '`')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sections(text, title) {
  const out = [];
  let current = { heading: title || 'Overview', level: 1, lines: [] };
  for (const line of text.split('\n')) {
    const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (m) {
      if (current.lines.join('').trim()) out.push(current);
      current = { heading: m[2].trim(), level: m[1].length, lines: [] };
    } else current.lines.push(line);
  }
  if (current.lines.join('').trim()) out.push(current);
  // Split very long sections so retrieval stays precise.
  const chunks = [];
  for (const s of out) {
    const body = s.lines.join('\n').trim();
    if (body.length <= 1800) chunks.push({ heading: s.heading, level: s.level, text: body });
    else {
      let part = '';
      let n = 1;
      for (const para of body.split(/\n\s*\n/)) {
        if ((part + para).length > 1600 && part) {
          chunks.push({ heading: `${s.heading} (${n++})`, level: s.level, text: part.trim() });
          part = '';
        }
        part += para + '\n\n';
      }
      if (part.trim()) chunks.push({ heading: n > 1 ? `${s.heading} (${n})` : s.heading, level: s.level, text: part.trim() });
    }
  }
  return chunks;
}

function tokenize(text) {
  return String(text)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function conceptsOf(text) {
  const found = new Map();
  const add = (term, kind) => {
    const t = term.trim();
    if (t.length < 3 || t.length > 60 || STOP.has(t.toLowerCase())) return;
    const key = t.toLowerCase();
    if (!found.has(key)) found.set(key, { term: t, kind, count: 0 });
    found.get(key).count++;
  };
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) add(m[1].replace(/\(.*$/, ''), 'code');
  for (const m of text.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) add(m[0], 'code');
  for (const m of text.matchAll(/\b[a-z]+(?:_[a-z0-9]+)+\b/g)) add(m[0], 'code');
  for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w/{}:.-]*)/g)) add(`${m[1]} ${m[2]}`, 'endpoint');
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g)) add(m[1], 'term');
  return [...found.values()];
}

function requirementsOf(text) {
  const reqs = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n/)) {
    const s = raw.replace(/^[-*\d.)\s]+/, '').trim();
    if (s.length < 12 || s.length > 400 || s.endsWith('?')) continue;
    if (/\b(must|shall|should|required|requires|need(s)? to|has to|have to|never|always|ensure|mandatory|do not|don't)\b/i.test(s)) reqs.push(s);
  }
  return reqs;
}

// ---------------------------------------------------------------- store

class ArtifactsKB {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = null;
    this.busy = null;
  }

  /** One library for all projects, so stored artifacts are available from anywhere. */
  dir() {
    return path.join(app.getPath('userData'), 'artifacts-kb', 'library');
  }

  async load() {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await fsp.readFile(path.join(this.dir(), 'kb.json'), 'utf8'));
    } catch {
      this.cache = { version: 1, docs: [] };
    }
    return this.cache;
  }

  async save() {
    await fsp.mkdir(this.dir(), { recursive: true });
    const tmp = path.join(this.dir(), 'kb.json.tmp');
    await fsp.writeFile(tmp, JSON.stringify(this.cache));
    await fsp.rename(tmp, path.join(this.dir(), 'kb.json'));
  }

  /** Add or replace a document; everything else (sections, concepts, requirements) is derived here. */
  async addDoc({ title, content, format = 'markdown', source = 'file', url = null, origin = null }) {
    const kb = await this.load();
    const text = format === 'html' ? htmlToText(content) : String(content);
    const docTitle = title || (/<title>([^<]+)<\/title>/i.exec(content) || [])[1] || (/^#\s+(.+)$/m.exec(text) || [])[1] || 'Untitled';
    const id = sha(url || origin || docTitle).slice(0, 12);
    const secs = sections(text, docTitle).map((s, i) => ({ id: `${id}:${i}`, ...s, concepts: conceptsOf(s.heading + '\n' + s.text).map((c) => c.term), requirements: requirementsOf(s.text) }));
    const doc = { id, title: docTitle.trim(), source, url, origin, importedAt: Date.now(), size: text.length, sections: secs };
    kb.docs = kb.docs.filter((d) => d.id !== id);
    kb.docs.push(doc);
    await this.save();
    return { id, title: doc.title, sections: secs.length, requirements: secs.reduce((n, s) => n + s.requirements.length, 0) };
  }

  async importFiles(files) {
    const results = [];
    for (const f of files) {
      const raw = await fsp.readFile(f, 'utf8');
      const ext = path.extname(f).toLowerCase();
      results.push(await this.addDoc({ title: null, content: raw, format: ext === '.html' || ext === '.htm' ? 'html' : 'markdown', source: 'file', origin: f }));
    }
    return results;
  }

  async importProjectDocs() {
    const root = this.ctx.root;
    const picks = [];
    for (const name of ['CLAUDE.md', 'AGENTS.md', 'README.md', 'SPEC.md', 'DESIGN.md', 'ARCHITECTURE.md']) if (fs.existsSync(path.join(root, name))) picks.push(path.join(root, name));
    const docsDir = path.join(root, 'docs');
    if (fs.existsSync(docsDir)) for (const f of fs.readdirSync(docsDir)) if (/\.(md|html?)$/i.test(f)) picks.push(path.join(docsDir, f));
    return this.importFiles(picks.slice(0, 40));
  }

  /**
   * Run Claude Code (through the Agent SDK) with only its Artifact tool, allowing list/read actions,
   * and capture the raw tool results from the message stream.
   */
  async runArtifactTool(prompt, onProgress) {
    const sdk = await this.ctx.claude.sdk();
    const pending = new Map();
    const results = [];
    let sawTool = false;
    const options = {
      cwd: this.ctx.root || app.getPath('home'),
      env: this.ctx.claude.env(),
      model: 'haiku',
      maxTurns: 40,
      permissionMode: 'default',
      persistSession: false,
      settingSources: [],
      canUseTool: async (toolName, input) => {
        if (toolName === 'Artifact' && ['list', 'read'].includes(input.action)) return { behavior: 'allow', updatedInput: input };
        return { behavior: 'deny', message: 'Only listing and reading artifacts is allowed here.' };
      },
    };
    const exe = this.ctx.claude.executable();
    if (exe) options.pathToClaudeCodeExecutable = exe;
    for await (const msg of sdk.query({ prompt, options })) {
      if (msg.type === 'assistant') {
        for (const b of msg.message.content || []) {
          if (b.type === 'tool_use' && b.name === 'Artifact') {
            sawTool = true;
            pending.set(b.id, b.input || {});
            onProgress({ phase: b.input.action, url: b.input.url || null });
          }
        }
      } else if (msg.type === 'user' && Array.isArray(msg.message.content)) {
        for (const b of msg.message.content) {
          if (b.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue;
          const text = typeof b.content === 'string' ? b.content : (b.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
          results.push({ input: pending.get(b.tool_use_id), text, isError: !!b.is_error });
        }
      } else if (msg.type === 'result') {
        break;
      }
    }
    if (!sawTool) throw new Error('Claude Code could not use its Artifact tool in this session (it needs a claude.ai login). You can still import exported HTML/Markdown files.');
    return results;
  }

  async storeRead(r, url) {
    let content = r.text;
    const saved = /(\/[^\s'"]+\.(?:html|md|txt))/.exec(r.text);
    if (saved && fs.existsSync(saved[1])) content = await fsp.readFile(saved[1], 'utf8');
    const isHtml = /<html|<body|<div|<h1|<p>/i.test(content);
    return this.addDoc({ content, format: isHtml ? 'html' : 'markdown', source: 'claude', url });
  }

  /** Import one artifact from a pasted link. */
  async importUrl(url, onProgress = () => {}) {
    const link = String(url || '').trim();
    if (!/^https:\/\/(claude\.ai|claude\.site)\//.test(link)) throw new Error('Paste a claude.ai artifact link, for example https://claude.ai/artifact/…');
    if (/^https:\/\/claude\.site\//.test(link)) {
      // Public artifact pages can be fetched directly.
      const res = await require('electron').net.fetch(link, { headers: { 'User-Agent': 'Kiln-IDE' } });
      if (res.ok) {
        const html = await res.text();
        return this.addDoc({ content: html, format: 'html', source: 'claude', url: link });
      }
    }
    const results = await this.runArtifactTool(`Use the Artifact tool to read this artifact: action "read", url "${link}". Do not publish or change anything and do not summarize. Then reply with the single word DONE.`, onProgress);
    const read = results.find((r) => r.input.action === 'read' && !r.isError);
    if (!read) throw new Error((results[0] && results[0].text.slice(0, 300)) || 'The artifact could not be read.');
    const doc = await this.storeRead(read, link);
    onProgress({ phase: 'imported', title: doc.title });
    return doc;
  }

  /** Import every artifact in the user's claude.ai gallery. */
  async importFromClaude(onProgress = () => {}) {
    const results = await this.runArtifactTool('Use the Artifact tool to list my artifacts (action "list", scope "mine", limit 50). Then read every artifact in the list with the Artifact tool (action "read" with its url). Do not publish or change anything and do not summarize. When all reads are done, reply with the single word DONE.', onProgress);
    const imported = [];
    for (const r of results) {
      if (r.input.action !== 'read' || r.isError) continue;
      const doc = await this.storeRead(r, r.input.url);
      imported.push(doc);
      onProgress({ phase: 'imported', title: doc.title });
    }
    const listed = results.filter((r) => r.input.action === 'list').map((r) => (r.text.match(/https:\/\/claude\.ai\/\S*artifact\/[\w-]+/g) || []).length).reduce((a, b) => a + b, 0);
    return { listed, imported };
  }

  async list() {
    const kb = await this.load();
    return kb.docs.map((d) => ({ id: d.id, title: d.title, source: d.source, url: d.url, origin: d.origin, importedAt: d.importedAt, size: d.size, sections: d.sections.length, requirements: d.sections.reduce((n, s) => n + s.requirements.length, 0) }));
  }

  async read(id) {
    const kb = await this.load();
    return kb.docs.find((d) => d.id === id) || null;
  }

  async remove(id) {
    const kb = await this.load();
    kb.docs = kb.docs.filter((d) => d.id !== id);
    await this.save();
    return true;
  }

  /** Graph of documents, sections, concepts and requirements; concepts that name code symbols are flagged. */
  async graph({ codeNames } = {}) {
    const kb = await this.load();
    const nodes = [];
    const edges = [];
    const conceptIds = new Map();
    for (const d of kb.docs) {
      nodes.push({ id: `doc:${d.id}`, kind: 'artifact', label: d.title });
      for (const s of d.sections) {
        const sid = `sec:${s.id}`;
        nodes.push({ id: sid, kind: 'section', label: s.heading, doc: d.id });
        edges.push({ source: `doc:${d.id}`, target: sid, kind: 'contains', weight: 1 });
        for (const term of s.concepts.slice(0, 25)) {
          const key = term.toLowerCase();
          if (!conceptIds.has(key)) {
            const cid = `con:${key}`;
            conceptIds.set(key, cid);
            nodes.push({ id: cid, kind: 'concept', label: term, inCode: !!(codeNames && codeNames.has(term.replace(/\s+/g, ''))) });
          }
          edges.push({ source: sid, target: conceptIds.get(key), kind: 'mentions', weight: 1 });
        }
        s.requirements.slice(0, 10).forEach((r, i) => {
          const rid = `req:${s.id}:${i}`;
          nodes.push({ id: rid, kind: 'requirement', label: r.length > 80 ? r.slice(0, 77) + '…' : r, text: r });
          edges.push({ source: sid, target: rid, kind: 'requires', weight: 1 });
        });
      }
    }
    return { nodes, edges, docs: kb.docs.length };
  }

  /** BM25 retrieval over sections. */
  async search(query, k = 8) {
    const kb = await this.load();
    const chunks = [];
    for (const d of kb.docs) for (const s of d.sections) chunks.push({ doc: d, sec: s, tokens: tokenize(`${s.heading} ${s.heading} ${s.text}`) });
    if (!chunks.length) return [];
    const df = new Map();
    for (const c of chunks) for (const t of new Set(c.tokens)) df.set(t, (df.get(t) || 0) + 1);
    const avg = chunks.reduce((n, c) => n + c.tokens.length, 0) / chunks.length;
    const q = tokenize(query);
    const scored = chunks.map((c) => {
      const tf = new Map();
      for (const t of c.tokens) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t) || 0;
        if (!f) continue;
        const idf = Math.log(1 + (chunks.length - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
        score += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (c.tokens.length / avg)));
      }
      return { score, c };
    });
    return scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x, i) => ({ ref: `A${i + 1}`, score: Math.round(x.score * 100) / 100, docId: x.c.doc.id, doc: x.c.doc.title, section: x.c.sec.heading, text: x.c.sec.text, url: x.c.doc.url }));
  }

  /** Answer a question from the knowledge base (no tools, no project context: isolated). */
  async ask(question, onEvent = () => {}) {
    const hits = await this.search(question, 8);
    if (!hits.length) return { answer: 'The artifacts knowledge base has nothing related to this question yet. Import artifacts first.', sources: [] };
    const context = hits.map((h) => `[${h.ref}] ${h.doc} — ${h.section}\n${h.text.slice(0, 3000)}`).join('\n\n---\n\n');
    const sdk = await this.ctx.claude.sdk();
    const options = {
      cwd: this.ctx.root || app.getPath('home'),
      env: this.ctx.claude.env(),
      tools: [],
      maxTurns: 1,
      persistSession: false,
      settingSources: [],
      includePartialMessages: true,
      systemPrompt: 'You answer questions using only the artifact excerpts provided by the user. Cite excerpts inline as [A1], [A2]. If the excerpts do not contain the answer, say so plainly.',
    };
    const model = settings.get().claude.model;
    if (model && model !== 'default') options.model = model;
    const exe = this.ctx.claude.executable();
    if (exe) options.pathToClaudeCodeExecutable = exe;
    let answer = '';
    for await (const msg of sdk.query({ prompt: `Artifact excerpts:\n\n${context}\n\nQuestion: ${question}`, options })) {
      if (msg.type === 'stream_event' && msg.event.type === 'content_block_delta' && msg.event.delta.type === 'text_delta') {
        answer += msg.event.delta.text;
        onEvent({ type: 'delta', text: msg.event.delta.text });
      } else if (msg.type === 'result') {
        if (!answer && msg.result) answer = msg.result;
        break;
      }
    }
    return { answer, sources: hits.map(({ text, ...h }) => ({ ...h, preview: text.slice(0, 240) })) };
  }

  /** Check the project's code against requirements found in the selected artifacts. */
  async checkCode({ docIds, focus } = {}, onEvent = () => {}) {
    const kb = await this.load();
    const docs = kb.docs.filter((d) => !docIds || !docIds.length || docIds.includes(d.id));
    const reqs = [];
    for (const d of docs) for (const s of d.sections) for (const r of s.requirements) reqs.push({ id: `R${reqs.length + 1}`, doc: d.title, section: s.heading, text: r });
    if (!reqs.length) return { summary: 'No requirements (must/should/shall statements) were found in the selected artifacts.', findings: [] };
    const sdk = await this.ctx.claude.sdk();
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              requirement: { type: 'string' },
              status: { type: 'string', enum: ['met', 'partial', 'missing', 'violated', 'unknown'] },
              evidence: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, note: { type: 'string' } }, required: ['file', 'note'] } },
              suggestion: { type: 'string' },
            },
            required: ['requirement', 'status', 'evidence'],
          },
        },
      },
      required: ['summary', 'findings'],
    };
    const options = {
      cwd: this.ctx.root,
      env: this.ctx.claude.env(),
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'default',
      maxTurns: 40,
      persistSession: false,
      settingSources: [],
      outputFormat: { type: 'json_schema', schema },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are reviewing this codebase against requirements taken from design artifacts. Only read files; never modify anything. For each requirement decide met / partial / missing / violated / unknown and cite file paths (relative to the project root) with line numbers as evidence.' },
    };
    const model = settings.get().claude.model;
    if (model && model !== 'default') options.model = model;
    const exe = this.ctx.claude.executable();
    if (exe) options.pathToClaudeCodeExecutable = exe;
    const list = reqs.slice(0, 60).map((r) => `${r.id}. (${r.doc} — ${r.section}) ${r.text}`).join('\n');
    const prompt = `Check the code in this project against these requirements${focus ? ` (focus on ${focus})` : ''}:\n\n${list}\n\nReturn one finding per requirement.`;
    let result = null;
    for await (const msg of sdk.query({ prompt, options })) {
      if (msg.type === 'assistant') {
        for (const b of msg.message.content || []) if (b.type === 'tool_use') onEvent({ type: 'tool', name: b.name, input: b.input });
      } else if (msg.type === 'result') {
        result = msg.structured_output || null;
        if (!result && msg.result) {
          try {
            result = JSON.parse(/\{[\s\S]*\}/.exec(msg.result)[0]);
          } catch {
            result = { summary: msg.result, findings: [] };
          }
        }
        break;
      }
    }
    const findings = ((result && result.findings) || []).map((f) => ({ ...f, evidence: (f.evidence || []).map((e) => ({ ...e, abs: e.file ? path.resolve(this.ctx.root, e.file) : null })) }));
    return { summary: (result && result.summary) || '', findings, requirements: reqs.length };
  }
}

module.exports = { ArtifactsKB, htmlToText, sections, requirementsOf, conceptsOf };
