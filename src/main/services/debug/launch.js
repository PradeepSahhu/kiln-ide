'use strict';
// Maps run configurations (detected or custom) and single files to debug launch specs:
//   { kind: 'python', python, interp, program | module, args, cwd }
//   { kind: 'dotnet', project, args, cwd }
//   { kind: 'node', program, args, runtimeArgs, env, cwd }
const fs = require('fs');
const path = require('path');

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs']);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

class NotDebuggable extends Error {}

function cwdOf(cfg, root) {
  if (!cfg.cwd) return root;
  return path.isAbsolute(cfg.cwd) ? cfg.cwd : path.join(root, cfg.cwd);
}

function pythonSpec(argv, { cwd, interp, script }) {
  if (!interp) throw new Error('No Python interpreter found for this configuration.');
  const spec = { kind: 'python', python: interp.python, interp, cwd, args: [] };
  if (script) {
    spec.program = script;
    spec.args = argv.slice();
  } else if (argv[0] === '-m') {
    if (!argv[1]) throw new NotDebuggable('"python -m" needs a module name.');
    spec.module = argv[1];
    spec.args = argv.slice(2);
  } else {
    const first = argv.findIndex((a) => !a.startsWith('-'));
    if (first < 0) throw new NotDebuggable('This Python configuration has no script to debug, so it cannot be debugged.');
    spec.program = path.resolve(cwd, argv[first]);
    spec.args = argv.slice(first + 1);
  }
  // Auto-reloaders run the app in a child process the debugger does not follow.
  if (spec.module === 'uvicorn') spec.args = spec.args.filter((a) => a !== '--reload');
  if (spec.module === 'flask') spec.args = [...spec.args.filter((a) => a !== '--debug' && a !== '--reload'), '--no-reload', '--no-debugger'];
  if (spec.program && path.basename(spec.program) === 'manage.py' && spec.args[0] === 'runserver' && !spec.args.includes('--noreload')) spec.args = [...spec.args, '--noreload'];
  return spec;
}

/** `node [flags] file [args]` (optionally prefixed by VAR=value pairs) -> node spec. */
function nodeSpecFromCommand(argv, cwd, label) {
  const env = {};
  let i = 0;
  while (i < argv.length && ENV_ASSIGN.test(argv[i])) {
    const eq = argv[i].indexOf('=');
    env[argv[i].slice(0, eq)] = argv[i].slice(eq + 1);
    i++;
  }
  const runner = argv[i];
  if (runner !== 'node' && runner !== 'nodemon') throw new NotDebuggable(`"${label}" does not start a JavaScript file with node, so it cannot be debugged.`);
  const rest = argv.slice(i + 1);
  const runtimeArgs = [];
  let j = 0;
  while (j < rest.length && rest[j].startsWith('-')) {
    // flags that take a separate value
    if (/^(-r|--require|--import|--loader|--env-file)$/.test(rest[j]) && rest[j + 1]) {
      runtimeArgs.push(rest[j], rest[j + 1]);
      j += 2;
    } else {
      if (!/^--inspect/.test(rest[j]) && !/^--watch/.test(rest[j])) runtimeArgs.push(rest[j]);
      j++;
    }
  }
  if (j >= rest.length) throw new NotDebuggable(`"${label}" does not name a script file, so it cannot be debugged.`);
  return { kind: 'node', program: path.resolve(cwd, rest[j]), args: rest.slice(j + 1), runtimeArgs, env, cwd };
}

function dotnetSpec(argv, cwd) {
  if (argv[0] === 'test') throw new NotDebuggable('Debugging tests is not supported yet; run the test configuration instead.');
  if (argv[0] !== 'run') throw new NotDebuggable(`"dotnet ${argv[0] || ''}" cannot be debugged.`);
  const dash = argv.indexOf('--');
  const own = dash >= 0 ? argv.slice(0, dash) : argv;
  const programArgs = dash >= 0 ? argv.slice(dash + 1) : [];
  const pi = own.findIndex((a) => a === '--project' || a === '-p');
  let project = pi >= 0 ? own[pi + 1] : null;
  if (project && !path.isAbsolute(project)) project = path.resolve(cwd, project);
  if (project && fs.existsSync(project) && fs.statSync(project).isDirectory()) project = findCsproj(project);
  if (!project) project = findCsproj(cwd);
  if (!project) throw new NotDebuggable('No .csproj found for this configuration, so it cannot be debugged.');
  return { kind: 'dotnet', project, args: programArgs, cwd: path.dirname(project) };
}

function findCsproj(dir) {
  try {
    const f = fs.readdirSync(dir).find((n) => n.endsWith('.csproj'));
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

/**
 * @param cfg run configuration (see detect.js runConfigs and RunService.saveCustom)
 * @param opts { root, interpreterFor(dir) -> { python, venv } | null, scriptPath?(interp, name) }
 */
function launchSpec(cfg, opts) {
  const { root, interpreterFor } = opts;
  const cwd = cwdOf(cfg, root);
  const label = cfg.name || cfg.detail || cfg.commandLine || 'This configuration';
  if (cfg.custom) {
    const argv = splitArgs(cfg.commandLine);
    const cmd = argv[0] || '';
    const base = path.basename(cmd);
    if (/^python(3(\.\d+)*)?$/.test(base)) return pythonSpec(argv.slice(1), { cwd, interp: cfg.usePython || base.startsWith('python') ? interpreterFor(root) : null });
    if (base === 'dotnet') return dotnetSpec(argv.slice(1), cwd);
    if (base === 'node' || ENV_ASSIGN.test(cmd)) return nodeSpecFromCommand(argv, cwd, label);
    if (PACKAGE_MANAGERS.has(base)) return packageScriptSpec(argv.slice(1), cwd, label);
    throw new NotDebuggable(`"${cfg.commandLine}" cannot be debugged: Kiln debugs Python, .NET and Node programs.`);
  }
  if (cfg.python) {
    const interp = interpreterFor(cfg.pyRoot || root);
    let script = null;
    if (cfg.script) {
      script = opts.scriptPath ? opts.scriptPath(interp, cfg.script) : null;
      if (!script) throw new NotDebuggable(`"${cfg.script}" is not installed in the project environment, so it cannot be debugged. Build the project first.`);
    }
    return pythonSpec(cfg.args || [], { cwd, interp, script });
  }
  const command = path.basename(cfg.command || '');
  if (command === 'dotnet') return dotnetSpec(cfg.args || [], cwd);
  if (PACKAGE_MANAGERS.has(command)) return packageScriptSpec(cfg.args || [], cwd, label);
  if (command === 'node') return nodeSpecFromCommand(['node', ...(cfg.args || [])], cwd, label);
  throw new NotDebuggable(`"${label}" cannot be debugged: Kiln debugs Python, .NET and Node programs.`);
}

function packageScriptSpec(argv, cwd, label) {
  const name = argv[0] === 'run' ? argv[1] : argv[0];
  let scripts = {};
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts || {};
  } catch {
    /* no package.json */
  }
  const command = scripts[name];
  if (!command) throw new NotDebuggable(`Script "${name}" was not found in package.json, so it cannot be debugged.`);
  if (/&&|\|\||;|\|/.test(command)) throw new NotDebuggable(`"${label}" runs several commands (${command}), so it cannot be debugged directly.`);
  return nodeSpecFromCommand(splitArgs(command), cwd, `${label} (${command})`);
}

/** Debug a single file (Debug 'current file'). */
function launchSpecForFile(file, opts) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.py') return pythonSpec([file], { cwd: opts.root || path.dirname(file), interp: opts.interpreterFor(opts.root || path.dirname(file)) });
  if (JS_EXT.has(ext) || ext === '.ts' || ext === '.mts') return { kind: 'node', program: file, args: [], runtimeArgs: [], env: {}, cwd: opts.root || path.dirname(file) };
  throw new NotDebuggable(`${path.basename(file)} cannot be debugged on its own; use a run configuration.`);
}

module.exports = { launchSpec, launchSpecForFile, splitArgs, NotDebuggable };
