import { describe, expect, it } from 'vitest';
import type { IMMessageEvent } from '@cindy/im';

import { buildTelegramAdapter } from '../adapter';

describe('Telegram group history access scope', () => {
  const adapter = buildTelegramAdapter({} as never, {} as never);

  it('marks group owners as owner scope and guests as lane scope', () => {
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
    expect(
      adapter.groupHistoryAccessFor?.({
        ...base,
        speaker: { id: 'owner', name: 'Owner', isOwner: true },
      } as unknown as IMMessageEvent),
    ).toEqual({
      access: 'owner',
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
