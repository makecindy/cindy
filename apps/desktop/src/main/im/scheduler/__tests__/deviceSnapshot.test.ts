import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClientEndpoint: vi.fn(() => 'https://device-link.example'),
  serverApiFetch: vi.fn(),
}));

vi.mock('../../../clientEndpointsService', () => ({
  getClientEndpoint: mocks.getClientEndpoint,
}));

vi.mock('../../../serverApiClient', () => ({
  serverApiFetch: mocks.serverApiFetch,
}));

import { fetchSchedulerDesktopDeviceSnapshot } from '../deviceSnapshot';

beforeEach(() => {
  mocks.getClientEndpoint.mockClear();
  mocks.serverApiFetch.mockReset();
});

describe('Discord scheduler account device snapshot', () => {
  it('returns the online self Desktop and every other online Desktop', async () => {
    mocks.serverApiFetch.mockResolvedValue({
      devices: [
        { deviceId: 'self', platform: 'darwin', online: true, isSelf: true },
        { deviceId: 'peer-win', platform: 'win32', online: true, isSelf: false },
        { deviceId: 'peer-linux', platform: 'linux', online: true, isSelf: false },
        { deviceId: 'offline', platform: 'darwin', online: false, isSelf: false },
        { deviceId: 'mobile', platform: 'ios', online: true, isSelf: false },
        { deviceId: 'unknown', platform: null, online: true, isSelf: false },
      ],
    });

    await expect(fetchSchedulerDesktopDeviceSnapshot()).resolves.toEqual({
      selfDeviceId: 'self',
      peers: [
        { deviceId: 'peer-win', platform: 'win32' },
        { deviceId: 'peer-linux', platform: 'linux' },
      ],
    });
    expect(mocks.serverApiFetch).toHaveBeenCalledWith('/api/device-link/devices', {
      baseUrl: expect.any(Function),
      cache: 'no-store',
      timeoutMs: 5_000,
      logLabel: '/api/device-link/devices',
    });
  });

  it('rejects a snapshot that does not prove this Desktop is online', async () => {
    mocks.serverApiFetch.mockResolvedValue({
      devices: [
        { deviceId: 'peer', platform: 'darwin', online: true, isSelf: false },
      ],
    });

    await expect(fetchSchedulerDesktopDeviceSnapshot()).rejects.toThrow(
      'device-link snapshot is missing the online self Desktop',
    );
  });
});
