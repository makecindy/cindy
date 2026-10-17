import { describe, expect, it } from 'vitest';

import { isHostManagedSession } from '@/session/hostManagedSession';

describe('host-managed Session presentation', () => {
  it('trusts the authoritative Session source instead of route metadata', () => {
    expect(isHostManagedSession({ source: 'bot' })).toBe(true);
    expect(isHostManagedSession({ source: 'desktop' })).toBe(false);
    expect(isHostManagedSession(null)).toBe(false);
  });
});
