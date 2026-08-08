import { describe, expect, it } from 'vitest';

import { formatRunningTokenUsage } from '@/features/cc-agent/lib/runningTokenUsage';

describe('formatRunningTokenUsage', () => {
  it('marks zero usage as pending while a turn is running', () => {
    expect(formatRunningTokenUsage(0, true)).toBe('— tokens');
  });

  it('keeps authoritative completed and positive usage values', () => {
    expect(formatRunningTokenUsage(0, false)).toBe('0 tokens');
    expect(formatRunningTokenUsage(999, true)).toBe('999 tokens');
    expect(formatRunningTokenUsage(1250, true)).toBe('1.3k tokens');
  });
});
