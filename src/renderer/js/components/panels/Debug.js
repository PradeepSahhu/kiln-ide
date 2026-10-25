// Debug tool window (Rider style): vertical action bar, frames with a thread picker, variables tree
// with an evaluate field and watches, the debug console (program output + REPL) and a breakpoints list.
import { html, useEffect, useRef, useState } from '../../lib/preact.js';
import { useStore, store } from '../../lib/store.js';
import { Icon } from '../../lib/icons.js';
import { invoke } from '../../lib/ipc.js';
import { cls, basename } from '../../lib/util.js';
import { SHORTCUTS } from '../../lib/commands.js';
import { ToolWindow, Splitter, Spinner } from '../ui.js';
import * as dbg from '../../services/debug.js';
import * as ed from '../../services/editor.js';

const expanded = new Set(); // variable paths kept open across steps, like Rider

const STATE_LABEL = { starting: 'Starting…', running: 'Running', stopped: 'Paused', terminated: 'Finished' };
const REASON = { breakpoint: 'at a breakpoint', step: 'after a step', exception: 'on an exception', pause: 'by request', entry: 'on entry', 'function breakpoint': 'at a breakpoint', goto: 'at the cursor' };

function valueClass(v) {
  const t = (v.type || '').toLowerCase();
  const val = v.value || '';
  if (/^(['"]).*\1$/s.test(val) || t === 'str' || t === 'string') return 'v-str';
  if (/^-?\d/.test(val) && !/[a-z]/i.test(val.replace(/e[+-]?\d+$/i, ''))) return 'v-num';
  if (/^(true|false|True|False)$/.test(val)) return 'v-bool';
  if (/^(null|None|undefined|nil)$/.test(val)) return 'v-null';
  return '';
}

function ActionBar({ state }) {
  const options = useStore((s) => s.debugOptions);
  const stopped = state === 'stopped';
  const active = dbg.isActive(state);
  const b = (icon, title, onClick, opts = {}) => html`<button class=${cls('icon-btn sm', opts.on && 'active', opts.className)} title=${title} data-testid=${opts.testid} disabled=${opts.disabled} onClick=${onClick}><${Icon} name=${icon} /></button>`;
  return html`<div class="dbg-actions">
    ${b('refresh', 'Rerun (⇧⌘F5)', () => dbg.restartDebug(), { testid: 'debug-restart', disabled: !state })}
    ${stopped ? b('resume', `Resume Program (${SHORTCUTS['debug.resume'] || '⌥⌘R'})`, () => dbg.resume(), { testid: 'debug-resume', className: 'ok' }) : b('pause', 'Pause Program', () => dbg.pause(), { testid: 'debug-pause', disabled: state !== 'running' })}
    ${b('stop', 'Stop (⌘F2)', () => dbg.stopDebug(), { testid: 'debug-stop', disabled: !active, className: 'danger' })}
    <div class="sep"></div>
    ${b('stepOver', 'Step Over (F8)', () => dbg.stepOver(), { testid: 'debug-step-over', disabled: !stopped })}
    ${b('stepInto', 'Step Into (F7)', () => dbg.stepInto(), { testid: 'debug-step-into', disabled: !stopped })}
    ${b('stepOut', 'Step Out (⇧F8)', () => dbg.stepOut(), { testid: 'debug-step-out', disabled: !stopped })}
    ${b('runToCursor', 'Run to Cursor (⌥F9)', () => dbg.runToCursor(), { testid: 'debug-run-to-cursor', disabled: !stopped })}
    <div class="sep"></div>
    ${b('muteBreakpoints', options.muted ? 'Unmute Breakpoints' : 'Mute Breakpoints', () => dbg.setMuted(!options.muted), { on: options.muted, testid: 'debug-mute' })}
    ${b('exceptionBreak', options.breakOnExceptions ? 'Stop on unhandled exceptions: on' : 'Stop on unhandled exceptions: off', () => dbg.setBreakOnExceptions(!options.breakOnExceptions), { on: options.breakOnExceptions })}
  </div>`;
}

function Frames({ s }) {
  return html`<div class="dbg-frames">
    ${s.threads.length > 1
      ? html`<div class="dbg-thread"><${Icon} name="frames" size=${13} className="muted" /><select class="input" value=${s.threadId} onChange=${(e) => dbg.selectThread(Number(e.target.value) || e.target.value)}>${s.threads.map((t) => html`<option value=${t.id}>${t.name}${t.id === s.threadId ? '' : ''}</option>`)}</select></div>`
      : null}
    <div class="list">
      ${s.frames.map((f, i) => html`<div class=${cls('dbg-frame', i === s.frameIndex && 'selected', f.presentationHint === 'subtle' && 'subtle')} data-testid="debug-frame" onClick=${() => dbg.revealFrame(i)} title=${f.file || f.source || ''}>
          <span class="fn">${f.name}</span><span class="loc">${f.file ? `${basename(f.file)}:${f.line}` : f.source || ''}</span>
        </div>`)}
      ${!s.frames.length ? html`<div class="empty">${s.state === 'running' ? 'The program is running.' : s.state === 'starting' ? html`<${Spinner} /> Starting…` : 'Frames appear here when the program is paused.'}</div>` : null}
    </div>
  </div>`;
}

function VarRow({ v, depth, path, parentRef, stopSeq, testid = 'debug-variable', onRemove }) {
  const open = expanded.has(path);
  const [children, setChildren] = useState(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open || !v.variablesReference) return setChildren(null);
    let alive = true;
    invoke('debug:variables', v.variablesReference).then((c) => alive && setChildren(c)).catch(() => alive && setChildren([]));
    return () => {
      alive = false;
    };
  }, [open, v.variablesReference, stopSeq]);
  const toggle = () => {
    if (!v.variablesReference) return;
    if (open) expanded.delete(path);
    else expanded.add(path);
    setChildren(open ? null : children);
    store.update('debug', (d) => ({ ...d, treeTick: (d.treeTick || 0) + 1 }));
  };
  const commit = async (value) => {
    setEditing(false);
    if (value === v.value || !parentRef) return;
    try {
      await invoke('debug:setVariable', parentRef, v.name, value);
      setError(null);
      store.update('debug', (d) => ({ ...d, stopSeq: d.stopSeq + 1 }));
    } catch (err) {
      setError(err.message);
    }
  };
  return html`<div>
    <div class="dbg-var" style=${{ paddingLeft: `${8 + depth * 16}px` }} data-testid=${testid} data-name=${v.name} onDblClick=${() => parentRef && setEditing(true)}>
      <span class="twisty" onClick=${toggle}>${v.variablesReference ? html`<${Icon} name=${open ? 'chevronDown' : 'chevronRight'} size=${11} />` : null}</span>
      <span class="name">${v.name}</span>${' '}<span class="eq">=</span>${' '}
      ${editing
        ? html`<input class="input mono" style="height:20px;flex:1" value=${v.value} ref=${(el) => el && setTimeout(() => el.focus(), 0)} onKeyDown=${(e) => { if (e.key === 'Enter') commit(e.target.value); if (e.key === 'Escape') setEditing(false); }} onBlur=${(e) => commit(e.target.value)} />`
        : html`<span class=${cls('value', valueClass(v))} title=${v.value}>${v.value}</span>`}
      ${v.type ? html`${' '}<span class="type">${v.type}</span>` : null}
      ${error ? html`<span class="sev-error" style="font-size:11px">${error}</span>` : null}
      ${onRemove ? html`<button class="icon-btn sm rm" title="Remove watch" onClick=${(e) => { e.stopPropagation(); onRemove(); }}><${Icon} name="close" size=${11} /></button>` : null}
    </div>
    ${open && children ? children.map((c) => html`<${VarRow} key=${c.name} v=${c} depth=${depth + 1} path=${`${path}/${c.name}`} parentRef=${v.variablesReference} stopSeq=${stopSeq} />`) : null}
  </div>`;
}

function ScopeNode({ scope, stopSeq, first }) {
  const path = `scope:${scope.name}`;
  if (first && !expanded.has(`${path}#seen`)) {
    expanded.add(`${path}#seen`);
    expanded.add(path);
  }
  const open = expanded.has(path);
  const [vars, setVars] = useState(null);
  const [, force] = useState(0);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    invoke('debug:variables', scope.variablesReference).then((v) => alive && setVars(v)).catch(() => alive && setVars([]));
    return () => {
      alive = false;
    };
  }, [open, scope.variablesReference, stopSeq]);
  const toggle = () => {
    if (open) expanded.delete(path);
    else expanded.add(path);
    force((x) => x + 1);
  };
  return html`<div>
    <div class="dbg-scope" onClick=${toggle}><${Icon} name=${open ? 'chevronDown' : 'chevronRight'} size=${11} />${scope.name}${scope.expensive ? html`<span class="muted" style="font-weight:400"> (expand to load)</span>` : null}</div>
    ${open && vars ? vars.map((v) => html`<${VarRow} key=${v.name} v=${v} depth=${1} path=${`${path}/${v.name}`} parentRef=${scope.variablesReference} stopSeq=${stopSeq} />`) : null}
    ${open && !vars ? html`<div class="muted" style="padding:2px 28px"><${Spinner} size=${11} /></div>` : null}
  </div>`;
}

function Variables({ s }) {
  const watches = useStore((st) => st.debugWatches || []);
  const [scopes, setScopes] = useState([]);
  const [expr, setExpr] = useState('');
  const [evalResult, setEvalResult] = useState(null);
  const [watchValues, setWatchValues] = useState({});
  const frame = s.frames[s.frameIndex];
  const key = `${s.stopSeq}:${s.frameIndex}`;
  useEffect(() => {
    if (s.state !== 'stopped' || !frame) return setScopes([]);
    let alive = true;
    invoke('debug:scopes', frame.id).then((sc) => alive && setScopes(sc)).catch(() => alive && setScopes([]));
    return () => {
      alive = false;
    };
  }, [key, s.state]);
  useEffect(() => {
    if (s.state !== 'stopped') return;
    let alive = true;
    (async () => {
      const out = {};
      for (const w of watches) {
        try {
          out[w] = await dbg.evaluate(w, 'watch');
        } catch (err) {
          out[w] = { error: err.message };
        }
      }
      if (alive) setWatchValues(out);
    })();
    return () => {
      alive = false;
    };
  }, [key, s.state, watches.join('\n')]);
  useEffect(() => {
    if (evalResult && s.state === 'stopped') run(evalResult.expression, true);
  }, [key]);
  const run = async (e, quiet) => {
    const text = (e || '').trim();
    if (!text) return;
    try {
      const r = await dbg.evaluate(text, 'watch');
      setEvalResult({ expression: text, ...r });
    } catch (err) {
      if (!quiet) setEvalResult({ expression: text, error: err.message });
    }
  };
  const disabled = s.state !== 'stopped';
  return html`<div class="dbg-vars">
    <div class="dbg-eval">
      <${Icon} name="evaluate" size=${13} className="muted" />
      <input class="input mono" data-testid="debug-eval-input" placeholder=${disabled ? 'Evaluate expressions when the program is paused' : 'Evaluate expression (↩) or add a watch (⌘↩)'} disabled=${disabled} value=${expr}
        onInput=${(e) => setExpr(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key !== 'Enter') return;
          if (e.metaKey || e.ctrlKey) {
            dbg.addWatch(expr);
            setExpr('');
          } else run(expr);
        }} />
    </div>
    <div class="list">
      ${evalResult
        ? html`<div data-testid="debug-eval-result">${evalResult.error
            ? html`<div class="dbg-var" style="padding-left:8px"><span class="twisty"></span><span class="name">${evalResult.expression}</span><span class="eq">=</span><span class="sev-error">${evalResult.error}</span></div>`
            : html`<${VarRow} v=${{ name: evalResult.expression, value: evalResult.result, type: evalResult.type, variablesReference: evalResult.variablesReference }} depth=${0} path=${`eval:${evalResult.expression}`} stopSeq=${s.stopSeq} testid="debug-eval-row" onRemove=${() => setEvalResult(null)} />`}</div>`
        : null}
      ${watches.map((w) => {
        const r = watchValues[w];
        return r && r.error
          ? html`<div class="dbg-var watch" style="padding-left:8px" data-testid="debug-watch"><span class="twisty"><${Icon} name="eye" size=${11} /></span><span class="name">${w}</span><span class="eq">=</span><span class="sev-error ellipsis">${r.error}</span><button class="icon-btn sm rm" onClick=${() => dbg.removeWatch(w)}><${Icon} name="close" size=${11} /></button></div>`
          : html`<div class="watch"><${VarRow} v=${{ name: w, value: r ? r.result : disabled ? '…' : '', type: r ? r.type : '', variablesReference: r ? r.variablesReference : 0 }} depth=${0} path=${`watch:${w}`} stopSeq=${s.stopSeq} testid="debug-watch" onRemove=${() => dbg.removeWatch(w)} /></div>`;
      })}
      ${scopes.map((sc, i) => html`<${ScopeNode} key=${`${sc.name}:${i}`} scope=${sc} stopSeq=${s.stopSeq} first=${i === 0} />`)}
      ${disabled && !watches.length ? html`<div class="empty">Variables of the selected frame appear here when the program is paused.<br />Click the gutter of a line to add a breakpoint.</div>` : null}
    </div>
  </div>`;
}

function ConsoleView({ s }) {
  const ref = useRef(null);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([]);
  const [hi, setHi] = useState(-1);
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [s.output.length]);
  return html`<div class="dbg-console">
    <div class="text-output" ref=${ref} data-testid="debug-console">${s.output.map((o) => html`<span class=${cls('o', o.category)}>${o.text}</span>`)}</div>
    <div class="dbg-repl"><span class="muted">›</span><input class="input mono" data-testid="debug-console-input" placeholder=${s.state === 'stopped' ? 'Evaluate in the selected frame' : dbg.isActive(s.state) ? 'Evaluate (the program is running)' : 'Start debugging to evaluate expressions'} disabled=${!dbg.isActive(s.state)} value=${input}
      onInput=${(e) => setInput(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === 'Enter' && input.trim()) {
          dbg.evaluateToConsole(input.trim());
          setHistory([input.trim(), ...history.filter((h) => h !== input.trim())].slice(0, 50));
          setHi(-1);
          setInput('');
        } else if (e.key === 'ArrowUp' && history.length) {
          e.preventDefault();
          const n = Math.min(hi + 1, history.length - 1);
          setHi(n);
          setInput(history[n]);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          const n = Math.max(hi - 1, -1);
          setHi(n);
          setInput(n < 0 ? '' : history[n]);
        }
      }} /></div>
  </div>`;
}

function BreakpointsView() {
  useStore((s) => s.breakpoints);
  const list = dbg.allBreakpoints();
  return html`<div class="list">
    ${list.map((b) => html`<div class="list-row" data-testid="breakpoint-row" onClick=${() => ed.openFile(b.file, { line: b.line })}>
        <input type="checkbox" checked=${b.enabled !== false} onClick=${(e) => e.stopPropagation()} onChange=${(e) => dbg.updateBreakpoint(b.file, b.line, { enabled: e.target.checked })} />
        <span class=${cls('bp-dot', b.logMessage ? 'log' : b.condition ? 'cond' : '', b.enabled === false && 'disabled')}></span>
        <span>${basename(b.file)}:${b.line}</span><span class="muted ellipsis" style="font-size:12px">${b.logMessage ? `log "${b.logMessage}"` : b.condition ? `when ${b.condition}` : b.rel}</span>
        <span class="spacer"></span>
        <button class="icon-btn sm" title="Edit condition" onClick=${(e) => { e.stopPropagation(); dbg.editBreakpoint(b.file, b.line); }}><${Icon} name="edit" size=${12} /></button>
        <button class="icon-btn sm" title="Remove" onClick=${(e) => { e.stopPropagation(); dbg.removeBreakpoint(b.file, b.line); }}><${Icon} name="trash" size=${12} /></button>
      </div>`)}
    ${!list.length ? html`<div class="empty">No breakpoints. Click the gutter next to a line number to add one; right-click it for conditions and logpoints.</div>` : html`<div style="padding:6px 10px"><button class="btn small" onClick=${() => dbg.removeAllBreakpoints()}>Remove All</button></div>`}
  </div>`;
}

let framesWidth = 300;

export function DebugPanel({ onHide }) {
  const s = useStore((st) => st.debug);
  useStore((st) => st.debug.treeTick);
  const [tab, setTab] = useState('debugger');
  const [, force] = useState(0);
  const state = s.state || 'idle';
  const status = s.state === 'stopped' ? `Paused ${REASON[s.reason] || ''}` : STATE_LABEL[s.state] || '';
  return html`<${ToolWindow} side="bottom" title="Debug" onHide=${onHide}
      tabs=${html`${s.name ? html`<span class="dbg-session"><${Icon} name="debug" size=${13} />${s.name}</span>` : null}
        ${['debugger', 'console', 'breakpoints'].map((t) => html`<button class=${cls('tw-tab', tab === t && 'active')} data-testid=${`debug-tab-${t}`} onClick=${() => setTab(t)}>${t === 'debugger' ? 'Debugger' : t === 'console' ? 'Console' : 'Breakpoints'}</button>`)}`}
      actions=${html`<span class=${cls('dbg-status', state)}>${status}${s.exitCode != null && s.state === 'terminated' ? ` (exit code ${s.exitCode})` : ''}</span>`}>
    <div class="dbg" data-testid="debug-panel" data-state=${state}>
      <${ActionBar} state=${s.state} />
      ${tab === 'debugger'
        ? html`<div class="dbg-main">
            <div style=${{ width: `${framesWidth}px`, display: 'flex', flexDirection: 'column', minWidth: 0 }}><${Frames} s=${s} /></div>
            <${Splitter} dir="v" onResize=${(d) => { framesWidth = Math.max(160, Math.min(700, framesWidth + d)); force((x) => x + 1); }} />
            <${Variables} s=${s} />
          </div>`
        : tab === 'console'
          ? html`<${ConsoleView} s=${s} />`
          : html`<${BreakpointsView} />`}
    </div>
  <//>`;
}
