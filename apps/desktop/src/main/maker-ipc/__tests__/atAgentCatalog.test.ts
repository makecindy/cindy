import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  finalizeAtProjectAgentResources,
  listAtProjectAgentResources,
  mergeAtProjectAgentResources,
  supportsAtProjectAgentResources,
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

  it('exposes project Agents only for Claude Code', () => {
    expect(supportsAtProjectAgentResources('claude-code')).toBe(true);
    expect(supportsAtProjectAgentResources('codex')).toBe(false);
    expect(supportsAtProjectAgentResources('pi')).toBe(false);
  });

  it.each(['codex', 'pi'] as const)(
    'hides Agent entries and their backing .claude files for %s',
    (agentKind) => {
      const result = finalizeAtProjectAgentResources(
        agentKind,
        [
          { type: 'dir', name: '.claude', relPath: '.claude' },
          { type: 'dir', name: 'agents', relPath: '.claude/agents' },
          {
            type: 'file',
            name: 'reviewer.md',
            relPath: '.claude\\agents\\reviewer.md',
          },
          {
            type: 'agent',
            name: 'reviewer',
            relPath: '.claude/agents/reviewer.md',
          },
          { type: 'file', name: 'README.md', relPath: 'README.md' },
        ],
        [{
          type: 'agent',
          name: 'reviewer',
          relPath: '.claude/agents/reviewer.md',
        }],
      );

      expect(result).toEqual({
        items: [
          { type: 'dir', name: '.claude', relPath: '.claude' },
          { type: 'file', name: 'README.md', relPath: 'README.md' },
        ],
        capped: false,
      });
    },
  );

  it('keeps Claude Code project Agents ahead of ordinary resources', () => {
    const agent = {
      type: 'agent' as const,
      name: 'reviewer',
      relPath: '.claude/agents/reviewer.md',
    };

    expect(finalizeAtProjectAgentResources(
      'claude-code',
      [{ type: 'file', name: 'README.md', relPath: 'README.md' }],
      [agent],
    )).toEqual({
      items: [agent, { type: 'file', name: 'README.md', relPath: 'README.md' }],
      capped: false,
    });
  });
});
