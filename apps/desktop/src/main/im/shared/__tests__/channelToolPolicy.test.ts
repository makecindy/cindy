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

describe('channel policy for scheduler command execution', () => {
  it.each(['schedule_create', 'schedule_update', 'schedule_set_pre_run_hook', 'schedule_resume', 'schedule_run_now'])(
    'requires per-turn confirmation for %s, even inside a trusted scheduler MCP', (name) => {
      expect(channelForceConfirmToolCall('mcp__cindy_scheduler__call_tool', { name, args: {} })).toBe(true);
      expect(channelForceConfirmToolCall('mcp:cindy_scheduler', {
        toolParams: { name: 'call_tool', args: { name, args: {} } },
      })).toBe(true);
      expect(channelForceConfirmToolCall(name, {})).toBe(true);
    },
  );

  it('keeps scheduler discovery and reads outside forced confirmation', () => {
    for (const name of ['schedule_list', 'schedule_get', 'schedule_list_runs']) {
      expect(channelForceConfirmToolCall('mcp:cindy_scheduler', {
        toolParams: { name: 'call_tool', args: { name, args: {} } },
      })).toBe(false);
    }
  });
});

describe('channel policy for Host app update cards', () => {
  it.each([
    ['cindy.app.update', { from: '0.1.86', to: '0.1.90' }],
    ['cindy.app.auto_update', { enabled: true }],
  ])('lets the owner answer the %s card instead of hard-denying it', (toolName, input) => {
    expect(checkChannelDestructiveToolCall(toolName, input)).toEqual({ destructive: false });
  });
});
