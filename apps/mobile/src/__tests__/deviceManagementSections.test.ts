import { describe, expect, it } from 'vitest';
import type { DeviceAccessState, DeviceListDeviceLike, DeviceListItem } from '@cindy/maker-shared/device-list';
import { buildDeviceManagementSections } from '@/session/deviceManagementSections';

function row(id: string, online: boolean, state: DeviceAccessState, lastSeenAt: string | null = null): DeviceListItem {
  const device: DeviceListDeviceLike = {
    busy: false, deviceId: id, isSelf: false, lastSeenAt, name: `Mac ${id}`, online, platform: 'darwin', remoteControlEnabled: true,
  };
  return { canOpen: state === 'ready', device, state, statusDetail: '', statusLabel: '' };
}

describe('buildDeviceManagementSections', () => {
  it('groups by the device being online, not by the access state label', () => {
    // 状态先判「已撤销访问」再判离线:已撤销且离线的设备 state 是 access_revoked。
    const sections = buildDeviceManagementSections([
      row('ready', true, 'ready'),
      row('revoked-online', true, 'access_revoked'),
      row('revoked-offline', false, 'access_revoked'),
      row('offline', false, 'offline'),
    ]);
    expect(sections.online.map((r) => r.device.deviceId)).toEqual(['ready', 'revoked-online']);
    expect(sections.offline.map((r) => r.device.deviceId).sort()).toEqual(['offline', 'revoked-offline']);
  });

  it('puts the most recently seen offline device first', () => {
    const sections = buildDeviceManagementSections([
      row('old', false, 'offline', '2026-09-01T00:00:00Z'),
      row('never', false, 'offline', null),
      row('new', false, 'offline', '2026-09-28T00:00:00Z'),
    ]);
    expect(sections.offline.map((r) => r.device.deviceId)).toEqual(['new', 'old', 'never']);
  });
});
