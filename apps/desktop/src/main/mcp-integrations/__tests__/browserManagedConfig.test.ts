import { describe, expect, it } from 'vitest';

import { buildManagedConfig } from '../browser-managed-config.js';

describe('managed browser runtime config', () => {
  it('allows only proxy fake-IP ranges without disabling private-network protection', () => {
    expect(buildManagedConfig().browser?.ssrfPolicy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
    });
  });

  it('adds nothing when no local preview is running', () => {
    expect(buildManagedConfig({ previewOrigins: [] }).browser?.ssrfPolicy).not.toHaveProperty(
      'allowedOrigins',
    );
  });

  it('trusts exactly the running preview origin, and nothing broader', () => {
    const policy = buildManagedConfig({
      previewOrigins: ['http://127.0.0.1:54321'],
    }).browser?.ssrfPolicy;
    expect(policy?.allowedOrigins).toEqual(['http://127.0.0.1:54321']);
    // The grant must stay origin-scoped: a hostname-level allowance would
    // extend to every port on loopback, including the managed browser's own
    // CDP port. See preview-origin-navigation.test.ts in the runtime package
    // for the matching assertion on the navigation guard side.
    expect(policy).not.toHaveProperty('allowedHostnames');
    expect(policy?.dangerouslyAllowPrivateNetwork).toBeUndefined();
  });
});
