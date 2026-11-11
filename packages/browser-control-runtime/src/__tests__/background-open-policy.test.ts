import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchJson, send, withCdpSocket } = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  send: vi.fn(async (method: string, _params?: unknown) =>
    method === 'Target.createTarget' ? { targetId: 'created' } : {},
  ),
  withCdpSocket: vi.fn(),
}));

// Keep the real navigation and CDP endpoint guards. Only replace network IO.
vi.mock('../_generated/extension/src/browser/cdp.helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_generated/extension/src/browser/cdp.helpers.js')>()),
  fetchJson,
  withCdpSocket,
}));

import { createTargetViaCdp } from '../_generated/extension/src/browser/cdp.js';
import {
  resolveBrowserConfig,
  resolveProfile,
} from '../_generated/extension/src/browser/config.js';
import { createProfileTabOps } from '../_generated/extension/src/browser/server-context.tab-ops.js';
import type {
  BrowserServerState,
  ProfileRuntimeState,
} from '../_generated/extension/src/browser/server-context.types.js';

beforeEach(() => {
  vi.clearAllMocks();
  withCdpSocket.mockImplementation(async (_url, callback) => callback(send));
});

describe('background target navigation policy', () => {
  it('opens a permitted local page without applying the CDP control policy to its URL', async () => {
    const url = 'http://127.0.0.1:3000/';
    const resolved = resolveBrowserConfig({
      enabled: true,
      defaultProfile: 'Cindy',
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      profiles: { Cindy: { driver: 'openclaw', cdpPort: 18800, color: '#00D9C5' } },
    });
    const profile = resolveProfile(resolved, 'Cindy')!;
    const profileState: ProfileRuntimeState = { profile, running: null };
    const serverState: BrowserServerState = {
      port: 0,
      resolved,
      profiles: new Map([[profile.name, profileState]]),
    };
    fetchJson.mockImplementation(async (endpoint: string) =>
      endpoint.endsWith('/json/version')
        ? { webSocketDebuggerUrl: 'ws://127.0.0.1:18800/devtools/browser/test' }
        : [
            {
              id: 'created',
              type: 'page',
              url,
              webSocketDebuggerUrl: 'ws://127.0.0.1:18800/devtools/page/created',
            },
          ],
    );
    const tabs = createProfileTabOps({
      profile,
      state: () => serverState,
      getProfileState: () => profileState,
    });

    await expect(tabs.openTab(url, { background: true })).resolves.toMatchObject({
      targetId: 'created',
      url,
    });
    expect(send).toHaveBeenCalledWith('Target.createTarget', { url, background: true });
    expect(
      fetchJson.mock.calls.every(([endpoint]) => !String(endpoint).includes('/json/new')),
    ).toBe(true);
  });

  it('does not grant page navigation the control endpoint exemption', async () => {
    await expect(
      createTargetViaCdp({
        cdpUrl: 'ws://127.0.0.1:18800/devtools/browser/test',
        url: 'http://127.0.0.1:3000/',
        background: true,
        ssrfPolicy: { allowedHostnames: ['127.0.0.1'] },
        navigationPolicy: {},
      }),
    ).rejects.toThrow(/blocked/i);
    expect(withCdpSocket).not.toHaveBeenCalled();
  });

  it('keeps CDP endpoint restrictions when page navigation permits private networks', async () => {
    await expect(
      createTargetViaCdp({
        cdpUrl: 'ws://192.168.1.100:18800/devtools/browser/test',
        url: 'http://127.0.0.1:3000/',
        background: true,
        ssrfPolicy: { hostnameAllowlist: ['127.0.0.1'] },
        navigationPolicy: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } },
      }),
    ).rejects.toThrow(/blocked|allowlist/i);
    expect(withCdpSocket).not.toHaveBeenCalled();
  });

  it('preserves the explicit proxy HTTPS requirement', async () => {
    await expect(
      createTargetViaCdp({
        cdpUrl: 'ws://127.0.0.1:18800/devtools/browser/test',
        url: 'http://example.com/',
        background: true,
        navigationPolicy: {
          browserProxyMode: 'explicit-browser-proxy',
          ssrfPolicy: { hostnameAllowlist: ['example.com'] },
        },
      }),
    ).rejects.toThrow(/requires HTTPS/);
    expect(withCdpSocket).not.toHaveBeenCalled();
  });
});
