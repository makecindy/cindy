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
  });
});
