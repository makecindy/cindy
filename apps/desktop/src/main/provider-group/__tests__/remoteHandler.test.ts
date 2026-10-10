/**
 * 组所在电脑这一侧(provider-groups.md §4–§6)：同账号其他电脑来问该用哪台、报告冷却与运行中的任务；
 * 目录只给同账号电脑补组摘要。
 */
import type { ProviderView } from '@cindy/model-providers';
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
import {
  PROVIDER_GROUP_DEFAULT_COOLDOWN_MS,
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
  createProviderGroupRouter,
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
  const router = {
    // 真实分配器的契约：选中的同一步调 occupy 记临时占用，不让并发分配都挑中同一台。
    pick: vi.fn(async (input: ProviderGroupPickInput) => {
      input.occupy?.(MINI.key);
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
  const externalLoad = createProviderGroupExternalLoad({ now: () => now });
  const value = {
    router,
    externalLoad,
    readGroup: (id: string) => (id === 'anthropic' ? CONFIG : null),
    isRemoteAllowed: () => true,
    now: () => now,
    ...overrides,
  } satisfies ProviderGroupRemoteHandlerDeps;
  return {
    ...value,
    // 测试直接驱动的是默认那份假实现；覆盖进来的(真实分配器 / 换账号的负载)原样生效。
    router: (overrides.router ?? router) as typeof router,
    externalLoad: (overrides.externalLoad ?? externalLoad) as typeof externalLoad,
    advance: (ms: number) => { now += ms; },
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

  it('rejects malformed requests', async () => {
    for (const raw of [null, { action: 'nope' }, { ...PICK, agentKind: 'x' }, { ...PICK, sessionId: '../x' }, { action: 'leases', seq: -1, entries: [] }]) {
      await expect(handleProviderGroupRemote(deps(), 'laptop', raw)).rejects.toThrow('[INVALID_PARAMS]');
    }
  });

  it('records the occupancy in the same step as picking, so concurrent requests do not pile onto one computer', async () => {
    // 真实分配器 + 真实负载记录：两次并发分配都读到同一份目录时，第二次要看到第一次的临时占用。
    const A: ProviderGroupMember = {
      key: 'device:a:anthropic', kind: 'device', agentDeviceId: 'a', providerId: 'anthropic', label: 'A', limit: 4, weight: 1, paused: false,
    };
    const B: ProviderGroupMember = { ...A, key: 'device:b:anthropic', agentDeviceId: 'b', label: 'B' };
    const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [A, B] };
    const view = {
      id: 'anthropic', name: 'Claude', agents: ['claude-code'], connected: true,
      models: { 'claude-code': [{ id: 'claude-opus-5-5', name: 'Opus' }] }, routing: {},
    } as unknown as ProviderView;
    const externalLoad = createProviderGroupExternalLoad({ now: () => 10_000 });
    const router = createProviderGroupRouter({
      directory: {
        // 两次请求都进到选电脑之前才返回，复现“读完目录再各自记账”的交错。
        resolveMembers: async () => {
          await Promise.resolve();
          await Promise.resolve();
          return [A, B].map((member) => ({ member, label: member.label!, state: 'ok' as const, view }));
        },
        listCandidates: async () => [],
        readDeviceCatalog: async () => [],
        invalidate: () => undefined,
      },
      readGroup: (id) => (id === 'anthropic' ? config : null),
      listBindings: () => ({}),
      isTurnRunning: () => false,
      externalRunning: (providerId, memberKey) => externalLoad.running(providerId, memberKey),
      now: () => 10_000,
      random: () => 0,
    });
    const d = deps({ router, externalLoad });
    const results = await Promise.all([
      handleProviderGroupRemote(d, 'laptop', { ...PICK, model: 'claude-opus-5-5' }),
      handleProviderGroupRemote(d, 'laptop', { ...PICK, sessionId: 's2', model: 'claude-opus-5-5' }),
    ]);
    expect(results.map((r) => (r as { member?: { key: string } }).member?.key).sort()).toEqual([A.key, B.key]);
    expect(externalLoad.running('anthropic', A.key)).toBe(1);
    expect(externalLoad.running('anthropic', B.key)).toBe(1);
  });

  it('keeps an in-flight pick on the account it started with and drops it after an account switch', async () => {
    // 等待目录期间换了账号：占用记在旧账号那份负载里，不写进新账号，也不把旧账号的分配发回去。
    const oldLoad = createProviderGroupExternalLoad({ now: () => 10_000 });
    const newLoad = createProviderGroupExternalLoad({ now: () => 10_000 });
    let current = 'account-a';
    const router = {
      pick: vi.fn(async (input: ProviderGroupPickInput) => {
        input.occupy?.(MINI.key);
        current = 'account-b';
        return { kind: 'member' as const, member: MINI, label: 'Mini', resolved: [] };
      }),
      view: vi.fn(), running: vi.fn(), markCooling: vi.fn(), coolingUntil: vi.fn(),
      markTried: vi.fn(), triedThisTurn: vi.fn(), resetTurn: vi.fn(),
    } as unknown as ProviderGroupRouter;
    const d = deps({
      externalLoad: newLoad,
      router,
      pin: () => ({ router, externalLoad: oldLoad, isCurrent: () => current === 'account-a' }),
    });
    expect(await handleProviderGroupRemote(d, 'laptop', PICK)).toEqual({ kind: 'none' });
    expect(oldLoad.running('anthropic', MINI.key)).toBe(1);
    expect(newLoad.running('anthropic', MINI.key)).toBe(0);
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
