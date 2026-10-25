// Build state in the renderer: steps, streamed output and Problems.
import { store } from '../lib/store.js';
import { invoke, on } from '../lib/ipc.js';
import { toast } from '../lib/ui.js';
import { formatDuration, debounce } from '../lib/util.js';
import * as ed from './editor.js';
import { openTool } from './layout.js';

const outputs = new Map(); // stepId -> text
const listeners = new Set();
let pendingProblems = [];

export const buildOutput = (stepId) => (stepId ? outputs.get(stepId) || '' : [...outputs.values()].join(''));
export const onBuildOutput = (fn) => (listeners.add(fn), () => listeners.delete(fn));

const flushProblems = debounce(() => {
  if (!pendingProblems.length) return;
  const add = pendingProblems;
  pendingProblems = [];
  store.update('problems', (p) => ({ ...p, build: [...p.build, ...add] }));
  for (const f of new Set(add.map((x) => x.file).filter(Boolean))) ed.applyMarkers(f);
}, 60);

export function initBuild() {
  on('build:event', (e) => {
    const b = store.get().build;
    if (e.type === 'start') {
      outputs.clear();
      listeners.forEach((fn) => fn({ reset: true }));
      store.set((s) => ({ build: { running: true, id: e.id, steps: [], status: 'running', errors: 0, warnings: 0, startedAt: e.at, endedAt: null, mode: e.mode, reason: e.reason, only: e.only }, problems: { ...s.problems, build: e.only ? s.problems.build.filter((p) => !matchesOnly(p, e.only)) : [] } }));
      ed.applyAllMarkers();
      const s = store.get().settings;
      if (s && s.build.openBuildWindow && e.reason !== 'save' && e.reason !== 'claude') openTool('bottom', 'build');
      return;
    }
    if (b.id !== e.id) return;
    if (e.type === 'step') {
      const steps = b.steps.some((x) => x.id === e.step.id) ? b.steps.map((x) => (x.id === e.step.id ? e.step : x)) : [...b.steps, e.step];
      store.update('build', { steps });
    } else if (e.type === 'output') {
      outputs.set(e.stepId, (outputs.get(e.stepId) || '') + e.text);
      listeners.forEach((fn) => fn({ stepId: e.stepId, text: e.text }));
    } else if (e.type === 'problems') {
      pendingProblems.push(...e.problems);
      flushProblems();
    } else if (e.type === 'end') {
      flushProblems();
      store.update('build', { running: false, status: e.status, errors: e.errors, warnings: e.warnings, endedAt: e.at, durationMs: e.durationMs });
      const quiet = b.reason === 'save' || b.reason === 'claude';
      if (e.status === 'success' && !quiet) toast({ kind: 'success', title: 'Build succeeded', message: `${formatDuration(e.durationMs)}${e.warnings ? ` · ${e.warnings} warning${e.warnings === 1 ? '' : 's'}` : ''}`, timeout: 3500 });
      else if (e.status === 'failed') {
        toast({
          kind: 'error',
          title: 'Build failed',
          message: `${e.errors} error${e.errors === 1 ? '' : 's'}, ${e.warnings} warning${e.warnings === 1 ? '' : 's'}`,
          actions: [
            { label: 'Show Problems', run: () => openTool('bottom', 'problems') },
            { label: 'Fix with Claude', run: () => import('./claude.js').then((c) => c.fixBuildProblems()) },
          ],
        });
      }
    }
  });
}

function matchesOnly(p, only) {
  if (only.includes('python')) return ['python', 'imports', 'pyflakes', 'pip'].includes(p.source);
  if (only.includes('dotnet')) return ['msbuild', 'nuget', 'dotnet'].includes(p.source);
  return false;
}

export async function restoreBuildState() {
  const st = await invoke('build:state').catch(() => null);
  if (!st) return;
  outputs.clear();
  for (const [k, v] of Object.entries(st.outputs || {})) outputs.set(k, v);
  store.set((s) => ({ build: { running: st.status === 'running', id: st.id, steps: st.steps, status: st.status, errors: st.problems.filter((p) => p.severity === 'error').length, warnings: st.problems.filter((p) => p.severity === 'warning').length, startedAt: st.startedAt, endedAt: st.endedAt, mode: st.mode, reason: st.reason }, problems: { ...s.problems, build: st.problems } }));
}

export function startBuild(opts = {}) {
  return invoke('build:start', { reason: 'manual', ...opts });
}

export function cancelBuild() {
  return invoke('build:cancel');
}

/** On-save check of one Python file: replaces that file's live problems. */
export async function checkPythonFile(path) {
  const r = await invoke('build:checkFile', path).catch(() => null);
  if (!r) return;
  store.update('problems', (p) => {
    const keep = (p.live[path] || []).filter((x) => x.lsp);
    return { ...p, live: { ...p.live, [path]: [...keep, ...r.problems.map((x) => ({ ...x, file: path }))] } };
  });
  ed.applyMarkers(path);
  // Like Rider's "Show Problems on error": a save that introduces errors brings up the Problems window.
  const s = store.get().settings;
  if (r.problems.some((x) => x.severity === 'error') && s && s.build.openProblemsOnError !== false) openTool('bottom', 'problems');
}
