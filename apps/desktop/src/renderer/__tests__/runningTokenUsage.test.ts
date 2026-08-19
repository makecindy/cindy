import { describe, expect, it } from 'vitest';

import { formatRunningTokenCount } from '@/features/cc-agent/lib/runningTokenUsage';

describe('formatRunningTokenCount', () => {
  it('marks zero usage as pending while a turn is running', () => {
    expect(formatRunningTokenCount(0, true)).toBe('—');
  });

  it('keeps authoritative completed and positive usage values', () => {
    expect(formatRunningTokenCount(0, false)).toBe('0');
    expect(formatRunningTokenCount(999, true)).toBe('999');
    expect(formatRunningTokenCount(1250, true)).toBe('1.3k');
  });
});
