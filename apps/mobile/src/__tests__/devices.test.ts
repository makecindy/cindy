import { beforeAll, describe, expect, it } from 'vitest';
import type { DeviceView } from '@cindy/device-link';
import { i18n } from '@/i18n';
import {
  deviceAccessState,
  isControllableDevice,
  platformLabel,
  toDeviceListItems,
  visibleDeviceListItems,
} from '@/device-link/devices';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function device(patch: Partial<DeviceView> = {}): DeviceView {
  return {
    deviceId: 'dev-1',
    name: 'Mac',
    platform: 'darwin',
    appVersion: '0.0.0-test',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    online: true,
    busy: false,
    remoteControlEnabled: true,
    isSelf: false,
    ...patch,
  };
}

describe('mobile controllable device filter', () => {
  it('requires online, remoteControlEnabled and not self', () => {
    expect(isControllableDevice(device())).toBe(true);
    expect(isControllableDevice(device({ busy: true }))).toBe(true);
    expect(isControllableDevice(device({ online: false }))).toBe(false);
    expect(isControllableDevice(device({ remoteControlEnabled: false }))).toBe(false);
    expect(isControllableDevice(device({ isSelf: true }))).toBe(false);
    expect(isControllableDevice(device({ platform: 'ios' }))).toBe(false);
    expect(isControllableDevice(device({ platform: 'android' }))).toBe(false);
  });

  it('uses user-facing platform labels', () => {
    expect(platformLabel('darwin')).toBe('macOS');
    expect(platformLabel('win32')).toBe('Windows');
    expect(platformLabel('linux')).toBe('Linux');
    expect(platformLabel('ios')).toBe('iOS');
    expect(platformLabel('android')).toBe('Android');
    expect(platformLabel(null)).toBe('Unknown');
  });

  it('maps device access states without treating busy as unavailable', () => {
    expect(deviceAccessState(device())).toBe('ready');
    expect(deviceAccessState(device({ busy: true }))).toBe('busy');
    expect(deviceAccessState(device({ deviceId: 'revoked' }), new Set(['revoked']))).toBe('access_revoked');
    expect(deviceAccessState(device({ online: false }))).toBe('offline');
    expect(deviceAccessState(device({ remoteControlEnabled: false }))).toBe('remote_disabled');
    expect(deviceAccessState(device({ isSelf: true }))).toBe('self');
  });

  it('omits the current mobile device and other mobile clients while keeping unavailable peers with actionable details', () => {
    const now = new Date('2026-01-01T00:10:00.000Z').getTime();
    const items = toDeviceListItems([
      device({ deviceId: 'self', isSelf: true }),
      device({ deviceId: 'phone', platform: 'ios' }),
      device({ deviceId: 'tablet', platform: 'android' }),
      device({ deviceId: 'disabled', name: 'Charlie', remoteControlEnabled: false }),
      device({ deviceId: 'busy', name: 'Alpha', busy: true }),
      device({ deviceId: 'revoked', name: 'Delta' }),
      device({ deviceId: 'offline', name: 'Echo', online: false, lastSeenAt: '2026-01-01T00:00:00.000Z' }),
      device({ deviceId: 'ready', name: 'Beta' }),
    ], now, new Set(['revoked']));

    expect(items.map((item) => [item.device.deviceId, item.state, item.canOpen])).toEqual([
      ['busy', 'busy', true],
      ['ready', 'ready', true],
      ['disabled', 'remote_disabled', false],
      ['revoked', 'access_revoked', false],
      ['offline', 'offline', false],
    ]);
    expect(items.find((item) => item.device.deviceId === 'ready')?.statusDetail).toBe('已允许远程控制');
    expect(items.find((item) => item.device.deviceId === 'busy')?.statusDetail).toBe('电脑端正在处理任务');
    expect(items.find((item) => item.device.deviceId === 'revoked')?.statusDetail).toContain('恢复');
    expect(items.find((item) => item.device.deviceId === 'disabled')?.statusDetail).toContain('打开允许远程控制');
    expect(items.find((item) => item.device.deviceId === 'offline')?.statusDetail).toContain('10 分钟前在线');
  });

  it('defaults the visible list to controllable devices while keeping unavailable diagnostics behind a toggle', () => {
    const items = toDeviceListItems([
      device({ deviceId: 'disabled', name: 'A disabled', remoteControlEnabled: false }),
      device({ deviceId: 'busy', name: 'B busy', busy: true }),
      device({ deviceId: 'offline', name: 'C offline', online: false }),
      device({ deviceId: 'ready', name: 'D ready' }),
    ]);

    expect(visibleDeviceListItems(items, false)).toMatchObject({
      availableCount: 2,
      hiddenUnavailableCount: 2,
      unavailableCount: 2,
    });
    expect(visibleDeviceListItems(items, false).visibleItems.map((item) => item.device.deviceId)).toEqual([
      'busy',
      'ready',
    ]);
    expect(visibleDeviceListItems(items, true).visibleItems.map((item) => item.device.deviceId)).toEqual([
      'busy',
      'ready',
      'disabled',
      'offline',
    ]);
  });

  it('shows unavailable devices by default when there is no controllable peer', () => {
    const items = toDeviceListItems([
      device({ deviceId: 'disabled', remoteControlEnabled: false }),
      device({ deviceId: 'offline', online: false }),
    ]);

    const visibility = visibleDeviceListItems(items, false);
    expect(visibility.availableCount).toBe(0);
    expect(visibility.hiddenUnavailableCount).toBe(0);
    expect(visibility.visibleItems.map((item) => item.device.deviceId)).toEqual(['disabled', 'offline']);
  });

  it('sorts same-bucket devices by stable identity instead of lastSeenAt or caller order', () => {
    const items = toDeviceListItems([
      device({ deviceId: 'second', name: 'Beta', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
      device({ deviceId: 'first', name: 'Alpha', lastSeenAt: '2026-01-01T00:10:00.000Z' }),
    ]);

    expect(items.map((item) => item.device.deviceId)).toEqual(['first', 'second']);
  });

  it('keeps bucket order stable when ready and busy states change', () => {
    const readyBusy = toDeviceListItems([
      device({ deviceId: 'beta', name: 'Beta', busy: false }),
      device({ deviceId: 'alpha', name: 'Alpha', busy: true }),
    ]);
    const busyReady = toDeviceListItems([
      device({ deviceId: 'beta', name: 'Beta', busy: true }),
      device({ deviceId: 'alpha', name: 'Alpha', busy: false }),
    ]);

    expect(readyBusy.map((item) => [item.device.deviceId, item.state])).toEqual([
      ['alpha', 'busy'],
      ['beta', 'ready'],
    ]);
    expect(busyReady.map((item) => [item.device.deviceId, item.state])).toEqual([
      ['alpha', 'ready'],
      ['beta', 'busy'],
    ]);
  });

  it('keeps available devices before unavailable devices while sorting within each bucket by stable identity', () => {
    const items = toDeviceListItems([
      device({ deviceId: 'unavailable-a', name: 'A unavailable', online: false }),
      device({ deviceId: 'available-b', name: 'B available' }),
      device({ deviceId: 'unavailable-c', name: 'C unavailable', remoteControlEnabled: false }),
      device({ deviceId: 'available-d', name: 'D available', busy: true }),
    ]);

    expect(items.map((item) => [item.device.deviceId, item.canOpen])).toEqual([
      ['available-b', true],
      ['available-d', true],
      ['unavailable-a', false],
      ['unavailable-c', false],
    ]);
  });
});
