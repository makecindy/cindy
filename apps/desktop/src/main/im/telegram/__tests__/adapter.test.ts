import { describe, expect, it } from 'vitest';
import type { IMMessageEvent } from '@cindy/im';

import { buildTelegramAdapter } from '../adapter';
import { ui } from '../uiText';

describe('Telegram group history access scope', () => {
  const adapter = buildTelegramAdapter({} as never, {} as never);

  it('only lets owner-triggered group turns omit the policy in Full access', () => {
    const groupEvent = {
      messageId: 'm-policy',
      speaker: { id: 'guest', name: 'Guest', isOwner: false },
    } as unknown as IMMessageEvent;
    const guestPolicy = adapter.turnPermissionPolicyFor?.(groupEvent);
    const ownerPolicy = adapter.turnPermissionPolicyFor?.({
      ...groupEvent,
      messageId: 'm-owner-policy',
      speaker: { id: 'owner', name: 'Owner', isOwner: true },
    } as unknown as IMMessageEvent);

    expect(guestPolicy).toMatchObject({
      origin: { kind: 'im', channel: 'telegram', taskId: 'm-policy' },
      confirmationSurface: 'channel',
    });
    expect(ownerPolicy).toBeDefined();
    expect(adapter.turnPolicyOptionalForMode?.('bypassPermissions', guestPolicy!)).toBe(false);
    expect(adapter.turnPolicyOptionalForMode?.('bypassPermissions', ownerPolicy!)).toBe(true);
    expect(adapter.turnPolicyOptionalForMode?.('auto', ownerPolicy!)).toBe(false);
    expect(adapter.turnPolicyOptionalForMode?.('ask', ownerPolicy!)).toBe(false);
  });

  it('does not attach a group confirmation policy to DMs', () => {
    const groupEvent = {
      messageId: 'm-policy',
      speaker: { id: 'guest', name: 'Guest', isOwner: false },
    } as unknown as IMMessageEvent;
    expect(
      adapter.turnPermissionPolicyFor?.({
        ...groupEvent,
        speaker: undefined,
      } as unknown as IMMessageEvent),
    ).toBeUndefined();
  });

  it('explains an unsupported permission mode without exposing the internal error code', () => {
    const message = ui.error.permissionModeUnsupported;
    expect(message).toContain('自动审批');
    expect(message).toContain('/permission');
    expect(message).not.toContain('TURN_PERMISSION_POLICY_UNSUPPORTED');
  });

  it('keeps every group turn lane-only — owner-triggered included (injection hardening)', () => {
    const base = {
      contextId: 'bot-1',
      senderId: 'g/-100/77',
      messageId: 'm-1',
      chatId: '-100',
      text: 'hi',
      attachments: [],
      unsupported: [],
      speaker: { id: 'u-1', name: 'Guest', isOwner: false },
    } as unknown as IMMessageEvent;
    expect(adapter.groupHistoryAccessFor?.(base)).toEqual({
      access: 'lane',
      provider: 'telegram-personal:bot-1',
      lane: { provider: 'telegram-personal:bot-1', chatId: '-100', threadId: '77' },
    });
    // owner 在群里触发也不升权: 群窗口携带成员可控文本, 注入可借 owner 轮次
    // 跨 lane 检索并回帖泄漏(与 turnPermissionPolicyFor 同一裁决)。
    expect(
      adapter.groupHistoryAccessFor?.({
        ...base,
        speaker: { id: 'owner', name: 'Owner', isOwner: true },
      } as unknown as IMMessageEvent),
    ).toEqual({
      access: 'lane',
      provider: 'telegram-personal:bot-1',
      lane: { provider: 'telegram-personal:bot-1', chatId: '-100', threadId: '77' },
    });
  });

  it('keeps owner DM explicit: no implicit current lane', () => {
    expect(
      adapter.groupHistoryAccessFor?.({
        contextId: 'bot-1',
        senderId: '12345',
        messageId: 'm-2',
        chatId: '12345',
        text: '查历史',
        attachments: [],
        unsupported: [],
      } as never),
    ).toEqual({
      access: 'owner',
      provider: 'telegram-personal:bot-1',
      lane: null,
    });
  });
});
