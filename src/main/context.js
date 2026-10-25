'use strict';
// Everything that belongs to one IDE window: the open project, its watcher and its services.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const { allowFileRoot } = require('./protocol');
const { detectProject } = require('./services/detect');
const { Watcher } = require('./services/watcher');
const { GitService } = require('./services/git');
const { BuildService } = require('./services/build');
const { RunService } = require('./services/run');
const { TerminalService } = require('./services/terminal');
const { ClaudeService } = require('./services/claude');
const { CodeIndex } = require('./services/codeindex');
const { BranchGraph } = require('./services/codeindex/branch');
const { LanguageServices } = require('./services/lsp');
const { LocalHistory } = require('./services/local-history');
const { TestService } = require('./services/tests');
const { PackageService } = require('./services/packages');
const { ArtifactsKB } = require('./services/artifacts');
const { KafkaLive } = require('./services/kafka-live');
const { DebugService } = require('./services/debug');
const fsSvc = require('./services/fs');

// Changes to these files can add projects, dependencies or run configurations.
const MANIFEST = /(\.(sln|slnx|csproj|fsproj|vbproj)|pyproject\.toml|requirements[\w.-]*\.txt|setup\.py|Pipfile|package\.json|langgraph\.json|\.mcp\.json|\.env(\.example)?)$/i;

class ProjectContext {
  constructor(win, hooks = {}) {
    this.win = win;
    this.hooks = hooks;
    this.root = null;
    this.detection = null;
    this.watcher = null;
    this.redetectTimer = null;
    this.git = new GitService(this);
    this.build = new BuildService(this);
    this.runs = new RunService(this);
    this.terminals = new TerminalService(this);
    this.claude = new ClaudeService(this);
    this.index = new CodeIndex(this);
    this.branchGraph = new BranchGraph(this);
    this.lsp = new LanguageServices(this);
    this.history = new LocalHistory(this);
    this.tests = new TestService(this);
    this.packages = new PackageService(this);
    this.artifacts = new ArtifactsKB(this);
    this.kafka = new KafkaLive();
    this.debug = new DebugService(this);
  }

  send(channel, payload) {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (!wc.isDestroyed()) wc.send(channel, payload);
  }

  async open(dir) {
    const resolved = fs.realpathSync(path.resolve(dir));
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`${resolved} is not a folder`);
    await this.close();
    this.root = resolved;
    allowFileRoot(resolved);
    const gitInfo = await this.git.init(resolved);
    this.detection = await detectProject(resolved);
    this.watcher = new Watcher({
      root: resolved,
      gitDir: gitInfo.gitDir,
      onFsChange: (e) => {
        this.send('fs:changed', e);
        this.index.onFsChange(e.paths);
        if (e.overflow || e.paths.some((p) => MANIFEST.test(p))) this.scheduleRedetect();
      },
      onGitChange: () => {
        this.send('git:changed', {});
        // Follow main in the background (commits, merges, pulls, fetched origin/main).
        clearTimeout(this.branchTimer);
        this.branchTimer = setTimeout(() => this.branchGraph.onGitChange(), 800);
      },
    });
    this.watcher.start();
    let branch = null;
    if (gitInfo.isRepo) {
      const st = await this.git.status().catch(() => null);
      branch = st && st.branch ? st.branch.head : null;
    }
    settings.addRecent(resolved, path.basename(resolved), { kinds: this.detection.kinds, summary: this.detection.summary, branch, frameworks: this.detection.agentic ? this.detection.agentic.frameworks.map((f) => f.name).slice(0, 4) : [] });
    if (this.hooks.onRecentChanged) this.hooks.onRecentChanged();
    if (!this.win.isDestroyed()) {
      this.win.setTitle(`${path.basename(resolved)} - Kiln IDE`);
      if (process.platform === 'darwin') this.win.setRepresentedFilename(resolved);
    }
    this.claude.probeResult = null;
    // Index the code in the background; the UI gets index:status progress events.
    fsSvc
      .listFiles(resolved, gitInfo.root)
      .then(({ files }) => (this.root === resolved ? this.index.open(resolved, files) : null))
      .then(() => (this.root === resolved && gitInfo.isRepo ? this.branchGraph.open(resolved) : null))
      .catch((err) => console.warn('[index]', err.message));
    return { root: resolved, name: path.basename(resolved), detection: this.detection, git: gitInfo, state: settings.getProjectState(resolved) };
  }

  scheduleRedetect() {
    clearTimeout(this.redetectTimer);
    this.redetectTimer = setTimeout(() => this.redetect().catch(() => {}), 1200);
  }

  async redetect() {
    if (!this.root) throw new Error('No project is open');
    this.detection = await detectProject(this.root);
    this.send('project:detected', this.detection);
    return this.detection;
  }

  onBuildEnd(status) {
    if (this.root) settings.updateRecent(this.root, { lastBuild: { status, at: Date.now() } });
  }

  async close() {
    clearTimeout(this.redetectTimer);
    if (this.watcher) this.watcher.stop();
    this.watcher = null;
    this.build.dispose();
    this.runs.dispose();
    this.debug.dispose();
    this.terminals.dispose();
    this.claude.dispose();
    this.index.dispose();
    clearTimeout(this.branchTimer);
    this.branchGraph.dispose();
    this.lsp.dispose();
    this.tests.cancel();
    this.kafka.disconnect().catch(() => {});
    this.root = null;
    this.detection = null;
    if (this.win && !this.win.isDestroyed()) {
      this.win.setTitle('Kiln IDE');
      if (process.platform === 'darwin') this.win.setRepresentedFilename('');
    }
    return true;
  }

  dispose() {
    this.close().catch(() => {});
  }
}

module.exports = { ProjectContext };
