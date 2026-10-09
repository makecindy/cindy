import { describe, expect, it } from 'vitest';
import { AuthRefreshBackoff } from '../authRefreshBackoff';

describe('runtime auth refresh backoff', () => {
  it('keeps an absolute deadline across two-second explicit calls and resumes at expiry', () => {
    let now = 1_000_000;
    const backoff = new AuthRefreshBackoff(() => now);
    expect(backoff.remaining(1)).toBe(0);
    expect(backoff.defer(1)).toBe(60_000);
    for (let elapsed = 2_000; elapsed < 60_000; elapsed += 2_000) {
      now = 1_000_000 + elapsed;
      expect(backoff.remaining(1)).toBe(60_000 - elapsed);
    }
    now = 1_060_000;
    expect(backoff.remaining(1)).toBe(0);
  });

  it('honors a longer server wait without applying the failed login generation to another account', () => {
    let now = 1_000_000;
    const backoff = new AuthRefreshBackoff(() => now);
    expect(backoff.defer(1, now + 120_000)).toBe(120_000);
    now += 60_000;
    expect(backoff.remaining(1)).toBe(60_000);
    expect(backoff.remaining(2)).toBe(0);
    backoff.defer(2);
    expect(backoff.remaining(1)).toBe(0);
    expect(backoff.remaining(2)).toBe(60_000);
  });

  it.each([undefined, 0, 999_999, Number.NaN, Number.POSITIVE_INFINITY])('retains the minimum wait for invalid or shorter deadline %s', retryAt => {
    const backoff = new AuthRefreshBackoff(() => 1_000_000);
    expect(backoff.defer(1, retryAt)).toBe(60_000);
  });

  it('clears the failed wait when a successful login or refresh schedules normal renewal', () => {
    const backoff = new AuthRefreshBackoff(() => 1_000_000);
    backoff.defer(1);
    backoff.clear();
    expect(backoff.remaining(1)).toBe(0);
  });
});
