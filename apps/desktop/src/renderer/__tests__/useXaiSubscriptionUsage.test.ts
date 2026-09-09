import { describe, expect, it } from 'vitest';

import {
  reduceXaiSubscriptionPush,
  resolvePersistedXaiSubscriptionRead,
  shouldApplyXaiSubscriptionRead,
} from '../hooks/useXaiSubscriptionUsage';

describe('useXaiSubscriptionUsage reducers', () => {
  it('clears on null and applies snapshots', () => {
    const prev = { planLabel: 'SuperGrok Heavy', creditUsagePercent: 2 };
    expect(reduceXaiSubscriptionPush(prev, null)).toBeNull();
    expect(reduceXaiSubscriptionPush(prev, { planLabel: 'SuperGrok' })).toEqual({
      planLabel: 'SuperGrok',
    });
    expect(reduceXaiSubscriptionPush(prev, 'nope')).toBe(prev);
  });

  it('resolves persisted IPC reads', () => {
    expect(resolvePersistedXaiSubscriptionRead(null)).toEqual({ action: 'clear' });
    expect(resolvePersistedXaiSubscriptionRead({ planLabel: 'SuperGrok Heavy' })).toEqual({
      action: 'apply',
      snapshot: { planLabel: 'SuperGrok Heavy' },
    });
    expect(resolvePersistedXaiSubscriptionRead('x')).toEqual({ action: 'ignore' });
  });

  it('ignores a late IPC read after a newer push', () => {
    expect(shouldApplyXaiSubscriptionRead(3, 3)).toBe(true);
    expect(shouldApplyXaiSubscriptionRead(3, 4)).toBe(false);
  });
});
