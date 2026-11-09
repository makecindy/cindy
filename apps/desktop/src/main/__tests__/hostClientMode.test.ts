import { afterEach, describe, expect, it } from 'vitest';

import { setHostClientMode } from '../host-client-mode';
import { ensureReady, getCurrentUserId, getRawDb } from '../localDb';

/**
 * Single writer per profile: the host holds the runtime and schema leases, so a
 * local open from the Electron client would race it.
 */
describe('localDb in host client mode', () => {
  afterEach(() => setHostClientMode(false));

  it('reports ready without opening a local SQLite database', async () => {
    setHostClientMode(true);
    const result = await ensureReady('owner-under-host');
    expect(result.ready).toBe(true);
    expect(() => getRawDb()).toThrow('localDb not ready');
    expect(getCurrentUserId()).toBe('owner-under-host');
  });

  it('rejects invalid userId even in client mode', async () => {
    setHostClientMode(true);
    const result = await ensureReady('');
    expect(result.ready).toBe(false);
  });
});
