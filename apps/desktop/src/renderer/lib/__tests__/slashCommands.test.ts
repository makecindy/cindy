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

  it('keeps the result capped by the requested limit', () => {
    const commands = [
      { kind: 'desktop' as const, name: 'drive', description: '' },
      { kind: 'desktop' as const, name: 'lark-drive', description: '' },
    ];

    expect(filterSlashCommands(commands, 'drive', 1).map((command) => command.name)).toEqual([
      'drive',
    ]);
  });
});
