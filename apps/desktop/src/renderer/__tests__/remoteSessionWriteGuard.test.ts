import { describe, expect, it } from 'vitest';

import {
  isDeviceLinkWriteBlocked,
  isRemoteSessionWriteBlocked,
} from '@/features/cc-agent/lib/remoteSessionWriteGuard';

describe('remote session write guard', () => {
  it('blocks writes for disconnected and still-unverified (connecting) device-link sessions', () => {
    expect(
      isRemoteSessionWriteBlocked({
        deviceLinkDeviceId: 'device-1',
        deviceLinkConnectionStatus: 'disconnected',
      }),
    ).toBe(true);
    // 冷启动缓存种入 / relay 重连:图标是「检测中」,但快照仍非权威,写必须等 connected。
    expect(
      isRemoteSessionWriteBlocked({
        deviceLinkDeviceId: 'device-1',
        deviceLinkConnectionStatus: 'connecting',
      }),
    ).toBe(true);

    expect(
      isRemoteSessionWriteBlocked({
        deviceLinkDeviceId: 'device-1',
        deviceLinkConnectionStatus: 'connected',
      }),
    ).toBe(false);
    expect(
      isRemoteSessionWriteBlocked({
        deviceLinkDeviceId: undefined,
        deviceLinkConnectionStatus: 'disconnected',
      }),
    ).toBe(false);
  });

  it('uses the same write block for disconnected device-link projects', () => {
    expect(
      isDeviceLinkWriteBlocked({
        deviceLinkDeviceId: 'device-1',
        deviceLinkConnectionStatus: 'disconnected',
      }),
    ).toBe(true);
    expect(
      isDeviceLinkWriteBlocked({
        deviceLinkDeviceId: 'device-1',
        deviceLinkConnectionStatus: 'connected',
      }),
    ).toBe(false);
  });
});
