import { describe, expect, it } from 'vitest';

import { createAccountDiscoveryReloadTracker } from '../accountDiscoveryReload.js';

describe('account discovery reload tracker', () => {
  it('does not treat the first authenticated startup snapshot as a refill boundary', () => {
    const tracker = createAccountDiscoveryReloadTracker();

    expect(tracker.noteAuthState({ isAuthenticated: true, identityChanged: false })).toBe(false);
  });

  it('refills after a real sign-out even when the same identity signs back in', () => {
    const tracker = createAccountDiscoveryReloadTracker();

    expect(tracker.noteAuthState({ isAuthenticated: false, identityChanged: false })).toBe(false);
    expect(tracker.noteAuthState({ isAuthenticated: true, identityChanged: false })).toBe(true);
    expect(tracker.noteAuthState({ isAuthenticated: true, identityChanged: false })).toBe(false);
  });

  it('refills on a direct account or realm change', () => {
    const tracker = createAccountDiscoveryReloadTracker();

    expect(tracker.noteAuthState({ isAuthenticated: true, identityChanged: true })).toBe(true);
  });
});
