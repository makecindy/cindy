import { describe, expect, it } from 'vitest';

import {
  botListSubtitle,
  botListTimestampAt,
  formatBotListTimestamp,
  formatBotUnreadBadge,
} from '../botListDisplay';

describe('Bots list timestamp', () => {
  const now = new Date(2026, 7, 17, 14, 5, 0).getTime();

  it('shows the clock for today and the date for anything older', () => {
    expect(formatBotListTimestamp(new Date(2026, 7, 17, 9, 7, 0).getTime(), now)).toBe('09:07');
    expect(formatBotListTimestamp(new Date(2026, 7, 17, 23, 59, 0).getTime(), now)).toBe('23:59');
    expect(formatBotListTimestamp(new Date(2026, 7, 16, 23, 59, 0).getTime(), now)).toBe('8/16');
    expect(formatBotListTimestamp(new Date(2025, 11, 3, 8, 0, 0).getTime(), now)).toBe('12/3');
  });

  it('renders nothing when the Bot has no message yet', () => {
    expect(formatBotListTimestamp(null, now)).toBe('');
    expect(formatBotListTimestamp(undefined, now)).toBe('');
    expect(formatBotListTimestamp(0, now)).toBe('');
  });
});

describe('Bots list unread badge', () => {
  it('prints the exact count up to 99 and truncates above it', () => {
    expect(formatBotUnreadBadge(1)).toBe('1');
    expect(formatBotUnreadBadge(99)).toBe('99');
    expect(formatBotUnreadBadge(100)).toBe('99+');
  });
});

describe('Bots list subtitle fallback chain', () => {
  it('prefers the latest message, collapsed to one line', () => {
    expect(
      botListSubtitle({
        lastMessagePreview: '  帮我看看  \n 这个 PR ',
        description: 'PR steward',
      }),
    ).toEqual({ kind: 'message', text: '帮我看看 这个 PR' });
  });

  it('falls back to the description, then to the start-chat prompt', () => {
    expect(botListSubtitle({ lastMessagePreview: '', description: 'PR steward' })).toEqual({
      kind: 'description',
      text: 'PR steward',
    });
    expect(botListSubtitle({ lastMessagePreview: null, description: '   ' })).toEqual({
      kind: 'placeholder',
      text: '',
    });
    expect(botListSubtitle({})).toEqual({ kind: 'placeholder', text: '' });
  });
});

/**
 * 行时间要包含「正在干活」这件事。
 *
 * 委派与定时任务跑起来不产生消息,只看 lastMessageAt 的话,一个接了 20 分钟活的
 * 伙伴在列表里显示成「20 分钟前」——看着像闲着,而第二行同时写着「正在输入…」,
 * 两者自相矛盾。判据同 Hermes 名单行的 rowAgeTs(#90268)。
 */
describe('botListTimestampAt', () => {
  const NOW = new Date('2026-08-24T14:30:00').getTime();
  const TWENTY_MIN_AGO = NOW - 20 * 60 * 1000;

  it('正在干活时取此刻,不是上一条消息的时刻', () => {
    expect(botListTimestampAt({ lastMessageAt: TWENTY_MIN_AGO, working: true }, NOW)).toBe(NOW);
  });

  it('活干完就落回最后一条消息的时刻,不留痕', () => {
    expect(botListTimestampAt({ lastMessageAt: TWENTY_MIN_AGO, working: false }, NOW)).toBe(
      TWENTY_MIN_AGO,
    );
  });

  it('从没说过话但正在干活的伙伴也有时间可显示', () => {
    expect(botListTimestampAt({ lastMessageAt: null, working: true }, NOW)).toBe(NOW);
  });

  it('既没说过话也没在干活时不编造时间', () => {
    expect(botListTimestampAt({ lastMessageAt: null, working: false }, NOW)).toBeNull();
    expect(botListTimestampAt({}, NOW)).toBeNull();
  });
});
