import { describe, expect, it } from 'vitest';

import {
  formatTerminalRateLimitRetryMessage,
  isTerminalRateLimitRetryExhaustion,
  parseTerminalRateLimitRetryProgress,
  TERMINAL_RATE_LIMIT_RETRY_REASON,
  terminalRateLimitRetryDelayMs,
} from './terminal-rate-limit-retry.js';

describe('terminal rate-limit retry', () => {
  it('recognizes structured exhausted retries whose final response is 429', () => {
    expect(
      isTerminalRateLimitRetryExhaustion(
        'provider retries exhausted',
        undefined,
        { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      ),
    ).toBe(true);
    expect(
      isTerminalRateLimitRetryExhaustion(
        'retry budget exhausted',
        undefined,
        { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      ),
    ).toBe(true);
    expect(
      isTerminalRateLimitRetryExhaustion(
        'exceeded retry limit, retry budget exceeded, last status: 429',
        undefined,
        { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      ),
    ).toBe(true);
  });

  it('recognizes the legacy text fallback only when it also carries status 429', () => {
    expect(
      isTerminalRateLimitRetryExhaustion(
        'exceeded retry limit, last status: 429 Too Many Requests',
        429,
        undefined,
      ),
    ).toBe(true);
    expect(
      isTerminalRateLimitRetryExhaustion(
        'exceeded retry limit, last status: 503 Service Unavailable',
        undefined,
        undefined,
      ),
    ).toBe(false);
    expect(
      isTerminalRateLimitRetryExhaustion(
        'exceeded retry limit, retry budget exhausted, last status: 429',
        429,
        undefined,
      ),
    ).toBe(true);
  });

  it('does not short-retry account usage limits', () => {
    expect(
      isTerminalRateLimitRetryExhaustion(
        'exceeded retry limit, last status: 429 Too Many Requests',
        429,
        'usageLimitExceeded',
      ),
    ).toBe(false);
    expect(
      isTerminalRateLimitRetryExhaustion(
        'exceeded retry limit, last status: 429 Too Many Requests',
        429,
        'sessionBudgetExceeded',
      ),
    ).toBe(false);
    expect(
      isTerminalRateLimitRetryExhaustion(
        'exceeded retry limit, quota exhausted, status: 429',
        429,
        undefined,
      ),
    ).toBe(false);
    expect(
      isTerminalRateLimitRetryExhaustion(
        'exceeded retry limit, last status: 429: You exceeded your current quota',
        429,
        undefined,
      ),
    ).toBe(false);
    expect(
      isTerminalRateLimitRetryExhaustion(
        'exceeded retry limit, last status: 429: Your quota has been exceeded',
        429,
        undefined,
      ),
    ).toBe(false);
    expect(
      isTerminalRateLimitRetryExhaustion(
        'exceeded retry limit, last status: 429: insufficient credit balance',
        429,
        undefined,
      ),
    ).toBe(false);
    expect(
      isTerminalRateLimitRetryExhaustion(
        'exceeded retry limit, last status: 429: ExceededBudget',
        429,
        undefined,
      ),
    ).toBe(false);
  });

  it('does not retry a plain terminal 429 or a non-429 exhausted response', () => {
    expect(
      isTerminalRateLimitRetryExhaustion(
        'HTTP status: 429 Too Many Requests',
        429,
        undefined,
      ),
    ).toBe(false);
    expect(
      isTerminalRateLimitRetryExhaustion(
        'provider retries exhausted',
        undefined,
        { responseTooManyFailedAttempts: { httpStatusCode: 500 } },
      ),
    ).toBe(false);
  });

  it('uses bounded jittered 15s and 30s delays', () => {
    expect(terminalRateLimitRetryDelayMs(1, () => 0.5)).toBe(15_000);
    expect(terminalRateLimitRetryDelayMs(2, () => 0.5)).toBe(30_000);
    expect(terminalRateLimitRetryDelayMs(2, () => 0)).toBe(22_500);
    expect(terminalRateLimitRetryDelayMs(2, () => 0.999999)).toBe(30_000);
  });

  it('uses a dedicated reason and progress marker instead of the overload contract', () => {
    expect(TERMINAL_RATE_LIMIT_RETRY_REASON).toBe('terminal-rate-limit-retry');
    expect(
      formatTerminalRateLimitRetryMessage(
        'exceeded retry limit, last status: 429 Too Many Requests',
        1,
        2,
      ),
    ).toBe(
      'exceeded retry limit, last status: 429 Too Many Requests (rate-limit-retry 1/2)',
    );
    expect(
      parseTerminalRateLimitRetryProgress(
        'exceeded retry limit, last status: 429 Too Many Requests (rate-limit-retry 1/2)',
        TERMINAL_RATE_LIMIT_RETRY_REASON,
      ),
    ).toEqual({ attempt: 1, maxAttempts: 2 });
  });

  it.each([
    ['provider failed (rate-limit-retry 1/2)', 'other-reason'],
    ['provider failed', TERMINAL_RATE_LIMIT_RETRY_REASON],
    ['provider failed (rate-limit-retry 0/2)', TERMINAL_RATE_LIMIT_RETRY_REASON],
    ['provider failed (rate-limit-retry 3/2)', TERMINAL_RATE_LIMIT_RETRY_REASON],
    ['provider failed (rate-limit-retry 1/2) trailing', TERMINAL_RATE_LIMIT_RETRY_REASON],
  ])('rejects malformed or mismatched progress: %s', (message, reason) => {
    expect(parseTerminalRateLimitRetryProgress(message, reason)).toBeNull();
  });
});
