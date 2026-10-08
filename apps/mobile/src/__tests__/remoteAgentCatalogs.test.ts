import type { DeviceView } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers/registry';
import { describe, expect, it } from 'vitest';

import { remoteAgentProviders, selectRemoteAgentDevices } from '@/session/remoteAgentCatalogs';
import { groupSourceFilters, remoteFilterId } from '@/session/remoteSourceFilters';

const device = (deviceId: string, patch: Partial<DeviceView> = {}): DeviceView => ({
  deviceId,
  name: deviceId,
  platform: 'darwin',
  appVersion: '1.0.0',
  lastSeenAt: null,
  online: true,
  busy: false,
  remoteControlEnabled: true,
  isSelf: false,
  ...patch,
});

describe('remote Agent catalogs', () => {
  it('lists the other computers the Agent can run on', () => {
    const devices = [
      device('controlled', { name: 'Home Mac' }),
      device('studio', { name: 'Studio Mac' }),
      device('office', { name: 'Office PC', platform: 'win32', busy: true }),
      device('offline', { name: 'Old Laptop', online: false }),
      device('locked', { name: 'Locked PC', remoteControlEnabled: false }),
      device('revoked', { name: 'Revoked PC' }),
      device('phone', { name: 'iPhone', platform: 'ios' }),
      device('self', { name: 'This phone', isSelf: true }),
      device('unnamed', { name: '  ' }),
    ];
    expect(selectRemoteAgentDevices({
      devices,
      controlledDeviceId: 'controlled',
      keepDeviceIds: [],
      revokedDeviceIds: new Set(['revoked']),
    })).toEqual([
      { deviceId: 'unnamed', name: 'unnamed', canOpen: true },
      { deviceId: 'office', name: 'Office PC', canOpen: true },
      { deviceId: 'studio', name: 'Studio Mac', canOpen: true },
    ]);
  });

  it('keeps the computer the Agent runs on even when it cannot be reached', () => {
    const selected = selectRemoteAgentDevices({
      devices: [device('controlled'), device('offline', { name: 'Old Laptop', online: false })],
      controlledDeviceId: 'controlled',
      keepDeviceIds: ['offline'],
    });
    expect(selected).toEqual([{ deviceId: 'offline', name: 'Old Laptop', canOpen: false }]);
  });

  it('only offers providers that computer allows to be used remotely', () => {
    const providers = [
      { id: 'allowed', remoteInvocationEnabled: true },
      { id: 'closed', remoteInvocationEnabled: false },
      { id: 'legacy' },
    ] as unknown as ProviderView[];
    expect(remoteAgentProviders(providers).map((provider) => provider.id)).toEqual(['allowed']);
  });

  it('groups source choices into one block per computer', () => {
    type Filter = { id: string; remote?: { deviceId: string; deviceName: string } };
    const remote = (deviceId: string, deviceName: string, providerId: string): Filter => ({
      id: remoteFilterId(deviceId, providerId),
      remote: { deviceId, deviceName },
    });
    const filters: Filter[] = [
      { id: 'all' },
      { id: 'favorites' },
      remote('studio', 'Studio Mac', 'claude'),
      { id: 'local-provider' },
      remote('office', 'Office PC', 'codex'),
      remote('studio', 'Studio Mac', 'openrouter'),
    ];
    const groups = groupSourceFilters(filters);
    expect(groups.local.map((item) => item.id)).toEqual(['all', 'favorites', 'local-provider']);
    expect(groups.devices.map((item) => [item.deviceId, item.name, item.filters.map((f) => f.id)])).toEqual([
      ['studio', 'Studio Mac', [remoteFilterId('studio', 'claude'), remoteFilterId('studio', 'openrouter')]],
      ['office', 'Office PC', [remoteFilterId('office', 'codex')]],
    ]);
    // 远程格 id 不会和本机供应商 id 撞,哪怕供应商 id 相同。
    expect(remoteFilterId('studio', 'local-provider')).not.toBe('local-provider');
    expect(remoteFilterId('a:b', 'c')).not.toBe(remoteFilterId('a', 'b:c'));
  });
});
