import { describe, expect, it } from 'vitest';

import { ghostTokenBrokerInstallError } from '../ghostTokenBrokerInstallError.js';

describe('ghostTokenBrokerInstallError', () => {
  it('returns the actionable local-install authorization error', () => {
    expect(ghostTokenBrokerInstallError()).toMatchObject({
      code: 'GHOST_BROKER_MANUAL_INSTALL_NOT_AUTHORIZED',
      reason: expect.stringContaining('本地装入'),
    });
  });
});
