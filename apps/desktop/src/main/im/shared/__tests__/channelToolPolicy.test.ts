import { describe, expect, it } from 'vitest';
import { channelForceConfirmToolCall, checkChannelDestructiveToolCall } from '../channelToolPolicy';

describe('production channel policy for Pi management', () => {
  it.each(['cindy_pi_command', 'cindy_pi_extension', 'mcp__cindy__cindy_pi_command'])('requires confirmation for %s mutations', name => {
    for (const args of [['update'], ['update', '--self'], ['update', '--all'], ['update', '--extensions'],
      ['update', '--extension', 'npm:example'], ['install', 'npm:example'], ['remove', 'npm:example'], ['uninstall', 'npm:example']]) {
      expect(channelForceConfirmToolCall(name, { args })).toBe(true);
      expect(checkChannelDestructiveToolCall(name, { args }).destructive).toBe(false);
    }
    expect(channelForceConfirmToolCall(name, { action: 'remove', source: 'npm:example' })).toBe(true);
  });

  it.each([['list'], ['list', '--no-approve'], ['--version'], ['--help'], ['update', '--help']])('keeps the readonly query %j outside forced confirmation', (...args) => {
    expect(channelForceConfirmToolCall('cindy_pi_command', { args })).toBe(false);
  });

  it('classifies wrapped Pi arguments without treating them as permanently denied', () => {
    const input = { tool: 'call_tool', args: { name: 'cindy_pi_command', args: { args: ['update', '--self'] } } };
    expect(channelForceConfirmToolCall('ghost_call', input)).toBe(true);
    expect(checkChannelDestructiveToolCall('ghost_call', input).destructive).toBe(false);
    expect(channelForceConfirmToolCall('call_tool', { name: 'cindy_pi_extension', args: { action: 'update', source: 'npm:example' } })).toBe(true);
    expect(channelForceConfirmToolCall('elicitation', { toolParams: { name: 'cindy_pi_command', args: { args: ['update', '--all'] } } })).toBe(true);
  });

  it('does not let malformed or mixed mutation inputs borrow readonly approval', () => {
    for (const input of [{}, { args: ['list', '--unknown'] }, { args: ['--help'], action: 'remove' }, { args: [null] }]) {
      expect(channelForceConfirmToolCall('cindy_pi_command', input)).toBe(true);
    }
    expect(channelForceConfirmToolCall('read', { path: 'notes.md' })).toBe(false);
  });
});
