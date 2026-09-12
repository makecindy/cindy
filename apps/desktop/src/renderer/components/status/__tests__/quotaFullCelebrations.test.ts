import { afterEach, describe, expect, it } from 'vitest';
import { __testing as ownerTesting, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { QuotaFullCelebrations } from '../quotaFullCelebrations';

const slot = (remainingPercent: number, resetsAtMs: number | null = null, key = 'primary') => ({
  key,
  remainingPercent,
  resetsAtMs,
  resetPending: false,
});

afterEach(() => ownerTesting.reset());

describe('QuotaFullCelebrations', () => {
  it('celebrates first full observation, but not repeated task mounts or source changes', () => {
    const history = new QuotaFullCelebrations();
    expect(history.observe('openai', [slot(100)])).toBe('primary');
    expect(history.observe('openai', [])).toBeNull();
    expect(history.observe('openai', [slot(100, null, 'another-session-source')])).toBeNull();
    expect(history.observe('anthropic', [slot(100)])).toBe('primary');
  });

  it('isolates login owners while preserving history across same-owner generation changes', () => {
    setDataOwnerGeneration('owner-a', 1);
    const history = new QuotaFullCelebrations();
    expect(history.observe('openai', [slot(100)], 9000)).toBe('primary');
    setDataOwnerGeneration('owner-a', 2);
    expect(history.observe('openai', [slot(100)], 9001)).toBeNull();
    setDataOwnerGeneration('owner-b', 3);
    expect(history.observe('openai', [slot(100)], 1000)).toBe('primary');
    history.observe('openai', [slot(50)], 2000);
    expect(history.observe('openai', [slot(100)], 3000)).toBe('primary');
  });

  it('does not mistake switching model quota buckets for recovery', () => {
    const history = new QuotaFullCelebrations();
    history.observe('openai', [slot(50, null, 'bucket-a')], 1000);
    expect(history.observe('openai', [slot(100, null, 'bucket-b')], 2000)).toBe('bucket-b');
    history.observe('openai', [slot(50, null, 'bucket-a')], 3000);
    expect(history.observe('openai', [slot(100, null, 'bucket-b')], 4000)).toBeNull();
    expect(history.observe('openai', [slot(100, null, 'bucket-c')], 5000)).toBeNull();
    expect(history.observe('openai', [slot(100, null, 'bucket-a')], 6000)).toBe('bucket-a');
  });

  it('requires 100 and rearms after consumption without requiring a deadline', () => {
    const history = new QuotaFullCelebrations();
    expect(history.observe('openai', [slot(98)])).toBeNull();
    expect(history.observe('openai', [slot(100)])).toBe('primary');
    expect(history.observe('openai', [slot(99.9)])).toBeNull();
    expect(history.observe('openai', [slot(100)])).toBe('primary');
  });

  it('requires a drop before another burst, regardless of reset deadlines', () => {
    const history = new QuotaFullCelebrations();
    expect(history.observe('openai', [slot(100, 200)])).toBe('primary');
    expect(history.observe('openai', [slot(100, 300)])).toBeNull();
    expect(history.observe('openai', [slot(50, 100)])).toBeNull();
    expect(history.observe('openai', [slot(100, 100)])).toBe('primary');
    expect(history.observe('openai', [slot(100, 400)])).toBeNull();
    expect(history.observe('openai', [slot(80, 400)])).toBeNull();
    expect(history.observe('openai', [slot(100, 300)])).toBe('primary');
  });

  it.each([0, -1000])(
    'recognizes an extra reset with deadline offset %s and ignores stale task snapshots',
    (offset) => {
      const history = new QuotaFullCelebrations();
      const future = Date.now() + 60_000;
      expect(history.observe('openai', [slot(100, future)], 1000)).toBe('primary');
      expect(history.observe('openai', [slot(50, future)], 2000)).toBeNull();
      expect(history.observe('openai', [slot(100, future + offset)], 3000)).toBe('primary');
      expect(history.observe('openai', [slot(50, future)], 2000)).toBeNull();
      expect(history.observe('openai', [slot(100, future + offset)], 3000)).toBeNull();
      expect(history.observe('openai', [slot(100, future + offset)], 4000)).toBeNull();
      expect(history.observe('openai', [slot(30, future + offset)], 5000)).toBeNull();
      expect(history.observe('openai', [slot(100, future + offset)], 6000)).toBe('primary');
    },
  );

  it('does not rearm from unversioned or equal-timestamp data after a versioned full snapshot', () => {
    const history = new QuotaFullCelebrations();
    expect(history.observe('openai', [slot(100)], 1000)).toBe('primary');
    expect(history.observe('openai', [slot(20)], 1000)).toBeNull();
    expect(history.observe('openai', [slot(20)])).toBeNull();
    expect(history.observe('openai', [slot(100)], 2000)).toBeNull();
  });

  it('consumes simultaneous windows together and keeps independent windows armed', () => {
    const history = new QuotaFullCelebrations();
    expect(history.observe('openai', [slot(100), slot(100, null, 'weekly')])).toBe('primary');
    expect(history.observe('openai', [slot(100), slot(100, null, 'weekly')])).toBeNull();
    history.observe('openai', [slot(90), slot(100, null, 'weekly')]);
    expect(history.observe('openai', [slot(100), slot(100, null, 'weekly')])).toBe('primary');
  });

  it('does not replay full quota when a future deadline is corrected or windows reorder', () => {
    const history = new QuotaFullCelebrations();
    const future = Date.now() + 60_000;
    expect(history.observe('openai', [slot(100, future)])).toBe('primary');
    expect(history.observe('openai', [slot(100, future + 1000)])).toBeNull();
    history.observe('openai', [slot(80, future), slot(100, future, 'weekly')]);
    expect(history.observe('openai', [slot(100, future, 'weekly')])).toBeNull();
    expect(history.observe('another-device:openai', [slot(100, future)])).toBe('primary');
  });

  it('ignores pending and invalid values, and does not replay when deadline metadata arrives', () => {
    const history = new QuotaFullCelebrations();
    expect(history.observe('openai', [{ ...slot(100), resetPending: true }])).toBeNull();
    expect(history.observe('openai', [slot(NaN)])).toBeNull();
    expect(history.observe('openai', [slot(100)])).toBe('primary');
    expect(history.observe('openai', [slot(100, 200)])).toBeNull();
    expect(history.observe('openai', [slot(100, null)])).toBeNull();
    expect(history.observe('openai', [slot(100, 200)])).toBeNull();
  });
});
