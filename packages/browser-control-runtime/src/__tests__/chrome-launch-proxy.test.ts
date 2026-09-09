import { describe, expect, it } from 'vitest';

import { hasExplicitChromeProxyRoutingArg } from '../_generated/extension/src/browser/browser-proxy-mode.js';
import { buildOpenClawChromeLaunchArgs } from '../_generated/extension/src/browser/chrome.js';
import {
  resolveBrowserConfig,
  resolveProfile,
} from '../_generated/extension/src/browser/config.js';

function launchArgs(extraArgs: string[]): string[] {
  const resolved = resolveBrowserConfig({
    enabled: true,
    defaultProfile: 'Cindy',
    headless: true,
    extraArgs,
    profiles: {
      Cindy: { driver: 'openclaw', cdpPort: 18800, color: '#00D9C5' },
    },
  });
  const profile = resolveProfile(resolved, 'Cindy');
  if (!profile) throw new Error('test profile did not resolve');
  return buildOpenClawChromeLaunchArgs({
    resolved,
    profile,
    userDataDir: '/tmp/cindy-browser-proxy-test',
    platform: 'linux',
    env: { DISPLAY: ':99' },
  });
}

describe('managed Chrome proxy launch arguments', () => {
  it('retains explicit direct mode', () => {
    const args = launchArgs([]);
    expect(args).toContain('--no-proxy-server');
    expect(args.some((arg) => arg.startsWith('--proxy-server'))).toBe(false);
  });

  it('treats a PAC-only launch as the explicit proxy route', () => {
    // The host emits only `--proxy-pac-url` for a proxied start (Chromium
    // ignores `--proxy-server` next to a PAC). That single flag must be enough
    // to suppress the direct-mode default and to count as explicit routing
    // for the navigation guard's proxy-mode detection.
    const pacArg = 'data:application/x-ns-proxy-autoconfig;base64,ZnVuY3Rpb24gRmluZFByb3h5Rm9yVVJMKCl7fQ==';
    const args = launchArgs([`--proxy-pac-url=${pacArg}`]);
    expect(args).not.toContain('--no-proxy-server');
    expect(args.some((arg) => arg.startsWith('--proxy-server'))).toBe(false);
    expect(args.filter((arg) => arg.startsWith('--proxy-pac-url'))).toEqual([
      `--proxy-pac-url=${pacArg}`,
    ]);
    expect(hasExplicitChromeProxyRoutingArg([`--proxy-pac-url=${pacArg}`])).toBe(true);
  });
});
