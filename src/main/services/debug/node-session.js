'use strict';
// Debugs a Node.js program through the V8 inspector protocol (node --inspect-brk), exposing the same
// session interface as DapSession so the debugger UI does not care which runtime it talks to.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');
const { killTree, isWin } = require('../../util/proc');

const SCOPE_NAMES = { local: 'Local', closure: 'Closure', block: 'Block', catch: 'Catch', with: 'With', script: 'Script', module: 'Module', global: 'Global', eval: 'Eval', wasmExpressionStack: 'Stack' };
const INSPECTOR_NOISE = /^(Debugger listening on ws:\/\/\S+|For help, see: https:\/\/nodejs\.org\/\S*|Debugger attached\.|Waiting for the debugger to disconnect\.\.\.)\s*$/;
const HIDDEN_INTERNALS = new Set(['[[Prototype]]', '[[Scopes]]', '[[FunctionLocation]]', '[[IsRevoked]]']);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function urlToPath(url) {
  if (!url) return null;
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(url) ? url : null;
}

/** Display text for a CDP RemoteObject. */
function formatValue(v) {
  if (!v) return 'undefined';
  switch (v.type) {
    case 'string':
      return JSON.stringify(v.value);
    case 'number':
    case 'boolean':
      return v.description != null ? v.description : String(v.value);
    case 'undefined':
      return 'undefined';
    case 'bigint':
    case 'symbol':
      return v.description || String(v.unserializableValue || '');
    case 'function': {
      const first = (v.description || '').split('\n')[0];
      const m = /^(?:async\s+)?(?:function\*?\s*([\w$]*)\s*\(([^)]*)\)|class\s+([\w$]+))/.exec(first);
      return m ? (m[3] ? `class ${m[3]}` : `ƒ ${m[1] || ''}(${m[2]})`) : `ƒ ${first.slice(0, 60)}`;
    }
    case 'object':
      if (v.subtype === 'null') return 'null';
      return v.description || v.className || 'Object';
    default:
      return v.description || String(v.value);
  }
}

class NodeSession extends EventEmitter {
  /** @param opts { node, program, args, runtimeArgs, cwd, env } */
  constructor(opts) {
    super();
    this.opts = opts;
    this.proc = null;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.scripts = new Map(); // scriptId -> url
    this.breakpoints = new Map(); // file -> [{ id, line }]
    this.handles = new Map();
    this.handleSeq = 0;
    this.callFrames = null;
    this.ended = false;
    this.exitCode = null;
    this.startPausePending = true;
    this.stopOnEntry = false;
    this.pauseRequested = false;
    this.stepping = false;
  }

  async start({ breakpoints = {}, exceptionFilters = ['uncaught'], stopOnEntry = false } = {}) {
    const { node, program, args = [], runtimeArgs = [], cwd, env } = this.opts;
    if (!node) throw new Error('Node.js was not found on PATH.');
    this.stopOnEntry = stopOnEntry;
    this.proc = spawn(node, ['--inspect-brk=127.0.0.1:0', ...runtimeArgs, program, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !isWin });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (t) => this.emit('output', { category: 'stdout', text: t }));
    const wsUrl = new Promise((resolve, reject) => {
      let buf = '';
      this.proc.stderr.on('data', (t) => {
        buf += t;
        const m = /Debugger listening on (ws:\/\/\S+)/.exec(buf);
        if (m) resolve(m[1]);
        const lines = t.split(/(?<=\n)/);
        const visible = lines.filter((l) => !INSPECTOR_NOISE.test(l.trim()) || !l.trim()).join('');
        if (visible.trim()) this.emit('output', { category: 'stderr', text: visible });
        if (/Waiting for the debugger to disconnect/.test(t) && this.ws) this.ws.close();
      });
      this.proc.once('error', (err) => reject(new Error(`Could not start node: ${err.message}`)));
      this.proc.once('exit', (code) => reject(new Error(`node exited (${code}) before the debugger connected`)));
    });
    this.proc.on('exit', (code) => {
      this.exitCode = code;
      this.finish();
    });
    const url = await wsUrl;
    await this.connect(url);
    await this.send('Runtime.enable');
    await this.send('Debugger.enable', { maxScriptsCacheSize: 10000000 });
    await this.setExceptionFilters(exceptionFilters);
    for (const [file, bps] of Object.entries(breakpoints)) if (bps && bps.length) await this.setBreakpoints(file, bps);
    await this.send('Runtime.runIfWaitingForDebugger');
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error(`Could not connect to the Node inspector: ${(e && e.message) || url}`));
      ws.onclose = () => {
        for (const p of this.pending.values()) p.reject(new Error('The Node inspector connection closed'));
        this.pending.clear();
      };
      ws.onmessage = (m) => {
        let msg;
        try {
          msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8'));
        } catch {
          return;
        }
        if (msg.id != null) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'Inspector error'));
          else p.resolve(msg.result || {});
        } else if (msg.method) this.onEvent(msg.method, msg.params || {});
      };
    });
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('The program is not running'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(method, p) {
    if (method === 'Debugger.scriptParsed') {
      if (p.url) this.scripts.set(p.scriptId, p.url);
    } else if (method === 'Debugger.paused') {
      this.handles.clear();
      this.callFrames = p.callFrames;
      const hit = (p.hitBreakpoints || []).length > 0;
      if (this.startPausePending) {
        this.startPausePending = false;
        if (!hit && !this.stopOnEntry) {
          this.send('Debugger.resume').catch(() => {});
          return;
        }
      }
      let reason = 'step';
      if (hit) reason = 'breakpoint';
      else if (p.reason === 'exception' || p.reason === 'promiseRejection') reason = 'exception';
      else if (p.reason === 'Break on start') reason = 'entry';
      else if (this.pauseRequested) reason = 'pause';
      else if (p.reason === 'debugCommand' || p.reason === 'other') reason = this.stepping ? 'step' : 'pause';
      this.pauseRequested = false;
      this.stepping = false;
      const text = reason === 'exception' && p.data ? p.data.description || formatValue(p.data) : undefined;
      this.emit('stopped', { reason, threadId: 1, description: reason === 'exception' ? 'Paused on exception' : undefined, text, allThreadsStopped: true, hitBreakpointIds: p.hitBreakpoints || [] });
    } else if (method === 'Debugger.resumed') {
      this.callFrames = null;
      this.emit('continued', { threadId: 1, allThreadsContinued: true });
    } else if (method === 'Debugger.breakpointResolved') {
      for (const [file, list] of this.breakpoints) {
        const bp = list.find((b) => b.id === p.breakpointId);
        if (bp) this.emit('breakpoint', { file, line: p.location.lineNumber + 1, verified: true, id: bp.id });
      }
    } else if (method === 'Runtime.consoleAPICalled') {
      // stdout already carries console output; nothing extra to show.
    } else if (method === 'Runtime.executionContextDestroyed') {
      if (this.ws && p.executionContextId === 1) setTimeout(() => this.ws && this.ws.close(), 50);
    }
  }

  finish() {
    if (this.ended) return;
    this.ended = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* closed */
      }
    }
    this.emit('terminated', { exitCode: this.exitCode });
  }

  handle(data) {
    const id = ++this.handleSeq;
    this.handles.set(id, data);
    return id;
  }

  async threads() {
    return [{ id: 1, name: 'Main Thread' }];
  }

  async stackTrace() {
    return (this.callFrames || []).map((f, i) => {
      const url = f.url || this.scripts.get(f.location.scriptId) || '';
      const file = urlToPath(url);
      const internal = !file || /^node:/.test(url) || file.includes(`${path.sep}node_modules${path.sep}`);
      return { id: i, name: f.functionName || '(anonymous)', file, line: f.location.lineNumber + 1, col: (f.location.columnNumber || 0) + 1, presentationHint: internal ? 'subtle' : 'normal', source: file ? undefined : url };
    });
  }

  frame(frameId) {
    const f = this.callFrames && this.callFrames[frameId];
    if (!f) throw new Error('The program is not paused at this frame');
    return f;
  }

  async scopes(frameId) {
    const f = this.frame(frameId);
    return f.scopeChain.map((s, index) => ({ name: SCOPE_NAMES[s.type] || s.type, variablesReference: this.handle({ objectId: s.object.objectId, scope: { index, frameId } }), expensive: s.type === 'global' }));
  }

  async variables(ref) {
    const h = this.handles.get(ref);
    if (!h) return [];
    const r = await this.send('Runtime.getProperties', { objectId: h.objectId, ownProperties: true, generatePreview: false });
    const out = [];
    for (const p of r.result || []) {
      if (p.name === '__proto__') continue;
      if (!p.value && p.get) {
        out.push({ name: p.name, value: '(getter)', type: 'accessor', variablesReference: 0 });
        continue;
      }
      out.push(this.toVariable(p.name, p.value, h));
    }
    for (const p of r.internalProperties || []) if (!HIDDEN_INTERNALS.has(p.name) && p.value) out.push(this.toVariable(p.name, p.value, h));
    if (!h.scope) {
      // Arrays: numeric indexes in order, then the rest.
      out.sort((a, b) => {
        const ai = /^\d+$/.test(a.name);
        const bi = /^\d+$/.test(b.name);
        if (ai && bi) return Number(a.name) - Number(b.name);
        return ai === bi ? 0 : ai ? -1 : 1;
      });
    }
    return out;
  }

  toVariable(name, v, parent) {
    const expandable = v && v.objectId && (v.type === 'object' || v.type === 'function') && v.subtype !== 'null';
    return { name, value: formatValue(v), type: v ? v.subtype || v.className || v.type : 'undefined', variablesReference: expandable && v.type === 'object' ? this.handle({ objectId: v.objectId, parent }) : 0 };
  }

  async evaluate(expression, frameId, context = 'watch') {
    let r;
    if (this.callFrames && frameId != null && this.callFrames[frameId]) {
      r = await this.send('Debugger.evaluateOnCallFrame', { callFrameId: this.callFrames[frameId].callFrameId, expression, generatePreview: false, includeCommandLineAPI: context === 'repl', throwOnSideEffect: context === 'hover' });
    } else {
      r = await this.send('Runtime.evaluate', { expression, generatePreview: false, includeCommandLineAPI: true, awaitPromise: false });
    }
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      throw new Error((ex && (ex.description || formatValue(ex))) || r.exceptionDetails.text || 'Evaluation failed');
    }
    const v = r.result;
    return { result: formatValue(v), type: v.subtype || v.type, variablesReference: v.objectId && v.type === 'object' && v.subtype !== 'null' ? this.handle({ objectId: v.objectId }) : 0 };
  }

  async setVariable(ref, name, value) {
    const h = this.handles.get(ref);
    if (!h) throw new Error('Variable not found');
    const frameId = h.scope ? h.scope.frameId : 0;
    const f = this.callFrames && this.callFrames[frameId];
    const ev = f
      ? await this.send('Debugger.evaluateOnCallFrame', { callFrameId: f.callFrameId, expression: value })
      : await this.send('Runtime.evaluate', { expression: value });
    if (ev.exceptionDetails) throw new Error(ev.exceptionDetails.exception ? ev.exceptionDetails.exception.description : 'Invalid value');
    const arg = ev.result.objectId ? { objectId: ev.result.objectId } : ev.result.unserializableValue ? { unserializableValue: ev.result.unserializableValue } : { value: ev.result.value };
    if (h.scope) {
      await this.send('Debugger.setVariableValue', { scopeNumber: h.scope.index, variableName: name, newValue: arg, callFrameId: this.frame(h.scope.frameId).callFrameId });
    } else {
      await this.send('Runtime.callFunctionOn', { objectId: h.objectId, functionDeclaration: 'function(k, v) { this[k] = v; }', arguments: [{ value: name }, arg] });
    }
    return { value: formatValue(ev.result), type: ev.result.type, variablesReference: 0 };
  }

  async setBreakpoints(file, bps) {
    for (const old of this.breakpoints.get(file) || []) await this.send('Debugger.removeBreakpoint', { breakpointId: old.id }).catch(() => {});
    const urlRegex = `^(${escapeRegex(pathToFileURL(file).href)}|${escapeRegex(file)})$`;
    const placed = [];
    const results = [];
    for (const b of bps) {
      let condition = b.condition || '';
      if (b.logMessage) {
        const tpl = b.logMessage.replace(/`/g, '\\`').replace(/\{([^}]+)\}/g, '${$1}');
        condition = `${condition ? `(${condition}) && ` : ''}(console.log(\`${tpl}\`), false)`;
      }
      try {
        const r = await this.send('Debugger.setBreakpointByUrl', { lineNumber: b.line - 1, urlRegex, columnNumber: 0, condition });
        placed.push({ id: r.breakpointId, line: b.line });
        const loc = (r.locations || [])[0];
        results.push({ line: loc ? loc.lineNumber + 1 : b.line, requestedLine: b.line, verified: !!loc, id: r.breakpointId });
      } catch (err) {
        results.push({ line: b.line, requestedLine: b.line, verified: false, message: err.message });
      }
    }
    this.breakpoints.set(file, placed);
    return results;
  }

  async setExceptionFilters(filters) {
    const state = filters.includes('all') || filters.includes('raised') ? 'all' : filters.includes('uncaught') || filters.includes('user-unhandled') ? 'uncaught' : 'none';
    await this.send('Debugger.setPauseOnExceptions', { state });
  }

  continue() {
    return this.send('Debugger.resume');
  }

  next() {
    this.stepping = true;
    return this.send('Debugger.stepOver');
  }

  stepIn() {
    this.stepping = true;
    return this.send('Debugger.stepInto');
  }

  stepOut() {
    this.stepping = true;
    return this.send('Debugger.stepOut');
  }

  pause() {
    this.pauseRequested = true;
    return this.send('Debugger.pause');
  }

  async stop() {
    if (this.ended) return;
    if (this.proc) killTree(this.proc);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* closed */
      }
    }
    await new Promise((resolve) => {
      if (this.ended) return resolve();
      const t = setTimeout(() => {
        this.finish();
        resolve();
      }, 5000);
      this.once('terminated', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

module.exports = { NodeSession, formatValue };
