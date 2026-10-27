/**
 * 组内电脑的实时情况(provider-groups.md §3、§5)：可加入的电脑只列这台电脑已经能用的同一个供应商；
 * 组里每台按在线、远程调用、分享状态给出能不能用与原因。
 */
import type { ProviderShareReceived } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it, vi } from 'vitest';

import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc';
import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import { createProviderGroupDirectory, type ProviderGroupDirectoryDeps } from '../directory';
import { providerGroupCodexUsageSnapshot } from '../usage';

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
    // 分享者那台电脑只带设备 id，用来把同一台的几个分享收在一起。
    expect(candidates[1].hostDeviceId).toBe('host-s1');
    expect(candidates[0].hostDeviceId).toBeUndefined();
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
  it('uses actual local and advertised device versions, including offline devices; never invents a share version', async () => {
    const directory = createProviderGroupDirectory(deps({ localAppVersion: () => '0.1.104-beta' }));
    const members: ProviderGroupConfig['members'] = [
      { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false },
      { key: 'mini', kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d', limit: 4, weight: 1, paused: false },
      { key: 'off', kind: 'device', agentDeviceId: 'off', providerId: 'anthropic', limit: 4, weight: 1, paused: false },
      { key: 'share', kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic', limit: 4, weight: 1, paused: false },
    ];
    const resolved = await directory.resolveMembers('anthropic', { strategy: 'least', autoSwitch: true, members });
    expect(resolved.map((m) => m.appVersion)).toEqual(['0.1.104-beta', '1.0.0', '1.0.0', undefined]);
    expect(resolved[2].state).toBe('offline');
  });

  it('reads quota only for available Claude subscriptions on this account’s computers', async () => {
    const readClaudeUsage = vi.fn<(member: ProviderGroupMember) => Promise<{ updatedAt: number; fiveHour: { utilization: number } }>>(
      async () => ({ updatedAt: 1_000, fiveHour: { utilization: 25 } }),
    );
    const directory = createProviderGroupDirectory(deps({ readClaudeUsage }));
    const member = (kind: 'local' | 'device' | 'share', agentDeviceId: string | null, providerId: string) => ({
      key: `${kind}:${agentDeviceId}:${providerId}`, kind, agentDeviceId, providerId, limit: 4, weight: 1, paused: false,
    });
    const members = [member('local', null, 'anthropic'), member('device', 'mini', 'anthropic-1a2b3c4d'),
      member('device', 'mini', 'deepseek'), member('device', 'off', 'anthropic'), member('share', 'share:s1', 'anthropic')];
    const result = await directory.resolveMembers('anthropic', { strategy: 'usage', autoSwitch: true, members });
    expect(readClaudeUsage).toHaveBeenCalledTimes(2);
    expect(readClaudeUsage).toHaveBeenCalledWith(members[0]);
    expect(readClaudeUsage).toHaveBeenCalledWith(members[1]);
    expect(result[0].claudeUsage?.fiveHour?.utilization).toBe(25);
    expect(result[4]).not.toHaveProperty('claudeUsage');
  });

  // Unit/privacy: OpenAI quota reads are confined to usable same-account subscriptions.
  // The Claude-only fixture cannot detect querying API connections or a borrowed OpenAI share.
  it('reads OpenAI quota only for usable local/same-account subscriptions, never shares or API connections', async () => {
    const readCodexUsage = vi.fn(async (_member: ProviderGroupMember) => providerGroupCodexUsageSnapshot({ updatedAt: 1_000, primary: { usedPercent: 25 } }));
    const providers = [view('openai', 'OpenAI', { auth: { method: 'oauth', native: 'codex' } }),
      view('openai-api', 'OpenAI API', { auth: { method: 'apiKey' } }),
      view('openai-disabled', 'OpenAI', { suspended: true, auth: { method: 'oauth', native: 'codex' } })];
    const directory = createProviderGroupDirectory(deps({ readCodexUsage,
      listLocalProviders: async () => providers, readDeviceProviders: async () => providers,
      listReceivedShares: () => [share('s1', { providerId: 'openai' })],
    }));
    const member = (kind: 'local' | 'device' | 'share', agentDeviceId: string | null, providerId: string) => ({
      key: `${kind}:${agentDeviceId}:${providerId}`, kind, agentDeviceId, providerId, limit: 4, weight: 1, paused: false,
    });
    const members = [member('local', null, 'openai'), member('device', 'mini', 'openai'),
      member('device', 'mini', 'openai-api'), member('device', 'off', 'openai'),
      member('share', 'share:s1', 'openai'), member('local', null, 'openai-disabled')];
    await directory.resolveMembers('openai', { strategy: 'least', autoSwitch: true, members });
    expect(readCodexUsage.mock.calls.map(([entry]) => entry.key)).toEqual(members.slice(0, 2).map((m) => m.key));
  });

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

  it.each(['resolve', 'reject'] as const)('bounds local load reads and ignores a late %s', async (outcome) => {
    vi.useFakeTimers();
    try {
      const directory = createProviderGroupDirectory(deps({
        localRunning: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 4_000));
          if (outcome === 'reject') throw new Error('db busy');
          return 6;
        },
      }));
      const done = vi.fn();
      void directory.resolveMembers('anthropic', {
        strategy: 'least',
        autoSwitch: true,
        members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false }],
      }).then(done);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(done).toHaveBeenCalledTimes(1);
      const [resolved] = done.mock.calls[0][0];
      expect(resolved).toMatchObject({ state: 'ok', member: { key: 'local' } });
      expect(resolved.reportedRunning).toBeUndefined();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(done).toHaveBeenCalledTimes(1);
      expect(resolved.reportedRunning).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

describe('resolving members quickly when choosing a computer (2026-10-11)', () => {
  const MINI = { key: 'device:mini:anthropic-1a2b3c4d', kind: 'device' as const, agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d', limit: 4, weight: 1, paused: false };
  const OTHER = { key: 'device:other:anthropic-1a2b3c4d', kind: 'device' as const, agentDeviceId: 'other', providerId: 'anthropic-1a2b3c4d', limit: 4, weight: 1, paused: false };
  const SLOW = { key: 'device:slow:anthropic', kind: 'device' as const, agentDeviceId: 'slow', providerId: 'anthropic', label: 'Slow PC', limit: 4, weight: 1, paused: false };
  const config: ProviderGroupConfig = { strategy: 'order', autoSwitch: true, members: [SLOW, MINI] };

  function slowDeps(): ProviderGroupDirectoryDeps {
    return deps({
      listDevices: async () => [device('mini'), device('slow')],
      readDeviceProviders: vi.fn((id: string) => id === 'slow'
        ? new Promise<ProviderView[]>(() => undefined)
        : Promise.resolve([view('anthropic-1a2b3c4d', 'Claude')])),
    });
  }

  it('stops waiting for a slow computer once one that can take the task is known', async () => {
    vi.useFakeTimers();
    try {
      const directory = createProviderGroupDirectory(slowDeps());
      const done = vi.fn();
      void directory.resolveMembers('anthropic', config, { quickMs: 3_000, enough: (r) => r.state === 'ok' }).then(done);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalledTimes(1);
      const resolved = done.mock.calls[0][0] as Array<{ member: { key: string }; state: string; pending?: boolean; label: string }>;
      expect(resolved.map((r) => [r.member.key, r.state, r.pending ?? false])).toEqual([
        [SLOW.key, 'offline', true],
        [MINI.key, 'ok', false],
      ]);
      expect(resolved[0].label).toBe('Slow PC');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an available computer when its quota read outlives the quick selection window', async () => {
    vi.useFakeTimers();
    try {
      const usage = new Promise<null>(() => undefined);
      const directory = createProviderGroupDirectory(deps({
        listDevices: async () => [device('mini'), device('other')],
        readDeviceProviders: vi.fn(async () => [view('anthropic-1a2b3c4d', 'Claude')]),
        readClaudeUsage: vi.fn(async (member: ProviderGroupMember) => member.key === MINI.key ? usage : null),
      }));
      const done = vi.fn();
      void directory.resolveMembers('anthropic', { strategy: 'usage', autoSwitch: true, members: [MINI, OTHER] }, {
        quickMs: 3_000,
        enough: (r) => r.state === 'ok',
      }).then(done);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalledTimes(1);
      const resolved = done.mock.calls[0][0] as Array<{ state: string; pending?: boolean; claudeUsage?: unknown }>;
      expect(resolved).toMatchObject([
        { member: { key: MINI.key }, state: 'ok' },
        { member: { key: OTHER.key }, state: 'ok' },
      ]);
      expect(resolved[0].pending).toBeUndefined();
      expect(resolved[0].claudeUsage).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the local computer when its catalog is slow and its load read stalls', async () => {
    vi.useFakeTimers();
    try {
      const local: ProviderGroupMember = {
        key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false,
      };
      const directory = createProviderGroupDirectory({
        ...slowDeps(),
        listLocalProviders: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
          return [view('anthropic', 'Anthropic')];
        },
        localRunning: () => new Promise<number | null>(() => undefined),
      });
      const done = vi.fn();
      void directory.resolveMembers('anthropic', { ...config, members: [local, SLOW] }, {
        quickMs: 3_000,
        enough: (resolved) => resolved.state === 'ok',
      }).then(done);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(done).toHaveBeenCalledTimes(1);
      expect(done.mock.calls[0][0]).toMatchObject([
        { member: { key: local.key }, state: 'ok' },
        { member: { key: SLOW.key }, state: 'offline', pending: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting when the completed quota makes the known computer unavailable', async () => {
    vi.useFakeTimers();
    try {
      const directory = createProviderGroupDirectory(deps({
        listDevices: async () => [device('mini'), device('slow')],
        readDeviceProviders: vi.fn((id: string) => id === 'slow'
          ? new Promise<ProviderView[]>((resolve) => {
              setTimeout(() => resolve([view('anthropic', 'Claude')]), 4_000);
            })
          : Promise.resolve([view('anthropic-1a2b3c4d', 'Claude')])),
        readClaudeUsage: async (member) => member.key === MINI.key
          ? { updatedAt: 0, fiveHour: { utilization: 100, resetsAt: 80_000 }, sevenDay: { utilization: 20, resetsAt: 80_000 } }
          : null,
      }));
      const done = vi.fn();
      void directory.resolveMembers('anthropic', config, {
        quickMs: 3_000,
        enough: (resolved) => resolved.state === 'ok' && resolved.claudeUsage?.fiveHour?.utilization !== 100,
      }).then(done);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(done).toHaveBeenCalledTimes(1);
      expect(done.mock.calls[0][0]).toMatchObject([
        { member: { key: SLOW.key }, state: 'ok' },
        { member: { key: MINI.key }, state: 'ok', claudeUsage: { fiveHour: { utilization: 100 } } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting when none of the computers read so far can take the task', async () => {
    vi.useFakeTimers();
    try {
      const directory = createProviderGroupDirectory(slowDeps());
      const done = vi.fn();
      void directory.resolveMembers('anthropic', config, { quickMs: 3_000, enough: () => false }).then(done);
      await vi.advanceTimersByTimeAsync(10_000);
      // 不会因为慢就当作都不能用。
      expect(done).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('设备列表本身很慢时，也受三秒快速选择窗口管——本机成员先给出结论就不等它(chatgpt-codex-connector P2, PR #5792 review)', async () => {
    vi.useFakeTimers();
    try {
      const LOCAL = { key: 'local', kind: 'local' as const, agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false };
      const cfg: ProviderGroupConfig = { strategy: 'order', autoSwitch: true, members: [LOCAL, MINI] };
      // listDevices 永远不完成：如果设备列表读取在 settleQuickly 计时器启动前就 await，这里会永远不返回。
      const directory = createProviderGroupDirectory(deps({ listDevices: () => new Promise<DeviceLinkDeviceView[]>(() => undefined) }));
      const done = vi.fn();
      void directory.resolveMembers('anthropic', cfg, { quickMs: 3_000, enough: (r) => r.state === 'ok' }).then(done);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalledTimes(1);
      const resolved = done.mock.calls[0][0] as Array<{ member: { key: string }; state: string; pending?: boolean }>;
      expect(resolved.map((r) => [r.member.key, r.state, r.pending ?? false])).toEqual([
        [LOCAL.key, 'ok', false],
        [MINI.key, 'offline', true],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the latest state instead of the short-lived cache when asked', async () => {
    const readDeviceProviders = vi.fn(async () => [view('anthropic-1a2b3c4d', 'Claude')]);
    const directory = createProviderGroupDirectory(deps({ listDevices: async () => [device('mini')], readDeviceProviders }));
    const cfg: ProviderGroupConfig = { strategy: 'order', autoSwitch: true, members: [MINI] };
    await directory.resolveMembers('anthropic', cfg);
    await directory.resolveMembers('anthropic', cfg);
    expect(readDeviceProviders).toHaveBeenCalledTimes(1);
    await directory.resolveMembers('anthropic', cfg, { fresh: true });
    expect(readDeviceProviders).toHaveBeenCalledTimes(2);
  });

  it('tells how long a same-account computer has been offline', async () => {
    const directory = createProviderGroupDirectory(deps({
      listDevices: async () => [
        device('mini'),
        device('off', { online: false, lastSeenAt: new Date(10_000).toISOString() }),
        device('never', { online: false, lastSeenAt: null }),
      ],
      now: () => 250_000,
    }));
    expect(await directory.offlineForMs?.('off')).toBe(240_000);
    expect(await directory.offlineForMs?.('mini')).toBeNull();
    expect(await directory.offlineForMs?.('never')).toBeNull();
    expect(await directory.offlineForMs?.('share:s1')).toBeNull();
  });
});

describe('shared computers that refuse or stay offline', () => {
  it('treats a sharer refusing this account as unavailable, not offline (no waiting for it to come back)', async () => {
    const directory = createProviderGroupDirectory(deps({
      listReceivedShares: () => [share('s5')],
      readDeviceProviders: vi.fn(async () => {
        throw new Error('[REMOTE_AGENT_SHARE_UNAVAILABLE] the shared provider is not available right now');
      }),
    }));
    expect(await directory.probe('share:s5', 'anthropic')).toBe('unavailable');
  });

  it('tells how long a shared computer has been seen offline, so a long-gone one is not waited for', async () => {
    let now = 1_000;
    let online = false;
    const directory = createProviderGroupDirectory(deps({
      now: () => now,
      listReceivedShares: () => [share('s6', { hostOnline: online })],
    }));
    expect(await directory.offlineForMs!('share:s6')).toBe(0);
    now += 150_000;
    expect(await directory.offlineForMs!('share:s6')).toBe(150_000);
    online = true;
    expect(await directory.offlineForMs!('share:s6')).toBeNull();
  });
});
