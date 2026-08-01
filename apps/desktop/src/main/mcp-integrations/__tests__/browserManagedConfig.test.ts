import { describe, expect, it } from 'vitest';

import { buildManagedConfig } from '../browser-managed-config.js';

describe('managed browser runtime config', () => {
  it('allows private-network destinations so proxy fake-IP DNS is not blocked', () => {
    expect(buildManagedConfig().browser?.ssrfPolicy).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
  });
});
