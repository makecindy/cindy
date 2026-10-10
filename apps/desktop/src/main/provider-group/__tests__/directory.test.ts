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
    // 分享来的电脑只用分享者的昵称称呼，不用分享者的电脑名(provider-sharing.md §6)。
    expect(candidates[1]).toMatchObject({ label: 'Magi', ownerName: 'Magi' });
    expect(JSON.stringify(candidates)).not.toContain('s1-pc');
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
      // 分享来的电脑用分享者的昵称；旧版本存下的快照(可能是电脑名)不再用。
      ['share:s2:anthropic', 'Magi', 'unavailable', 'share-paused'],
      ['share:s9:anthropic', '', 'unavailable', 'share-removed'],
    ]);
  });

  it('takes the running count a shared computer reports for this account', async () => {
    const catalogs: Record<string, ProviderView[]> = {
      mini: [view('anthropic-1a2b3c4d', 'Claude', { guestRunning: 5 } as unknown as Partial<ProviderView>)],
      'share:s1': [view('anthropic', 'Anthropic', { guestRunning: 3 } as unknown as Partial<ProviderView>)],
      'share:s3': [view('anthropic', 'Anthropic', { guestRunning: -1 } as unknown as Partial<ProviderView>)],
      'share:s4': [view('anthropic', 'Anthropic')],
    };
    const directory = createProviderGroupDirectory(deps({
      readDeviceProviders: async (id: string) => catalogs[id] ?? [],
      listReceivedShares: () => [share('s1'), share('s3'), share('s4')],
    }));
    const member = (key: string, kind: 'device' | 'share', agentDeviceId: string, providerId: string) => ({
      key, kind, agentDeviceId, providerId, limit: 4, weight: 1, paused: false,
    });
    const resolved = await directory.resolveMembers('anthropic', {
      strategy: 'least',
      autoSwitch: true,
      members: [
        member('device:mini:anthropic-1a2b3c4d', 'device', 'mini', 'anthropic-1a2b3c4d'),
        member('share:s1:anthropic', 'share', 'share:s1', 'anthropic'),
        member('share:s3:anthropic', 'share', 'share:s3', 'anthropic'),
        member('share:s4:anthropic', 'share', 'share:s4', 'anthropic'),
      ],
    });
    // 只认分享来的电脑报来的合理值；同账号电脑的目录不带这个字段，带了也不认；旧分享者不报时没有。
    expect(resolved.map((r) => r.reportedRunning ?? null)).toEqual([null, 3, null, null]);
  });

  it('takes the running count of this computer and of same-account computers', async () => {
    const catalogs: Record<string, ProviderView[]> = {
      mini: [view('anthropic-1a2b3c4d', 'Claude', { runningTurns: 2 } as unknown as Partial<ProviderView>)],
      studio: [view('anthropic', 'Anthropic', { runningTurns: 2.5 } as unknown as Partial<ProviderView>)],
      old: [view('anthropic', 'Anthropic')],
      'share:s1': [view('anthropic', 'Anthropic', { runningTurns: 7 } as unknown as Partial<ProviderView>)],
    };
    const localRunning = vi.fn(async (providerId: string) => (providerId === 'anthropic' ? 4 : null));
    const directory = createProviderGroupDirectory(deps({
      listDevices: async () => [device('mini'), device('studio'), device('old')],
      readDeviceProviders: async (id: string) => catalogs[id] ?? [],
      listReceivedShares: () => [share('s1')],
      localRunning,
    }));
    const member = (key: string, kind: 'local' | 'device' | 'share', agentDeviceId: string | null, providerId: string) => ({
      key, kind, agentDeviceId, providerId, limit: 4, weight: 1, paused: false,
    });
    const resolved = await directory.resolveMembers('anthropic', {
      strategy: 'least',
      autoSwitch: true,
      members: [
        member('local', 'local', null, 'anthropic'),
        member('device:mini:anthropic-1a2b3c4d', 'device', 'mini', 'anthropic-1a2b3c4d'),
        member('device:studio:anthropic', 'device', 'studio', 'anthropic'),
        member('device:old:anthropic', 'device', 'old', 'anthropic'),
        member('share:s1:anthropic', 'share', 'share:s1', 'anthropic'),
      ],
    });
    // 本机现算；同账号电脑只认合理值，旧版不报时没有；分享来的电脑只认本账号的数，不认那台的总数。
    expect(resolved.map((r) => r.reportedRunning ?? null)).toEqual([4, 2, null, null, null]);
    expect(localRunning).toHaveBeenCalledWith('anthropic');
  });

  it('leaves the local count out when it cannot be read', async () => {
    const directory = createProviderGroupDirectory(deps({ localRunning: async () => { throw new Error('db busy'); } }));
    const [resolved] = await directory.resolveMembers('anthropic', {
      strategy: 'least',
      autoSwitch: true,
      members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false }],
    });
    expect(resolved).toMatchObject({ state: 'ok' });
    expect(resolved.reportedRunning).toBeUndefined();
  });

  it('names members for activity records without the sharer’s computer name', () => {
    const directory = createProviderGroupDirectory(deps());
    const member = (patch: Partial<ProviderGroupConfig['members'][number]>) => ({
      key: 'k', kind: 'device' as const, agentDeviceId: 'mini', providerId: 'anthropic', limit: 4, weight: 1, paused: false, ...patch,
    });
    expect(directory.memberLabel(member({ label: 'Mini' }))).toBe('Mini');
    expect(directory.memberLabel(member({ key: 'local', kind: 'local', agentDeviceId: null }))).toBe('local');
    expect(directory.memberLabel(member({ kind: 'share', agentDeviceId: 'share:s1', label: 's1-pc' }))).toBe('Magi');
    expect(directory.memberLabel(member({ kind: 'share', agentDeviceId: 'share:gone', label: 'Kai PC' }))).toBe('');
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

describe('probe (waiting for a computer to come back, §6.1)', () => {
  it('tells apart a computer that cannot be reached from one whose provider cannot be used', async () => {
    const directory = createProviderGroupDirectory(deps());
    expect(await directory.probe('mini', 'anthropic-1a2b3c4d')).toBe('ok');
    expect(await directory.probe('off', 'anthropic')).toBe('offline');
    expect(await directory.probe('mini', 'gone')).toBe('unavailable');
    expect(await directory.probe('share:s1', 'anthropic')).toBe('ok');
    expect(await directory.probe('share:s2', 'anthropic')).toBe('unavailable');
  });

  it('does not wait for a computer that is online but turned off remote control', async () => {
    const directory = createProviderGroupDirectory(deps({
      listDevices: async () => [device('mini', { remoteControlEnabled: false })],
    }));
    expect(await directory.probe('mini', 'anthropic-1a2b3c4d')).toBe('unavailable');
  });

  it('reads a shared computer directly instead of trusting the periodically refreshed online flag', async () => {
    const directory = createProviderGroupDirectory(deps({
      listReceivedShares: () => [share('s1', { hostOnline: false })],
    }));
    // 快照还说离线，其实已经能读到那台的目录：按恢复算。
    expect(await directory.probe('share:s1', 'anthropic')).toBe('ok');
    // 真读不到时仍是离线。
    const unreachable = createProviderGroupDirectory(deps({
      listReceivedShares: () => [share('s1', { hostOnline: false })],
      readDeviceProviders: async () => {
        throw new Error('unreachable');
      },
    }));
    expect(await unreachable.probe('share:s1', 'anthropic')).toBe('offline');
  });

  it('reads the current state instead of the cached one', async () => {
    let miniOnline = true;
    const d = deps({ listDevices: async () => [device('self', { isSelf: true }), device('mini', { online: miniOnline })] });
    const directory = createProviderGroupDirectory(d);
    const config: ProviderGroupConfig = {
      strategy: 'least',
      autoSwitch: true,
      members: [{ key: 'device:mini:anthropic-1a2b3c4d', kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d', limit: 4, weight: 1, paused: false }],
    };
    await directory.resolveMembers('anthropic', config);
    miniOnline = false;
    expect(await directory.probe('mini', 'anthropic-1a2b3c4d')).toBe('offline');
    miniOnline = true;
    expect(await directory.probe('mini', 'anthropic-1a2b3c4d')).toBe('ok');
    // 那台的目录也现读，不用短时缓存。
    expect(d.readDeviceProviders).toHaveBeenCalledTimes(2);
  });
});
