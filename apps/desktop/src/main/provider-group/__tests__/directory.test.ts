/**
 * 组内电脑的实时情况(provider-groups.md §3、§5)：可加入的电脑只列这台电脑已经能用的同一个供应商；
 * 组里每台按在线、远程调用、分享状态给出能不能用与原因。
 */
import type { ProviderShareReceived } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it, vi } from 'vitest';

import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc';
import type { ProviderGroupConfig } from '../../../shared/providerGroup';
import { createProviderGroupDirectory, type ProviderGroupDirectoryDeps } from '../directory';

const view = (id: string, name: string, patch: Partial<ProviderView> = {}): ProviderView => ({
  id,
  name,
  agents: ['claude-code'],
  connected: true,
  models: { 'claude-code': [] },
  routing: { 'claude-code': {} },
  auth: { method: 'oauth', native: 'claude' },
  ...patch,
}) as unknown as ProviderView;

const device = (deviceId: string, patch: Partial<DeviceLinkDeviceView> = {}): DeviceLinkDeviceView => ({
  deviceId,
  name: `${deviceId}-name`,
  platform: 'darwin',
  appVersion: '1.0.0',
  lastSeenAt: null,
  online: true,
  busy: false,
  remoteControlEnabled: true,
  controlEnabled: true,
  isSelf: false,
  ...patch,
});

const share = (shareId: string, patch: Partial<ProviderShareReceived> = {}): ProviderShareReceived => ({
  shareId,
  memberId: `m-${shareId}`,
  providerId: 'anthropic',
  providerLabel: 'Anthropic',
  hostDeviceId: `host-${shareId}`,
  deviceName: `${shareId}-pc`,
  owner: { displayName: 'Magi', avatarUrl: null, region: 'cn' },
  status: 'active',
  hostOnline: true,
  hostCapable: true,
  ...patch,
});

function deps(overrides: Partial<ProviderGroupDirectoryDeps> = {}): ProviderGroupDirectoryDeps {
  const catalogs: Record<string, ProviderView[]> = {
    mini: [view('anthropic-1a2b3c4d', 'Claude'), view('deepseek', 'DeepSeek', { auth: { method: 'api-key' } } as unknown as Partial<ProviderView>)],
    'share:s1': [view('anthropic', 'Anthropic')],
  };
  return {
    listLocalProviders: async () => [view('anthropic', 'Anthropic')],
    localDeviceName: () => 'Home Mac Studio',
    listDevices: async () => [device('self', { isSelf: true }), device('mini'), device('phone', { platform: 'ios' }), device('off', { online: false })],
    readDeviceProviders: vi.fn(async (id: string) => {
      if (!catalogs[id]) throw new Error('unreachable');
      return catalogs[id];
    }),
    listReceivedShares: () => [share('s1'), share('s2', { status: 'paused' })],
    isMobilePlatform: (platform) => platform === 'ios' || platform === 'android',
    now: () => 0,
    ...overrides,
  };
}

describe('listCandidates', () => {
  it('lists same-account computers and received shares offering the same provider', async () => {
    const directory = createProviderGroupDirectory(deps());
    const candidates = await directory.listCandidates('anthropic', null);
    expect(candidates.map((c) => [c.kind, c.agentDeviceId, c.providerId, c.blocked ?? null])).toEqual([
      ['device', 'mini', 'anthropic-1a2b3c4d', null],
      ['share', 'share:s1', 'anthropic', null],
    ]);
    expect(candidates[1]).toMatchObject({ label: 's1-pc', ownerName: 'Magi' });
  });

  it('marks computers already in the group', async () => {
    const directory = createProviderGroupDirectory(deps());
    const config: ProviderGroupConfig = {
      strategy: 'least',
      autoSwitch: true,
      members: [{ key: 'device:mini:anthropic-1a2b3c4d', kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d', limit: 4, weight: 1, paused: false }],
    };
    const candidates = await directory.listCandidates('anthropic', config);
    expect(candidates.find((c) => c.agentDeviceId === 'mini')?.blocked).toBe('member');
  });

  it('returns nothing when this computer does not have the provider', async () => {
    const directory = createProviderGroupDirectory(deps());
    expect(await directory.listCandidates('missing', null)).toEqual([]);
  });
});

describe('resolveMembers', () => {
  it('reports each member with a state and reason', async () => {
    const directory = createProviderGroupDirectory(deps({
      listReceivedShares: () => [share('s1'), share('s2', { status: 'paused' })],
    }));
    const config: ProviderGroupConfig = {
      strategy: 'least',
      autoSwitch: true,
      members: [
        { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false },
        { key: 'device:mini:anthropic-1a2b3c4d', kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d', limit: 4, weight: 1, paused: false },
        { key: 'device:mini:gone', kind: 'device', agentDeviceId: 'mini', providerId: 'gone', limit: 4, weight: 1, paused: false },
        { key: 'device:off:anthropic', kind: 'device', agentDeviceId: 'off', providerId: 'anthropic', label: 'Old PC', limit: 4, weight: 1, paused: false },
        { key: 'share:s2:anthropic', kind: 'share', agentDeviceId: 'share:s2', providerId: 'anthropic', limit: 4, weight: 1, paused: false },
        { key: 'share:s9:anthropic', kind: 'share', agentDeviceId: 'share:s9', providerId: 'anthropic', label: 'Kai PC', limit: 4, weight: 1, paused: false },
      ],
    };
    const resolved = await directory.resolveMembers('anthropic', config);
    expect(resolved.map((r) => [r.member.key, r.label, r.state, r.reason ?? null])).toEqual([
      ['local', 'Home Mac Studio', 'ok', null],
      ['device:mini:anthropic-1a2b3c4d', 'mini-name', 'ok', null],
      ['device:mini:gone', 'mini-name', 'unavailable', 'provider-off'],
      ['device:off:anthropic', 'off-name', 'offline', null],
      ['share:s2:anthropic', 's2-pc', 'unavailable', 'share-paused'],
      ['share:s9:anthropic', 'Kai PC', 'unavailable', 'share-removed'],
    ]);
  });

  it('caches catalogs briefly and forgets them on invalidate', async () => {
    const d = deps();
    const directory = createProviderGroupDirectory(d);
    const config: ProviderGroupConfig = {
      strategy: 'least',
      autoSwitch: true,
      members: [{ key: 'device:mini:anthropic-1a2b3c4d', kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d', limit: 4, weight: 1, paused: false }],
    };
    await directory.resolveMembers('anthropic', config);
    await directory.resolveMembers('anthropic', config);
    expect(d.readDeviceProviders).toHaveBeenCalledTimes(1);
    directory.invalidate('mini');
    await directory.resolveMembers('anthropic', config);
    expect(d.readDeviceProviders).toHaveBeenCalledTimes(2);
  });
});
