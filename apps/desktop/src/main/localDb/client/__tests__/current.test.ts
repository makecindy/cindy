import { describe, expect, it } from 'vitest';

import { isDbClientNotReadyError } from '../current.js';

describe('current DbClient readiness', () => {
  it.each([
    new Error('DbClient not ready'),
    new Error('localDb not ready: call ensureReady(userId) first'),
    { code: 'HOST_NOT_READY', message: 'database owner unavailable' },
  ])('classifies retryable database-owner gaps', (error) => {
    expect(isDbClientNotReadyError(error)).toBe(true);
  });

  it('keeps ordinary storage failures internal', () => {
    expect(isDbClientNotReadyError(new Error('storage read failed'))).toBe(false);
  });
});
