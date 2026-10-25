'use strict';
// Lets main-process services run under plain Node for unit tests by answering require('electron')
// with a minimal stand-in. userData points at a throwaway folder so tests never touch real settings.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-unit-userdata-'));

const electron = {
  app: {
    getPath: (name) => (name === 'userData' ? userData : name === 'home' ? os.homedir() : os.tmpdir()),
    getVersion: () => '0.0.0-test',
    getName: () => 'Kiln IDE',
  },
  shell: {
    trashItem: async (p) => fs.rmSync(p, { recursive: true, force: true }),
    openExternal: async () => true,
    showItemInFolder: () => {},
    openPath: async () => '',
  },
  net: { fetch: (...args) => fetch(...args) },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  ipcMain: { handle() {}, on() {} },
  dialog: {},
  clipboard: { writeText() {} },
  BrowserWindow: class {},
};

const load = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return electron;
  return load.call(this, request, parent, isMain);
};

process.env.KILN_TEST_USERDATA = userData;
module.exports = electron;
