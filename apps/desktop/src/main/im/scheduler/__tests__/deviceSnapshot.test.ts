import { describe, expect, it } from 'vitest';

import { buildSchedulerDesktopDeviceSnapshot } from '../deviceSnapshot';

describe('scheduler desktop snapshot projection', () => {
  it('requires an online self Desktop and sorts online Desktop peers', () => {
    expect(
      buildSchedulerDesktopDeviceSnapshot(
        [
          { deviceId: 'z', platform: 'darwin', online: true, isSelf: true },
          { deviceId: 'b', platform: 'linux', online: true, isSelf: false },
          { deviceId: 'a', platform: 'win32', online: true, isSelf: false },
          { deviceId: 'phone', platform: 'ios', online: true, isSelf: false },
          { deviceId: 'offline', platform: 'darwin', online: false, isSelf: false },
        ],
        42,
      ),
    ).toEqual({
      selfDeviceId: 'z',
      peers: [
        { deviceId: 'a', platform: 'win32' },
        { deviceId: 'b', platform: 'linux' },
      ],
      observedAt: 42,
    });
  });

  it('returns null when the full response cannot prove this Desktop is online', () => {
    expect(
      buildSchedulerDesktopDeviceSnapshot([
        { deviceId: 'peer', platform: 'darwin', online: true, isSelf: false },
      ]),
    ).toBeNull();
  });
});
