import { describe, expect, it } from 'vitest';

import { createDingTalkTurnPermissionPolicy } from '../permissionPolicy';

describe('dingtalk turn permission policy', () => {
  it('forces confirmation for destructive and opaque writes', () => {
    const policy = createDingTalkTurnPermissionPolicy('message-1');
    expect(policy.origin).toEqual({
      kind: 'im',
      channel: 'dingtalk',
      taskId: 'message-1',
    });
    expect(policy.forceConfirmToolCall?.('file_change', {})).toBe(true);
    expect(policy.forceConfirmToolCall?.('permissions', {})).toBe(true);
    expect(policy.forceConfirmToolCall?.('bash', { command: 'rm -rf build' })).toBe(true);
    expect(policy.forceConfirmToolCall?.('mcp__cindy_contacts__call_tool', {
      name: 'contacts_delete',
      args: { id: 'contact-1' },
    })).toBe(true);
    expect(policy.forceConfirmToolCall?.('mcp__cindy__ghost_call', {
      ghost_id: 'files',
      tool: 'call_tool',
      args: {
        name: 'bash',
        args: { command: 'rm -rf generated' },
      },
    })).toBe(true);
    expect(policy.forceConfirmToolCall?.('write', { path: 'notes.md', content: 'safe' })).toBe(false);
    expect(policy.forceConfirmToolCall?.('edit', { path: 'notes.md', oldText: 'a', newText: 'b' })).toBe(false);
  });
});
