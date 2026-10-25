'use strict';
// A debug session driven through a Debug Adapter Protocol adapter process (debugpy, netcoredbg).
// Presents the session interface shared with NodeSession: start, threads, stackTrace, scopes,
// variables, evaluate, setVariable, setBreakpoints, setExceptionFilters, continue/next/stepIn/stepOut/
// pause, stop; events 'stopped', 'continued', 'output', 'breakpoint', 'terminated'.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const { DapClient } = require('./dap');
const { killTree, isWin } = require('../../util/proc');

class DapSession extends EventEmitter {
  /**
   * @param opts { command, args, env, cwd, adapterID, launchArgs, request: 'launch'|'attach' }
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.proc = null;
    this.client = null;
    this.caps = {};
    this.exitCode = null;
    this.ended = false;
    this.initialized = false;
  }

  async start({ breakpoints = {}, exceptionFilters = [], stopOnEntry = false } = {}) {
    const { command, args = [], env = process.env, cwd, adapterID, launchArgs, request = 'launch' } = this.opts;
    this.proc = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !isWin });
    const spawnError = new Promise((_, reject) => this.proc.once('error', (err) => reject(new Error(`Could not start the debug adapter (${path.basename(command)}): ${err.message}`))));
    spawnError.catch(() => {});
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (t) => this.emit('output', { category: 'console', text: t }));
    this.proc.on('exit', () => this.finish());
    this.client = new DapClient(this.proc.stdout, this.proc.stdin);
    this.client.on('error', () => {});
    this.client.on('close', () => this.finish());
    this.client.on('request', (req) => this.client.respond(req, null, `${req.command} is not supported by Kiln`));

    const initializedEvent = new Promise((resolve) => this.once('_initialized', resolve));
    this.client.on('event', (name, body) => this.onEvent(name, body));

    this.caps = await Promise.race([
      this.client.request('initialize', {
        clientID: 'kiln',
        clientName: 'Kiln IDE',
        adapterID,
        locale: 'en-US',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsVariablePaging: false,
        supportsRunInTerminalRequest: false,
        supportsStartDebuggingRequest: false,
        supportsProgressReporting: false,
        supportsInvalidatedEvent: false,
      }),
      spawnError,
    ]);
    // The launch response only arrives after configurationDone, so it is not awaited here.
    const launched = this.client.request(request, { ...launchArgs, stopOnEntry, stopAtEntry: stopOnEntry }, 0);
    launched.catch(() => {});
    await Promise.race([initializedEvent, launched.then(() => initializedEvent)]);
    for (const [file, bps] of Object.entries(breakpoints)) if (bps && bps.length) await this.setBreakpoints(file, bps).catch(() => []);
    await this.setExceptionFilters(exceptionFilters).catch(() => {});
    if (this.caps.supportsConfigurationDoneRequest !== false) await this.client.request('configurationDone', {});
    await launched;
  }

  onEvent(name, body) {
    switch (name) {
      case 'initialized':
        this.initialized = true;
        this.emit('_initialized');
        break;
      case 'stopped':
        this.emit('stopped', { reason: body.reason, threadId: body.threadId, description: body.description, text: body.text, allThreadsStopped: body.allThreadsStopped !== false, hitBreakpointIds: body.hitBreakpointIds || [] });
        break;
      case 'continued':
        this.emit('continued', { threadId: body.threadId, allThreadsContinued: body.allThreadsContinued !== false });
        break;
      case 'output':
        if (body.category === 'telemetry') break;
        this.emit('output', { category: body.category || 'console', text: body.output || '' });
        break;
      case 'breakpoint':
        if (body.breakpoint && body.breakpoint.source && body.breakpoint.source.path) this.emit('breakpoint', { file: body.breakpoint.source.path, line: body.breakpoint.line, verified: !!body.breakpoint.verified, id: body.breakpoint.id });
        break;
      case 'exited':
        this.exitCode = body.exitCode;
        break;
      case 'terminated':
        this.finish();
        break;
      default:
        break;
    }
  }

  finish() {
    if (this.ended) return;
    this.ended = true;
    this.emit('terminated', { exitCode: this.exitCode });
    // Give the adapter a moment to clean up the debuggee, then make sure it is gone.
    setTimeout(() => {
      if (this.client) this.client.close();
      if (this.proc) killTree(this.proc);
    }, 300).unref();
  }

  req(command, args, timeout) {
    if (this.ended) return Promise.reject(new Error('The debug session has ended'));
    return this.client.request(command, args, timeout);
  }

  async threads() {
    const r = await this.req('threads', {});
    return (r.threads || []).map((t) => ({ id: t.id, name: t.name }));
  }

  async stackTrace(threadId, levels = 200) {
    const r = await this.req('stackTrace', { threadId, startFrame: 0, levels });
    return (r.stackFrames || []).map((f) => ({
      id: f.id,
      name: f.name,
      file: (f.source && (f.source.path || null)) || null,
      line: f.line,
      col: f.column,
      presentationHint: f.presentationHint || (f.source && f.source.presentationHint === 'deemphasize' ? 'subtle' : 'normal'),
    }));
  }

  async scopes(frameId) {
    const r = await this.req('scopes', { frameId });
    return (r.scopes || []).map((s) => ({ name: s.name, variablesReference: s.variablesReference, expensive: !!s.expensive }));
  }

  async variables(variablesReference) {
    const r = await this.req('variables', { variablesReference });
    return (r.variables || []).map((v) => ({ name: v.name, value: v.value, type: v.type || '', variablesReference: v.variablesReference || 0, evaluateName: v.evaluateName }));
  }

  async evaluate(expression, frameId, context = 'watch') {
    const r = await this.req('evaluate', { expression, frameId, context });
    return { result: r.result, type: r.type || '', variablesReference: r.variablesReference || 0 };
  }

  async setVariable(variablesReference, name, value) {
    const r = await this.req('setVariable', { variablesReference, name, value });
    return { value: r.value, type: r.type || '', variablesReference: r.variablesReference || 0 };
  }

  async setBreakpoints(file, bps) {
    const r = await this.req('setBreakpoints', {
      source: { path: file, name: path.basename(file) },
      breakpoints: bps.map((b) => ({ line: b.line, condition: b.condition || undefined, hitCondition: b.hitCondition || undefined, logMessage: b.logMessage || undefined })),
      lines: bps.map((b) => b.line),
      sourceModified: false,
    });
    return (r.breakpoints || []).map((b, i) => ({ line: b.line || bps[i].line, requestedLine: bps[i] && bps[i].line, verified: !!b.verified, message: b.message, id: b.id }));
  }

  async setExceptionFilters(filters) {
    const supported = new Set((this.caps.exceptionBreakpointFilters || []).map((f) => f.filter));
    const use = filters.filter((f) => !supported.size || supported.has(f));
    await this.req('setExceptionBreakpoints', { filters: use });
  }

  continue(threadId) {
    return this.req('continue', { threadId });
  }

  next(threadId) {
    return this.req('next', { threadId });
  }

  stepIn(threadId) {
    return this.req('stepIn', { threadId });
  }

  stepOut(threadId) {
    return this.req('stepOut', { threadId });
  }

  pause(threadId) {
    return this.req('pause', { threadId });
  }

  async stop() {
    if (this.ended) return;
    try {
      await this.req('disconnect', { terminateDebuggee: true, restart: false }, 4000);
    } catch {
      /* adapter already gone or slow */
    }
    this.finish();
  }
}

module.exports = { DapSession };
