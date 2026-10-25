'use strict';
// Builders for throwaway projects and git repositories used by the tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function tmpdir(prefix = 'kiln-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Write a tree of files: { 'a/b.txt': 'content' }. */
function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' } });
}

function gitRepo(files = { 'README.md': '# demo\n' }) {
  const root = tmpdir('kiln-repo-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeTree(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

/** A fake ProjectContext: collects events sent to the renderer. */
function fakeContext(root, extra = {}) {
  const events = [];
  return {
    root,
    detection: null,
    events,
    send(channel, payload) {
      events.push({ channel, payload });
    },
    build: { interpreters: new Map() },
    git: { root: null },
    ...extra,
  };
}

const has = (cmd) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

module.exports = { tmpdir, writeTree, git, gitRepo, fakeContext, has };
