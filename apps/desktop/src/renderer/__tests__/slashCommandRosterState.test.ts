import { describe, expect, it } from 'vitest';

import {
  beginSlashCommandRosterLoad,
  EMPTY_SLASH_COMMANDS,
  failSlashCommandRosterLoad,
  isSlashCommandRosterReady,
  type SlashCommandRosterState,
  type UnifiedCommand,
} from '../lib/slashCommands';

const help: UnifiedCommand = {
  kind: 'desktop',
  name: 'help',
  description: 'Open help',
};

function ready(contextKey = 'local'): SlashCommandRosterState {
  return { contextKey, status: 'ready', commands: [help] };
}

describe('slash command roster refresh state', () => {
  it('keeps the successful same-context roster available during refresh', () => {
    const state = beginSlashCommandRosterLoad(ready(), 'local');

    expect(state).toEqual({ contextKey: 'local', status: 'refreshing', commands: [help] });
    expect(isSlashCommandRosterReady(state, 'local')).toBe(true);
  });

  it('restores the previous roster when a same-context refresh fails', () => {
    const state = failSlashCommandRosterLoad(
      { contextKey: 'local', status: 'refreshing', commands: [help] },
      'local',
    );

    expect(state).toEqual({ contextKey: 'local', status: 'ready', commands: [help] });
    expect(isSlashCommandRosterReady(state, 'local')).toBe(true);
  });

  it('clears commands until a new context finishes loading', () => {
    const loading = beginSlashCommandRosterLoad(ready('local'), 'remote');

    expect(loading).toEqual({
      contextKey: 'remote',
      status: 'loading',
      commands: EMPTY_SLASH_COMMANDS,
    });
    expect(isSlashCommandRosterReady(loading, 'remote')).toBe(false);
    expect(failSlashCommandRosterLoad(loading, 'remote')).toEqual({
      contextKey: 'remote',
      status: 'error',
      commands: EMPTY_SLASH_COMMANDS,
    });
  });
});
