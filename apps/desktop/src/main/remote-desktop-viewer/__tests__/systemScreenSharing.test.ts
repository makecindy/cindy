import type { RemoteDesktopCapabilities } from '@cindy/device-link';
import { beforeEach, expect, it, vi } from 'vitest';
import { shell } from 'electron';
import { probeTcp, supportsHighPerformance } from '../../remote-desktop/systemScreenSharing';
import { verifySystemScreenSharingHost } from '../../remote-desktop/systemScreenSharingProbe';

vi.mock('../../remote-desktop/systemScreenSharingProbe', async (original) => ({
  ...(await original<typeof import('../../remote-desktop/systemScreenSharingProbe')>()),
  verifySystemScreenSharingHost: vi.fn(),
}));

const settings = vi.hoisted(() => ({
  value: { enabled: true, mode: 'high' as 'high' | 'standard' },
  write: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { runningUnderARM64Translation: false },
  BrowserWindow: {},
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => 'owner',
  ownerScopedUserDataPath: (name: string) => name,
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../maker-host/override-settings-file', () => ({
  createOverrideSettingsFile: () => ({
    invalidateIfChanged: vi.fn(),
    read: () => settings.value,
    writePatchAtomic: settings.write,
  }),
}));
vi.mock('../../remote-desktop/systemScreenSharing', () => ({
  probeTcp: vi.fn(),
  SCREEN_SHARING_PORT: 5900,
  supportsHighPerformance: vi.fn(),
}));
import {
  openWithSystemScreenSharing,
  planSystemScreenSharing,
  systemScreenSharingUrl,
} from '../systemScreenSharing';

beforeEach(() => {
  vi.clearAllMocks();
  settings.value.mode = 'high';
  vi.mocked(probeTcp).mockResolvedValue(true);
  vi.mocked(supportsHighPerformance).mockReturnValue(true);
  vi.mocked(shell.openExternal).mockResolvedValue();
  vi.mocked(verifySystemScreenSharingHost).mockResolvedValue(true);
});

function expectDynamicConnection(host: string) {
  expect(shell.openExternal).toHaveBeenCalledWith(
    `vnc://alex@${host}?quality=high&numVirtualDisplays=1&scaled=dynamic`,
  );
}

it.each([true, false])('opens a VPN IP only after a successful peer proof: %s', async (valid) => {
  vi.mocked(verifySystemScreenSharingHost).mockResolvedValue(valid);
  const requestProbe = vi.fn(async (request) =>
    request.action === 'begin' ? { id: request.id } : null,
  );
  const result = await openWithSystemScreenSharing({
    caps: mac({
      listening: true,
      hosts: ['172.16.20.30'],
      user: 'alex',
      highPerformance: true,
      addressVerification: 1,
    }),
    current: () => true,
    requestProbe,
  });
  expect(result).toBe(valid ? 'opened' : 'fallback');
  if (valid) expectDynamicConnection('172.16.20.30');
  else {
    expect(probeTcp).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  }
  expect(requestProbe.mock.calls.map(([request]) => request.action)).toEqual(['begin', 'end']);
});

const mac = (systemScreenSharing: RemoteDesktopCapabilities['systemScreenSharing']) =>
  ({
    version: 1,
    enabled: true,
    canControl: true,
    platform: 'darwin',
    displays: [],
    systemScreenSharing,
  }) as RemoteDesktopCapabilities;
// Unit regression: matching private subnets can belong to different networks.
// Reported bare IPs must not redirect a saved login to an unrelated local Mac.
it('tries only the reported Bonjour name, never bare IP addresses', () => {
  const plan = planSystemScreenSharing(
    mac({
      listening: true,
      hosts: ['M3-Air.local', '10.0.0.8', '192.168.1.20', 'evil.example.com?x=1'],
      user: 'alex',
      highPerformance: true,
    }),
    true,
  );
  expect(plan).toEqual({
    ok: true,
    hosts: ['M3-Air.local'],
    user: 'alex',
    highPerformance: true,
  });
});

// Unit: the owner requested High Performance by default without a mode prompt.
// Prior tests only covered planning/URL helpers, not the actual launch behavior.
// Minimum input: two capable Macs, a reachable reported host and default settings.
// Regression: without `scaled=dynamic`, dynamic resolution is not turned on.
// Lock the external launch contract here; the real Apple parser is checked separately.
it('requests dynamic resolution in the High Performance URL without another prompt', async () => {
  const result = await openWithSystemScreenSharing({
    caps: mac({
      listening: true,
      hosts: ['Test-Mac.local'],
      user: 'alex',
      highPerformance: true,
    }),
    current: () => true,
  });
  expect(result).toBe('opened');
  expectDynamicConnection('Test-Mac.local');
  expect(settings.write).not.toHaveBeenCalled();
});

// Unit: an OS launch failure must retain the existing Cindy viewer fallback.
it('falls back when Apple cannot be launched', async () => {
  vi.mocked(shell.openExternal).mockRejectedValueOnce(new Error('failed'));
  expect(
    await openWithSystemScreenSharing({
      caps: mac({
        listening: true,
        hosts: ['Test-Mac.local'],
        user: 'alex',
        highPerformance: true,
      }),
      current: () => true,
    }),
  ).toBe('fallback');
});

it.each([
  { localHigh: false, remoteHigh: true, mode: 'high' as const },
  { localHigh: true, remoteHigh: false, mode: 'high' as const },
  { localHigh: true, remoteHigh: true, mode: 'standard' as const },
])(
  'uses Standard for unsupported Macs or an explicit override: %j',
  async ({ localHigh, remoteHigh, mode }) => {
    vi.mocked(supportsHighPerformance).mockReturnValue(localHigh);
    settings.value.mode = mode;
    expect(
      await openWithSystemScreenSharing({
        caps: mac({
          listening: true,
          hosts: ['Test-Mac.local'],
          user: 'alex',
          highPerformance: remoteHigh,
        }),
        current: () => true,
      }),
    ).toBe('opened');
    expect(shell.openExternal).toHaveBeenCalledWith(
      'vnc://alex@Test-Mac.local?quality=adaptive&numVirtualDisplays=0',
    );
    expect(settings.write).not.toHaveBeenCalled();
  },
);

it.each([
  { reachable: false, current: true, outcome: 'fallback' },
  { reachable: true, current: false, outcome: 'cancelled' },
])(
  'does not open Screen Sharing when the peer is unreachable or the request is stale: %j',
  async ({ reachable, current, outcome }) => {
    vi.mocked(probeTcp).mockResolvedValue(reachable);
    expect(
      await openWithSystemScreenSharing({
        caps: mac({
          listening: true,
          hosts: ['Test-Mac.local'],
          user: 'alex',
          highPerformance: true,
        }),
        current: () => current,
      }),
    ).toBe(outcome);
    expect(shell.openExternal).not.toHaveBeenCalled();
  },
);

// Unit: every case that cannot connect directly falls back to Cindy's viewer.
it('falls back for older hosts, non-Macs, sharing turned off and other networks', () => {
  const reachable = { listening: true, hosts: ['10.0.0.8'], user: 'v', highPerformance: true };
  expect(planSystemScreenSharing(mac(undefined), true)).toMatchObject({
    reason: 'not-reported',
  });
  expect(planSystemScreenSharing({ ...mac(reachable), platform: 'win32' }, true)).toMatchObject({
    reason: 'not-mac',
  });
  expect(planSystemScreenSharing(mac({ ...reachable, listening: false }), true)).toMatchObject({
    reason: 'not-listening',
  });
  expect(planSystemScreenSharing(mac(reachable), true)).toMatchObject({
    reason: 'no-address',
  });
});

// Unit: High Performance needs both Macs; the URL carries the login name, never a password.
it('selects High Performance only when both ends support it and builds the Screen Sharing URL', () => {
  const info = { listening: true, hosts: ['M3-Air.local'], user: 'a b', highPerformance: true };
  expect(planSystemScreenSharing(mac(info), false)).toMatchObject({
    highPerformance: false,
    user: null,
  });
  expect(systemScreenSharingUrl('M3-Air.local', 'alex', 'high')).toBe(
    'vnc://alex@M3-Air.local?quality=high&numVirtualDisplays=1&scaled=dynamic',
  );
  expect(systemScreenSharingUrl('192.168.1.20', null, 'standard')).toBe(
    'vnc://192.168.1.20?quality=adaptive&numVirtualDisplays=0',
  );
});
