import { describe, expect, it } from 'vitest';
import type { TurnPermissionPolicy } from '@cindy/maker-core';

import {
  channelForceConfirmMutatingToolCall,
  channelForceConfirmToolCall,
  channelGuestForceConfirmMutatingToolCall,
  channelGuestForceConfirmToolCall,
  checkChannelDestructiveToolCall,
  isCindyMemoryToolCall,
  isGuestTurnAuthority,
  withGuestMemoryConfirmation,
} from '../channelToolPolicy';

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

/**
 * 访客轮次里的 Cindy 记忆 (docs/product-rules/cindy-memory.md §7)。
 *
 * 入口: 渠道逐轮策略的 forceConfirmToolCall。三种 Agent 把同一次记忆调用包成不同形态
 * (Claude / Pi `mcp__cindy_memory__call_tool`、Codex `mcp:cindy_memory` + toolParams),
 * 任何一种漏判, 访客就能不经主人确认读到主人的账号级记忆。
 */
describe('channel policy for Cindy memory in guest turns', () => {
  const memoryCalls: Array<[string, string, unknown]> = [
    ['Claude / Pi call_tool', 'mcp__cindy_memory__call_tool', { name: 'memory_read', args: { filename: 'user_tone.md' } }],
    ['Codex elicitation', 'mcp:cindy_memory', { toolParams: { name: 'call_tool', args: { name: 'memory_search', args: { query: 'x' } } } }],
    ['Codex elicitation without tool params', 'mcp:cindy_memory', {}],
    ['bare inner action', 'memory_list', {}],
    ['nested dispatcher', 'mcp__other__call_tool', { name: 'memory_write', args: {} }],
    ['session search on the memory server', 'mcp__cindy_memory__call_tool', { name: 'session_search', args: { query: 'x' } }],
  ];

  it.each(memoryCalls)('treats %s as a memory call', (_label, toolName, input) => {
    expect(isCindyMemoryToolCall(toolName, input)).toBe(true);
    // 主人轮次用的原策略不拦读写记忆; 访客轮次用的那一份拦。
    expect(channelGuestForceConfirmToolCall(toolName, input)).toBe(true);
    expect(channelGuestForceConfirmMutatingToolCall(toolName, input)).toBe(true);
  });

  it('leaves owner turns as they were: reading and writing memory is not force-confirmed', () => {
    expect(channelForceConfirmToolCall('mcp__cindy_memory__call_tool', { name: 'memory_read', args: {} })).toBe(false);
    expect(channelForceConfirmToolCall('mcp:cindy_memory', {
      toolParams: { name: 'call_tool', args: { name: 'memory_write', args: {} } },
    })).toBe(false);
  });

  it('keeps tool discovery and unrelated tools outside the memory rule', () => {
    expect(isCindyMemoryToolCall('mcp__cindy_memory__list_tools', {})).toBe(false);
    expect(isCindyMemoryToolCall('mcp:cindy_memory', { toolParams: { name: 'list_tools', args: {} } })).toBe(false);
    expect(isCindyMemoryToolCall('mcp__cindy_scheduler__call_tool', { name: 'schedule_list', args: {} })).toBe(false);
    expect(isCindyMemoryToolCall('Read', { file_path: 'memory_notes.md' })).toBe(false);
    expect(channelGuestForceConfirmToolCall('Read', { file_path: 'notes.md' })).toBe(false);
  });

  it('counts a guest, and an unidentified speaker in a group, as not the owner', () => {
    expect(isGuestTurnAuthority({ requesterAuthority: 'guest', source: 'group' })).toBe(true);
    expect(isGuestTurnAuthority({ requesterAuthority: 'guest', source: 'direct' })).toBe(true);
    expect(isGuestTurnAuthority({ requesterAuthority: 'unknown', source: 'group' })).toBe(true);
    // 个人微信: 私聊、身份恒为 unknown, 对话另一端就是用它的人。
    expect(isGuestTurnAuthority({ requesterAuthority: 'unknown', source: 'direct' })).toBe(false);
    expect(isGuestTurnAuthority({ requesterAuthority: 'owner', source: 'group' })).toBe(false);
    expect(isGuestTurnAuthority(undefined)).toBe(false);
  });

  const policy = (
    authority: 'owner' | 'guest' | 'unknown',
    force: TurnPermissionPolicy['forceConfirmToolCall'],
    source: 'group' | 'direct' = 'group',
  ): TurnPermissionPolicy => ({
    origin: { kind: 'im', channel: 'telegram', taskId: 't' },
    autoReviewContext: { requesterAuthority: authority, source },
    confirmationSurface: 'channel',
    forceConfirmToolCall: force,
  });
  const read = ['mcp__cindy_memory__call_tool', { name: 'memory_read', args: {} }] as const;

  it('adds the memory rule to a guest turn and keeps the function identities the wire encodes', () => {
    const guest = withGuestMemoryConfirmation(policy('guest', channelForceConfirmToolCall));
    expect(guest.forceConfirmToolCall).toBe(channelGuestForceConfirmToolCall);
    expect(guest.forceConfirmToolCall(...read)).toBe(true);
    expect(withGuestMemoryConfirmation(policy('unknown', channelForceConfirmMutatingToolCall)).forceConfirmToolCall)
      .toBe(channelGuestForceConfirmMutatingToolCall);
    // 已经加过的不再包一层。
    expect(withGuestMemoryConfirmation(guest)).toBe(guest);
  });

  it('returns owner turns and private chats with an unverified sender unchanged', () => {
    const owner = policy('owner', channelForceConfirmToolCall);
    expect(withGuestMemoryConfirmation(owner)).toBe(owner);
    const wechat = policy('unknown', channelForceConfirmToolCall, 'direct');
    expect(withGuestMemoryConfirmation(wechat)).toBe(wechat);
  });

  it('wraps a custom policy instead of dropping its own rule', () => {
    const custom = withGuestMemoryConfirmation(policy('guest', (toolName) => toolName === 'Bash'));
    expect(custom.forceConfirmToolCall('Bash', {})).toBe(true);
    expect(custom.forceConfirmToolCall(...read)).toBe(true);
    expect(custom.forceConfirmToolCall('Read', {})).toBe(false);
  });
});
