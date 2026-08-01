import { describe, expect, it } from 'vitest';

import { hasAuthSessionIdentityChanged } from '../authSessionIdentity.js';

describe('hasAuthSessionIdentityChanged', () => {
  it('treats user or realm changes as an authentication boundary', () => {
    expect(
      hasAuthSessionIdentityChanged(
        { userId: 'user-a', realm: 'cn' },
        { userId: 'user-b', realm: 'cn' },
      ),
    ).toBe(true);
    expect(
      hasAuthSessionIdentityChanged(
        { userId: 'user-a', realm: 'cn' },
        { userId: 'user-a', realm: 'global' },
      ),
    ).toBe(true);
  });

  it('does not treat the first known identity or an unchanged identity as a switch', () => {
    expect(
      hasAuthSessionIdentityChanged(
        { userId: null, realm: null },
        { userId: 'user-a', realm: 'cn' },
      ),
    ).toBe(false);
    expect(
      hasAuthSessionIdentityChanged(
        { userId: 'user-a', realm: 'cn' },
        { userId: 'user-a', realm: 'cn' },
      ),
    ).toBe(false);
  });
});
