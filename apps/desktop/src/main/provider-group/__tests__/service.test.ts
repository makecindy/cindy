/**
 * 供应商组接到任务生命周期(provider-groups.md §6)：
 * - 新任务第一次启动前按组策略分配，已有原生会话 / 已指定电脑的不动；
 * - 分配后 Agent 没能启动时换下一台，每台最多一次；
 * - 运行中因那台电脑的原因失败时交接到下一台并继续这一轮，全部试过才交回原有处理。
 */
import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import type { ProviderGroupBinding } from '../bindings';
import type { ProviderGroupDirectory, ResolvedProviderGroupMember } from '../directory';
import { createProviderGroupGuestSwitch, PROVIDER_GROUP_SWITCH_OFFER_TTL_MS } from '../guestSwitch';
import { createProviderGroupRouter, PROVIDER_GROUP_DEFAULT_COOLDOWN_MS } from '../router';
import {
  createProviderGroupService,
  PROVIDER_GROUP_SUPERSEDED_ERROR,
  PROVIDER_GROUP_UNAVAILABLE_ERROR,
  type ProviderGroupServiceDeps,
  type ProviderGroupSessionRow,
} from '../service';

const MODEL = 'claude-opus-5-5';

function view(id: string, model: Record<string, unknown> = {}): ProviderView {
  return {
    id,
    name: id,
    agents: ['claude-code'],
    connected: true,
    models: { 'claude-code': [{ id: MODEL, name: MODEL, efforts: [], defaultEffort: null, ...model }] },
    routing: { 'claude-code': {} },
  } as unknown as ProviderView;
}

function member(kind: ProviderGroupMember['kind'], agentDeviceId: string | null, providerId: string): ProviderGroupMember {
  const key = kind === 'local' ? 'local' : `${kind}:${agentDeviceId!.replace(/^share:/, '')}:${providerId}`;
  return { key, kind, agentDeviceId, providerId, limit: 4, weight: 1, paused: false };
}

const LEASE = { recovery: 'lease' };
const LOCAL = member('local', null, 'anthropic');
const MINI = member('device', 'mini', 'anthropic-1a2b3c4d');
const STUDIO = member('share', 'share:s1', 'anthropic');

function harness(options: {
  members?: ProviderGroupMember[];
  row?: Partial<ProviderGroupSessionRow>;
  offline?: string[];
  autoSwitch?: boolean;
  /** 这些组内电脑上的同名模型不能用于新会话(停用、退役、需要付费)。 */
  unusableModel?: Record<string, Record<string, unknown>>;
} = {}) {
  let now = 1_000_000;
  const config: ProviderGroupConfig = {
    strategy: 'order',
    autoSwitch: options.autoSwitch ?? true,
    members: options.members ?? [LOCAL, MINI, STUDIO],
  };
  const offline = new Set(options.offline ?? []);
  const bindings = new Map<string, ProviderGroupBinding>();
  const directory: ProviderGroupDirectory = {
    async resolveMembers(_providerId, current) {
      return current.members.map((m): ResolvedProviderGroupMember => offline.has(m.key)
        ? { member: m, label: m.key, state: 'offline' }
        : { member: m, label: `${m.key}-name`, state: 'ok', view: view(m.providerId, options.unusableModel?.[m.key]) });
    },
    async listCandidates() {
      return [];
    },
    async readDeviceCatalog() {
      return [];
    },
    memberLabel: (m) => m.label ?? m.key,
    invalidate: vi.fn(),
  };
  const router = createProviderGroupRouter({
    directory,
    readGroup: (id) => (id === 'anthropic' ? config : null),
    listBindings: () => Object.fromEntries(bindings),
    isTurnRunning: () => false,
    now: () => now,
    random: () => 0,
  });
  const row: ProviderGroupSessionRow = {
    agentKind: 'claude-code',
    model: MODEL,
    providerId: 'anthropic',
    agentDeviceId: null,
    remoteHostId: null,
    sdkSessionId: null,
    ...options.row,
  };
  const deps = {
    router,
    directory,
    readGroup: (id: string) => (id === 'anthropic' ? config : null),
    readBinding: (id: string) => bindings.get(id) ?? null,
    writeBinding: vi.fn(async (id: string, binding: { providerId: string; memberKey: string } | null) => {
      if (binding) bindings.set(id, { ...binding, at: now });
      else bindings.delete(id);
    }),
    readSessionRow: vi.fn(async () => row),
    resolveImplicitProvider: vi.fn(async () => 'anthropic'),
    persistRoute: vi.fn(async (_id: string, route: { agentDeviceId: string | null; providerId: string | null }) => {
      row.agentDeviceId = route.agentDeviceId;
      row.providerId = route.providerId;
    }),
    hasAssistantHistory: vi.fn(async () => false),
    isFailoverEligible: vi.fn(async () => true),
    leaseRecovery: vi.fn((): object | null => LEASE),
    isLeaseCurrent: vi.fn(() => true),
    rearmContinue: vi.fn((): number | null => 99),
    cancelContinue: vi.fn(),
    switchAgentLocation: vi.fn(async (_id: string, route: { agentDeviceId: string | null; providerId: string | null }) => {
      row.agentDeviceId = route.agentDeviceId;
      row.providerId = route.providerId;
    }),
    isTurnRunning: vi.fn(() => false),
    continueSession: vi.fn(async () => 'resumed' as const),
    fallback: vi.fn(),
    readResetAt: vi.fn(() => null),
    now: () => now,
    log: { info: vi.fn(), warn: vi.fn() },
  } satisfies ProviderGroupServiceDeps;
  const service = createProviderGroupService(deps);
  return { service, deps, row, bindings, router, config, offline, advance: (ms: number) => { now += ms; } };
}

async function flush() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

describe('assignBeforeStart', () => {
  it('assigns a fresh task to the first available computer and writes the route back', async () => {
    const h = harness({ offline: ['local'] });
    const context = await h.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL });
    expect(context?.member.key).toBe(MINI.key);
    expect(context?.route).toEqual({ agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d' });
    expect(h.deps.persistRoute).toHaveBeenCalledWith('s1', { agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d' });
    expect(h.bindings.get('s1')?.memberKey).toBe(MINI.key);
  });

  it('keeps the task local without touching its route when this computer is chosen', async () => {
    const h = harness({ row: { providerId: null } });
    const context = await h.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL });
    expect(context?.member.key).toBe('local');
    expect(context?.route).toEqual({ agentDeviceId: null, providerId: null });
    expect(h.deps.persistRoute).not.toHaveBeenCalled();
    expect(h.bindings.get('s1')).toMatchObject({ providerId: 'anthropic', memberKey: 'local' });
  });

  it('leaves tasks that already run elsewhere alone and never moves a started task', async () => {
    for (const row of [{ agentDeviceId: 'other' }, { remoteHostId: 'ssh-1' }]) {
      const h = harness({ row });
      expect(await h.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL })).toBeNull();
      expect(h.deps.writeBinding).not.toHaveBeenCalled();
    }
    const started = harness({ row: { sdkSessionId: 'native-1' } });
    expect(await started.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL })).toBeNull();
    expect(started.deps.persistRoute).not.toHaveBeenCalled();
  });

  it('binds a task that already ran to this computer instead of moving it', async () => {
    const h = harness();
    h.deps.hasAssistantHistory.mockResolvedValue(true);
    expect(await h.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL })).toBeNull();
    expect(h.deps.persistRoute).not.toHaveBeenCalled();
    expect(h.bindings.get('s1')?.memberKey).toBe('local');
  });

  it('does nothing for providers without a group', async () => {
    const h = harness({ row: { providerId: 'openai' } });
    expect(await h.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL })).toBeNull();
  });

  it('reports a clear error when no computer in the group can take the task', async () => {
    const h = harness({ offline: ['local', MINI.key, STUDIO.key] });
    await expect(h.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL }))
      .rejects.toThrow(PROVIDER_GROUP_UNAVAILABLE_ERROR);
  });

  it('skips computers whose model cannot be used for a new task', async () => {
    for (const unusable of [{ disabled: true }, { status: 'retired' }, { availability: 'requires_payment' }]) {
      const h = harness({ unusableModel: { local: unusable } });
      const context = await h.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL });
      expect(context?.member.key).toBe(MINI.key);
    }
  });

  it('keeps a start context for a bound task that never ran, so a failed start can move on', async () => {
    const h = harness({ row: { agentDeviceId: 'mini', providerId: MINI.providerId } });
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: MINI.key, at: 1 });
    const context = await h.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL });
    expect(context).toMatchObject({ member: { key: MINI.key }, route: { agentDeviceId: 'mini', providerId: MINI.providerId } });
    expect(h.deps.persistRoute).not.toHaveBeenCalled();
    const next = await h.service.nextAfterStartFailure(context!, new Error('[REMOTE_AGENT_DEVICE_UNREACHABLE] x'));
    expect(next?.member.key).not.toBe(MINI.key);

    // 已经运行过的任务换电脑要走交接，这里不带启动上下文。
    const ran = harness({ row: { agentDeviceId: 'mini', providerId: MINI.providerId, sdkSessionId: 'native-1' } });
    ran.bindings.set('s1', { providerId: 'anthropic', memberKey: MINI.key, at: 1 });
    expect(await ran.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL })).toBeNull();
  });

  it('drops the binding when the user moved the task out of the group', async () => {
    const h = harness({ row: { agentDeviceId: 'somewhere', providerId: 'p', sdkSessionId: 'x' } });
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: MINI.key, at: 1 });
    expect(await h.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL })).toBeNull();
    expect(h.bindings.has('s1')).toBe(false);
  });
});

describe('nextAfterStartFailure', () => {
  it('moves to the next computer when the assigned one could not start the agent', async () => {
    const h = harness({ offline: ['local'] });
    const context = await h.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL });
    const next = await h.service.nextAfterStartFailure(context!, new Error('[REMOTE_AGENT_UNAVAILABLE] remote agent request failed'));
    expect(next?.member.key).toBe(STUDIO.key);
    expect(h.row).toMatchObject({ agentDeviceId: 'share:s1', providerId: 'anthropic' });
    // 每台最多一次：第二台也失败后没有下一台了。
    expect(await h.service.nextAfterStartFailure(next!, new Error('[REMOTE_AGENT_UNAVAILABLE] x'))).toBeNull();
  });

  it('does not retry failures that are not about the computer', async () => {
    const h = harness({ offline: ['local'] });
    const context = await h.service.assignBeforeStart({ sessionId: 's1', agentKind: 'claude-code', model: MODEL });
    expect(await h.service.nextAfterStartFailure(context!, new Error('working directory is missing'))).toBeNull();
  });
});

describe('onTurnError (automatic switch)', () => {
  it('hands the task to the next computer and continues the turn with an activity row', async () => {
    const h = harness();
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 7);
    await flush();
    expect(h.deps.leaseRecovery).toHaveBeenCalledWith('s1', 7);
    expect(h.deps.switchAgentLocation).toHaveBeenCalledWith('s1', {
      agentKind: 'claude-code',
      model: MODEL,
      providerId: 'anthropic-1a2b3c4d',
      agentDeviceId: 'mini',
    }, { isCurrent: expect.any(Function) });
    expect(h.bindings.get('s1')?.memberKey).toBe(MINI.key);
    // 交接后用新令牌续跑(旧会话关闭撤销了原来的等待)。
    expect(h.deps.rearmContinue).toHaveBeenCalledWith('s1', LEASE, expect.any(Number));
    expect(h.deps.continueSession).toHaveBeenCalledWith('s1', 99, expect.objectContaining({
      agentSwitch: { from: 'local-name', to: `${MINI.key}-name`, cause: 'usage-limit' },
    }));
    expect(h.deps.fallback).not.toHaveBeenCalled();
    // 撞到用量上限的那台进入冷却，新任务不会分到它。
    expect(h.router.coolingUntil('anthropic', 'local')).toBe(1_000_000 + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS);
  });

  it('switches back to this computer with its provider when a remote member fails', async () => {
    const h = harness({ members: [MINI, LOCAL] , row: { agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d' } });
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: MINI.key, at: 1 });
    h.service.onTurnError('s1', { message: '[REMOTE_AGENT_UNAVAILABLE] gone' }, 3);
    await flush();
    expect(h.deps.switchAgentLocation).toHaveBeenCalledWith('s1', expect.objectContaining({ agentDeviceId: null, providerId: 'anthropic' }), expect.anything());
  });

  it('tries each computer once per turn and then hands back to the existing handling', async () => {
    const h = harness({ members: [LOCAL, MINI] });
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 2);
    await flush();
    expect(h.deps.switchAgentLocation).toHaveBeenCalledTimes(1);
    expect(h.deps.fallback).toHaveBeenCalledWith('s1', { sdkError: 'rate_limit' }, 2);
  });

  it('does not switch for failures any computer would hit, or when auto switch is off', async () => {
    const h = harness();
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    h.service.onTurnError('s1', { message: 'prompt is too long', sdkError: 'invalid_request' }, 1);
    await flush();
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.deps.fallback).toHaveBeenCalledTimes(1);

    const off = harness({ autoSwitch: false });
    off.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    off.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(off.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(off.deps.fallback).toHaveBeenCalledTimes(1);
  });

  it('leaves tasks that are not group-bound to the existing handling', async () => {
    const h = harness();
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(h.deps.fallback).toHaveBeenCalledTimes(1);
    expect(h.deps.leaseRecovery).not.toHaveBeenCalled();
  });

  it('does nothing when the user already took over the error', async () => {
    const h = harness();
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    h.deps.leaseRecovery.mockReturnValue(null);
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.deps.fallback).not.toHaveBeenCalled();
  });

  it('tries the next computer when a handoff fails, and hands back when none works', async () => {
    const h = harness();
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    h.deps.switchAgentLocation.mockRejectedValueOnce(new Error('[REMOTE_AGENT_DEVICE_UNREACHABLE] unreachable'));
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(h.deps.switchAgentLocation).toHaveBeenCalledTimes(2);
    expect(h.deps.switchAgentLocation.mock.calls[1][1]).toMatchObject({ agentDeviceId: 'share:s1' });
    expect(h.bindings.get('s1')?.memberKey).toBe(STUDIO.key);
    expect(h.deps.continueSession).toHaveBeenCalledTimes(1);

    const none = harness({ members: [LOCAL, MINI] });
    none.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    none.deps.switchAgentLocation.mockRejectedValue(new Error('[REMOTE_AGENT_DEVICE_UNREACHABLE] unreachable'));
    // 交接失败时旧会话可能已关闭：原令牌失效，用重新登记的候选交回原有处理。
    none.deps.leaseRecovery.mockReturnValueOnce(LEASE).mockReturnValue(null);
    none.deps.rearmContinue.mockReturnValue(42);
    none.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(none.deps.rearmContinue).toHaveBeenCalledWith('s1', LEASE, null);
    expect(none.deps.fallback).toHaveBeenCalledWith('s1', { sdkError: 'rate_limit' }, 42);
    expect(none.bindings.get('s1')?.memberKey).toBe('local');
    expect(none.deps.continueSession).not.toHaveBeenCalled();
  });

  it('stops without blaming the target when the handoff fails for an unrelated reason', async () => {
    const h = harness();
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    h.deps.switchAgentLocation.mockRejectedValueOnce(new Error('[SESSION_RUNNING] Session s1 is running a turn'));
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(h.deps.switchAgentLocation).toHaveBeenCalledTimes(1);
    expect(h.router.coolingUntil('anthropic', MINI.key)).toBeNull();
    expect(h.bindings.get('s1')?.memberKey).toBe('local');
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    expect(h.deps.fallback).toHaveBeenCalledTimes(1);
  });

  it('stops every remaining step once the user takes over mid-switch', async () => {
    // 用户在第一次交接期间接手：交接在改动之前作废，不再试下一台、不冷却、不交回、不续跑。
    const h = harness();
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    h.deps.switchAgentLocation.mockImplementationOnce(async (_id, _route, options?: { isCurrent?: () => boolean }) => {
      h.service.noteUserAction('s1');
      if (options?.isCurrent && !options.isCurrent()) throw new Error(PROVIDER_GROUP_SUPERSEDED_ERROR);
    });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(h.deps.switchAgentLocation).toHaveBeenCalledTimes(1);
    expect(h.router.coolingUntil('anthropic', MINI.key)).toBeNull();
    expect(h.deps.rearmContinue).not.toHaveBeenCalled();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    expect(h.deps.fallback).not.toHaveBeenCalled();

    // 交接已经完成但用户随即接手：不替用户续跑。
    const done = harness();
    done.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    done.deps.switchAgentLocation.mockImplementationOnce(async () => {
      done.service.noteUserAction('s1');
    });
    done.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(done.deps.rearmContinue).not.toHaveBeenCalled();
    expect(done.deps.continueSession).not.toHaveBeenCalled();
  });

  it('leaves the binding alone when the user takes over while the next computer is being picked', async () => {
    const h = harness();
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    const pick = h.router.pick.bind(h.router);
    vi.spyOn(h.router, 'pick').mockImplementation(async (input) => {
      const result = await pick(input);
      h.service.noteUserAction('s1');
      return result;
    });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.bindings.get('s1')?.memberKey).toBe('local');
    expect(h.deps.fallback).not.toHaveBeenCalled();
  });

  it('hands back with a valid token when switching breaks unexpectedly', async () => {
    const h = harness();
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    // 交接已关掉旧会话(原令牌失效)后，还原绑定时读任务记录出错。
    h.deps.switchAgentLocation.mockRejectedValueOnce(new Error('[REMOTE_AGENT_DEVICE_UNREACHABLE] unreachable'));
    h.deps.readSessionRow.mockResolvedValueOnce(h.row).mockRejectedValueOnce(new Error('db closed'));
    h.deps.leaseRecovery.mockReturnValueOnce(LEASE).mockReturnValue(null);
    h.deps.rearmContinue.mockReturnValue(42);
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(h.deps.rearmContinue).toHaveBeenCalledWith('s1', LEASE, null);
    expect(h.deps.fallback).toHaveBeenCalledTimes(1);
    expect(h.deps.fallback).toHaveBeenCalledWith('s1', { sdkError: 'rate_limit' }, 42);
  });

  it('does not try the next computer once the error is no longer current', async () => {
    const h = harness();
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    h.deps.switchAgentLocation.mockRejectedValueOnce(new Error('[REMOTE_AGENT_DEVICE_UNREACHABLE] unreachable'));
    // 第一次交接失败后，那次错误已被新 turn / 中断自愈接管。
    h.deps.isLeaseCurrent.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(h.deps.switchAgentLocation).toHaveBeenCalledTimes(1);
    expect(h.deps.fallback).not.toHaveBeenCalled();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
  });

  it('does not continue when the user took over during the handoff', async () => {
    const h = harness();
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    h.deps.rearmContinue.mockReturnValue(null);
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(h.deps.switchAgentLocation).toHaveBeenCalledTimes(1);
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    expect(h.deps.fallback).not.toHaveBeenCalled();
  });

  it('never switches between two accounts on the same computer', async () => {
    const MINI2 = member('device', 'mini', 'anthropic-9f9f9f9f');
    const h = harness({ members: [MINI, MINI2, LOCAL], row: { agentDeviceId: 'mini', providerId: MINI.providerId } });
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: MINI.key, at: 1 });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(h.deps.switchAgentLocation).toHaveBeenCalledWith('s1', expect.objectContaining({ agentDeviceId: null }), expect.anything());
  });

  it('respects a manual move: the binding is dropped and the task is not moved back', async () => {
    const h = harness({ row: { agentDeviceId: 'studio-not-in-group', providerId: 'anthropic' } });
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: MINI.key, at: 1 });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.bindings.has('s1')).toBe(false);
    expect(h.router.coolingUntil('anthropic', MINI.key)).toBeNull();
    expect(h.deps.fallback).toHaveBeenCalledTimes(1);
  });

  it('starts a new round after the user takes over', async () => {
    const h = harness({ members: [LOCAL, MINI] });
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    h.service.noteUserAction('s1');
    h.advance(PROVIDER_GROUP_DEFAULT_COOLDOWN_MS + 1);
    h.service.onTurnError('s1', { message: '[REMOTE_AGENT_UNAVAILABLE] gone' }, 2);
    await flush();
    expect(h.deps.switchAgentLocation).toHaveBeenCalledTimes(2);
  });
});

describe('beforeSend', () => {
  it('moves a task off a computer that went offline before sending, without an extra continue', async () => {
    const h = harness({ offline: [MINI.key], row: { agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d', sdkSessionId: 'native' } });
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: MINI.key, at: 1 });
    await h.service.beforeSend('s1');
    expect(h.deps.switchAgentLocation).toHaveBeenCalledWith(
      's1',
      { agentKind: 'claude-code', model: MODEL, providerId: 'anthropic', agentDeviceId: null },
      { beforeSend: true },
    );
    expect(h.bindings.get('s1')?.memberKey).toBe('local');
    expect(h.deps.continueSession).not.toHaveBeenCalled();
  });

  it('moves a task off a computer that is cooling down', async () => {
    const h = harness({ row: { sdkSessionId: 'native' } });
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    h.router.markCooling('anthropic', 'local', 2_000_000);
    await h.service.beforeSend('s1');
    expect(h.bindings.get('s1')?.memberKey).toBe(MINI.key);
  });

  it('leaves tasks alone when their computer is fine, paused, running, or not grouped', async () => {
    const fine = harness({ row: { sdkSessionId: 'native' } });
    fine.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    await fine.service.beforeSend('s1');
    expect(fine.deps.switchAgentLocation).not.toHaveBeenCalled();

    const paused = harness({ members: [{ ...LOCAL, paused: true }, MINI], offline: ['local'] });
    paused.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    await paused.service.beforeSend('s1');
    expect(paused.deps.switchAgentLocation).not.toHaveBeenCalled();

    const running = harness({ offline: ['local'] });
    running.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    running.deps.isTurnRunning.mockReturnValue(true);
    await running.service.beforeSend('s1');
    expect(running.deps.switchAgentLocation).not.toHaveBeenCalled();

    const loose = harness({ offline: ['local'] });
    await loose.service.beforeSend('s1');
    expect(loose.deps.readSessionRow).not.toHaveBeenCalled();
  });

  it('keeps the binding when the move fails, so the send reports the original problem', async () => {
    const h = harness({ offline: ['local'] });
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: 'local', at: 1 });
    h.deps.switchAgentLocation.mockRejectedValueOnce(new Error('unreachable'));
    await h.service.beforeSend('s1');
    expect(h.bindings.get('s1')?.memberKey).toBe('local');
  });
});

describe('onTurnError for a shared user (the sharer’s group picks the computer)', () => {
  const SHARE_ROUTE = 'share:share-from-alice';

  function guestHarness() {
    let clock = 5_000;
    const guestSwitch = createProviderGroupGuestSwitch(() => clock);
    const h = harness({ row: { agentDeviceId: SHARE_ROUTE, providerId: 'alice-anthropic' } });
    const service = createProviderGroupService({ ...h.deps, guestSwitch });
    return { ...h, service, guestSwitch, tick: (ms: number) => { clock += ms; } };
  }

  it('hands off and reopens with the token when the group computer asks to switch', async () => {
    const h = guestHarness();
    h.guestSwitch.offer('s1', 'token-aaaaaaaaaaaaaaaa');
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 7);
    await flush();
    // 位置仍是同一个分享：强制重新交接。
    expect(h.deps.switchAgentLocation).toHaveBeenCalledWith('s1', {
      agentKind: 'claude-code',
      model: MODEL,
      providerId: 'alice-anthropic',
      agentDeviceId: SHARE_ROUTE,
    }, { isCurrent: expect.any(Function), relocate: true });
    // 交接时重新打开带上凭证(这里交接是假的，凭证仍在等打开)。
    expect(h.guestSwitch.takeForOpen('s1')).toBe('token-aaaaaaaaaaaaaaaa');
    expect(h.deps.continueSession).toHaveBeenCalledWith('s1', 99, expect.objectContaining({
      groupSwitch: { cause: 'usage-limit' },
    }));
    const info = (h.deps.continueSession.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(info).not.toHaveProperty('agentSwitch');
    expect(h.deps.fallback).not.toHaveBeenCalled();
    // 分享来的电脑不在本机的任何组里：不冷却、不写绑定。
    expect(h.bindings.size).toBe(0);
  });

  it('leaves the error to the existing handling without a token from the group computer', async () => {
    const h = guestHarness();
    h.service.onTurnError('s1', { message: '[REMOTE_AGENT_SHARE_PAUSED] paused' }, 3);
    await flush();
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.deps.fallback).toHaveBeenCalledWith('s1', { message: '[REMOTE_AGENT_SHARE_PAUSED] paused' }, 3);
  });

  it('ignores a stale token, a token the user already took over from, and failures any computer would hit', async () => {
    const stale = guestHarness();
    stale.guestSwitch.offer('s1', 'token-aaaaaaaaaaaaaaaa');
    stale.tick(PROVIDER_GROUP_SWITCH_OFFER_TTL_MS + 1);
    stale.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(stale.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(stale.deps.fallback).toHaveBeenCalledTimes(1);

    const tookOver = guestHarness();
    tookOver.guestSwitch.offer('s1', 'token-aaaaaaaaaaaaaaaa');
    tookOver.service.noteUserAction('s1');
    tookOver.service.onTurnError('s1', { sdkError: 'rate_limit' }, 1);
    await flush();
    expect(tookOver.deps.switchAgentLocation).not.toHaveBeenCalled();

    const sameEverywhere = guestHarness();
    sameEverywhere.guestSwitch.offer('s1', 'token-aaaaaaaaaaaaaaaa');
    sameEverywhere.service.onTurnError('s1', { message: 'prompt is too long', sdkError: 'invalid_request' }, 1);
    await flush();
    expect(sameEverywhere.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(sameEverywhere.deps.fallback).toHaveBeenCalledTimes(1);
  });

  it('drops the token and hands back when the handoff does not go through', async () => {
    const h = guestHarness();
    h.guestSwitch.offer('s1', 'token-aaaaaaaaaaaaaaaa');
    h.deps.switchAgentLocation.mockRejectedValueOnce(new Error('[REMOTE_AGENT_SHARE_PAUSED] paused'));
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 4);
    await flush();
    expect(h.guestSwitch.takeForOpen('s1')).toBeUndefined();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    expect(h.deps.fallback).toHaveBeenCalledWith('s1', { sdkError: 'rate_limit' }, 4);
  });
});
