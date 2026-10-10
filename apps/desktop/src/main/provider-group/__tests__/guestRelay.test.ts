/**
 * 组所在电脑替受邀者选组内电脑(provider-groups.md §4、§9)：只选能按受邀者隔离的电脑；不支持的
 * 同账号电脑一阵子不再给它受邀者的任务，但不冷却它(本机自己的任务照常分过去)。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import { createProviderGroupExternalLoad } from '../externalLoad';
import { createProviderGroupGuestRelay, PROVIDER_GROUP_GUEST_INCAPABLE_MS } from '../guestRelay';
import { PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS } from '../remoteHandler';
import { PROVIDER_GROUP_DEFAULT_COOLDOWN_MS, type ProviderGroupPickInput, type ProviderGroupRouter } from '../router';

function member(key: string, kind: ProviderGroupMember['kind'], agentDeviceId: string | null, providerId: string): ProviderGroupMember {
  return { key, kind, agentDeviceId, providerId, limit: 4, weight: 1, paused: false };
}

const LOCAL = member('local', 'local', null, 'anthropic');
const MINI = member('device:mini:anthropic-2', 'device', 'mini', 'anthropic-2');
const FRIEND = member('share:s1:anthropic', 'share', 'share:s1', 'anthropic');
const CONFIG: ProviderGroupConfig = { strategy: 'order', autoSwitch: true, members: [LOCAL, MINI, FRIEND] };

function setup(picks: ProviderGroupMember[], config: ProviderGroupConfig = CONFIG) {
  let now = 1_000;
  let current = true;
  const router = {
    pick: vi.fn(async ({ exclude, onPicked }: ProviderGroupPickInput) => {
      const next = picks.find((m) => !exclude?.has(m.key));
      if (next) onPicked?.(next.key);
      return next ? { kind: 'member' as const, member: next, label: next.key, resolved: [] } : { kind: 'unavailable' as const, resolved: [] };
    }),
    view: vi.fn(),
    running: vi.fn(() => 0),
    markCooling: vi.fn(),
    coolingUntil: vi.fn(() => null),
    markTried: vi.fn(() => new Set<string>()),
    triedThisTurn: vi.fn(() => new Set<string>()),
    resetTurn: vi.fn(),
  } as unknown as ProviderGroupRouter & { pick: ReturnType<typeof vi.fn>; markCooling: ReturnType<typeof vi.fn> };
  const externalLoad = createProviderGroupExternalLoad({ now: () => now });
  const invoke = vi.fn(async () => ({}));
  const relay = createProviderGroupGuestRelay({
    scope: () => ({ router, externalLoad, isCurrent: () => current }),
    readGroup: (id) => (id === 'anthropic' ? config : null),
    connect: () => ({ invoke, poller: {} as never }),
    now: () => now,
    log: { warn: vi.fn() },
  });
  return {
    relay,
    router,
    externalLoad,
    invoke,
    advance: (ms: number) => { now += ms; },
    switchAccount: () => { current = false; },
  };
}

const PLAN = { kind: 'claude-code' as const, model: 'opus', providerId: 'anthropic', exclude: new Set<string>() };

describe('provider group guest relay planner', () => {
  it('maps the picked computer: this computer runs locally, others are relayed', async () => {
    expect(await setup([LOCAL]).relay.plan(PLAN)).toEqual({ kind: 'local' });
    expect(await setup([MINI]).relay.plan(PLAN)).toEqual({
      kind: 'member', memberKey: MINI.key, agentDeviceId: 'mini', providerId: 'anthropic-2', sameAccount: true,
    });
    expect(await setup([FRIEND]).relay.plan(PLAN)).toEqual({
      kind: 'member', memberKey: FRIEND.key, agentDeviceId: 'share:s1', providerId: 'anthropic', sameAccount: false,
    });
    expect(await setup([]).relay.plan(PLAN)).toEqual({ kind: 'unavailable' });
    expect(await setup([MINI]).relay.plan({ ...PLAN, providerId: 'openai' })).toBeNull();
  });

  it('skips a same-account computer that cannot isolate shared users for a while, without cooling it', async () => {
    const env = setup([MINI, FRIEND]);
    env.relay.noteStartFailure('anthropic', { memberKey: MINI.key, agentDeviceId: 'mini', providerId: MINI.providerId, sameAccount: true },
      new Error('[REMOTE_AGENT_PEER_TOO_OLD] old'));
    expect(env.router.markCooling).not.toHaveBeenCalled();
    expect((await env.relay.plan(PLAN))).toMatchObject({ memberKey: FRIEND.key });
    env.advance(PROVIDER_GROUP_GUEST_INCAPABLE_MS + 1);
    expect((await env.relay.plan(PLAN))).toMatchObject({ memberKey: MINI.key });
  });

  it('cools a computer that failed to start for a reason of its own', async () => {
    const env = setup([MINI]);
    env.relay.noteStartFailure('anthropic', { memberKey: MINI.key, agentDeviceId: 'mini', providerId: MINI.providerId, sameAccount: true },
      new Error('prompt is too long'));
    expect(env.router.markCooling).not.toHaveBeenCalled();
    env.relay.noteStartFailure('anthropic', { memberKey: MINI.key, agentDeviceId: 'mini', providerId: MINI.providerId, sameAccount: true },
      new Error('[REMOTE_AGENT_DEVICE_UNREACHABLE] gone'));
    expect(env.router.markCooling).toHaveBeenCalledWith('anthropic', MINI.key, expect.any(Number));
    expect(env.router.markCooling.mock.calls[0][2]).toBeLessThan(1_000 + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS);
  });

  it('cools a computer whose relayed task failed mid-run for a reason of its own', () => {
    const env = setup([MINI]);
    const mini = { memberKey: MINI.key, agentDeviceId: 'mini', providerId: MINI.providerId, sameAccount: true };
    // 换到哪台都一样的失败：不冷却，也不换。
    expect(env.relay.noteRunFailure('anthropic', mini, { message: 'prompt is too long', sdkError: 'invalid_request' })).toBe(false);
    expect(env.router.markCooling).not.toHaveBeenCalled();
    expect(env.relay.noteRunFailure('anthropic', mini, { usageLimit: true, message: 'usage limit' })).toBe(true);
    expect(env.router.markCooling).toHaveBeenLastCalledWith('anthropic', MINI.key, 1_000 + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS);
    expect(env.relay.noteRunFailure('anthropic', mini, { reason: 'remote_agent_closed' })).toBe(true);
    expect(env.router.markCooling.mock.calls.at(-1)?.[2]).toBeLessThan(1_000 + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS);
    // 没有组的供应商，或那台已被移出组：不冷却、不换(成为普通的远程 Agent 任务)。
    const calls = env.router.markCooling.mock.calls.length;
    expect(env.relay.noteRunFailure('openai', mini, { usageLimit: true })).toBe(false);
    expect(env.relay.noteRunFailure('anthropic', { ...mini, memberKey: 'device:gone:anthropic' }, { usageLimit: true })).toBe(false);
    expect(env.router.markCooling.mock.calls.length).toBe(calls);
  });

  it('cools until the reported reset time, trusting it at most 8 days', () => {
    const router = { markCooling: vi.fn() } as unknown as ProviderGroupRouter & { markCooling: ReturnType<typeof vi.fn> };
    let resetAt = 1_000 + 3 * 60 * 60_000;
    const externalLoad = createProviderGroupExternalLoad({ now: () => 1_000 });
    const relay = createProviderGroupGuestRelay({
      scope: () => ({ router, externalLoad, isCurrent: () => true }),
      readGroup: () => CONFIG,
      connect: () => ({ invoke: vi.fn(), poller: {} as never }),
      readResetAt: () => resetAt,
      now: () => 1_000,
      log: { warn: vi.fn() },
    });
    const mini = { memberKey: MINI.key, agentDeviceId: 'mini', providerId: MINI.providerId, sameAccount: true };
    relay.noteRunFailure('anthropic', mini, { usageLimit: true });
    expect(router.markCooling).toHaveBeenLastCalledWith('anthropic', MINI.key, resetAt);
    resetAt = 1_000 + 30 * 24 * 60 * 60_000;
    relay.noteRunFailure('anthropic', mini, { usageLimit: true });
    expect(router.markCooling).toHaveBeenLastCalledWith('anthropic', MINI.key, 1_000 + PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS);
  });

  it('still cools the computer but offers no switch when the group has automatic switching turned off', () => {
    const env = setup([MINI], { ...CONFIG, autoSwitch: false });
    const mini = { memberKey: MINI.key, agentDeviceId: 'mini', providerId: MINI.providerId, sameAccount: true };
    expect(env.relay.noteRunFailure('anthropic', mini, { usageLimit: true, message: 'usage limit' })).toBe(false);
    expect(env.router.markCooling).toHaveBeenCalledWith('anthropic', MINI.key, expect.any(Number));
  });

  it('counts the picked computer in the same step it is picked, when asked to', async () => {
    const env = setup([MINI, LOCAL]);
    const relayed = await env.relay.plan({ ...PLAN, reserve: true });
    expect(env.externalLoad.running('anthropic', MINI.key)).toBe(1);
    expect(relayed).toMatchObject({ kind: 'member', memberKey: MINI.key, load: expect.anything() });
    const local = await env.relay.plan({ ...PLAN, exclude: new Set([MINI.key]), reserve: true });
    expect(local).toMatchObject({ kind: 'local', load: expect.anything() });
    expect(env.externalLoad.running('anthropic', LOCAL.key)).toBe(1);
    // 只是问问有没有能接的电脑时不预占。
    await env.relay.plan(PLAN);
    expect(env.externalLoad.running('anthropic', MINI.key)).toBe(1);
  });

  it('drops a pick made for the previous account', async () => {
    const env = setup([MINI]);
    env.router.pick.mockImplementationOnce(async (input: ProviderGroupPickInput) => {
      env.switchAccount();
      input.onPicked?.(MINI.key);
      return { kind: 'member' as const, member: MINI, label: MINI.key, resolved: [] };
    });
    expect(await env.relay.plan({ ...PLAN, reserve: true })).toEqual({ kind: 'unavailable' });
    expect(env.externalLoad.running('anthropic', MINI.key)).toBe(0);
  });

  it('counts relayed tasks while they run and asks computers to forget a shared user', async () => {
    const env = setup([MINI]);
    const load = env.relay.trackRun('anthropic', MINI.key);
    expect(env.externalLoad.running('anthropic', MINI.key)).toBe(1);
    load.setRunning(false);
    expect(env.externalLoad.running('anthropic', MINI.key)).toBe(0);
    load.setRunning(true);
    load.release();
    expect(env.externalLoad.running('anthropic', MINI.key)).toBe(0);
    await env.relay.forget('mini', 'a'.repeat(32));
    expect(env.invoke).toHaveBeenCalledWith([{ op: 'forget', relay: 'a'.repeat(32) }]);
  });
});
