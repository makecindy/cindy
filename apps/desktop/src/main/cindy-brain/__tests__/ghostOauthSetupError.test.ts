import { describe, expect, it } from 'vitest';

import { mapGhostOauthConnectError } from '../ghostOauthSetupError.js';

describe('mapGhostOauthConnectError', () => {
  it.each([
    ['CANCELLED', 'AUTH_CANCELLED'],
    ['NETWORK', 'AUTH_NETWORK'],
    ['SERVICE_UNAVAILABLE', 'AUTH_SERVICE_UNAVAILABLE'],
    ['EXCHANGE_FAILED', 'AUTH_FAILED'],
    ['INVALID_CONFIG', 'AUTH_FAILED'],
  ] as const)('%s → %s', (error, expected) => {
    expect(mapGhostOauthConnectError(error)).toBe(expected);
  });
});
