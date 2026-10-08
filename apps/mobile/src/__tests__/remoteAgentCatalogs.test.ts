import type { DeviceView } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers/registry';
import { describe, expect, it } from 'vitest';

import type { ProviderShareCatalogEntry } from '@/device-link/providerShareCatalogCache';
import {
  isProviderShareAgentDeviceId,
  providerShareRemoteCatalogs,
  remoteAgentProviders,
  selectRemoteAgentDevices,
} from '@/session/remoteAgentCatalogs';
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

describe('provider shares in the remote Agent catalogs', () => {
  const providers = [
    { id: 'anthropic', name: 'Anthropic', remoteInvocationEnabled: true },
    { id: 'closed', name: 'Closed', remoteInvocationEnabled: false },
    { id: 'other', name: 'Other', remoteInvocationEnabled: true },
  ] as unknown as ProviderView[];
  const share = (shareId: string, patch: Partial<ProviderShareCatalogEntry> = {}): ProviderShareCatalogEntry => ({
    agentDeviceId: `share:${shareId}`,
    shareId,
    providerId: 'anthropic',
    deviceName: "Magi's Mac Mini",
    ownerName: 'Magi',
    status: 'active',
    hostOnline: true,
    payload: { providers, modelVisibilityOverrides: { 'claude-code:anthropic:claude-x': true } },
    ...patch,
  });
  const build = (input: {
    shares: ProviderShareCatalogEntry[];
    keepDeviceIds?: string[];
    keepOnly?: boolean;
    loaded?: boolean;
  }) => providerShareRemoteCatalogs({
    shares: input.shares,
    loaded: input.loaded ?? true,
    keepDeviceIds: input.keepDeviceIds ?? [],
    keepOnly: input.keepOnly,
    deviceName: (item) => `${item.deviceName} · 来自 ${item.ownerName} 的分享`,
    unavailableName: '已不可用的分享',
  });

  it('recognizes share agent locations', () => {
    expect(isProviderShareAgentDeviceId('share:abc')).toBe(true);
    expect(isProviderShareAgentDeviceId('share:')).toBe(false);
    expect(isProviderShareAgentDeviceId('studio')).toBe(false);
    expect(isProviderShareAgentDeviceId(null)).toBe(false);
  });

  it('lists each reachable share as one more computer with only the shared provider', () => {
    const [catalog] = build({ shares: [share('one')] });
    expect(catalog).toEqual({
      deviceId: 'share:one',
      name: "Magi's Mac Mini · 来自 Magi 的分享",
      status: 'ready',
      providers: [providers[0]],
      modelVisibilityOverrides: { 'claude-code:anthropic:claude-x': true },
    });
  });

  it('omits paused shares and offline owners like unreachable computers, unless the task uses them', () => {
    const shares = [
      share('paused', { status: 'paused' }),
      share('offline', { hostOnline: false, payload: null }),
      share('ready'),
    ];
    expect(build({ shares }).map((item) => item.deviceId)).toEqual(['share:ready']);
    expect(build({ shares, keepDeviceIds: ['share:paused', 'share:offline'] }).map((item) => [item.deviceId, item.status]))
      .toEqual([['share:paused', 'ready'], ['share:offline', 'error'], ['share:ready', 'ready']]);
  });

  it('only returns kept shares when reading for the model pill', () => {
    expect(build({ shares: [share('one'), share('two')], keepOnly: true, keepDeviceIds: ['share:two', 'studio'] })
      .map((item) => item.deviceId)).toEqual(['share:two']);
    expect(build({ shares: [share('one')], keepOnly: true })).toEqual([]);
  });

  it('keeps a removed share the task still points at, once the list is authoritative', () => {
    expect(build({ shares: [], keepDeviceIds: ['share:gone'], loaded: false })).toEqual([]);
    expect(build({ shares: [], keepDeviceIds: ['share:gone'] })).toEqual([
      { deviceId: 'share:gone', name: '已不可用的分享', status: 'error', providers: [] },
    ]);
  });

  it('does not list a share whose catalog lost the remote-use mark', () => {
    const closed = share('closed', {
      payload: { providers: [{ ...providers[0], remoteInvocationEnabled: false } as ProviderView] },
    });
    expect(build({ shares: [closed] })[0].providers).toEqual([]);
  });
});
