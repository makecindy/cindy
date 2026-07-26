import { describe, expect, it } from 'vitest';
import { matchTerminalCommands, wrapTerminalText } from './terminal-ui.js';

const commands = [
  { name: '/help', description: 'Show commands' },
  { name: '/resume', description: 'Resume a session' },
  { name: '/settings', description: 'Change settings' },
  { name: '/stop', description: 'Interrupt a turn' },
] as const;

describe('CindyTerminalUi helpers', () => {
  it('offers the real resume command while a user types its prefix', () => {
    expect(matchTerminalCommands('/re', commands).map((command) => command.name)).toEqual(['/resume']);
  });

  it('ranks a prefix match before a looser fuzzy match without adding commands', () => {
    expect(matchTerminalCommands('/s', commands).map((command) => command.name)).toEqual(['/settings', '/stop', '/resume']);
  });

  it('does not offer a command palette after command arguments begin', () => {
    expect(matchTerminalCommands('/attach /srv/file', commands)).toEqual([]);
  });

  it('wraps Unicode content by terminal columns without dropping characters', () => {
    expect(wrapTerminalText('你好 Cindy terminal', 4)).toEqual(['你好 C', 'indy', ' ter', 'mina', 'l']);
  });
});
