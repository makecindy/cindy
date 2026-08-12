import { describe, expect, it } from 'vitest';

import {
  parseTerminalRateLimitRetryProgress,
  TERMINAL_RATE_LIMIT_RETRY_REASON,
} from '@/utils/rateLimitRetry';

describe('parseTerminalRateLimitRetryProgress', () => {
  it('requires the dedicated reason and marker', () => {
    const message =
      'exceeded retry limit, last status: 429 Too Many Requests (rate-limit-retry 1/2)';
    expect(parseTerminalRateLimitRetryProgress(message, TERMINAL_RATE_LIMIT_RETRY_REASON)).toEqual({
      attempt: 1,
      maxAttempts: 2,
    });
    expect(parseTerminalRateLimitRetryProgress(message, undefined)).toBeNull();
    expect(
      parseTerminalRateLimitRetryProgress(
        'Selected model is at capacity (auto-retry 1/4)',
        TERMINAL_RATE_LIMIT_RETRY_REASON,
      ),
    ).toBeNull();
  });

  it.each([
    'provider failed (rate-limit-retry 0/2)',
    'provider failed (rate-limit-retry 3/2)',
    'provider failed (rate-limit-retry 1/2) trailing text',
  ])('rejects an invalid progress marker: %s', (message) => {
    expect(
      parseTerminalRateLimitRetryProgress(message, TERMINAL_RATE_LIMIT_RETRY_REASON),
    ).toBeNull();
  });
});
