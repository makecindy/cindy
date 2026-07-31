import { describe, expect, it } from 'vitest';

import { extractUsageLimitRecoveryHint } from '@/lib/usageLimitRecovery';

const NOW = Date.parse('2026-01-24T10:00:00.000Z');

describe('usage limit recovery detection', () => {
  it('uses Claude structured rate-limit data and a structured reset timestamp', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          sdkError: 'rate_limit',
          message: 'Rate limit reached',
          resetAt: '2026-01-24T12:30:00.000Z',
        },
        NOW,
      ),
    ).toEqual({ resetAtMs: Date.parse('2026-01-24T12:30:00.000Z') });
  });

  it('recognizes Codex usage-limit signals and relative retry times', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          codexErrorInfo: 'usageLimitExceeded',
          message: 'Usage limit reached. Try again in 1h 15m.',
        },
        NOW,
      ),
    ).toEqual({ resetAtMs: NOW + 75 * 60_000 });
  });

  it('parses the real Claude session-limit wording with a named timezone', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          sdkError: 'rate_limit',
          message: "You've hit your session limit · resets 9:10pm (Asia/Shanghai)",
        },
        NOW,
      ),
    ).toEqual({ resetAtMs: Date.parse('2026-01-24T13:10:00.000Z') });
  });

  it('keeps weekly limits actionable without guessing an unsupported weekday reset time', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          sdkError: 'rate_limit',
          message: "You've hit your weekly limit · resets Mon 12:00am (Asia/Shanghai)",
        },
        NOW,
      ),
    ).toEqual({ resetAtMs: null });
  });

  it('keeps a restorable limit actionable when the reset time is unknown', () => {
    expect(
      extractUsageLimitRecoveryHint({ errorStatus: 429, message: 'Too many requests' }, NOW),
    ).toEqual({ resetAtMs: null });
  });

  it('excludes billing depletion and temporary upstream overload', () => {
    expect(
      extractUsageLimitRecoveryHint(
        { sdkError: 'billing_error', message: 'Credit balance too low' },
        NOW,
      ),
    ).toBeNull();
    expect(
      extractUsageLimitRecoveryHint(
        {
          errorStatus: 529,
          codexErrorInfo: 'serverOverloaded',
          message: 'Selected model is at capacity',
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      extractUsageLimitRecoveryHint({ message: 'insufficient_quota: add billing credits' }, NOW),
    ).toBeNull();
  });
});
