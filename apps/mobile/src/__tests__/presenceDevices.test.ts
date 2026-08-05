import { describe, expect, it } from 'vitest';
import type { DeviceView, PresenceSnapshot } from '@cindy/device-link';
import {
  collectFreshPresenceDeviceIds,
  createPresenceFreshnessTracker,
  markPresenceFresh,
  mergeDeviceViewsWithFreshPresence,
  patchDeviceViewsWithPresence,
} from '@/device-link/presenceDevices';

function device(patch: Partial<DeviceView> = {}): DeviceView {
  return {
    deviceId: 'dev-1',
    name: 'Mac',
    platform: 'darwin',
    appVersion: '1.0.0',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    online: false,
    busy: false,
    remoteControlEnabled: false,
    isSelf: false,
    ...patch,
  };
}

function presence(patch: Partial<PresenceSnapshot> = {}): PresenceSnapshot {
  return {
    deviceId: 'dev-1',
    deviceName: 'Mac',
    platform: 'darwin',
    appVersion: '1.0.0',
    lastSeenAt: Date.parse('2026-01-01T00:00:01.000Z'),
    online: true,
    busy: false,
    remoteControlEnabled: true,
    ...patch,
  };
}

describe('patchDeviceViewsWithPresence', () => {
  it('patches a known device locally and flags the first controllable transition', () => {
    const result = patchDeviceViewsWithPresence([device()], presence(), 'mobile-1');

    expect(result.changed).toBe(true);
    expect(result.becameControllable).toBe(true);
    expect(result.devices[0]).toMatchObject({
      deviceId: 'dev-1',
      online: true,
      remoteControlEnabled: true,
      lastSeenAt: '2026-01-01T00:00:01.000Z',
    });
  });

  it('does not ask for a session hydrate when an already controllable device only changes busy state', () => {
    const result = patchDeviceViewsWithPresence(
      [device({ online: true, remoteControlEnabled: true })],
      presence({ busy: true }),
      'mobile-1',
    );

    expect(result.changed).toBe(true);
    expect(result.becameControllable).toBe(false);
    expect(result.devices[0].busy).toBe(true);
  });

  it('patches selfName and deviceInfo from presence snapshots', () => {
    const result = patchDeviceViewsWithPresence(
      [device()],
      presence({
        deviceName: 'Studio Mac',
        selfName: 'Carol-MacBook-Pro',
        deviceInfo: { cpuLabel: 'Apple M3 Pro', memoryGb: 36 },
      }),
      'mobile-1',
    );

    expect(result.devices[0]).toMatchObject({
      name: 'Studio Mac',
      selfName: 'Carol-MacBook-Pro',
      deviceInfo: { cpuLabel: 'Apple M3 Pro', memoryGb: 36 },
    });
  });

  it('keeps the existing device list reference when a presence tick changes nothing', () => {
    const existing = [
      device({
        online: true,
        remoteControlEnabled: true,
        lastSeenAt: '2026-01-01T00:00:01.000Z',
      }),
    ];

    const result = patchDeviceViewsWithPresence(existing, presence(), 'mobile-1');

    expect(result.changed).toBe(false);
    expect(result.becameControllable).toBe(false);
    expect(result.devices).toBe(existing);
    expect(result.device).toBe(existing[0]);
  });

  it('does not add a self mobile presence snapshot as a controllable host', () => {
    const result = patchDeviceViewsWithPresence([], presence({ deviceId: 'mobile-1' }), 'mobile-1');

    expect(result.changed).toBe(false);
    expect(result.becameControllable).toBe(false);
    expect(result.devices).toEqual([]);
  });

  it('preserves existing order instead of re-sorting by heartbeat time', () => {
    const result = patchDeviceViewsWithPresence(
      [
        device({
          deviceId: 'first',
          name: 'First',
          online: true,
          remoteControlEnabled: true,
        }),
        device({
          deviceId: 'second',
          name: 'Second',
          online: true,
          remoteControlEnabled: true,
        }),
      ],
      presence({
        deviceId: 'second',
        deviceName: 'Second',
        lastSeenAt: Date.parse('2026-01-01T00:10:00.000Z'),
      }),
      'mobile-1',
    );

    expect(result.devices.map((item) => item.deviceId)).toEqual(['first', 'second']);
  });
});

describe('presence freshness tracker', () => {
  it('collects only devices patched after the recorded epoch', () => {
    const tracker = createPresenceFreshnessTracker();
    markPresenceFresh(tracker, 'dev-a');
    const epochAtFetchStart = tracker.epoch;
    markPresenceFresh(tracker, 'dev-b');
    markPresenceFresh(tracker, 'dev-c');

    const fresh = collectFreshPresenceDeviceIds(tracker, epochAtFetchStart);

    expect(fresh).toEqual(new Set(['dev-b', 'dev-c']));
  });

  it('treats a re-patched device as fresh again', () => {
    const tracker = createPresenceFreshnessTracker();
    markPresenceFresh(tracker, 'dev-a');
    const epochAtFetchStart = tracker.epoch;
    markPresenceFresh(tracker, 'dev-a');

    expect(collectFreshPresenceDeviceIds(tracker, epochAtFetchStart)).toEqual(new Set(['dev-a']));
  });

  it('returns an empty set when nothing arrived after the epoch', () => {
    const tracker = createPresenceFreshnessTracker();
    markPresenceFresh(tracker, 'dev-a');

    expect(collectFreshPresenceDeviceIds(tracker, tracker.epoch)).toEqual(new Set());
  });
});

describe('mergeDeviceViewsWithFreshPresence', () => {
  it('keeps the presence-patched view for devices refreshed during the REST flight', () => {
    // 竞态回归:REST 快照(offline)在飞行期间被 presence-changed(online) 超越,
    // 合并结果必须保住在线状态,否则首页会卡死在「会话都在、新建对话按钮灰」。
    const serverDevices = [device({ online: false, remoteControlEnabled: false })];
    const currentDevices = [device({ online: true, remoteControlEnabled: true })];

    const merged = mergeDeviceViewsWithFreshPresence(serverDevices, currentDevices, new Set(['dev-1']));

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ deviceId: 'dev-1', online: true, remoteControlEnabled: true });
  });

  it('prefers the REST snapshot for devices without a fresh presence patch', () => {
    const serverDevices = [device({ online: false, remoteControlEnabled: false })];
    const currentDevices = [device({ online: true, remoteControlEnabled: true })];

    const merged = mergeDeviceViewsWithFreshPresence(serverDevices, currentDevices, new Set());

    expect(merged[0]).toMatchObject({ deviceId: 'dev-1', online: false, remoteControlEnabled: false });
  });

  it('appends a freshly announced device the REST snapshot has not picked up yet', () => {
    const serverDevices = [device({ deviceId: 'dev-1' })];
    const currentDevices = [
      device({ deviceId: 'dev-1' }),
      device({ deviceId: 'dev-2', name: 'Studio', online: true, remoteControlEnabled: true }),
    ];

    const merged = mergeDeviceViewsWithFreshPresence(serverDevices, currentDevices, new Set(['dev-2']));

    expect(merged.map((item) => item.deviceId)).toEqual(['dev-1', 'dev-2']);
    expect(merged[1]).toMatchObject({ online: true, remoteControlEnabled: true });
  });

  it('drops stale non-fresh devices that only exist in the current view', () => {
    const serverDevices = [device({ deviceId: 'dev-1' })];
    const currentDevices = [
      device({ deviceId: 'dev-1' }),
      device({ deviceId: 'dev-gone', online: true, remoteControlEnabled: true }),
    ];

    const merged = mergeDeviceViewsWithFreshPresence(serverDevices, currentDevices, new Set(['dev-1']));

    expect(merged.map((item) => item.deviceId)).toEqual(['dev-1']);
  });

  it('falls back to the REST entry when a fresh device is missing from the current view', () => {
    const serverDevices = [device({ online: true, remoteControlEnabled: true })];

    const merged = mergeDeviceViewsWithFreshPresence(serverDevices, [], new Set(['dev-1']));

    expect(merged[0]).toMatchObject({ deviceId: 'dev-1', online: true, remoteControlEnabled: true });
  });
});
