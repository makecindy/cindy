import { afterEach, describe, expect, it } from 'vitest';

import { setHostClientMode } from '../host-client-mode';
import { ensureReady } from '../localDb';

/**
 * Single writer per profile: the host holds the runtime and schema leases, so a
 * local open from the Electron client would race it.
 */
describe('localDb in host client mode', () => {
  afterEach(() => setHostClientMode(false));

  it('refuses to open the profile database the host owns', async () => {
    setHostClientMode(true);
    const result = await ensureReady('owner-under-host');
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.error.message).toContain('cindy-host owns the profile database');
    }
  });
});
