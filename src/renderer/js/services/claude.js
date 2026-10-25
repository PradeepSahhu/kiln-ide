// Claude chat state: turns the Agent SDK message stream into chat items, handles permission prompts,
// follows Claude's file edits in the editor and rebuilds afterwards.
import { store } from '../lib/store.js';
import { invoke, on } from '../lib/ipc.js';
import { toast } from '../lib/ui.js';
import { uid, relative } from '../lib/util.js';
import * as ed from './editor.js';
import { openTool } from './layout.js';
import { startBuild } from './build.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const streamState = new Map(); // chatId -> { msgId, keys: Map(index -> itemId) }
let chatSeq = 1;

function cfg() {
  return (store.get().settings && store.get().settings.claude) || {};
}

function newChat(id) {
  return { id, items: [], status: 'idle', sessionId: null, model: cfg().model || 'default', permissionMode: cfg().permissionMode || 'default', effort: cfg().effort || 'default', follow: true, includeContext: cfg().includeContext !== false, turnEdits: [], title: 'New chat', configured: false };
}

export function activeChatId() {
  return store.get().claude.active;
}

export function getChat(id = activeChatId()) {
  return store.get().claude.chats[id] || newChat(id);
}

function setChat(id, fn) {
  store.update('claude', (c) => ({ ...c, chats: { ...c.chats, [id]: fn(c.chats[id] || newChat(id)) } }));
}

function updateItem(chatId, itemId, fn) {
  setChat(chatId, (c) => ({ ...c, items: c.items.map((it) => (it.id === itemId ? fn(it) : it)) }));
}

function pushItem(chatId, item) {
  setChat(chatId, (c) => ({ ...c, items: [...c.items, item] }));
}

function findItem(chatId, pred) {
  return getChat(chatId).items.find(pred);
}

const toolText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n') : '');

function tryParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Best-effort view of a tool input that is still streaming. */
function partialInput(json) {
  const full = tryParse(json);
  if (full) return full;
  const out = {};
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'description']) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
    if (m) out[key] = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  const content = /"(content|new_string)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(json);
  if (content) out[content[1]] = content[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return out;
}

function onEdit(chatId, input) {
  const file = input && (input.file_path || input.notebook_path);
  if (!file) return;
  setChat(chatId, (c) => ({ ...c, turnEdits: [...new Set([...c.turnEdits, file])] }));
  if (getChat(chatId).follow) ed.openFile(file, { preview: true, focus: false }).catch(() => {});
}

function handleEvent(chatId, msg) {
  const st = streamState.get(chatId) || { msgId: null, keys: new Map(), streamed: new Set() };
  streamState.set(chatId, st);
  if (msg.type === 'stream_event') {
    if (msg.parent_tool_use_id) return;
    const ev = msg.event;
    if (ev.type === 'message_start') {
      st.msgId = ev.message.id;
      st.keys = new Map();
    } else if (ev.type === 'content_block_start') {
      const b = ev.content_block;
      const id = b.type === 'tool_use' ? b.id : `${st.msgId}:${ev.index}`;
      st.keys.set(ev.index, id);
      st.streamed.add(st.msgId);
      if (b.type === 'text') pushItem(chatId, { kind: 'text', id, text: '', streaming: true });
      else if (b.type === 'thinking') pushItem(chatId, { kind: 'thinking', id, text: '', streaming: true, startedAt: Date.now() });
      else if (b.type === 'tool_use' || b.type === 'server_tool_use') pushItem(chatId, { kind: 'tool', id, name: b.name, input: {}, inputJson: '', status: 'streaming', children: [] });
    } else if (ev.type === 'content_block_delta') {
      const id = st.keys.get(ev.index);
      if (!id) return;
      const d = ev.delta;
      if (d.type === 'text_delta') updateItem(chatId, id, (it) => ({ ...it, text: it.text + d.text }));
      else if (d.type === 'thinking_delta') updateItem(chatId, id, (it) => ({ ...it, text: it.text + d.thinking }));
      else if (d.type === 'input_json_delta') updateItem(chatId, id, (it) => {
        const inputJson = it.inputJson + d.partial_json;
        return { ...it, inputJson, input: partialInput(inputJson) };
      });
    } else if (ev.type === 'content_block_stop') {
      const id = st.keys.get(ev.index);
      if (!id) return;
      const it = findItem(chatId, (x) => x.id === id);
      if (!it) return;
      if (it.kind === 'tool') {
        const input = tryParse(it.inputJson) || it.input;
        updateItem(chatId, id, (x) => ({ ...x, input, status: 'running' }));
        if (EDIT_TOOLS.has(it.name)) onEdit(chatId, input);
      } else updateItem(chatId, id, (x) => ({ ...x, streaming: false, endedAt: Date.now() }));
    }
    return;
  }
  if (msg.type === 'assistant') {
    const content = (msg.message && msg.message.content) || [];
    if (msg.parent_tool_use_id) {
      const parent = findItem(chatId, (x) => x.id === msg.parent_tool_use_id);
      if (parent) {
        const kids = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
        if (kids.length) updateItem(chatId, parent.id, (p) => ({ ...p, children: [...p.children, ...kids] }));
      }
      return;
    }
    const streamed = st.streamed.has(msg.message.id);
    content.forEach((b, i) => {
      if (b.type === 'tool_use') {
        const existing = findItem(chatId, (x) => x.id === b.id);
        if (existing) updateItem(chatId, b.id, (x) => ({ ...x, input: b.input, status: x.status === 'streaming' ? 'running' : x.status }));
        else {
          pushItem(chatId, { kind: 'tool', id: b.id, name: b.name, input: b.input, inputJson: '', status: 'running', children: [] });
          if (EDIT_TOOLS.has(b.name)) onEdit(chatId, b.input);
        }
      } else if (!streamed && b.type === 'text' && b.text) pushItem(chatId, { kind: 'text', id: `${msg.message.id}:${i}:${uid('t')}`, text: b.text });
      else if (!streamed && b.type === 'thinking' && b.thinking) pushItem(chatId, { kind: 'thinking', id: `${msg.message.id}:${i}:${uid('k')}`, text: b.thinking });
    });
    if (msg.error) pushItem(chatId, { kind: 'error', id: uid('e'), message: String(msg.error) });
    return;
  }
  if (msg.type === 'user') {
    const content = msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      if (msg.parent_tool_use_id) {
        const parent = findItem(chatId, (x) => x.id === msg.parent_tool_use_id);
        if (parent) updateItem(chatId, parent.id, (p) => ({ ...p, children: p.children.map((k) => (k.id === b.tool_use_id ? { ...k, done: true, isError: !!b.is_error } : k)) }));
        continue;
      }
      const it = findItem(chatId, (x) => x.id === b.tool_use_id);
      if (!it) continue;
      updateItem(chatId, it.id, (x) => ({ ...x, result: toolText(b.content).slice(0, 20000), isError: !!b.is_error, status: b.is_error ? 'error' : 'done' }));
      const file = it.input && (it.input.file_path || it.input.notebook_path);
      if (!b.is_error && EDIT_TOOLS.has(it.name) && file) ed.onFsChanged([file], { follow: getChat(chatId).follow });
    }
    return;
  }
  if (msg.type === 'system') {
    if (msg.subtype === 'init') setChat(chatId, (c) => ({ ...c, sessionId: msg.session_id, liveModel: msg.model, livePermissionMode: msg.permissionMode }));
    else if (msg.subtype === 'api_retry') pushItem(chatId, { kind: 'note', id: uid('n'), text: `API request failed (${msg.error_status || 'network'}), retrying (attempt ${msg.attempt} of ${msg.max_retries})…` });
    else if (msg.subtype === 'compact_boundary') pushItem(chatId, { kind: 'note', id: uid('n'), text: 'Conversation compacted to free up context.' });
    else if (msg.subtype === 'permission_denied') pushItem(chatId, { kind: 'note', id: uid('n'), text: `${msg.tool_name} was not allowed: ${msg.message}` });
    else if (msg.subtype === 'status' && msg.status) setChat(chatId, (c) => ({ ...c, statusText: msg.status }));
    return;
  }
  if (msg.type === 'result') {
    const c = getChat(chatId);
    pushItem(chatId, { kind: 'result', id: uid('r'), subtype: msg.subtype, isError: msg.is_error, durationMs: msg.duration_ms, costUsd: msg.total_cost_usd, turns: msg.num_turns, text: msg.subtype !== 'success' ? (msg.errors || []).join('\n') || msg.result : '', edits: c.turnEdits });
    if (c.turnEdits.length && store.get().settings.build.rebuildAfterClaude) startBuild({ reason: 'claude' });
    setChat(chatId, (x) => ({ ...x, turnEdits: [], statusText: '' }));
    streamState.delete(chatId);
  }
}

export function initClaude() {
  on('claude:event', ({ chatId, msg }) => handleEvent(chatId, msg));
  on('claude:status', (s) => {
    setChat(s.chatId, (c) => ({ ...c, status: s.state, sessionId: s.sessionId || c.sessionId }));
    if (s.state === 'error') pushItem(s.chatId, { kind: 'error', id: uid('e'), message: s.error, detail: s.detail });
  });
  on('claude:permission', (p) => {
    pushItem(p.chatId, { kind: 'permission', id: p.requestId, ...p, state: 'pending' });
    const layout = store.get().layout;
    if (layout.right !== 'claude') openTool('right', 'claude');
  });
  on('claude:permissionCancel', ({ chatId, requestId }) => updateItem(chatId, requestId, (x) => ({ ...x, state: 'cancelled' })));
}

export async function respond(chatId, requestId, decision) {
  updateItem(chatId, requestId, (x) => ({ ...x, state: decision.behavior === 'allow' ? 'allowed' : 'denied', decision }));
  await invoke('claude:respond', chatId, requestId, decision);
}

/** IDE context sent with each prompt: the open file, cursor and selection. */
function ideContext() {
  const path = ed.activeFile();
  const root = store.get().project && store.get().project.root;
  if (!path) return null;
  const e = store.get().editor;
  const rel = relative(root, path);
  let ctx = `<ide_context>\nThe user has ${rel} open in the editor${e.cursor ? `, cursor at line ${e.cursor.line}` : ''}.`;
  if (e.selection && e.selection.trim()) {
    const lines = e.selection.split('\n');
    const sel = lines.length > 150 ? lines.slice(0, 150).join('\n') + '\n…' : e.selection;
    ctx += `\nSelected text${e.selectionLines ? ` (lines ${e.selectionLines[0]}-${e.selectionLines[1]})` : ''}:\n\`\`\`\n${sel}\n\`\`\``;
  }
  return ctx + '\n</ide_context>';
}

export async function configure(patch, chatId = activeChatId()) {
  setChat(chatId, (c) => ({ ...c, ...patch }));
  const c = getChat(chatId);
  await invoke('claude:configure', chatId, { model: c.model, permissionMode: c.permissionMode, effort: c.effort }).catch(() => {});
  setChat(chatId, (x) => ({ ...x, configured: true }));
}

export async function sendMessage(text, { chatId = activeChatId(), images = [] } = {}) {
  const t = String(text || '').trim();
  if (!t) return;
  const c = getChat(chatId);
  if (!c.configured) await configure({}, chatId);
  const context = c.includeContext ? ideContext() : null;
  const chips = context ? [relative(store.get().project.root, ed.activeFile())] : [];
  const title = c.items.length ? c.title : t.slice(0, 60);
  setChat(chatId, (x) => ({ ...x, title, status: 'busy', items: [...x.items, { kind: 'user', id: uid('u'), text: t, chips, images: images.length }] }));
  try {
    const r = await invoke('claude:send', chatId, { text: t, context, images });
    setChat(chatId, (x) => ({ ...x, items: x.items.map((it, i) => (i === x.items.length - 1 && it.kind === 'user' ? { ...it, uuid: r.uuid } : it)) }));
  } catch (err) {
    pushItem(chatId, { kind: 'error', id: uid('e'), message: err.message });
    setChat(chatId, (x) => ({ ...x, status: 'idle' }));
  }
}

export function interrupt(chatId = activeChatId()) {
  return invoke('claude:interrupt', chatId);
}

export async function startNewChat() {
  const id = `chat-${++chatSeq}-${Date.now().toString(36)}`;
  store.update('claude', (c) => ({ ...c, active: id, chats: { ...c.chats, [id]: newChat(id) } }));
  return id;
}

export function switchChat(id) {
  store.update('claude', { active: id });
}

export async function closeChat(id) {
  await invoke('claude:close', id).catch(() => {});
  store.update('claude', (c) => {
    const chats = { ...c.chats };
    delete chats[id];
    const ids = Object.keys(chats);
    return { ...c, chats, active: c.active === id ? ids[ids.length - 1] || 'chat-1' : c.active };
  });
}

/** Load an earlier Claude Code session for this project into a new chat. */
export async function resumeSession(sessionId, summary) {
  const id = await startNewChat();
  const r = await invoke('claude:resume', id, sessionId);
  const items = [];
  const tools = new Map();
  for (const m of r.messages || []) {
    const content = m.message && m.message.content;
    if (m.type === 'user') {
      if (typeof content === 'string') items.push({ kind: 'user', id: uid('u'), text: stripContext(content), chips: [] });
      else if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text' && !/^<ide_context>/.test(b.text)) items.push({ kind: 'user', id: uid('u'), text: stripContext(b.text), chips: [] });
          if (b.type === 'tool_result' && tools.has(b.tool_use_id)) Object.assign(tools.get(b.tool_use_id), { result: toolText(b.content).slice(0, 8000), status: b.is_error ? 'error' : 'done', isError: !!b.is_error });
        }
      }
    } else if (m.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text) items.push({ kind: 'text', id: uid('t'), text: b.text });
        if (b.type === 'tool_use') {
          const it = { kind: 'tool', id: b.id, name: b.name, input: b.input, status: 'done', children: [] };
          tools.set(b.id, it);
          items.push(it);
        }
      }
    }
  }
  setChat(id, (c) => ({ ...c, items: [{ kind: 'note', id: uid('n'), text: `Resumed session: ${summary || sessionId}` }, ...items.filter((x) => x.kind !== 'user' || x.text)], sessionId, title: summary || 'Resumed chat' }));
  return id;
}

const stripContext = (t) => String(t || '').replace(/<ide_context>[\s\S]*?<\/ide_context>\s*/g, '').trim();

export async function rewind(chatId, uuid) {
  const r = await invoke('claude:rewind', chatId, uuid, false);
  if (r && r.canRewind !== false) toast({ kind: 'success', title: 'Files restored', message: `Claude's file changes after this message were undone${r.filesChanged ? ` (${r.filesChanged.length} files)` : ''}.` });
  else toast({ kind: 'warning', title: 'Could not undo', message: (r && r.error) || 'No checkpoint for this message.' });
}

export async function loadProbe(force = false) {
  if (!store.get().project) return null;
  const probe = await invoke('claude:probe', { force }).catch((err) => ({ ok: false, error: err.message }));
  store.update('claude', { probe });
  return probe;
}

// ------------------------------------------------------------ shortcuts

export async function fixBuildProblems() {
  const probs = store.get().problems.build.filter((p) => p.severity === 'error').slice(0, 40);
  if (!probs.length) return toast({ title: 'No build errors to fix' });
  const root = store.get().project.root;
  const list = probs.map((p) => `- ${p.file ? relative(root, p.file) + ':' + (p.line || 1) : '(project)'}: ${p.code ? p.code + ' ' : ''}${p.message}`).join('\n');
  openTool('right', 'claude');
  await sendMessage(`The build failed with these errors:\n${list}\n\nPlease fix them.`);
}

export async function askAboutProblems(file, markers) {
  const root = store.get().project.root;
  const list = markers.map((m) => `- ${relative(root, file)}:${m.startLineNumber}: ${m.message}`).join('\n');
  openTool('right', 'claude');
  await sendMessage(`Please fix these problems:\n${list}`);
}

export async function explainSelection() {
  openTool('right', 'claude');
  const e = store.get().editor;
  await sendMessage(e.selection ? 'Explain the selected code: what it does, and anything that looks wrong.' : 'Explain the code around the cursor in the open file.');
}
