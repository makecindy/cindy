import { describe, expect, it } from 'vitest';

import {
  botListSubtitle,
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
