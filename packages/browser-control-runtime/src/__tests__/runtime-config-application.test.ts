import { describe, expect, it } from 'vitest';

import { createBrowserControlRuntime } from '../index.js';

// Regression: the host-injected config must actually reach the vendored dispatcher.
// A shim bug (getRuntimeConfigSourceSnapshot returning a {config,source} wrapper
// instead of OpenClawConfig | null) silently shadowed the config, so the runtime
// fell back to the vendored DEFAULT profiles ("openclaw"/"user") and every
// host-set profile (name, color, ports) was ignored. This locks the fix in.
describe('host config application', () => {
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
