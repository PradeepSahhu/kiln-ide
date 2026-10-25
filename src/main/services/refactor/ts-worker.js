'use strict';
// Worker thread hosting the TypeScript language service for JS/TS refactorings, so building the
// program for a large project never blocks the main process.
const { parentPort } = require('worker_threads');
const { TsProject } = require('./ts-engine');

let project = null;

const handlers = {
  open: ({ root, format }) => {
    if (!project || project.root !== root) project = new TsProject(root, { format });
    else project.format = format || project.format;
    return true;
  },
  refresh: () => project && project.refresh(),
  refactors: (p) => project.refactors(p),
  edits: (p) => project.edits(p),
  references: (p) => project.references(p),
};

parentPort.on('message', (msg) => {
  try {
    const fn = handlers[msg.type];
    if (!fn) throw new Error(`Unknown request ${msg.type}`);
    if (msg.type !== 'open' && !project) throw new Error('No project is open');
    parentPort.postMessage({ id: msg.id, ok: true, result: fn(msg.payload || {}) });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: err && err.message ? err.message : String(err) });
  }
});
