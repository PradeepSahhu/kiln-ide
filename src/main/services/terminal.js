'use strict';
// Integrated terminal (node-pty + xterm.js in the renderer). When the project has a virtualenv,
// zsh and bash sessions start with it activated, without touching the user's own rc files:
// zsh gets a private ZDOTDIR whose startup files source the user's ones, then activate.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const settings = require('../settings');
const { isWin } = require('../util/proc');

let pty = null;
function loadPty() {
  if (!pty) pty = require('node-pty');
  return pty;
}

const ZSH_FILES = {
  '.zshenv': `KILN_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="\${KILN_USER_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/.zshenv" ]] && builtin source "$ZDOTDIR/.zshenv"
KILN_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$KILN_ZDOTDIR"
kiln_activate() {
  if [[ -n "$KILN_VENV" && -f "$KILN_VENV/bin/activate" ]]; then builtin source "$KILN_VENV/bin/activate"; fi
  ZDOTDIR="$KILN_USER_ZDOTDIR"
  unset -f kiln_activate
}
`,
  '.zprofile': `ZDOTDIR="$KILN_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zprofile" ]] && builtin source "$ZDOTDIR/.zprofile"
ZDOTDIR="$KILN_ZDOTDIR"
`,
  '.zshrc': `ZDOTDIR="$KILN_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zshrc" ]] && builtin source "$ZDOTDIR/.zshrc"
if [[ -o login ]]; then ZDOTDIR="$KILN_ZDOTDIR"; else kiln_activate; fi
`,
  '.zlogin': `ZDOTDIR="$KILN_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zlogin" ]] && builtin source "$ZDOTDIR/.zlogin"
(( $+functions[kiln_activate] )) && kiln_activate
`,
};

const BASH_RC = `if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
if [ -n "$KILN_VENV" ] && [ -f "$KILN_VENV/bin/activate" ]; then . "$KILN_VENV/bin/activate"; fi
`;

let shellDir = null;
function shellIntegrationDir() {
  if (shellDir) return shellDir;
  shellDir = path.join(app.getPath('temp'), `kiln-shell-${process.pid}`);
  fs.mkdirSync(path.join(shellDir, 'zsh'), { recursive: true });
  for (const [name, body] of Object.entries(ZSH_FILES)) fs.writeFileSync(path.join(shellDir, 'zsh', name), body);
  fs.writeFileSync(path.join(shellDir, 'bashrc'), BASH_RC);
  return shellDir;
}

function defaultShell() {
  const configured = settings.get().terminal.shell;
  if (configured) return configured;
  if (isWin) return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

class Batcher {
  constructor(flush) {
    this.flushFn = flush;
    this.buf = '';
    this.timer = null;
  }
  push(data) {
    this.buf += data;
    if (this.buf.length > 64 * 1024) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 12);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.buf) {
      const b = this.buf;
      this.buf = '';
      this.flushFn(b);
    }
  }
}

class TerminalService {
  constructor(ctx) {
    this.ctx = ctx;
    this.terms = new Map();
    this.seq = 0;
  }

  launchSpec(shell, venv) {
    const base = path.basename(shell).toLowerCase();
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'KilnIDE', TERM_PROGRAM_VERSION: app.getVersion() };
    delete env.CLAUDECODE;
    let args = isWin ? [] : ['-l'];
    if (venv && settings.get().terminal.activateVenv && !isWin) {
      const dir = shellIntegrationDir();
      if (base === 'zsh') {
        env.KILN_USER_ZDOTDIR = process.env.ZDOTDIR || '';
        env.ZDOTDIR = path.join(dir, 'zsh');
        env.KILN_VENV = venv;
      } else if (base === 'bash') {
        env.KILN_VENV = venv;
        args = ['--rcfile', path.join(dir, 'bashrc'), '-i'];
      }
    }
    return { args, env };
  }

  create({ cwd, cols = 120, rows = 30, venv, command, args: cmdArgs } = {}) {
    const id = `term-${++this.seq}`;
    const shell = command || defaultShell();
    const spec = this.launchSpec(command ? '' : shell, venv);
    const args = command ? cmdArgs || [] : spec.args;
    const env = spec.env;
    const dir = cwd && fs.existsSync(cwd) ? cwd : this.ctx.root || os.homedir();
    const p = loadPty().spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd: dir, env });
    const batch = new Batcher((data) => this.ctx.send('term:data', { id, data }));
    p.onData((d) => batch.push(d));
    p.onExit(({ exitCode }) => {
      batch.flush();
      this.terms.delete(id);
      this.ctx.send('term:exit', { id, code: exitCode });
    });
    this.terms.set(id, p);
    return { id, shell: path.basename(shell), cwd: dir, venv: venv || null };
  }

  write(id, data) {
    const t = this.terms.get(id);
    if (t) t.write(data);
  }

  resize(id, cols, rows) {
    const t = this.terms.get(id);
    if (t && cols > 0 && rows > 0) {
      try {
        t.resize(cols, rows);
      } catch {
        /* process exited */
      }
    }
  }

  kill(id) {
    const t = this.terms.get(id);
    if (!t) return;
    this.terms.delete(id);
    try {
      t.kill();
    } catch {
      /* already exited */
    }
  }

  dispose() {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}

module.exports = { TerminalService, Batcher, loadPty };
