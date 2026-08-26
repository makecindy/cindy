import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractUsageLimitRecoveryHint } from '@/lib/usageLimitRecovery';

const NOW = Date.parse('2026-01-24T10:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

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
    ).toEqual({ resetAtMs: NOW + 75 * 60_000, isAccountUsageLimit: true });
  });

  it('extracts the organization plan and reset time from the Codex 429 payload', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          message:
            'API Error: Request rejected (429) · {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"business","resets_at":1788220709,"eligible_promo":null,"resets_in_seconds":1264528}}',
        },
        Date.parse('2026-08-17T00:00:00.000Z'),
      ),
    ).toEqual({
      resetAtMs: Date.parse('2026-08-31T23:58:29.000Z'),
      isAccountUsageLimit: true,
      planType: 'business',
    });
  });

  it('does not classify a transient Codex 429 as an account usage limit', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          errorStatus: 429,
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
          message: 'Too many requests',
        },
        NOW,
      ),
    ).toEqual({ resetAtMs: null });
  });

  it('parses the real Claude session-limit wording with a named timezone', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
          message: "You've hit your session limit · resets 9:10pm (Asia/Shanghai)",
        },
        NOW,
      ),
    ).toEqual({ resetAtMs: Date.parse('2026-01-24T13:10:00.000Z') });
  });

  it('normalizes Intl midnight hour 24 while parsing a time-of-day reset', () => {
    const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (
      this: Intl.DateTimeFormat,
      date,
    ) {
      return [
        ...originalFormatToParts
          .call(this, date)
          .map((part) =>
            part.type === 'hour' && part.value === '00' ? { ...part, value: '24' } : part,
          ),
        { type: 'weekday', value: 'not-a-number' },
      ];
    });

    expect(
      extractUsageLimitRecoveryHint(
        {
          sdkError: 'rate_limit',
          message: "You've hit your session limit · resets 12:00am (UTC)",
        },
        Date.parse('2026-01-24T23:00:00.000Z'),
      ),
    ).toEqual({ resetAtMs: Date.parse('2026-01-25T00:00:00.000Z') });
  });

  it('keeps weekly limits actionable without guessing an unsupported weekday reset time', () => {
    expect(
      extractUsageLimitRecoveryHint(
        {
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
