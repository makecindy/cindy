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
import { PROVIDER_GROUP_DEFAULT_COOLDOWN_MS, PROVIDER_GROUP_FAILURE_COOLDOWN_MS, type ProviderGroupRouter } from '../router';

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
    pick: vi.fn(async () => ({ kind: 'member' as const, member: MINI, label: 'Mini', resolved: [] })),
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
  return { ...value, router, externalLoad, advance: (ms: number) => { now += ms; } };
}

const PICK = { action: 'pick', sessionId: 's1', providerId: 'anthropic', agentKind: 'claude-code', model: 'opus', exclude: ['local'] };

describe('provider-group:remote', () => {
  it('picks a computer, honouring what the caller already tried, and holds it briefly', async () => {
    const d = deps();
    const result = await handleProviderGroupRemote(d, 'laptop', PICK);
    expect(d.router.pick).toHaveBeenCalledWith({ providerId: 'anthropic', agentKind: 'claude-code', model: 'opus', exclude: new Set(['local']) });
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
