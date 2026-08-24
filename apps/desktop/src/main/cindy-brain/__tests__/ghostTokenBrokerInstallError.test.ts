import { describe, expect, it } from 'vitest';

import { ghostTokenBrokerInstallError } from '../ghostTokenBrokerInstallError.js';

describe('ghostTokenBrokerInstallError', () => {
  it('keeps manual install and unknown runtime facts on distinct actionable codes', () => {
    expect(ghostTokenBrokerInstallError('manual')).toMatchObject({
      code: 'GHOST_BROKER_MANUAL_INSTALL_NOT_AUTHORIZED',
      reason: expect.stringContaining('手动装入'),
    });
    expect(ghostTokenBrokerInstallError('agent-forge')).toMatchObject({
      code: 'GHOST_BROKER_NOT_AUTHORIZED',
      reason: expect.stringContaining('组织身份'),
    });
    expect(ghostTokenBrokerInstallError()).toMatchObject({
      code: 'GHOST_BROKER_NOT_AUTHORIZED',
    });
    // Distinct literal codes prevent Renderer copy from guessing the reason
    // from Main's localized message or remapping all GHOST_FILE_INVALID errors.
    expect(ghostTokenBrokerInstallError('manual').code).not.toBe(
      ghostTokenBrokerInstallError().code,
    );
  });
});
