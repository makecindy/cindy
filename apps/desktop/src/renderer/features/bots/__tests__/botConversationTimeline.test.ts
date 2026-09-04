import { describe, expect, it } from 'vitest';

import {
  BOT_MESSAGE_TIME_GROUP_MS,
  collectBotMessageTimeGroups,
  findFirstUnreadBotReplyClientId,
  formatBotMessageGroupTime,
} from '../botConversationTimeline';

describe('Bot message timeline', () => {
  it('shows one timestamp for messages less than five minutes apart', () => {
    const start = new Date(2026, 8, 1, 9, 0).getTime();
    const groups = collectBotMessageTimeGroups([
      { clientId: 'first', createdAt: start },
      { clientId: 'inside-window', createdAt: start + BOT_MESSAGE_TIME_GROUP_MS - 1 },
      { clientId: 'next-group', createdAt: start + BOT_MESSAGE_TIME_GROUP_MS * 2 },
    ]);

    expect([...groups.keys()]).toEqual(['first', 'next-group']);
  });

  it('starts a new group five minutes after the group began, even with frequent messages', () => {
    const start = new Date(2026, 8, 1, 9, 0).getTime();
    const groups = collectBotMessageTimeGroups([
      { clientId: 'first', createdAt: start },
      { clientId: 'near-end', createdAt: start + BOT_MESSAGE_TIME_GROUP_MS - 1 },
      { clientId: 'past-window', createdAt: start + BOT_MESSAGE_TIME_GROUP_MS + 60_000 },
    ]);

    expect([...groups.keys()]).toEqual(['first', 'past-window']);
  });

  it('ignores missing timestamps without splitting the surrounding group', () => {
    const start = new Date(2026, 8, 1, 9, 0).getTime();
    const groups = collectBotMessageTimeGroups([
      { clientId: 'first', createdAt: start },
      { clientId: 'missing', createdAt: null },
      { clientId: 'still-together', createdAt: start + 60_000 },
    ]);

    expect([...groups.keys()]).toEqual(['first']);
  });

  it('uses a compact time today and includes the date for older messages', () => {
    const now = new Date(2026, 8, 1, 14, 0).getTime();
    expect(formatBotMessageGroupTime(new Date(2026, 8, 1, 9, 7).getTime(), 'en-US', now)).toBe(
      '09:07 AM',
    );
    expect(
      formatBotMessageGroupTime(new Date(2026, 7, 31, 9, 7).getTime(), 'en-US', now),
    ).toContain('Aug 31');
  });
});

describe('Bot unread boundary', () => {
  const messages = [
    { clientId: 'old', role: 'assistant', createdAt: 4_000 },
    { clientId: 'user', role: 'user', createdAt: 6_000 },
    {
      clientId: 'internal-b2b-received',
      role: 'assistant',
      createdAt: 6_500,
      systemCardType: 'bot-direct-message',
    },
    { clientId: 'first-unread', role: 'assistant', createdAt: 7_000 },
    { clientId: 'later-unread', role: 'assistant', createdAt: 8_000 },
  ];

  it('anchors the divider to the first assistant reply after the entry read position', () => {
    expect(findFirstUnreadBotReplyClientId(messages, 5_000)).toBe('first-unread');
  });

  it('does not put NEW on an internal Bot-to-Bot message stamp', () => {
    const onlyInternal = messages.filter(
      (message) => message.clientId !== 'first-unread' && message.clientId !== 'later-unread',
    );
    expect(findFirstUnreadBotReplyClientId(onlyInternal, 5_000)).toBeNull();
  });

  it('does not create a divider without an entry boundary or a later reply', () => {
    expect(findFirstUnreadBotReplyClientId(messages, null)).toBeNull();
    expect(findFirstUnreadBotReplyClientId(messages, 9_000)).toBeNull();
  });
});
