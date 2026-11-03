import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';

import { hookTaskCardHeading } from '../HookTaskCard';

const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key) as unknown as TFunction;

describe('hookTaskCardHeading', () => {
  it('keeps the owner / legacy heading and never shows a user id for the owner', () => {
    expect(hookTaskCardHeading('telegram', undefined, t)).toEqual({
      label: 'chat.threadContext.cindyFrom:{"platform":"settings.tina.prefs.providerTelegram"}',
    });
    expect(
      hookTaskCardHeading('telegram', { chat: { kind: 'group', name: 'Hulu' }, sender: { id: '42', isOwner: true } }, t),
    ).toEqual({ label: 'chat.threadContext.cindyFrom:{"platform":"settings.tina.prefs.providerTelegram"}' });
  });

  it('names a group member with the group, and a stranger DM as not the owner', () => {
    expect(
      hookTaskCardHeading(
        'telegram',
        { chat: { kind: 'group', name: 'Hulu Report' }, sender: { id: '7', name: 'Ann', isOwner: false } },
        t,
      ),
    ).toEqual({
      label:
        'chat.threadContext.memberFromGroup:{"name":"Ann","platform":"settings.tina.prefs.providerTelegram","group":"Hulu Report"}',
      title: 'user_id: 7',
    });
    expect(
      hookTaskCardHeading('telegram', { chat: { kind: 'group' }, sender: { id: '7', isOwner: false } }, t),
    ).toEqual({
      label: 'chat.threadContext.memberFromPlatform:{"name":"7","platform":"settings.tina.prefs.providerTelegram"}',
      title: 'user_id: 7',
    });
    expect(
      hookTaskCardHeading('feishu', { chat: { kind: 'direct' }, sender: { name: 'Bob', isOwner: false } }, t),
    ).toEqual({
      label: 'chat.threadContext.guestFromDm:{"name":"Bob","platform":"settings.feishuBot.services.feishu"}',
    });
    // 早落库只有发言人、还没有群 / 私聊时按群成员显示, 不冒充主人。
    expect(hookTaskCardHeading('telegram', { sender: { isOwner: false } }, t).label).toBe(
      'chat.threadContext.memberFromPlatform:{"name":"chat.threadContext.unknownSender","platform":"settings.tina.prefs.providerTelegram"}',
    );
  });
});
