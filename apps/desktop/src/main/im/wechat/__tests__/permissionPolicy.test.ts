import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@cindy/maker-core';

import {
  createWechatTurnPermissionPolicy,
  createWechatTurnPermissionPolicyForMode,
  supportsWechatTurnPermissionMode,
} from '../permissionPolicy';

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
  });

  it('keeps read-only calls automatic but treats opaque Codex writes conservatively', () => {
    const policy = createWechatTurnPermissionPolicy('task-2');

    expect(policy.forceConfirmToolCall('Read', { path: 'README.md' })).toBe(false);
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

  it('honors the provider capability gate without silently downgrading Full Access', () => {
    const capabilities = {
      turnPermissionPolicy: {
        supported: { supported: true },
        unsupportedPermissionModes: ['bypassPermissions'],
      },
    } as Capabilities;

    expect(supportsWechatTurnPermissionMode(capabilities, 'auto')).toBe(true);
    expect(
      supportsWechatTurnPermissionMode(capabilities, 'bypassPermissions'),
    ).toBe(false);
    expect(
      supportsWechatTurnPermissionMode({} as Capabilities, 'ask'),
    ).toBe(false);

    expect(() =>
      createWechatTurnPermissionPolicyForMode('task-3', capabilities, 'bypassPermissions'),
    ).toThrow('TURN_PERMISSION_POLICY_UNSUPPORTED:bypassPermissions');
    expect(() =>
      createWechatTurnPermissionPolicyForMode('task-4', {} as Capabilities, 'ask'),
    ).toThrow('TURN_PERMISSION_POLICY_UNSUPPORTED:ask');
    expect(createWechatTurnPermissionPolicyForMode('task-5', capabilities, 'auto').origin).toEqual({
      kind: 'im',
      channel: 'wechat',
      taskId: 'task-5',
    });
  });
});
