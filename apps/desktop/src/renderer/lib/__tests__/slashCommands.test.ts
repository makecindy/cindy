import { describe, expect, it } from 'vitest';

import {
  filterSlashCommands,
  firstAvailableSlashCommandIndex,
  isSlashCommandUnavailable,
  mergeCommands,
  nextAvailableSlashCommandIndex,
  type UnifiedCommand,
} from '@/lib/slashCommands';

describe('filterSlashCommands', () => {
  it('matches command names by case-insensitive containment', () => {
    const commands = [
      { kind: 'desktop' as const, name: 'lark-drive', description: 'Drive' },
      { kind: 'desktop' as const, name: 'github', description: 'GitHub' },
    ];

    expect(filterSlashCommands(commands, 'DRIVE').map((command) => command.name)).toEqual([
      'lark-drive',
    ]);
  });

  it('ranks exact and prefix matches before ordinary contains matches', () => {
    const commands = [
      { kind: 'desktop' as const, name: 'my-drive-tool', description: '' },
      { kind: 'desktop' as const, name: 'drive-sync', description: '' },
      { kind: 'desktop' as const, name: 'archive-drive', description: '' },
      { kind: 'desktop' as const, name: 'drive', description: '' },
      { kind: 'desktop' as const, name: 'lark-drive', description: '' },
    ];

    expect(filterSlashCommands(commands, 'drive').map((command) => command.name)).toEqual([
      'drive',
      'drive-sync',
      'my-drive-tool',
      'archive-drive',
      'lark-drive',
    ]);
  });

  it('keeps an exact match visible when contains matches exceed the limit', () => {
    const containsMatches = Array.from({ length: 25 }, (_, index) => ({
      kind: 'desktop' as const,
      name: `plugin-${index}-drive`,
      description: '',
    }));

    expect(
      filterSlashCommands([
        ...containsMatches,
        { kind: 'desktop' as const, name: 'drive', description: '' },
      ], 'drive', 25).map((command) => command.name),
    ).toContain('drive');
  });
});

describe('Pi project skill availability', () => {
  const skill = (overrides: Partial<Extract<UnifiedCommand, { kind: 'agent-skill' }>> = {}) => ({
    kind: 'agent-skill' as const,
    name: 'demo',
    source: 'skill' as const,
    ...overrides,
  });

  it('disables only discovered project skills', () => {
    expect(isSlashCommandUnavailable(skill({ scope: 'repo', runtimeStatus: 'discovered' }))).toBe(true);
    expect(isSlashCommandUnavailable(skill({ scope: 'repo', runtimeStatus: 'loaded' }))).toBe(false);
    expect(isSlashCommandUnavailable(skill({ scope: 'user', runtimeStatus: 'discovered' }))).toBe(false);
    expect(isSlashCommandUnavailable(skill({ scope: 'repo' }))).toBe(false);
  });

  it('keeps an available same-name skill ahead of a discovered project preview', () => {
    const discovered = skill({ scope: 'repo', runtimeStatus: 'discovered', path: '/repo/.pi/skills/demo' });
    const available = skill({ scope: 'user', path: '/home/user/.agents/skills/demo' });

    expect(mergeCommands([], [], [discovered, available])).toEqual([available]);
  });

  it('does not let a discovered preview shadow same-name executable tiers', () => {
    const discovered = skill({ name: 'help', scope: 'repo', runtimeStatus: 'discovered' });
    const desktop: UnifiedCommand = {
      kind: 'desktop',
      name: 'help',
      description: 'Open help',
    };

    expect(mergeCommands([desktop], [], [discovered])).toEqual([desktop]);
  });

  it('initializes and moves keyboard focus past unavailable project skills', () => {
    const commands = [
      skill({ name: 'first', scope: 'repo', runtimeStatus: 'discovered' }),
      skill({ name: 'second', scope: 'user' }),
      skill({ name: 'third', scope: 'repo', runtimeStatus: 'discovered' }),
      skill({ name: 'fourth', scope: 'user' }),
    ];

    expect(firstAvailableSlashCommandIndex(commands)).toBe(1);
    expect(nextAvailableSlashCommandIndex(commands, 1, 1)).toBe(3);
    expect(nextAvailableSlashCommandIndex(commands, 3, 1)).toBe(1);
    expect(nextAvailableSlashCommandIndex(commands, 1, -1)).toBe(3);
  });

  it('keeps focus stable when every matching command is unavailable', () => {
    const commands = [
      skill({ name: 'first', scope: 'repo', runtimeStatus: 'discovered' }),
      skill({ name: 'second', scope: 'repo', runtimeStatus: 'discovered' }),
    ];

    expect(firstAvailableSlashCommandIndex(commands)).toBe(0);
    expect(nextAvailableSlashCommandIndex(commands, 0, 1)).toBe(0);
  });
});
