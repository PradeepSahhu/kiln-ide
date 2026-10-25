// AI features in the IDE (main process: services/ai.js): inline completion as ghost text (Tab accepts),
// commit messages from the diff, review of the changes before commit, Generate Documentation /
// Generate Tests with a preview, and Explain Exception in the Claude chat.
import { store } from '../lib/store.js';
import { invoke } from '../lib/ipc.js';
import { toast, errorToast, openModal } from '../lib/ui.js';
import { basename, relative, sleep } from '../lib/util.js';
import * as ed from './editor.js';
import { openTool } from './layout.js';

const aiSettings = () => (store.get().settings && store.get().settings.ai) || {};

// ------------------------------------------------------- inline completion

let registered = false;
let last = { key: null, text: '' };

/** Ghost-text completions in every language; requests wait for a pause in typing. */
export function registerInlineCompletion(monaco) {
  if (registered) return;
  registered = true;
  monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
    provideInlineCompletions: async (model, position, context, token) => {
      if (aiSettings().inlineCompletion === false || !store.get().project || model.uri.scheme !== 'file') return { items: [] };
      const full = model.getValue();
      const offset = model.getOffsetAt(position);
      const prefix = full.slice(0, offset);
      const suffix = full.slice(offset);
      // Not in the middle of a word, and not on an empty file.
      const lineAfter = model.getLineContent(position.lineNumber).slice(position.column - 1);
      if (!prefix.trim() || /^\w/.test(lineAfter)) return { items: [] };
      const key = `${model.uri.fsPath}\u0000${prefix.length}\u0000${prefix.slice(-200)}`;
      let text = last.key === key ? last.text : null;
      if (text == null) {
        // Explicit requests (Alt+\) go at once; typing waits for a short pause.
        if (context.triggerKind !== 1) await sleep(400);
        if (token.isCancellationRequested) return { items: [] };
        store.update('aiStatus', { busy: true });
        try {
          const r = await invoke('ai:inlineCompletion', { file: model.uri.fsPath, language: model.getLanguageId(), prefix, suffix });
          text = r.text || '';
          last = { key, text };
        } catch (err) {
          store.update('aiStatus', { busy: false, error: err.message });
          return { items: [] };
        }
        store.update('aiStatus', { busy: false, error: null });
      }
      if (!text || token.isCancellationRequested) return { items: [] };
      return { items: [{ insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
    },
    freeInlineCompletions() {},
    disposeInlineCompletions() {},
  });
}

export async function toggleInlineCompletion(on = aiSettings().inlineCompletion === false) {
  const next = await invoke('app:updateSettings', { ai: { inlineCompletion: on } });
  store.set({ settings: next });
  toast({ title: on ? 'AI code completion is on' : 'AI code completion is off', timeout: 2000 });
}

/** Ask for a completion at the caret now (Alt+\). */
export function triggerInlineCompletion() {
  const e = ed.getEditor();
  if (e) e.trigger('kiln', 'editor.action.inlineSuggest.trigger', {});
}

// ------------------------------------------------------- commit window

export async function generateCommitMessage(files) {
  if (!files.length) {
    toast({ kind: 'warning', title: 'Select the files to commit first' });
    return null;
  }
  try {
    const r = await invoke('ai:commitMessage', { files });
    if (r.truncated) toast({ title: 'The diff is long', message: 'Claude saw only its beginning; check the message.', timeout: 4000 });
    return r.message;
  } catch (err) {
    errorToast('Could not write a commit message', err);
    return null;
  }
}

/** Review the changes to commit; resolves true when the user chooses to commit anyway. */
export async function reviewChanges(files) {
  if (!files.length) {
    toast({ kind: 'warning', title: 'Select the files to review first' });
    return false;
  }
  return openModal('aiReview', { files });
}

// ------------------------------------------------------- generate

const DECL = new Set(['function', 'method', 'constructor', 'class', 'interface', 'struct', 'record', 'enum', 'property', 'delegate']);

/** The declaration at the caret: the innermost function / method / class around it. */
async function declarationAtCaret() {
  const file = ed.activeFile();
  const e = ed.getEditor();
  if (!file || !e) return null;
  const text = e.getModel().getValue();
  const line = e.getPosition().lineNumber;
  const syms = await invoke('code:documentSymbols', file, text).catch(() => []);
  const around = syms.filter((s) => DECL.has(s.kind) && line >= s.start && line <= s.end).sort((a, b) => a.end - a.start - (b.end - b.start));
  return { file, text, symbol: around[0] ? { name: around[0].name, kind: around[0].kind, start: around[0].start, end: around[0].end } : null };
}

export async function generateDocs() {
  const at = await declarationAtCaret();
  if (!at) return toast({ title: 'Open a file to document', timeout: 2500 });
  if (!at.symbol) return toast({ title: 'Put the caret in a function, method or class', timeout: 3000 });
  const preview = await openModal('aiPreview', { title: `Generate Documentation: ${at.symbol.name}`, run: () => invoke('ai:generateDocs', at) });
  if (!preview) return null;
  ed.replaceContent(at.file, preview.after, 'Before Generate Documentation');
  await ed.save(at.file, { quiet: true });
  toast({ kind: 'success', title: `Documented ${at.symbol.name}`, timeout: 2500 });
  return preview;
}

export async function generateTests() {
  const at = await declarationAtCaret();
  if (!at) return toast({ title: 'Open the file to write tests for', timeout: 2500 });
  const title = at.symbol ? `Generate Tests: ${at.symbol.name}` : `Generate Tests: ${basename(at.file)}`;
  const preview = await openModal('aiPreview', { title, run: () => invoke('ai:generateTests', at) });
  if (!preview) return null;
  if (ed.getDoc(preview.file)) ed.replaceContent(preview.file, preview.after, 'Before Generate Tests');
  else await invoke('fs:writeFile', preview.file, preview.after);
  await ed.openFile(preview.file);
  await ed.save(preview.file, { quiet: true });
  toast({ kind: 'success', title: preview.created ? `Created ${relative(store.get().project.root, preview.file)}` : `Added tests to ${basename(preview.file)}`, message: `${preview.framework} · run them from the gutter icons`, timeout: 4000 });
  const tests = await import('./tests.js');
  tests.loadProjects({ discoverTests: true });
  return preview;
}

// ------------------------------------------------------- explain exception

/** The chat prompt for an exception: the trace plus the project code of its frames. */
export async function exceptionPrompt(trace) {
  const ctx = await invoke('ai:stackContext', trace).catch(() => ({ excerpts: [] }));
  const code = ctx.excerpts.map((x) => `${x.rel}:${x.line}${x.fn ? ` (${x.fn})` : ''}\n\`\`\`\n${x.code}\n\`\`\``).join('\n\n');
  return `Explain this exception: what went wrong, why, and how to fix it.\n\n\`\`\`\n${trace.trim().slice(0, 12000)}\n\`\`\`${code ? `\n\nThe code at the frames in this project (> marks the line):\n\n${code}` : ''}`;
}

export async function explainException(trace) {
  let text = typeof trace === 'string' ? trace : '';
  if (!text.trim()) text = store.get().editor.selection || '';
  if (!text.trim()) text = await navigator.clipboard.readText().catch(() => '');
  if (!text.trim()) return toast({ title: 'Select or copy a stack trace first', message: 'Or use Explain with Claude on a failed test or an exception the debugger stopped at.', timeout: 4000 });
  const prompt = await exceptionPrompt(text);
  openTool('right', 'claude');
  const claude = await import('./claude.js');
  return claude.sendMessage(prompt);
}
