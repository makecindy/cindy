import { describe, expect, it } from 'vitest';

import { normalizePersistedState, pruneReusePool } from '../store.js';

describe('desktop companion store', () => {
  it('defaults missing state to disabled', () => {
    const state = normalizePersistedState(null);
    expect(state.settings.enabled).toBe(false);
    expect(state.settings.locationEnabled).toBe(false);
    expect(state.reusePool).toEqual([]);
  });

  it('drops expired or missing reuse items', () => {
    const pool = pruneReusePool(
      [
        { fingerprint: 'a', stillPath: '/tmp/a.jpg', videoPath: null, topic: 'a', expiresAt: 10 },
        { fingerprint: 'b', stillPath: '/tmp/b.jpg', videoPath: null, topic: 'b', expiresAt: 30 },
      ],
      20,
      (filePath) => filePath.endsWith('b.jpg'),
    );
    expect(pool).toEqual([
      { fingerprint: 'b', stillPath: '/tmp/b.jpg', videoPath: null, topic: 'b', expiresAt: 30 },
    ]);
  });
});
