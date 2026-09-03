/**
 * useRelativeTime — chat message-action-bar relative timestamps follow app language.
 */

// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatRelative, useRelativeTime } from '../useRelativeTime';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const JUST_NOW = 'chat.messageActionBar.relative.justNow';
const MINUTES = 'chat.messageActionBar.relative.minutesAgo';
const HOURS = 'chat.messageActionBar.relative.hoursAgo';
const DAYS = 'chat.messageActionBar.relative.daysAgo';

function tReturnsKey(key: string): string {
  return key;
}

function tZhCN(key: string, options?: Record<string, unknown>): string {
  const dict: Record<string, string> = {
    [JUST_NOW]: '刚刚',
    [MINUTES]: '{{count}} 分钟前',
    [HOURS]: '{{count}} 小时前',
    [DAYS]: '{{count}} 天前',
  };
  return (dict[key] ?? key).replace('{{count}}', String(options?.count ?? ''));
}

describe('formatRelative', () => {
  const now = new Date(2026, 4, 20, 12, 0, 0).getTime();

  it('falls back to English when t is missing or returns the key', () => {
    expect(formatRelative(now - 30_000, now)).toBe('just now');
    expect(formatRelative(now - 30_000, now, tReturnsKey)).toBe('just now');
    expect(formatRelative(now - 60_000, now, tReturnsKey)).toBe('1 minute ago');
    expect(formatRelative(now - 2 * 60_000, now, tReturnsKey)).toBe('2 minutes ago');
    expect(formatRelative(now - 60 * 60_000, now, tReturnsKey)).toBe('1 hour ago');
    expect(formatRelative(now - 24 * 60 * 60_000, now, tReturnsKey)).toBe('1 day ago');
    expect(formatRelative(now - 3 * 60 * 60_000, now, tReturnsKey)).toBe('3 hours ago');
    expect(formatRelative(now - 2 * 24 * 60 * 60_000, now, tReturnsKey)).toBe('2 days ago');
  });

  it('uses translated strings when t maps the four relative keys', () => {
    expect(formatRelative(now - 30_000, now, tZhCN)).toBe('刚刚');
    expect(formatRelative(now - 2 * 60_000, now, tZhCN)).toBe('2 分钟前');
    expect(formatRelative(now - 3 * 60 * 60_000, now, tZhCN)).toBe('3 小时前');
    expect(formatRelative(now - 2 * 24 * 60 * 60_000, now, tZhCN)).toBe('2 天前');
  });

  it('covers each delta bucket including numeric dates for older messages', () => {
    expect(formatRelative(now - 59_000, now, tReturnsKey)).toBe('just now');
    expect(formatRelative(now - 5 * 60_000, now, tReturnsKey)).toBe('5 minutes ago');
    expect(formatRelative(now - 23 * 60 * 60_000, now, tReturnsKey)).toBe('23 hours ago');
    expect(formatRelative(now - 6 * 24 * 60 * 60_000, now, tReturnsKey)).toBe('6 days ago');

    const sameYear = new Date(2026, 4, 10, 9, 5, 0).getTime();
    expect(formatRelative(sameYear, now, tReturnsKey)).toBe('05-10 09:05');

    const otherYear = new Date(2025, 11, 25, 14, 30, 0).getTime();
    expect(formatRelative(otherYear, now, tReturnsKey)).toBe('2025-12-25 14:30');
  });
});

describe('useRelativeTime', () => {
  it('clears stale text when the timestamp becomes missing or unparseable', () => {
    const now = new Date(2026, 4, 20, 12, 0, 0).getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const { result, rerender } = renderHook<
      string,
      { createdAt: string | undefined }
    >(
      ({ createdAt }) => useRelativeTime(createdAt, { hovered: false }),
      {
        initialProps: {
          createdAt: new Date(now - 5 * 60_000).toISOString(),
        },
      },
    );

    expect(result.current).toBe('5 minutes ago');

    rerender({ createdAt: undefined });
    expect(result.current).toBe('');

    rerender({ createdAt: 'not-a-date' });
    expect(result.current).toBe('');
  });
});
