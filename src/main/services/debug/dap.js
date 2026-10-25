'use strict';
// Debug Adapter Protocol transport: Content-Length framed JSON over a pair of streams, request/response
// correlation, events and reverse requests (adapter -> client).
const { EventEmitter } = require('events');

const HEADER_END = Buffer.from('\r\n\r\n');

function encode(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/** Incremental parser: push chunks, get back every complete message. */
class MessageReader {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.need = -1;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      if (this.need < 0) {
        const end = this.buf.indexOf(HEADER_END);
        if (end < 0) break;
        const header = this.buf.subarray(0, end).toString('ascii');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        this.buf = this.buf.subarray(end + HEADER_END.length);
        if (!m) continue; // malformed header block: skip it
        this.need = Number(m[1]);
      }
      if (this.buf.length < this.need) break;
      const body = this.buf.subarray(0, this.need).toString('utf8');
      this.buf = this.buf.subarray(this.need);
      this.need = -1;
      try {
        out.push(JSON.parse(body));
      } catch {
        /* ignore a corrupt message */
      }
    }
    return out;
  }
}

class DapError extends Error {
  constructor(command, message, body) {
    super(message || `${command} failed`);
    this.command = command;
    this.body = body;
  }
}

/**
 * Client side of a DAP connection. Emits 'event' (name, body), 'request' (reverse request),
 * 'close' and 'error'.
 */
class DapClient extends EventEmitter {
  constructor(input, output) {
    super();
    this.output = output;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    const reader = new MessageReader();
    input.on('data', (chunk) => {
      for (const msg of reader.push(chunk)) this.dispatch(msg);
    });
    input.on('close', () => this.close());
    input.on('error', (err) => this.emit('error', err));
    output.on('error', (err) => this.emit('error', err));
  }

  dispatch(msg) {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      clearTimeout(p.timer);
      if (msg.success) p.resolve(msg.body || {});
      else p.reject(new DapError(p.command, (msg.body && msg.body.error && formatError(msg.body.error)) || msg.message, msg.body));
    } else if (msg.type === 'event') {
      this.emit('event', msg.event, msg.body || {});
    } else if (msg.type === 'request') {
      if (this.listenerCount('request')) this.emit('request', msg);
      else this.respond(msg, null, `Unsupported request ${msg.command}`);
    }
  }

  send(msg) {
    if (this.closed) return false;
    try {
      this.output.write(encode({ seq: ++this.seq, ...msg }));
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  request(command, args, timeout = 30000) {
    if (this.closed) return Promise.reject(new DapError(command, 'The debug adapter is not running'));
    const seq = this.seq + 1;
    return new Promise((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => {
        this.pending.delete(seq);
        reject(new DapError(command, `${command} timed out`));
      }, timeout) : null;
      this.pending.set(seq, { resolve, reject, timer, command });
      this.send({ type: 'request', command, arguments: args });
    });
  }

  respond(req, body, error) {
    this.send({ type: 'response', request_seq: req.seq, command: req.command, success: !error, message: error || undefined, body: body || undefined });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DapError(p.command, 'The debug adapter exited'));
    }
    this.pending.clear();
    this.emit('close');
  }
}

/** DAP error bodies use "{name}" placeholders filled from `variables`. */
function formatError(err) {
  return String(err.format || '').replace(/\{(\w+)\}/g, (_, k) => (err.variables && err.variables[k] != null ? err.variables[k] : `{${k}}`));
}

module.exports = { encode, MessageReader, DapClient, DapError };
