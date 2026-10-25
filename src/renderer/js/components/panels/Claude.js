// Claude tool window: chat with live tool calls, permission prompts, questions, plans and history.
import { html, useEffect, useRef, useState, useMemo } from '../../lib/preact.js';
import { useStore, store } from '../../lib/store.js';
import { Icon } from '../../lib/icons.js';
import { invoke } from '../../lib/ipc.js';
import { cls, relative, basename, timeAgo, formatDuration, fuzzy } from '../../lib/util.js';
import { renderMarkdown, enhanceCodeBlocks } from '../../lib/markdown.js';
import { openPopup } from '../../lib/ui.js';
import { ToolWindow, Spinner } from '../ui.js';
import * as cl from '../../services/claude.js';
import * as ed from '../../services/editor.js';

const MODES = [
  ['default', 'Ask before edits'],
  ['acceptEdits', 'Accept edits'],
  ['plan', 'Plan mode'],
  ['auto', 'Auto mode'],
  ['bypassPermissions', 'Bypass permissions'],
];
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

const rel = (p) => relative(store.get().project && store.get().project.root, p || '');

function toolSummary(name, input = {}) {
  if (input.file_path || input.notebook_path) return rel(input.file_path || input.notebook_path);
  if (input.command) return input.command;
  if (input.pattern) return `${input.pattern}${input.path ? ` in ${rel(input.path)}` : ''}`;
  if (input.url) return input.url;
  if (input.query) return input.query;
  if (input.description) return input.description;
  if (input.skill) return input.skill;
  if (input.prompt) return input.prompt.slice(0, 80);
  const k = Object.keys(input)[0];
  return k ? `${k}: ${String(input[k]).slice(0, 80)}` : '';
}

function DiffLines({ oldText = '', newText = '' }) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  return html`${a.map((l) => html`<div class="diff-del">- ${l}</div>`)}${b.map((l) => html`<div class="diff-add">+ ${l}</div>`)}`;
}

function ToolBody({ item }) {
  const i = item.input || {};
  if (item.name === 'Edit' && (i.old_string != null || i.new_string != null)) return html`<${DiffLines} oldText=${i.old_string} newText=${i.new_string} />`;
  if (item.name === 'MultiEdit' && Array.isArray(i.edits)) return i.edits.map((e) => html`<${DiffLines} oldText=${e.old_string} newText=${e.new_string} /><div class="dim">⋯</div>`);
  if (item.name === 'Write' && i.content != null) return html`<div>${i.content.slice(0, 6000)}${i.content.length > 6000 ? '\n…' : ''}</div>`;
  if (item.name === 'TodoWrite' && Array.isArray(i.todos)) return i.todos.map((t) => html`<div>${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'} ${t.content}</div>`);
  const body = [];
  if (item.name === 'Bash' && i.command) body.push(html`<div style="color:var(--text)">$ ${i.command}</div>`);
  else body.push(html`<div>${JSON.stringify(i, null, 2).slice(0, 4000)}</div>`);
  if (item.result) body.push(html`<div style="margin-top:6px;color:${item.isError ? 'var(--error)' : 'var(--text-secondary)'}">${item.result.slice(0, 6000)}</div>`);
  return body;
}

function ToolCard({ item }) {
  const [open, setOpen] = useState(item.name === 'Edit' || item.name === 'Write' || item.name === 'MultiEdit');
  const file = item.input && (item.input.file_path || item.input.notebook_path);
  const icon = item.status === 'streaming' || item.status === 'running' ? html`<${Spinner} size=${13} />` : item.status === 'error' ? html`<${Icon} name="error" size=${13} className="sev-error" />` : html`<${Icon} name="success" size=${13} className="ok" />`;
  return html`<div class=${cls('tool-card', item.status === 'error' && 'err')} data-testid="tool-card" data-tool=${item.name}>
    <div class="head" onClick=${() => setOpen(!open)}>
      ${icon}<span class="name">${item.name}</span>
      <span class="arg" title=${toolSummary(item.name, item.input)} onClick=${(e) => { if (file) { e.stopPropagation(); ed.openFile(file); } }} style=${file ? 'cursor:pointer;text-decoration:underline dotted' : ''}>${toolSummary(item.name, item.input)}</span>
      ${item.children && item.children.length ? html`<span class="badge">${item.children.length} steps</span>` : null}
      <${Icon} name=${open ? 'chevronDown' : 'chevronRight'} size=${12} className="muted" />
    </div>
    ${open ? html`<div class="body">${item.children && item.children.length ? html`<div style="margin-bottom:6px">${item.children.slice(-12).map((c) => html`<div>${c.done ? (c.isError ? '✗' : '✓') : '…'} ${c.name} ${toolSummary(c.name, c.input)}</div>`)}</div>` : null}<${ToolBody} item=${item} /></div>` : null}
  </div>`;
}

function Markdown({ text }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) enhanceCodeBlocks(ref.current, { onInsert: (code) => insertAtCaret(code) });
  });
  // Turn path:line references into editor links.
  const onClick = (e) => {
    const fl = e.target.closest('.file-link');
    if (fl) {
      const root = store.get().project.root;
      const f = fl.dataset.file;
      ed.openFile(f.startsWith('/') ? f : `${root}/${f}`, { line: +fl.dataset.line || 1 });
      return;
    }
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/^https?:/.test(href)) invoke('app:openExternal', href);
  };
  return html`<div class="msg-assistant" data-testid="claude-message" ref=${ref} onClick=${onClick} dangerouslySetInnerHTML=${{ __html: linkify(renderMarkdown(text)) }}></div>`;
}

function linkify(htmlText) {
  return htmlText.replace(/<code>([\w./\\-]+\.(?:cs|py|ts|tsx|js|jsx|json|md|csproj|yml|yaml|toml))(?::(\d+))?<\/code>/g, (m, f, l) => `<code class="file-link" data-file="${f}" data-line="${l || 1}" style="cursor:pointer;text-decoration:underline dotted">${f}${l ? ':' + l : ''}</code>`);
}

function insertAtCaret(code) {
  const editor = ed.getEditor();
  if (!editor || !editor.getModel()) return;
  const sel = editor.getSelection();
  editor.executeEdits('claude', [{ range: sel, text: code, forceMoveMarkers: true }]);
  editor.focus();
}

function PermissionCard({ chatId, item }) {
  const [answers, setAnswers] = useState({});
  const [other, setOther] = useState({});
  const done = item.state !== 'pending';
  const input = item.input || {};
  const allow = (extra = {}) => cl.respond(chatId, item.id, { behavior: 'allow', ...extra });
  const deny = (message) => cl.respond(chatId, item.id, { behavior: 'deny', message: message || 'The user declined this action.' });
  if (item.toolName === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const submit = () => {
      const out = {};
      for (const q of input.questions) {
        const v = answers[q.question] || [];
        const extra = other[q.question] ? [other[q.question]] : [];
        out[q.question] = [...v, ...extra].join(', ');
      }
      allow({ updatedInput: { ...input, answers: out } });
    };
    return html`<div class="perm-card" data-testid="question-card">
      ${input.questions.map(
        (q) => html`<div style="margin-bottom:10px">
          <div class="title">${q.header ? html`<span class="badge accent" style="margin-right:6px">${q.header}</span>` : null}${q.question}</div>
          ${q.options.map((o) => {
            const on = (answers[q.question] || []).includes(o.label);
            return html`<button class=${cls('question-opt', on && 'on')} disabled=${done} onClick=${() => setAnswers({ ...answers, [q.question]: q.multiSelect ? (on ? answers[q.question].filter((x) => x !== o.label) : [...(answers[q.question] || []), o.label]) : [o.label] })}><span>${o.label}</span><span class="d">${o.description}</span></button>`;
          })}
          <input class="input" style="width:100%;margin-top:4px" placeholder="Other…" disabled=${done} value=${other[q.question] || ''} onInput=${(e) => setOther({ ...other, [q.question]: e.target.value })} />
        </div>`,
      )}
      ${done ? html`<div class="muted">Answered</div>` : html`<div class="actions"><button class="btn primary" onClick=${submit}>Submit answers</button><button class="btn" onClick=${() => deny('The user preferred not to answer.')}>Skip</button></div>`}
    </div>`;
  }
  if (item.toolName === 'ExitPlanMode') {
    return html`<div class="perm-card" data-testid="plan-card">
      <div class="title">Claude's plan</div>
      <${Markdown} text=${input.plan || ''} />
      ${done
        ? html`<div class="muted">${item.state === 'allowed' ? 'Plan approved' : 'Kept planning'}</div>`
        : html`<div class="actions"><button class="btn primary" onClick=${() => allow({ setMode: 'acceptEdits' })}>Approve and auto-accept edits</button><button class="btn" onClick=${() => allow({ setMode: 'default' })}>Approve, ask before edits</button><button class="btn" onClick=${() => deny('Keep planning: the user wants to refine the plan.')}>Keep planning</button></div>`}
    </div>`;
  }
  const file = input.file_path;
  return html`<div class="perm-card" data-testid="permission-card">
    <div class="title">${item.title || `Claude wants to use ${item.displayName || item.toolName}`}</div>
    ${item.description ? html`<div class="muted" style="font-size:12px">${item.description}</div>` : null}
    ${input.command ? html`<pre>${input.command}</pre>` : null}
    ${file ? html`<div class="mono" style="margin:4px 0"><a onClick=${() => ed.openFile(file)}>${rel(file)}</a></div>` : null}
    ${item.toolName === 'Edit' ? html`<pre><${DiffLines} oldText=${input.old_string} newText=${input.new_string} /></pre>` : null}
    ${item.toolName === 'Write' ? html`<pre>${(input.content || '').slice(0, 2000)}</pre>` : null}
    ${!input.command && !file ? html`<pre>${JSON.stringify(input, null, 2).slice(0, 1500)}</pre>` : null}
    ${item.decisionReason ? html`<div class="muted" style="font-size:12px">${item.decisionReason}</div>` : null}
    ${done
      ? html`<div class="muted">${item.state === 'allowed' ? 'Allowed' : item.state === 'cancelled' ? 'Cancelled' : 'Denied'}</div>`
      : html`<div class="actions">
          <button class="btn primary" data-testid="permission-allow" onClick=${() => allow()}>Allow</button>
          ${item.canAlwaysAllow ? html`<button class="btn" onClick=${() => allow({ always: true })}>Allow for this session</button>` : null}
          <button class="btn" data-testid="permission-deny" onClick=${() => deny()}>Deny</button>
        </div>`}
  </div>`;
}

function ChatItem({ chatId, item }) {
  switch (item.kind) {
    case 'user':
      return html`<div class="msg-user">
        ${item.chips && item.chips.length ? html`<div class="chips">${item.chips.map((c) => html`<span class="chip"><${Icon} name="file" size=${12} />${c}</span>`)}</div>` : null}
        ${item.text}
        ${item.uuid ? html`<div style="text-align:right;margin-top:4px"><a style="font-size:11px" title="Restore files to how they were before this message" onClick=${() => cl.rewind(chatId, item.uuid)}>Undo edits from here</a></div>` : null}
      </div>`;
    case 'text':
      return html`<${Markdown} text=${item.text} />`;
    case 'thinking':
      return item.text ? html`<details class="thinking" open=${item.streaming}><summary>${item.streaming ? 'Thinking…' : `Thought${item.endedAt && item.startedAt ? ` for ${formatDuration(item.endedAt - item.startedAt)}` : ''}`}</summary>${item.text}</details>` : item.streaming ? html`<div class="thinking"><${Spinner} size=${12} /> Thinking…</div>` : null;
    case 'tool':
      return html`<${ToolCard} item=${item} />`;
    case 'permission':
      return html`<${PermissionCard} chatId=${chatId} item=${item} />`;
    case 'result':
      return html`<div class="result-line">${item.isError ? html`<${Icon} name="error" size=${12} className="sev-error" />` : html`<${Icon} name="success" size=${12} className="ok" />`}<span>${item.isError ? item.subtype.replace(/_/g, ' ') : 'Done'}</span>${item.durationMs ? html`<span>${formatDuration(item.durationMs)}</span>` : null}${item.turns ? html`<span>${item.turns} turn${item.turns === 1 ? '' : 's'}</span>` : null}${item.edits && item.edits.length ? html`<span>${item.edits.length} file${item.edits.length === 1 ? '' : 's'} edited</span>` : null}${item.text ? html`<div class="sev-error">${item.text}</div>` : null}</div>`;
    case 'error':
      return html`<div class="chat-error"><b>${item.message}</b>${item.detail ? html`<div style="margin-top:6px;font-size:12px;opacity:.85">${item.detail}</div>` : null}${/login|auth|credential|401|api key/i.test(item.message + (item.detail || '')) ? html`<div style="margin-top:6px;color:var(--text-secondary)">Sign in by running <code>claude</code> once in the Terminal, or set ANTHROPIC_API_KEY.</div>` : null}</div>`;
    case 'note':
      return html`<div class="muted" style="font-size:12px">${item.text}</div>`;
    default:
      return null;
  }
}

let fileListCache = null;

function Composer({ chat }) {
  const probe = useStore((s) => s.claude.probe);
  const activeFile = useStore((s) => {
    const t = s.editor.tabs.find((x) => x.id === s.editor.active);
    return t && t.kind === 'file' ? t.path : null;
  });
  const [text, setText] = useState('');
  const [sugg, setSugg] = useState(null);
  const [sel, setSel] = useState(0);
  const ta = useRef(null);
  const busy = chat.status === 'busy' || chat.status === 'starting';
  const commands = useMemo(() => {
    if (!probe || !probe.ok) return [];
    const skills = new Set((probe.skills || []).map((s) => s.name));
    const list = [...(probe.skills || []).map((s) => ({ name: s.name, description: s.description, skill: true })), ...(probe.commands || []).filter((c) => !skills.has(c.name)).map((c) => ({ name: c.name, description: c.description, hint: c.argumentHint }))];
    return list;
  }, [probe]);
  useEffect(() => {
    const h = (e) => {
      if (e.detail && e.detail.text != null) {
        setText(e.detail.text);
        setTimeout(() => ta.current && (ta.current.focus(), (ta.current.selectionStart = ta.current.selectionEnd = e.detail.text.length)), 0);
      }
    };
    window.addEventListener('kiln:claude-insert', h);
    return () => window.removeEventListener('kiln:claude-insert', h);
  }, []);
  const update = async (value) => {
    setText(value);
    const caret = ta.current ? ta.current.selectionStart : value.length;
    const before = value.slice(0, caret);
    const slash = /^\/([\w:.-]*)$/.exec(before);
    const at = /(?:^|\s)@([\w./-]*)$/.exec(before);
    if (slash) {
      const q = slash[1].toLowerCase();
      setSugg({ type: 'slash', items: commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 40) });
      setSel(0);
    } else if (at) {
      if (!fileListCache) fileListCache = (await invoke('fs:listFiles').catch(() => ({ files: [] }))).files;
      const q = at[1];
      const items = fileListCache.map((f) => ({ f, m: fuzzy(q, f) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score).slice(0, 30).map((x) => ({ name: x.f }));
      setSugg({ type: 'at', items, q });
      setSel(0);
    } else setSugg(null);
  };
  const pick = (item) => {
    if (!sugg) return;
    if (sugg.type === 'slash') update(`/${item.name} `);
    else {
      const caret = ta.current.selectionStart;
      const before = text.slice(0, caret).replace(/@([\w./-]*)$/, `@${item.name} `);
      update(before + text.slice(caret));
    }
    setSugg(null);
    ta.current.focus();
  };
  const submit = () => {
    if (!text.trim() || busy) return;
    cl.sendMessage(text);
    setText('');
    setSugg(null);
  };
  const key = (e) => {
    if (sugg && sugg.items.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        return setSel((s) => Math.min(s + 1, sugg.items.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        return setSel((s) => Math.max(s - 1, 0));
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        return pick(sugg.items[sel]);
      }
      if (e.key === 'Escape') return setSugg(null);
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && busy) cl.interrupt();
  };
  const models = probe && probe.models && probe.models.length ? probe.models : [{ value: 'default', displayName: 'Default' }, { value: 'opus', displayName: 'Opus' }, { value: 'sonnet', displayName: 'Sonnet' }, { value: 'haiku', displayName: 'Haiku' }];
  return html`<div class="composer">
    ${sugg && sugg.items.length
      ? html`<div class="suggest">${sugg.items.map((it, i) => html`<div class=${cls('s-row', i === sel && 'selected')} onMouseDown=${(e) => { e.preventDefault(); pick(it); }} onMouseEnter=${() => setSel(i)}>
          ${sugg.type === 'slash' ? html`<${Icon} name=${it.skill ? 'skill' : 'terminal'} size=${13} className="muted" /><span class="mono">/${it.name}</span>${it.hint ? html`<span class="d">${it.hint}</span>` : null}<span class="d">${it.description}</span>` : html`<${Icon} name="file" size=${13} className="muted" /><span>${basename(it.name)}</span><span class="d">${it.name}</span>`}
        </div>`)}</div>`
      : null}
    <div class="row" style="flex-wrap:wrap">
      ${activeFile ? html`<span class="chip" title="The open file and selection are sent as context">${chat.includeContext ? html`<${Icon} name="file" size=${12} />` : html`<${Icon} name="eye" size=${12} className="dim" />`}<span class=${cls('ellipsis', !chat.includeContext && 'dim')}>${basename(activeFile)}</span><span class="x" onClick=${() => cl.configure({ includeContext: !chat.includeContext })}><${Icon} name=${chat.includeContext ? 'close' : 'plus'} size=${11} /></span></span>` : null}
      <span class="spacer"></span>
      <label class="checkbox" style="font-size:12px" title="Open files in the editor as Claude edits them"><input type="checkbox" checked=${chat.follow} onChange=${(e) => cl.configure({ follow: e.target.checked })} />Follow edits</label>
    </div>
    <textarea ref=${ta} data-testid="claude-input" placeholder="Ask Claude to write, explain or fix code…  ( / skills & commands · @ files · ⇧↩ new line )" value=${text} onInput=${(e) => update(e.target.value)} onKeyDown=${key}></textarea>
    <div class="bar">
      <select class="input" title="Permission mode" value=${chat.permissionMode} onChange=${(e) => cl.configure({ permissionMode: e.target.value })}>${MODES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
      <select class="input" title="Model" value=${chat.model} onChange=${(e) => cl.configure({ model: e.target.value })}>${models.map((m) => html`<option value=${m.value}>${m.displayName}</option>`)}</select>
      <select class="input" title="Effort" value=${chat.effort} onChange=${(e) => cl.configure({ effort: e.target.value })}>${EFFORTS.map((v) => html`<option value=${v}>${v === 'default' ? 'Effort: default' : `Effort: ${v}`}</option>`)}</select>
      <span class="spacer"></span>
      ${busy ? html`<button class="btn small" data-testid="claude-stop" onClick=${() => cl.interrupt()}><${Icon} name="stop" size=${12} />Stop</button>` : html`<button class="btn small primary" data-testid="claude-send" disabled=${!text.trim()} onClick=${submit}><${Icon} name="send" size=${12} />Send</button>`}
    </div>
  </div>`;
}

export function ClaudePanel({ onHide }) {
  const claude = useStore((s) => s.claude);
  const chat = claude.chats[claude.active] || cl.getChat(claude.active);
  const ref = useRef(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const showHistory = async () => {
    const list = await invoke('claude:sessions').catch(() => []);
    openPopup({ type: 'list', title: 'Claude sessions in this project', items: list.length ? list.map((s) => ({ label: s.summary, hint: `${timeAgo(s.lastModified)}${s.gitBranch ? ` · ${s.gitBranch}` : ''}`, icon: 'history', run: () => cl.resumeSession(s.sessionId, s.summary) })) : [{ label: 'No earlier sessions', run: () => {} }] });
  };
  const chats = Object.values(claude.chats);
  return html`<${ToolWindow} side="right" title="Claude" testid="claude-panel" onHide=${onHide}
      tabs=${chats.length > 1 ? chats.map((c) => html`<button class=${cls('tw-tab', c.id === claude.active && 'active')} onClick=${() => cl.switchChat(c.id)} title=${c.title}><span class="ellipsis" style="max-width:110px">${c.title}</span><span class="close" onClick=${(e) => { e.stopPropagation(); cl.closeChat(c.id); }}><${Icon} name="close" size=${11} /></span></button>`) : null}
      actions=${html`<button class="icon-btn sm" title="Chat history" onClick=${showHistory}><${Icon} name="history" /></button><button class="icon-btn sm" title="New chat" onClick=${() => cl.startNewChat()}><${Icon} name="plus" /></button>`}>
    <div class="claude-panel">
      ${chat.status === 'starting' ? html`<div class="claude-status"><${Spinner} size=${12} />Starting Claude Code…</div>` : null}
      <div class="chat" ref=${ref} onScroll=${(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        ${!chat.items.length
          ? html`<div class="empty" style="padding-top:40px">
              <${Icon} name="claude" size=${28} style="color:#D97757" />
              <div style="margin:10px 0 4px;color:var(--text);font-weight:600">Claude in Kiln</div>
              <div>Ask Claude to write, update or fix code. Edits appear live in the editor and the project rebuilds afterwards.</div>
              <div class="row" style="justify-content:center;flex-wrap:wrap;margin-top:12px;gap:6px">
                ${['Explain this project', 'Find bugs in the open file', 'Add unit tests for the open file', 'Fix the build errors'].map((p) => html`<button class="btn small" onClick=${() => (p === 'Fix the build errors' ? cl.fixBuildProblems() : cl.sendMessage(p))}>${p}</button>`)}
              </div>
            </div>`
          : chat.items.map((it) => html`<${ChatItem} key=${it.id} chatId=${chat.id} item=${it} />`)}
        ${chat.status === 'busy' && !chat.items.some((it) => it.streaming || it.status === 'streaming') ? html`<div class="claude-status"><${Spinner} size=${12} />${chat.statusText || 'Claude is working…'} <span class="dim">Esc to interrupt</span></div>` : null}
      </div>
      <${Composer} chat=${chat} />
    </div>
  <//>`;
}
