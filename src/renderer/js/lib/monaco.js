// Loads Monaco (AMD build) once and registers the Kiln themes.
import { themes, themeById, monacoTheme } from './themes.js';

let loading = null;

export function loadMonaco() {
  if (window.monaco) return Promise.resolve(window.monaco);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const base = new URL('../../../../node_modules/monaco-editor/min/', import.meta.url).href;
    window.MonacoEnvironment = { getWorkerUrl: () => `${base}vs/base/worker/workerMain.js` };
    const script = document.createElement('script');
    script.src = `${base}vs/loader.js`;
    script.onload = () => {
      window.require.config({ paths: { vs: `${base}vs` } });
      window.require(['vs/editor/editor.main'], () => {
        for (const t of themes) window.monaco.editor.defineTheme(`kiln-${t.id}`, monacoTheme(themeById(t.id)));
        resolve(window.monaco);
      }, reject);
    };
    script.onerror = () => reject(new Error('Could not load the Monaco editor'));
    document.head.appendChild(script);
  });
  return loading;
}

/** (Re)define and apply a theme; custom and edited themes are defined on demand. */
export function setMonacoTheme(id) {
  if (!window.monaco) return;
  const t = themeById(id);
  window.monaco.editor.defineTheme(`kiln-${t.id}`, monacoTheme(t));
  window.monaco.editor.setTheme(`kiln-${t.id}`);
}
