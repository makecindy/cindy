import { describe, expect, it } from 'vitest';

import { resolveBrowserConfig } from '../_generated/extension/src/browser/config.js';
import { createBrowserControlRuntime } from '../index.js';
import { assertBrowserNavigationAllowed, assertBrowserNavigationResultAllowed } from '../_generated/extension/src/browser/navigation-guard.js';
import type { LookupFn } from '../_generated/leaf/src/infra/net/ssrf.js';

// Regression: the host-injected config must actually reach the vendored dispatcher.
// A shim bug (getRuntimeConfigSourceSnapshot returning a {config,source} wrapper
// instead of OpenClawConfig | null) silently shadowed the config, so the runtime
// fell back to the vendored DEFAULT profiles ("openclaw"/"user") and every
// host-set profile (name, color, ports) was ignored. This locks the fix in.
describe('host config application', () => {
  it.each([
    ['http://172.20.0.2:8010/form', '172.20.0.2'],
    ['http://intranet.internal/form', '10.0.0.2'],
    ['http://localhost/form', '127.0.0.1'],
    ['http://169.254.169.254/', '169.254.169.254'],
    ['http://[fd00::1]/', 'fd00::1'],
    ['http://[fe80::1]/', 'fe80::1'],
    ['http://proxy.example/form', '198.18.0.1'],
  ])('honors explicit private-network access for navigation and resulting URL: %s', async (url, address) => {
    const { ssrfPolicy } = resolveBrowserConfig({ ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } });
    const options = {
      url, ssrfPolicy,
      // The guard always uses lookup({ all: true }); the other DNS overloads
      // are not exercised by this in-memory resolver.
      lookupFn: (async () => [{ address, family: address.includes(':') ? 6 : 4 }]) as unknown as LookupFn,
    };
    await expect(assertBrowserNavigationAllowed(options)).resolves.toBeUndefined();
    await expect(assertBrowserNavigationResultAllowed(options)).resolves.toBeUndefined();
  });

  it('retains scheme validation and the restrictive default for other hosts', async () => {
    const allowed = resolveBrowserConfig({ ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } });
    await expect(assertBrowserNavigationAllowed({ url: 'file:///private/example', ssrfPolicy: allowed.ssrfPolicy }))
      .rejects.toThrow(/unsupported protocol/);
    await expect(assertBrowserNavigationAllowed({ url: 'http://172.20.0.2/', ssrfPolicy: resolveBrowserConfig(undefined).ssrfPolicy }))
      .rejects.toThrow(/Blocked/);
  });

  it('preserves narrow fake-IP SSRF allowances through vendored config resolution', () => {
    const resolved = resolveBrowserConfig({
      ssrfPolicy: {
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
      },
    });

    expect(resolved.ssrfPolicy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
    });
  });

  it('uses the host-set custom profile as default (not the vendored "openclaw")', async () => {
    const rt = createBrowserControlRuntime({
      config: {
        browser: {
          enabled: true,
          defaultProfile: 'XDMaker',
          headless: false,
          profiles: {
            // openclaw-driver = managed launch. A custom-named managed profile
            // must define its own cdpPort (the runtime only auto-assigns one to
            // its built-in default-named profile).
            XDMaker: { driver: 'openclaw', color: '#FF4500', cdpPort: 18800 },
          },
        },
      },
    });
    const res = await rt.call({ action: 'profiles' });
    expect(res.ok).toBe(true);
    const profiles = (res.data as { profiles: Array<{ name: string; isDefault: boolean }> }).profiles;
    const def = profiles.find((p) => p.isDefault);
    // The default profile is our host-set one, NOT the vendored "openclaw" default
    // (which the result sanitizer would surface as "browser runtime").
    expect(def?.name).toBe('XDMaker');
  });

  it('does NOT auto-inject the upstream "openclaw"/"user" profiles when the host provides its own', async () => {
    // LOCAL PATCH (sync.mjs → config.ts): upstream auto-adds an "openclaw" profile
    // (default CDP port 18800 — collides with the managed profile) and a "user"
    // attach-to-existing profile. With an explicit host profile, only it resolves,
    // so the agent can never select a colliding/foreign profile.
    const rt = createBrowserControlRuntime({
      config: {
        browser: {
          enabled: true,
          defaultProfile: 'XDMaker',
          headless: false,
          profiles: { XDMaker: { driver: 'openclaw', color: '#FF4500', cdpPort: 18800 } },
        },
      },
    });
    const res = await rt.call({ action: 'profiles' });
    expect(res.ok).toBe(true);
    const names = (res.data as { profiles: Array<{ name: string }> }).profiles.map((p) => p.name);
    expect(names).toEqual(['XDMaker']);
    expect(names).not.toContain('openclaw');
    expect(names).not.toContain('user');
  });
});
