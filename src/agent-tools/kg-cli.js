#!/usr/bin/env node
'use strict';
// Kiln knowledge graph CLI for AI agents (used by the kiln-knowledge-graph skill).
//
//   node kg-cli.js overview                 project size, languages, most-called functions, shared variables
//   node kg-cli.js search <text> [--kind K] symbols matching a fuzzy query
//   node kg-cli.js symbol <name>            definition, callers, calls, reads/writes, locals, members
//   node kg-cli.js usages <name>            every call site / read / write with file:line
//   node kg-cli.js impact <name> [--depth N] what depends on it (transitive callers and readers)
//   node kg-cli.js path <from> <to>         call chain between two functions
//   node kg-cli.js file <path>              outline of a file: definitions and what each calls/reads/writes
//   node kg-cli.js variable <name>          which functions read and write a variable / field / property
//   node kg-cli.js index                    build the graph for a folder Kiln has not opened yet
//
// Names: Name, Class.Name, Namespace.Class.Name or path/file.py:Name. Run inside the project, or pass
// --project <path>. Output is JSON.
const kg = require('./kg-core');

const USAGE = 'Usage: kg-cli.js <overview|search|symbol|usages|impact|path|file|variable|index> [args] [--project <path>] [--kind K] [--depth N] [--limit N]';

function parse(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else opts[key] = true;
    } else pos.push(a);
  }
  return { pos, opts };
}

async function main() {
  const { pos, opts } = parse(process.argv.slice(2));
  const command = pos[0];
  if (!command || opts.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(command ? 0 : 1);
  }
  const args = { project: opts.project, kind: opts.kind, depth: opts.depth, limit: opts.limit };
  if (command === 'search') args.query = pos.slice(1).join(' ');
  else if (command === 'path') {
    args.from = pos[1];
    args.to = pos[2];
  } else if (command === 'file') args.path = pos[1];
  else args.name = pos[1];
  const result = await kg.run(command, args, { cwd: process.cwd() });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
  const known = err instanceof kg.KgError;
  process.stdout.write(`${JSON.stringify({ error: err.message }, null, 2)}\n`);
  if (!known) process.stderr.write(`${err.stack}\n`);
  process.exit(known ? 2 : 1);
});
