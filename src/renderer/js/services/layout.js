// Tool window placement (Rider-style stripes: left, right and bottom).
import { store } from '../lib/store.js';

export const TOOL_WINDOWS = {
  left: [
    { id: 'project', title: 'Project', icon: 'project', command: 'view.project' },
    { id: 'commit', title: 'Commit', icon: 'commit', command: 'view.commit' },
    { id: 'structure', title: 'Structure', icon: 'structure', command: 'view.structure' },
  ],
  bottom: [
    { id: 'build', title: 'Build', icon: 'hammer', command: 'view.build' },
    { id: 'problems', title: 'Problems', icon: 'problems', command: 'view.problems' },
    { id: 'terminal', title: 'Terminal', icon: 'terminal', command: 'view.terminal' },
    { id: 'run', title: 'Run', icon: 'play', command: 'view.run' },
    { id: 'debug', title: 'Debug', icon: 'debug', command: 'view.debug' },
    { id: 'git', title: 'Git', icon: 'git', command: 'view.git' },
    { id: 'tests', title: 'Tests', icon: 'test', command: 'view.tests' },
    { id: 'usages', title: 'Find Usages', icon: 'usages', command: 'navigate.usages' },
    { id: 'todo', title: 'TODO', icon: 'todo', command: 'view.todo' },
    { id: 'packages', title: 'Packages', icon: 'package', command: 'view.packages' },
  ],
  right: [
    { id: 'claude', title: 'Claude', icon: 'claude', command: 'view.claude' },
    { id: 'agents', title: 'AI Agents', icon: 'agent', command: 'view.agents' },
    { id: 'skills', title: 'Skills', icon: 'skill', command: 'view.skills' },
    { id: 'artifacts', title: 'Artifacts', icon: 'book', command: 'view.artifacts' },
  ],
};

export function openTool(side, id) {
  store.update('layout', { [side]: id, zen: false });
}

export function toggleTool(side, id) {
  const cur = store.get().layout[side];
  store.update('layout', { [side]: cur === id ? null : id, zen: false });
}

export function sideOf(id) {
  for (const [side, list] of Object.entries(TOOL_WINDOWS)) if (list.some((t) => t.id === id)) return side;
  return null;
}
