import { describe, expect, it } from 'vitest';

import { ghostTokenBrokerInstallError } from '../ghostTokenBrokerInstallError.js';

describe('ghostTokenBrokerInstallError', () => {
  it('distinguishes manual import from the explicit Forge author path', () => {
    expect(ghostTokenBrokerInstallError()).toMatchObject({
      code: 'GHOST_BROKER_MANUAL_INSTALL_NOT_AUTHORIZED',
      reason: expect.stringContaining('手动装入'),
    });
    expect(ghostTokenBrokerInstallError().reason).toContain('ghost_forge_install');
  });
});
