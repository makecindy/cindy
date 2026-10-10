/**
 * 组所在电脑这一侧(provider-groups.md §4–§6)：同账号其他电脑来问该用哪台、报告冷却与运行中的任务；
 * 目录只给同账号电脑补组摘要。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import {
  createProviderGroupExternalLoad,
  PROVIDER_GROUP_LEASE_TTL_MS,
  PROVIDER_GROUP_PROVISIONAL_MS,
} from '../externalLoad';
import {
  decorateProviderListWithGroups,
  handleProviderGroupRemote,
  PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS,
  type ProviderGroupRemoteHandlerDeps,
} from '../remoteHandler';
import type { ProviderGroupDirectory } from '../directory';
import {
  createProviderGroupRouter,
  PROVIDER_GROUP_DEFAULT_COOLDOWN_MS,
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
  type ProviderGroupPickInput,
  type ProviderGroupRouter,
} from '../router';

const MINI: ProviderGroupMember = {
  key: 'device:mini:anthropic-1a2b3c4d',
  kind: 'device',
  agentDeviceId: 'mini',
  providerId: 'anthropic-1a2b3c4d',
  label: 'Mini',
  limit: 4,
  weight: 1,
  paused: false,
};
const CONFIG: ProviderGroupConfig = {
  strategy: 'least',
  autoSwitch: true,
  members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false }, MINI],
};

function deps(overrides: Partial<ProviderGroupRemoteHandlerDeps> = {}) {
  let now = 10_000;
  let ownerCurrent = true;
  const externalLoad = createProviderGroupExternalLoad({ now: () => now });
  const router = {
    pick: vi.fn(async (input: ProviderGroupPickInput) => {
      input.onPicked?.(MINI.key);
      return { kind: 'member' as const, member: MINI, label: 'Mini', resolved: [] };
    }),
    view: vi.fn(async () => ({ providerId: 'anthropic', config: CONFIG, members: [] })),
    running: vi.fn(() => 0),
    markCooling: vi.fn(),
    coolingUntil: vi.fn(() => null),
    markTried: vi.fn(() => new Set<string>()),
    triedThisTurn: vi.fn(() => new Set<string>()),
    resetTurn: vi.fn(),
  } satisfies ProviderGroupRouter;
  const value = {
    scope: () => ({ router, externalLoad, isCurrent: () => ownerCurrent }),
    readGroup: (id: string) => (id === 'anthropic' ? CONFIG : null),
    isRemoteAllowed: () => true,
    now: () => now,
    ...overrides,
  } satisfies ProviderGroupRemoteHandlerDeps;
  return {
    ...value,
    router,
    externalLoad,
    advance: (ms: number) => { now += ms; },
    switchAccount: () => { ownerCurrent = false; },
  };
}

const PICK = { action: 'pick', sessionId: 's1', providerId: 'anthropic', agentKind: 'claude-code', model: 'opus', exclude: ['local'] };

describe('provider-group:remote', () => {
  it('picks a computer, honouring what the caller already tried, and holds it briefly', async () => {
    const d = deps();
    const result = await handleProviderGroupRemote(d, 'laptop', PICK);
    expect(d.router.pick).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'anthropic', agentKind: 'claude-code', model: 'opus', exclude: new Set(['local']),
    }));
    expect(result).toEqual({
      kind: 'member',
      member: { key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d' },
      label: 'Mini',
    });
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(1);
    d.advance(PROVIDER_GROUP_PROVISIONAL_MS + 1);
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(0);
  });

  it('answers that there is no group for providers without one or no longer open to other computers', async () => {
    expect(await handleProviderGroupRemote(deps(), 'laptop', { ...PICK, providerId: 'openai' })).toEqual({ kind: 'none' });
    expect(await handleProviderGroupRemote(deps({ isRemoteAllowed: () => false }), 'laptop', PICK)).toEqual({ kind: 'none' });
  });

  it('reports that no computer can take the task', async () => {
    const d = deps();
    d.router.pick.mockResolvedValueOnce({ kind: 'unavailable', resolved: [] } as never);
    expect(await handleProviderGroupRemote(d, 'laptop', PICK)).toEqual({ kind: 'unavailable' });
  });

  it('cools computers for usage limits up to a bounded reset time, and briefly for other causes', async () => {
    const d = deps();
    await handleProviderGroupRemote(d, 'laptop', { action: 'cool', providerId: 'anthropic', memberKey: MINI.key, cause: 'usage-limit', resetAt: 50_000 });
    expect(d.router.markCooling).toHaveBeenLastCalledWith('anthropic', MINI.key, 50_000);
    await handleProviderGroupRemote(d, 'laptop', { action: 'cool', providerId: 'anthropic', memberKey: MINI.key, cause: 'usage-limit', resetAt: 10_000 + 365 * 86_400_000 });
    expect(d.router.markCooling).toHaveBeenLastCalledWith('anthropic', MINI.key, 10_000 + PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS);
    await handleProviderGroupRemote(d, 'laptop', { action: 'cool', providerId: 'anthropic', memberKey: MINI.key, cause: 'usage-limit' });
    expect(d.router.markCooling).toHaveBeenLastCalledWith('anthropic', MINI.key, 10_000 + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS);
    await handleProviderGroupRemote(d, 'laptop', { action: 'cool', providerId: 'anthropic', memberKey: MINI.key, cause: 'auth' });
    expect(d.router.markCooling).toHaveBeenLastCalledWith('anthropic', MINI.key, 10_000 + PROVIDER_GROUP_FAILURE_COOLDOWN_MS);
  });

  it('refuses to cool computers outside the group and rejects causes it does not cool for', async () => {
    const d = deps();
    await handleProviderGroupRemote(d, 'laptop', { action: 'cool', providerId: 'anthropic', memberKey: 'device:x:y', cause: 'auth' });
    expect(d.router.markCooling).not.toHaveBeenCalled();
    await expect(handleProviderGroupRemote(d, 'laptop', { action: 'cool', providerId: 'anthropic', memberKey: MINI.key, cause: 'unavailable' }))
      .rejects.toThrow('[INVALID_PARAMS]');
  });

  it('counts the running tasks each computer reports and drops stale or out-of-order reports', async () => {
    const d = deps();
    const lease = { sessionId: 's1', providerId: 'anthropic', memberKey: MINI.key };
    await handleProviderGroupRemote(d, 'laptop', { action: 'leases', seq: 5, entries: [lease, { ...lease, sessionId: 's2' }] });
    await handleProviderGroupRemote(d, 'desktop', { action: 'leases', seq: 1, entries: [{ ...lease, sessionId: 's9' }] });
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(3);
    // 乱序到达的旧报告不能盖掉新的。
    await handleProviderGroupRemote(d, 'laptop', { action: 'leases', seq: 4, entries: [] });
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(3);
    await handleProviderGroupRemote(d, 'laptop', { action: 'leases', seq: 6, entries: [] });
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(1);
    d.advance(PROVIDER_GROUP_LEASE_TTL_MS + 1);
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(0);
  });

  it('does not double count a picked task once it is reported', async () => {
    const d = deps();
    await handleProviderGroupRemote(d, 'laptop', PICK);
    await handleProviderGroupRemote(d, 'laptop', { action: 'leases', seq: 1, entries: [{ sessionId: 's1', providerId: 'anthropic', memberKey: MINI.key }] });
    expect(d.externalLoad.running('anthropic', MINI.key)).toBe(1);
  });

  it('spreads requests that arrive together instead of sending them all to the same computer', async () => {
    const now = 10_000;
    const externalLoad = createProviderGroupExternalLoad({ now: () => now });
    const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [MINI, { ...MINI, key: 'device:studio:anthropic', agentDeviceId: 'studio', providerId: 'anthropic', label: 'Studio' }] };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const directory: ProviderGroupDirectory = {
      // 两个请求都在等目录时，读负载与选电脑要在目录回来后的同一步里完成。
      resolveMembers: async (_providerId, cfg) => {
        await gate;
        return cfg.members.map((m) => ({
          member: m,
          label: m.label ?? m.key,
          state: 'ok' as const,
          view: {
            id: m.providerId,
            name: m.providerId,
            agents: ['claude-code'],
            connected: true,
            models: { 'claude-code': [{ id: 'opus', name: 'opus', efforts: [], defaultEffort: null }] },
            routing: { 'claude-code': {} },
          } as never,
        }));
      },
      listCandidates: async () => [],
      readDeviceCatalog: async () => [],
      invalidate: vi.fn(),
    };
    const router = createProviderGroupRouter({
      directory,
      readGroup: () => config,
      listBindings: () => ({}),
      isTurnRunning: () => false,
      externalRunning: (p, m) => externalLoad.running(p, m),
      now: () => now,
      random: () => 0,
    });
    const d = {
      scope: () => ({ router, externalLoad, isCurrent: () => true }),
      readGroup: () => config,
      isRemoteAllowed: () => true,
      now: () => now,
    } satisfies ProviderGroupRemoteHandlerDeps;
    const first = handleProviderGroupRemote(d, 'laptop', { ...PICK, exclude: [] });
    const second = handleProviderGroupRemote(d, 'desktop', { ...PICK, sessionId: 's2', exclude: [] });
    release();
    const picked = (await Promise.all([first, second])).map((r) => (r as { member?: { key: string } }).member?.key);
    expect(new Set(picked).size).toBe(2);
  });

  it('drops a pick when the account changed while it waited for the directory', async () => {
    const d = deps();
    d.router.pick.mockImplementationOnce(async (input: ProviderGroupPickInput) => {
      d.switchAccount();
      input.onPicked?.(MINI.key);
      return { kind: 'member' as const, member: MINI, label: 'Mini', resolved: [] };
    });
    expect(await handleProviderGroupRemote(d, 'laptop', PICK)).toEqual({ kind: 'none' });
  });

  it('rejects malformed requests', async () => {
    for (const raw of [null, { action: 'nope' }, { ...PICK, agentKind: 'x' }, { ...PICK, sessionId: '../x' }, { action: 'leases', seq: -1, entries: [] }]) {
      await expect(handleProviderGroupRemote(deps(), 'laptop', raw)).rejects.toThrow('[INVALID_PARAMS]');
    }
  });
});

describe('decorateProviderListWithGroups', () => {
  it('adds the group summary only to providers that have a group and stay open for remote use', () => {
    const result = decorateProviderListWithGroups({
      providers: [
        { id: 'anthropic', remoteInvocationEnabled: true },
        { id: 'openai', remoteInvocationEnabled: true, group: { forged: true } },
        { id: 'anthropic', remoteInvocationEnabled: false },
      ],
      other: 1,
    }, (id) => (id === 'anthropic' ? CONFIG : null)) as { providers: Array<Record<string, unknown>>; other: number };
    expect(result.other).toBe(1);
    expect(result.providers[0].group).toEqual({
      strategy: 'least',
      autoSwitch: true,
      members: [
        { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', paused: false },
        { key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mini', paused: false },
      ],
    });
    // 只有本机设置能产生组摘要；没开放的不带。
    expect(result.providers[1]).not.toHaveProperty('group');
    expect(result.providers[2]).not.toHaveProperty('group');
  });
});
