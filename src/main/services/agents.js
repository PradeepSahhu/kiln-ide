'use strict';
// Other AI coding agents (CLI tools) that can run inside the IDE in an agent tab. They edit files on
// disk; the IDE's watcher picks those edits up and shows them live in the editor.
const { which, run } = require('../util/proc');

const AGENTS = [
  { id: 'claude-cli', name: 'Claude Code (terminal)', command: 'claude', args: [], vendor: 'Anthropic', url: 'https://code.claude.com' },
  { id: 'codex', name: 'Codex CLI', command: 'codex', args: [], vendor: 'OpenAI', url: 'https://github.com/openai/codex' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: [], vendor: 'Google', url: 'https://github.com/google-gemini/gemini-cli' },
  { id: 'copilot', name: 'GitHub Copilot CLI', command: 'copilot', args: [], vendor: 'GitHub', url: 'https://github.com/github/copilot-cli' },
  { id: 'aider', name: 'Aider', command: 'aider', args: [], vendor: 'Aider', url: 'https://aider.chat' },
  { id: 'cursor-agent', name: 'Cursor Agent', command: 'cursor-agent', args: [], vendor: 'Cursor', url: 'https://cursor.com/cli' },
  { id: 'opencode', name: 'opencode', command: 'opencode', args: [], vendor: 'SST', url: 'https://opencode.ai' },
  { id: 'qwen', name: 'Qwen Code', command: 'qwen', args: [], vendor: 'Alibaba', url: 'https://github.com/QwenLM/qwen-code' },
  { id: 'goose', name: 'Goose', command: 'goose', args: ['session'], vendor: 'Block', url: 'https://block.github.io/goose' },
  { id: 'amp', name: 'Amp', command: 'amp', args: [], vendor: 'Sourcegraph', url: 'https://ampcode.com' },
];

let cache = null;

async function listAgents(force = false) {
  if (cache && !force && Date.now() - cache.at < 30000) return cache.list;
  const list = await Promise.all(
    AGENTS.map(async (a) => {
      const p = which(a.command);
      if (!p) return { ...a, found: false };
      const r = await run(p, ['--version'], { timeout: 8000 });
      const version = r.code === 0 ? ((r.stdout || r.stderr).trim().split('\n')[0] || '').slice(0, 60) : null;
      return { ...a, found: true, path: p, version };
    }),
  );
  cache = { at: Date.now(), list };
  return list;
}

function agentById(id) {
  return AGENTS.find((a) => a.id === id) || null;
}

module.exports = { listAgents, agentById };
