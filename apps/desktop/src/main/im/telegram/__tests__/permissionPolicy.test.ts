import { describe, expect, it } from 'vitest';

import { createTelegramGuestOnlyPolicy, createTelegramGuestTurnPermissionPolicy } from '../permissionPolicy';

describe('telegram guest turn permission policy(一群一会话的成员轮次收紧)', () => {
  it('破坏性 shell 与包装的 MCP 写操作强制确认', () => {
    const policy = createTelegramGuestTurnPermissionPolicy('-100200|11');

    expect(policy.origin).toEqual({
      kind: 'im',
      channel: 'telegram',
      taskId: '-100200|11',
    });
    expect(policy.confirmationSurface).toBe('channel');
    expect(policy.forceConfirmToolCall('Bash', { command: 'rm -rf build' })).toBe(true);
    expect(policy.forceConfirmToolCall('bash', { command: 'rm -rf build' })).toBe(true);
    expect(
      policy.forceConfirmToolCall('mcp__cindy_contacts__call_tool', {
        name: 'contacts_delete',
        args: { id: 'contact-1' },
      }),
    ).toBe(true);
    expect(
      policy.forceConfirmToolCall('mcp:cindy_contacts', {
        toolParams: { name: 'contacts_merge', args: { sourceId: 'a', targetId: 'b' } },
      }),
    ).toBe(true);
    expect(
      policy.forceConfirmToolCall('mcp__cindy__ghost_call', {
        ghost_id: 'files',
        tool: 'delete_workspace',
        args: { id: 'workspace-1' },
      }),
    ).toBe(true);
  });

  it('读/搜自动放行; Codex 不透明写(file_change/permissions)保守强确认', () => {
    const policy = createTelegramGuestTurnPermissionPolicy('-100200|12');

    expect(policy.forceConfirmToolCall('Read', { path: 'README.md' })).toBe(false);
    expect(policy.forceConfirmToolCall('Grep', { pattern: 'foo' })).toBe(false);
    expect(policy.forceConfirmToolCall('write', { path: 'notes.md', content: 'safe' })).toBe(false);
    expect(policy.forceConfirmToolCall('edit', { path: 'notes.md', oldText: 'a', newText: 'b' })).toBe(false);
    expect(
      policy.forceConfirmToolCall('mcp:cindy_contacts', {
        toolParams: { name: 'contacts_search', args: { query: 'Carol' } },
      }),
    ).toBe(false);
    expect(policy.forceConfirmToolCall('file_change', { grantRoot: null })).toBe(true);
    expect(
      policy.forceConfirmToolCall('permissions', { permissions: { network: true } }),
    ).toBe(true);
  });
});

describe('telegram guest-only policy(开关放行的非 owner 轮次)', () => {
  it('每个工具调用都强制确认, 并向审阅器声明 guest 授权来源', () => {
    const group = createTelegramGuestOnlyPolicy('g/-100200|11', 'group');
    expect(group.autoReviewContext).toEqual({ requesterAuthority: 'guest', source: 'group' });
    expect(group.forceConfirmToolCall('Read', { path: 'README.md' })).toBe(true);
    expect(group.forceConfirmToolCall('Bash', { command: 'rm -rf build' })).toBe(true);

    const direct = createTelegramGuestOnlyPolicy('ou_guest');
    expect(direct.autoReviewContext).toEqual({ requesterAuthority: 'guest', source: 'direct' });
    expect(direct.forceConfirmToolCall('Read', { path: 'README.md' })).toBe(true);
  });
});

it('keeps trusted requester authority separate from message text', () => {
  expect(createTelegramGuestTurnPermissionPolicy('message', true).autoReviewContext).toEqual({ requesterAuthority: 'owner', source: 'group' });
  expect(createTelegramGuestTurnPermissionPolicy('message', false).autoReviewContext).toEqual({ requesterAuthority: 'guest', source: 'group' });
  expect(createTelegramGuestTurnPermissionPolicy('message').autoReviewContext?.requesterAuthority).toBe('unknown');
});
