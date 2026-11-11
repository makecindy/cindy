import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasExplicitChromeProxyRoutingArg } from '../_generated/extension/src/browser/browser-proxy-mode.js';
import { buildOpenClawChromeLaunchArgs } from '../_generated/extension/src/browser/chrome.js';
import {
  resolveBrowserConfig,
  resolveProfile,
} from '../_generated/extension/src/browser/config.js';

let testRoot: string;
beforeAll(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-chrome-launch-'));
});
afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function launchArgs(
  extraArgs: string[],
  headless = true,
  platform: NodeJS.Platform = 'linux',
  userDataDir = path.join(testRoot, 'empty'),
): string[] {
  const resolved = resolveBrowserConfig({
    enabled: true,
    defaultProfile: 'Cindy',
    headless,
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
    userDataDir,
    platform,
    env: { DISPLAY: ':99' },
  });
}

describe('managed Chrome proxy launch arguments', () => {
  it.each(['linux', 'win32'] as const)('starts headed %s Chrome without showing an empty startup window', (platform) => {
    const args = launchArgs([], false, platform);
    expect(args).toContain('--no-startup-window');
    expect(args).not.toContain('--silent-launch');
    expect(args).not.toContain('--headless=new');
  });

  // Regression: Chrome 156 on macOS accepts normal Quit but stays alive when
  // --no-startup-window is paired with CDP. Exercise the production launch-argv
  // contract: macOS must suppress startup UI without that automation keep-alive.
  // Explicitly select the same profile to avoid Chrome's deferred activation
  // of the first background tab after a restart with previously open windows.
  // The previous Linux-only matrix missed it; headed darwin is the minimal
  // failing input. Unit tier; real Quit/focus checks use an isolated Chrome.
  it('keeps macOS startup silent while allowing normal application Quit', () => {
    const args = launchArgs([], false, 'darwin');
    expect(args).toContain('--silent-launch');
    expect(args).toContain('--profile-directory=Default');
    expect(args).toContain('--remote-debugging-port=18800');
    expect(args).not.toContain('--no-startup-window');
    expect(args).not.toContain('--headless=new');
  });

  it('preserves the last-used managed Chrome profile when suppressing deferred activation', () => {
    const userDataDir = path.join(testRoot, 'last-used');
    fs.mkdirSync(userDataDir);
    fs.writeFileSync(path.join(userDataDir, 'Local State'), JSON.stringify({
      profile: { last_used: 'Profile 6' },
    }));
    const args = launchArgs([], false, 'darwin', userDataDir);
    expect(args).toContain('--profile-directory=Profile 6');
    expect(args).not.toContain('--profile-directory=Default');
  });

  it.each(['darwin', 'linux', 'win32'] as const)('keeps %s headless launches free of headed startup flags', (platform) => {
    const args = launchArgs([], true, platform);
    expect(args).toContain('--headless=new');
    expect(args).not.toContain('--no-startup-window');
    expect(args).not.toContain('--silent-launch');
  });

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
