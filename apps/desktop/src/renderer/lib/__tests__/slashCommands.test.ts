import { describe, expect, it } from 'vitest';

import { filterSlashCommands } from '@/lib/slashCommands';

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
