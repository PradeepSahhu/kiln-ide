// Code intelligence in the editor: semantic highlighting, Go to Declaration, Find Usages, hover,
// usage lenses, outline, completion/signature help/inlay hints (language servers), rename, quick fixes.
import { store } from '../lib/store.js';
import { invoke, on } from '../lib/ipc.js';
import { toast, prompt, confirm, openPopup, errorToast } from '../lib/ui.js';
import { debounce, basename } from '../lib/util.js';
import * as ed from './editor.js';
import { openTool } from './layout.js';

// Must match TOKEN_TYPES / TOKEN_MODIFIERS in src/main/services/codeindex/worker.js
const TOKEN_TYPES = ['namespace', 'class', 'interface', 'struct', 'enum', 'typeParameter', 'parameter', 'local', 'field', 'property', 'enumMember', 'event', 'function', 'method', 'decorator', 'constant', 'builtin', 'selfKeyword', 'module', 'record', 'delegate', 'attribute'];
const TOKEN_MODIFIERS = ['declaration', 'static', 'readonly'];
const INDEX_LANGS = ['csharp', 'python', 'javascript', 'typescript'];
const LSP_LANGS = ['csharp', 'python'];

let monaco = null;
let registered = false;
let tokensChanged = null;
let lensChanged = null;

const textIfDirty = (model) => (ed.isDirty(model.uri.fsPath) ? model.getValue() : null);
const hasProject = () => !!store.get().project;

export function registerLanguageFeatures(m) {
  if (registered) return;
  registered = true;
  monaco = m;
  tokensChanged = new monaco.Emitter();
  lensChanged = new monaco.Emitter();
  const K = monaco.languages.SymbolKind;
  const KIND = { class: K.Class, interface: K.Interface, struct: K.Struct, record: K.Struct, enum: K.Enum, delegate: K.Function, method: K.Method, function: K.Function, constructor: K.Constructor, property: K.Property, field: K.Field, event: K.Event, namespace: K.Namespace, variable: K.Variable, constant: K.Constant, enumMember: K.EnumMember };

  for (const lang of ['csharp', 'python']) {
    monaco.languages.registerDocumentSemanticTokensProvider(lang, {
      onDidChange: tokensChanged.event,
      getLegend: () => ({ tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS }),
      provideDocumentSemanticTokens: async (model) => {
        if (!hasProject()) return null;
        const r = await invoke('code:semanticTokens', model.uri.fsPath, model.getValue()).catch(() => null);
        return r ? { data: new Uint32Array(r.data) } : null;
      },
      releaseDocumentSemanticTokens: () => {},
    });
  }

  monaco.editor.registerCommand('kiln.usagesAt', (_a, file, line, col) => findUsagesAt(file, line, col));

  for (const lang of INDEX_LANGS) {
    monaco.languages.registerDefinitionProvider(lang, {
      provideDefinition: async (model, pos) => {
        if (!hasProject()) return null;
        const r = await invoke('code:definition', { file: model.uri.fsPath, text: textIfDirty(model), line: pos.lineNumber, col: pos.column }).catch(() => null);
        if (!r) return null;
        return r.locations.map((l) => ({ uri: monaco.Uri.file(l.file), range: new monaco.Range(l.line, l.col, l.endLine || l.line, l.endCol || l.col) }));
      },
    });
    monaco.languages.registerHoverProvider(lang, {
      provideHover: async (model, pos) => {
        if (!hasProject()) return null;
        const word = model.getWordAtPosition(pos);
        if (!word) return null;
        const r = await invoke('code:hover', { file: model.uri.fsPath, text: textIfDirty(model), line: pos.lineNumber, col: pos.column }).catch(() => null);
        if (!r || !r.markdown) return null;
        return { range: new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn), contents: [{ value: r.markdown }] };
      },
    });
    monaco.languages.registerCodeLensProvider(lang, {
      onDidChange: lensChanged.event,
      provideCodeLenses: async (model) => {
        if (!hasProject() || (store.get().settings.languages || {}).codeLens === false) return { lenses: [], dispose() {} };
        const lenses = await invoke('code:codeLens', model.uri.fsPath, textIfDirty(model)).catch(() => []);
        const file = model.uri.fsPath;
        return {
          lenses: lenses
            .filter((l) => l.kind !== 'constructor')
            .map((l) => ({ range: new monaco.Range(l.line, 1, l.line, 1), command: { id: 'kiln.usagesAt', title: l.usages === 0 ? 'no usages' : `${l.usages} usage${l.usages === 1 ? '' : 's'}`, arguments: [file, l.line, l.col] } })),
          dispose() {},
        };
      },
      resolveCodeLens: (_m, lens) => lens,
    });
    monaco.languages.registerDocumentSymbolProvider(lang, {
      provideDocumentSymbols: async (model) => {
        if (!hasProject()) return [];
        const syms = await invoke('code:documentSymbols', model.uri.fsPath, textIfDirty(model)).catch(() => []);
        return syms.map((s) => ({ name: s.name, detail: s.signature || '', kind: KIND[s.kind] || K.Variable, tags: [], containerName: s.container, range: new monaco.Range(s.start, 1, s.end, 1), selectionRange: new monaco.Range(s.line, s.col, s.line, s.endCol || s.col) }));
      },
    });
  }

  const CK = monaco.languages.CompletionItemKind;
  const LSP_KIND = { 1: CK.Text, 2: CK.Method, 3: CK.Function, 4: CK.Constructor, 5: CK.Field, 6: CK.Variable, 7: CK.Class, 8: CK.Interface, 9: CK.Module, 10: CK.Property, 11: CK.Unit, 12: CK.Value, 13: CK.Enum, 14: CK.Keyword, 15: CK.Snippet, 16: CK.Color, 17: CK.File, 18: CK.Reference, 19: CK.Folder, 20: CK.EnumMember, 21: CK.Constant, 22: CK.Struct, 23: CK.Event, 24: CK.Operator, 25: CK.TypeParameter };
  const SYM_KIND = { class: CK.Class, interface: CK.Interface, struct: CK.Struct, record: CK.Struct, enum: CK.Enum, method: CK.Method, function: CK.Function, property: CK.Property, field: CK.Field, constant: CK.Constant, delegate: CK.Function, event: CK.Event };
  const toRange = (r) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);

  for (const lang of LSP_LANGS) {
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: lang === 'csharp' ? ['.', '<', '"', '/', ' ', '('] : ['.', '[', '"', "'", '(', ' ', ','],
      provideCompletionItems: async (model, pos, ctx) => {
        if (!hasProject()) return { suggestions: [] };
        const file = model.uri.fsPath;
        const word = model.getWordUntilPosition(pos);
        const range = new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn);
        const res = await invoke('lsp:completion', file, pos.lineNumber, pos.column, ctx.triggerCharacter || null).catch(() => null);
        if (res && res.items) {
          return {
            incomplete: res.incomplete,
            suggestions: res.items.map((it) => {
              const te = it.textEdit;
              return {
                label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label,
                kind: LSP_KIND[it.kind] || CK.Text,
                detail: it.detail,
                documentation: it.documentation ? (typeof it.documentation === 'string' ? it.documentation : { value: it.documentation.value }) : undefined,
                insertText: te ? te.newText : it.insertText || it.label,
                insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
                range: te && te.range ? toRange(te.range) : te && te.insert ? toRange(te.insert) : range,
                sortText: it.sortText,
                filterText: it.filterText,
                preselect: it.preselect,
                additionalTextEdits: (it.additionalTextEdits || []).map((e) => ({ range: toRange(e.range), text: e.newText })),
                _raw: it,
                _file: file,
              };
            }),
          };
        }
        // No language server yet: offer project symbols from the index.
        if (!word.word || word.word.length < 2) return { suggestions: [] };
        const syms = await invoke('code:workspaceSymbols', word.word).catch(() => []);
        const seen = new Set();
        return {
          suggestions: syms
            .filter((s) => s.name.toLowerCase().startsWith(word.word.toLowerCase()) && !seen.has(s.name) && seen.add(s.name))
            .slice(0, 50)
            .map((s) => ({ label: s.name, kind: SYM_KIND[s.kind] || CK.Text, detail: s.signature || s.container, insertText: s.name, range })),
        };
      },
      resolveCompletionItem: async (item) => {
        if (!item._raw || item.documentation) return item;
        const r = await invoke('lsp:resolve', item._file, item._raw).catch(() => null);
        if (r && r.documentation) item.documentation = typeof r.documentation === 'string' ? r.documentation : { value: r.documentation.value };
        if (r && r.detail) item.detail = r.detail;
        return item;
      },
    });
    monaco.languages.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [','],
      provideSignatureHelp: async (model, pos) => {
        const r = await invoke('lsp:signatureHelp', model.uri.fsPath, pos.lineNumber, pos.column).catch(() => null);
        if (!r || !r.signatures || !r.signatures.length) return null;
        return {
          value: {
            activeSignature: r.activeSignature || 0,
            activeParameter: r.activeParameter || 0,
            signatures: r.signatures.map((s) => ({ label: s.label, documentation: s.documentation && (typeof s.documentation === 'string' ? s.documentation : { value: s.documentation.value }), parameters: (s.parameters || []).map((p) => ({ label: p.label, documentation: p.documentation && (typeof p.documentation === 'string' ? p.documentation : { value: p.documentation.value }) })) })),
          },
          dispose() {},
        };
      },
    });
    monaco.languages.registerInlayHintsProvider(lang, {
      provideInlayHints: async (model, range) => {
        if ((store.get().settings.languages || {}).inlayHints === false) return { hints: [], dispose() {} };
        const hints = await invoke('lsp:inlayHints', model.uri.fsPath, range.startLineNumber, range.endLineNumber).catch(() => []);
        return { hints: hints.map((h) => ({ position: { lineNumber: h.line, column: h.col }, label: h.label, kind: h.kind === 1 ? monaco.languages.InlayHintKind.Type : monaco.languages.InlayHintKind.Parameter, paddingLeft: h.paddingLeft, paddingRight: h.paddingRight })), dispose() {} };
      },
    });
  }

  on('lsp:diagnostics', ({ file, diagnostics }) => {
    store.update('problems', (p) => ({ ...p, live: { ...p.live, [file]: [...(p.live[file] || []).filter((x) => !x.lsp), ...diagnostics.map((d) => ({ ...d, file, lsp: true }))] } }));
    ed.applyMarkers(file);
  });
  on('lsp:applyEdit', ({ edit }) => ed.applyWorkspaceEdit(edit));
  on('lsp:status', (s) => store.update('lsp', { [s.lang]: s }));
  const refresh = debounce(() => {
    tokensChanged.fire();
    lensChanged.fire();
  }, 400);
  on('index:changed', refresh);
  on('index:status', (s) => {
    store.set({ index: s });
    if (s.state === 'ready') refresh();
  });
}

// ------------------------------------------------------------ navigation

function cursorContext() {
  const editor = ed.getEditor();
  const model = editor && editor.getModel();
  if (!model) return null;
  const pos = editor.getPosition();
  return { editor, model, file: model.uri.fsPath, line: pos.lineNumber, col: pos.column, text: textIfDirty(model) };
}

export async function goToDefinition(kind = 'definition') {
  const c = cursorContext();
  if (!c) return;
  const r = await invoke('code:definition', { file: c.file, text: c.text, line: c.line, col: c.col, kind });
  const locs = (r && r.locations) || [];
  if (!locs.length) {
    toast({ title: 'Cannot find declaration to go to', timeout: 2500 });
    return;
  }
  const here = locs.find((l) => l.file === c.file && l.line === c.line && c.col >= l.col && c.col <= (l.endCol || l.col + 200));
  if (here && locs.length === 1) return findUsages();
  if (locs.length === 1) return ed.openFile(locs[0].file, { line: locs[0].line, col: locs[0].col });
  openPopup({
    type: 'list',
    title: `Choose Declaration of ${r.ctx ? r.ctx.name : ''}`,
    items: locs.map((l) => ({ label: `${l.container ? l.container + '.' : ''}${l.name || basename(l.file)}`, hint: `${ed.relPath(l.file)}:${l.line}`, kind: l.kind, run: () => ed.openFile(l.file, { line: l.line, col: l.col }) })),
  });
}

export async function findUsages() {
  const c = cursorContext();
  if (!c) return;
  store.set({ usages: { loading: true, name: '' } });
  openTool('bottom', 'usages');
  const r = await invoke('code:references', { file: c.file, text: c.text, line: c.line, col: c.col }).catch((err) => ({ error: err.message, refs: [] }));
  store.set({ usages: { name: r.name || (c.model.getWordAtPosition({ lineNumber: c.line, column: c.col }) || {}).word || '', refs: r.refs || [], source: r.source, error: r.error, truncated: r.truncated } });
}

export async function findUsagesAt(file, line, col) {
  await ed.openFile(file, { line, col });
  return findUsages();
}

export async function renameSymbol() {
  const c = cursorContext();
  if (!c) return;
  const word = c.model.getWordAtPosition({ lineNumber: c.line, column: c.col });
  if (!word) return;
  const name = await prompt({ title: 'Rename', label: `Rename '${word.word}' to:`, value: word.word, ok: 'Refactor' });
  if (!name || name === word.word) return;
  await ed.saveAll({ quiet: true });
  let edit = await invoke('lsp:rename', c.file, c.line, word.startColumn, name).catch(() => null);
  if (!edit || !Object.keys(edit).length) {
    const refs = await invoke('code:references', { file: c.file, text: null, line: c.line, col: word.startColumn }).catch(() => null);
    if (!refs || !refs.refs.length) return toast({ title: 'Nothing to rename' });
    const files = [...new Set(refs.refs.map((x) => x.rel || x.file))];
    const ok = await confirm({ title: 'Rename (text-based)', message: `No language server is available, so ${refs.refs.length} occurrence(s) of '${word.word}' in ${files.length} file(s) will be renamed by name.`, detail: files.slice(0, 20).join('\n'), ok: 'Rename' });
    if (!ok) return;
    edit = {};
    for (const x of refs.refs) (edit[x.file] = edit[x.file] || []).push({ line: x.line, col: x.col, endLine: x.line, endCol: x.endCol, text: name });
  }
  const n = await ed.applyWorkspaceEdit(edit);
  toast({ kind: 'success', title: `Renamed to ${name}`, message: `${n} file(s) updated` });
}

export async function quickFix() {
  const c = cursorContext();
  if (!c) return;
  const markers = monaco.editor.getModelMarkers({ resource: c.model.uri }).filter((mk) => c.line >= mk.startLineNumber && c.line <= mk.endLineNumber);
  const sel = c.editor.getSelection();
  const range = { line: sel.startLineNumber, col: sel.startColumn, endLine: sel.endLineNumber, endCol: sel.endColumn };
  const diags = markers.map((mk) => ({ line: mk.startLineNumber, col: mk.startColumn, endLine: mk.endLineNumber, endCol: mk.endColumn, message: mk.message, code: typeof mk.code === 'string' ? mk.code : mk.code && mk.code.value, source: mk.source, severity: mk.severity === 8 ? 'error' : 'warning' }));
  const actions = await invoke('lsp:codeActions', c.file, range, diags).catch(() => []);
  const items = actions.map((a) => ({
    label: a.title,
    hint: a.kind,
    icon: a.kind.startsWith('quickfix') ? 'lightbulb' : 'wand',
    run: async () => {
      const edit = await invoke('lsp:applyCodeAction', c.file, a.raw).catch((err) => errorToast('Quick fix failed', err));
      if (edit && Object.keys(edit).length) await ed.applyWorkspaceEdit(edit);
    },
  }));
  if (markers.length) {
    items.push({ separator: true });
    items.push({ label: 'Fix with Claude', icon: 'claude', run: () => import('./claude.js').then((cl) => cl.askAboutProblems(c.file, markers)) });
  }
  items.push({ label: 'Explain with Claude', icon: 'claude', run: () => import('./claude.js').then((cl) => cl.explainSelection()) });
  openPopup({ type: 'list', title: actions.length ? 'Context Actions' : 'No language-server actions here', items, at: 'cursor' });
}

export async function formatDocument() {
  const c = cursorContext();
  if (!c) return;
  const lang = c.model.getLanguageId();
  if (['json', 'typescript', 'javascript', 'html', 'css', 'scss', 'less'].includes(lang)) {
    await c.editor.getAction('editor.action.formatDocument').run();
    return;
  }
  const r = await invoke('code:format', c.file, c.model.getValue());
  if (r.error) return toast({ kind: 'warning', title: 'Reformat Code', message: r.error });
  if (r.edits) await ed.applyEdits(c.file, r.edits);
  else if (r.text != null && r.text !== c.model.getValue()) ed.setContent(c.file, r.text);
  toast({ title: 'Code reformatted', message: r.tool ? `with ${r.tool}` : '', timeout: 2500 });
}
