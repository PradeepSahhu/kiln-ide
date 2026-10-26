// HTTP endpoints in the editor: a "Send" button above every endpoint method (FastAPI / Flask, Express,
// ASP.NET Core) that opens a request dialog and calls the endpoint on the running app (started when
// needed). See src/main/services/endpoints.js.
import { store } from '../lib/store.js';
import { invoke, on } from '../lib/ipc.js';
import { openModal } from '../lib/ui.js';
import { debounce } from '../lib/util.js';
import * as ed from './editor.js';

const LANGS = ['python', 'javascript', 'typescript', 'csharp'];
const SOURCE = /\.(py|[cm]?[jt]sx?|cs)$/;
const BUILD_DIR = /[\\/](bin|obj|node_modules|__pycache__|\.venv|venv|dist|build|\.git)[\\/]/;
let registered = false;

export function openRequest(endpoint) {
  return openModal('endpointRequest', { endpoint });
}

export function registerEndpointLenses(monaco) {
  if (registered) return;
  registered = true;
  const changed = new monaco.Emitter();
  monaco.editor.registerCommand('kiln.sendRequest', (_a, endpoint) => openRequest(endpoint));
  for (const lang of LANGS) {
    monaco.languages.registerCodeLensProvider(lang, {
      onDidChange: changed.event,
      provideCodeLenses: async (model) => {
        if (!store.get().project || model.uri.scheme !== 'file') return { lenses: [], dispose() {} };
        const file = model.uri.fsPath;
        const list = await invoke('endpoints:forFile', file, ed.isDirty(file) ? model.getValue() : null).catch(() => []);
        return {
          lenses: list.map((e) => ({ range: new monaco.Range(e.line, 1, e.line, 1), id: e.id, command: { id: 'kiln.sendRequest', title: `▶ Send ${e.method} ${e.path}`, tooltip: `Call ${e.method} ${e.path} on the running app`, arguments: [e] } })),
          dispose() {},
        };
      },
      resolveCodeLens: (_m, lens) => lens,
    });
  }
  const refresh = debounce(() => changed.fire(), 500);
  ed.onEditorEvent((type) => (type === 'saved' || type === 'reloaded') && refresh());
  // Only source files can add or move endpoints: build output (bin/, obj/, __pycache__/, ...) changes
  // all the time while an app builds and runs, and a refresh redraws (and briefly hides) the buttons.
  on('fs:changed', ({ paths, overflow }) => {
    if (overflow || (paths || []).some((p) => SOURCE.test(p) && !BUILD_DIR.test(p))) refresh();
  });
}
