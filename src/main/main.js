'use strict';
// Kiln IDE: Electron entry point.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, shell } = require('electron');

// Scratch profile for tests and experiments (settings, history and graphs go there instead).
if (process.env.KILN_USER_DATA) app.setPath('userData', path.resolve(process.env.KILN_USER_DATA));

const { registerSchemes, registerProtocols } = require('./protocol');
const settings = require('./settings');
const { loadShellEnv } = require('./env');
const { ProjectContext } = require('./context');
const ipc = require('./ipc');
const { buildMenu } = require('./menu');
const { effectiveKeymap } = require('./keymap');
const githubAuth = require('./services/github-auth');

registerSchemes();
app.setName('Kiln IDE');
// The app icon (scripts/make-icon.js). Packaged builds get it from the bundle; run from source, the
// Dock and the window (Windows / Linux) take it from here.
const ICON = path.join(__dirname, '..', '..', 'resources', 'icon.png');

const contexts = new Map(); // webContents id -> ProjectContext
const LIGHT_THEMES = new Set(['rider-light', 'intellij-light', 'github-light', 'solarized-light', 'catppuccin-latte']);

function getContext(sender) {
  return contexts.get(sender.id) || null;
}

function broadcast(channel, payload) {
  for (const c of contexts.values()) c.send(channel, payload);
}

function focusedContext() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  return win ? contexts.get(win.webContents.id) : null;
}

function rebuildMenu() {
  buildMenu({
    recent: settings.get().recentProjects,
    keymap: effectiveKeymap(settings.get()),
    send: (id, arg) => {
      const ctx = focusedContext();
      if (ctx) ctx.send('menu:command', { id, arg });
      else if (id === 'project.openPath' && arg) createWindow(arg);
      else createWindow();
    },
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function createWindow(projectPath) {
  const s = settings.get();
  const b = s.window.bounds || {};
  const isMac = process.platform === 'darwin';
  const custom = (s.customThemes || []).find((t) => t.id === s.theme);
  const light = custom ? custom.type === 'light' : LIGHT_THEMES.has(s.theme);
  const width = Number(process.env.KILN_SHOT_WIDTH) || b.width || 1480;
  const height = Number(process.env.KILN_SHOT_HEIGHT) || b.height || 940;
  const win = new BrowserWindow({
    width,
    height,
    x: process.env.KILN_SHOT ? undefined : b.x,
    y: process.env.KILN_SHOT ? undefined : b.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Kiln IDE',
    icon: process.platform === 'darwin' ? undefined : ICON,
    backgroundColor: light ? '#F7F8FA' : '#1E1F22',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 13 },
    titleBarOverlay: isMac ? undefined : { color: light ? '#F7F8FA' : '#2B2D30', symbolColor: light ? '#000000' : '#DFE1E5', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  const id = win.webContents.id;
  const ctx = new ProjectContext(win, { onRecentChanged: rebuildMenu });
  contexts.set(id, ctx);

  const open = projectPath || (contexts.size === 1 && process.env.KILN_OPEN ? path.resolve(process.env.KILN_OPEN) : null);
  win.loadURL(`kiln://app/src/renderer/index.html${open ? `?open=${encodeURIComponent(open)}` : ''}`);
  win.once('ready-to-show', () => {
    if (s.window.maximized && !process.env.KILN_SHOT) win.maximize();
    if (!process.env.KILN_HIDDEN) win.show();
  });

  const saveBounds = debounce(() => {
    if (win.isDestroyed() || win.isMinimized() || process.env.KILN_SHOT) return;
    settings.update({ window: { bounds: win.getNormalBounds(), maximized: win.isMaximized() } });
  }, 600);
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Give the renderer a moment to autosave dirty editors before the window goes away.
  win.on('close', (e) => {
    if (ctx.closeConfirmed || win.webContents.isDestroyed()) return;
    e.preventDefault();
    ctx.send('app:beforeClose', {});
    setTimeout(() => {
      ctx.closeConfirmed = true;
      if (!win.isDestroyed()) win.close();
    }, 2500);
  });
  win.on('closed', () => {
    ctx.dispose();
    contexts.delete(id);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('kiln://app/')) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  devHooks(win);
  return win;
}

// Development aid (same idea as DataDeck): KILN_SHOT=<png> captures the window once it has loaded,
// after running the page script in KILN_SCRIPT if set, then quits. KILN_DEBUG=1 mirrors the console.
function devHooks(win) {
  if (process.env.KILN_DEBUG || process.env.KILN_SHOT) {
    win.webContents.on('console-message', (event, level, message) => {
      const text = event && event.message !== undefined ? event.message : message;
      console.log(`[renderer] ${text}`);
    });
  }
  const shot = process.env.KILN_SHOT;
  if (!shot) return;
  win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, Number(process.env.KILN_SHOT_WAIT) || 2500));
      if (process.env.KILN_SCRIPT) {
        const out = await win.webContents.executeJavaScript(fs.readFileSync(process.env.KILN_SCRIPT, 'utf8'), true);
        if (out !== undefined) console.log(`[script] ${typeof out === 'string' ? out : JSON.stringify(out)}`);
      }
      await new Promise((r) => setTimeout(r, Number(process.env.KILN_SHOT_DELAY) || 800));
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      console.log(`[shot] ${shot}`);
    } catch (err) {
      console.error(`[shot] ${err.stack || err}`);
    } finally {
      for (const c of contexts.values()) c.closeConfirmed = true;
      app.quit();
    }
  });
}

app.on('open-file', (e, p) => {
  e.preventDefault();
  if (app.isReady()) createWindow(p);
  else process.env.KILN_OPEN = p;
});

app.whenReady().then(() => {
  if (process.platform === 'darwin' && !app.isPackaged && app.dock && fs.existsSync(ICON)) app.dock.setIcon(ICON);
  registerProtocols();
  loadShellEnv();
  ipc.register({ getContext, createWindow, rebuildMenu, broadcast });
  rebuildMenu();
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || process.env.KILN_E2E || process.env.KILN_SHOT) app.quit();
});

app.on('before-quit', () => {
  for (const c of contexts.values()) c.closeConfirmed = true;
  settings.flush();
  githubAuth.cleanup();
});
