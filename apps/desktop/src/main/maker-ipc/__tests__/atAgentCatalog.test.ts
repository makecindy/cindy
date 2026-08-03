import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  listAtProjectAgentResources,
  mergeAtProjectAgentResources,
} from '../atAgentCatalog.js';

const root = path.resolve('C:/workspace/demo');

describe('atAgentCatalog', () => {
  it('projects only safe project-scoped Claude Agent definitions', () => {
    const items = listAtProjectAgentResources([
      {
        engine: 'claude-code',
        kind: 'agent',
        scope: 'project',
        name: ' reviewer ',
        description: 'Reviews\nchanges',
        absolutePath: path.join(root, '.claude', 'agents', 'reviewer.md'),
        workingDir: root,
      },
      {
        engine: 'claude-code',
        kind: 'agent',
        scope: 'global',
        name: 'global-agent',
        absolutePath: path.resolve('C:/Users/demo/.claude/agents/global-agent.md'),
      },
      {
        engine: 'claude-code',
        kind: 'agent',
        scope: 'project',
        name: 'escape',
        absolutePath: path.resolve(root, '..', 'escape.md'),
      },
    ], root);

    expect(items).toEqual([{
      type: 'agent',
      name: 'reviewer',
      description: 'Reviews changes',
      relPath: '.claude/agents/reviewer.md',
    }]);
  });

  it('filters, deduplicates and keeps project agents ahead of workspace files', () => {
    const projectAgents = listAtProjectAgentResources([{
      engine: 'claude-code',
      kind: 'agent',
      scope: 'project',
      name: 'reviewer',
      absolutePath: path.join(root, '.claude', 'agents', 'reviewer.md'),
    }], root, 'review');
    const merged = mergeAtProjectAgentResources([
      projectAgents[0],
      { type: 'file', name: 'README.md', relPath: 'README.md' },
    ], projectAgents, 2);

    expect(merged).toEqual({
      items: [
        projectAgents[0],
        { type: 'file', name: 'README.md', relPath: 'README.md' },
      ],
      capped: false,
    });
  });
});
