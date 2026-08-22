import { describe, expect, it } from 'vitest';

import { buildManagedConfig } from '../browser-managed-config.js';

describe('managed browser runtime config', () => {
  it('allows proxy fake-IP ranges and localhost without disabling private-network protection', () => {
    expect(buildManagedConfig().browser?.ssrfPolicy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      allowedHostnames: ['localhost'],
    });
  });
});
