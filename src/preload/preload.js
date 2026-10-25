'use strict';
// Bridge between the sandboxed renderer and the main process. Only namespaced IPC channels are
// reachable; nothing from Node is exposed directly.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = /^(app|project|fs|git|build|run|term|claude|skills|search|templates|code|lsp|flow|kafka|history|agents|tests|pkg|kb|debug|refactor|ai):[A-Za-z]+$/;
const SEND = new Set(['term:write', 'term:resize', 'run:input', 'run:resize', 'app:closeReady', 'lsp:didOpen', 'lsp:didChange', 'lsp:didClose', 'lsp:didSave']);
const EVENTS = new Set([
  'menu:command',
  'fs:changed',
  'git:changed',
  'git:console',
  'git:cloneProgress',
  'build:event',
  'run:started',
  'run:data',
  'run:exit',
  'term:data',
  'term:exit',
  'claude:event',
  'claude:status',
  'claude:permission',
  'claude:permissionCancel',
  'project:detected',
  'app:settingsChanged',
  'app:beforeClose',
  'templates:progress',
  'index:status',
  'index:changed',
  'index:branch',
  'lsp:status',
  'lsp:diagnostics',
  'lsp:applyEdit',
  'tests:output',
  'kb:event',
  'debug:event',
  'refactor:progress',
]);

contextBridge.exposeInMainWorld('kiln', {
  platform: process.platform,
  invoke: (channel, ...args) => (INVOKE.test(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error(`Blocked channel ${channel}`))),
  send: (channel, ...args) => {
    if (SEND.has(channel)) ipcRenderer.send(channel, ...args);
  },
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) return () => {};
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
});
