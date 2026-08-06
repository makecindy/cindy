import { describe, expect, it } from 'vitest';

import { createWechatTurnPermissionPolicy } from '../permissionPolicy';

describe('personal WeChat turn permission policy', () => {
  it('forces destructive shell and wrapped MCP actions through Desktop', () => {
    const policy = createWechatTurnPermissionPolicy('task-1');

    expect(policy.origin).toEqual({
      kind: 'im',
      channel: 'wechat',
      taskId: 'task-1',
    });
    expect(
      policy.forceConfirmToolCall('Bash', { command: 'rm -rf build' }),
    ).toBe(true);
    expect(
      policy.forceConfirmToolCall('bash', { command: 'rm -rf build' }),
    ).toBe(true);
    expect(
      policy.forceConfirmToolCall('mcp__cindy_contacts__call_tool', {
        name: 'contacts_delete',
        args: { id: 'contact-1' },
      }),
    ).toBe(true);
    expect(
      policy.forceConfirmToolCall('mcp:cindy_contacts', {
        toolParams: {
          name: 'contacts_merge',
          args: { sourceId: 'a', targetId: 'b' },
        },
      }),
    ).toBe(true);
    expect(
      policy.forceConfirmToolCall('mcp__cindy__ghost_call', {
        ghost_id: 'files',
        tool: 'call_tool',
        args: {
          name: 'bash',
          args: { command: 'rm -rf generated' },
        },
      }),
    ).toBe(true);
    expect(
      policy.forceConfirmToolCall('mcp__cindy__call_tool', {
        name: 'file_change',
        args: { grantRoot: null },
      }),
    ).toBe(true);
    expect(
      policy.forceConfirmToolCall('mcp__cindy__ghost_call', {
        ghost_id: 'files',
        tool: 'permissions',
        args: { permissions: { network: true } },
      }),
    ).toBe(true);
  });

  it('keeps read-only calls automatic but treats opaque Codex writes conservatively', () => {
    const policy = createWechatTurnPermissionPolicy('task-2');

    expect(policy.forceConfirmToolCall('Read', { path: 'README.md' })).toBe(false);
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
