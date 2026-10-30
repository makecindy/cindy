/**
 * 组内电脑的状态以组所在电脑为准(provider-groups.md §5，2026-10-11 用户确认)：冷却落盘、重启后照样避开；
 * 选电脑不等慢的那台；带着这一轮试过的来选时现读最新状态。
 */
import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import type { ProviderGroupDirectory, ResolvedProviderGroupMember } from '../directory';
import {
  createProviderGroupRouter,
  PROVIDER_GROUP_PICK_QUICK_MS,
  type ProviderGroupPersistedCooling,
} from '../router';

const MODEL = 'claude-opus-5-5';
const START = 1_000_000;

function view(id: string): ProviderView {
  return {
    id,
    name: id,
    agents: ['claude-code'],
    connected: true,
    models: { 'claude-code': [{ id: MODEL, name: MODEL, efforts: [], defaultEffort: null }] },
    routing: { 'claude-code': {} },
  } as unknown as ProviderView;
}

function member(key: string, agentDeviceId: string): ProviderGroupMember {
  return { key, kind: 'device', agentDeviceId, providerId: 'anthropic', limit: 4, weight: 1, paused: false };
}

const A = member('device:a:anthropic', 'a');
const B = member('device:b:anthropic', 'b');
const CONFIG: ProviderGroupConfig = { strategy: 'order', autoSwitch: true, members: [A, B] };

function harness(resolveMembers: ProviderGroupDirectory['resolveMembers'], persisted: { value: ProviderGroupPersistedCooling }, now = START) {
  return createProviderGroupRouter({
    directory: {
      resolveMembers,
      listCandidates: async () => [],
      readDeviceCatalog: async () => [],
      probe: async () => 'ok' as const,
      memberLabel: (m) => m.key,
      invalidate: () => undefined,
    },
    readGroup: (id) => (id === 'anthropic' ? CONFIG : null),
    listBindings: () => ({}),
    isTurnRunning: () => false,
    coolingStore: {
      read: () => persisted.value,
      write: (value) => {
        persisted.value = value;
      },
    },
    now: () => now,
    random: () => 0,
  });
}

const bothOk = async (): Promise<ResolvedProviderGroupMember[]> => [
  { member: A, label: 'a', state: 'ok', view: view('anthropic') },
  { member: B, label: 'b', state: 'ok', view: view('anthropic') },
];

describe('provider group state kept by the group computer', () => {
  it('restores model scopes without blocking other models, and bounds legacy unscoped records', async () => {
    const persisted = { value: {} as ProviderGroupPersistedCooling };
    const router = harness(bothOk, persisted);
    router.markCooling('anthropic', A.key, START + 86_400_000, 'claude-fable-5[1m]');
    const restarted = harness(bothOk, persisted);
    expect(restarted.coolingUntil('anthropic', A.key, 'fable')).toBe(START + 86_400_000);
    expect(restarted.coolingUntil('anthropic', A.key, MODEL)).toBeNull();
    expect((await restarted.view('anthropic')).members[0].state).toBe('available');
    expect(await restarted.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL }))
      .toMatchObject({ kind: 'member', member: { key: A.key } });
    // PR #6322: 仅在内存截短会让每次重建 router 都重新冷却两分钟；unit 覆盖真实加载/保存入口。
    const oldStore = { value: { anthropic: { [A.key]: START + 86_400_000 } } as ProviderGroupPersistedCooling };
    const legacy = harness(bothOk, oldStore);
    expect(legacy.coolingUntil('anthropic', A.key)).toBe(START + 120_000);
    expect(oldStore.value.anthropic[A.key]).toEqual({ '': START + 120_000 });
    expect(harness(bothOk, oldStore, START + 60_000).coolingUntil('anthropic', A.key)).toBe(START + 120_000);
    const afterExpiry = harness(bothOk, oldStore, START + 180_000);
    expect(afterExpiry.coolingUntil('anthropic', A.key)).toBeNull();
    expect(await afterExpiry.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL }))
      .toMatchObject({ kind: 'member', member: { key: A.key } });
  });

  it('remembers cooldowns across restarts and drops the ones that have ended', async () => {
    const persisted = { value: {} as ProviderGroupPersistedCooling };
    const router = harness(bothOk, persisted);
    router.markCooling('anthropic', A.key, START + 3 * 60 * 60_000);
    expect(persisted.value).toEqual({ anthropic: { [A.key]: { '': START + 3 * 60 * 60_000 } } });
    const restarted = harness(bothOk, { value: { anthropic: { [A.key]: START + 60_000, [B.key]: START - 1 } } });
    expect(restarted.coolingUntil('anthropic', A.key)).toBe(START + 60_000);
    expect(restarted.coolingUntil('anthropic', B.key)).toBeNull();
    expect(await restarted.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL }))
      .toMatchObject({ kind: 'member', member: { key: B.key } });
  });

  it('does not wait for slow computers once one that can take the task is known, and reads fresh when asked', async () => {
    const resolveMembers = vi.fn<ProviderGroupDirectory['resolveMembers']>(async () => [
      // A 到点还没读完：这次按不能用算。
      { member: A, label: 'a', state: 'offline', pending: true },
      { member: B, label: 'b', state: 'ok', view: view('anthropic') },
    ]);
    const router = harness(resolveMembers, { value: {} });
    expect(await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL }))
      .toMatchObject({ kind: 'member', member: { key: B.key } });
    const options = resolveMembers.mock.calls[0][2];
    expect(options?.quickMs).toBe(PROVIDER_GROUP_PICK_QUICK_MS);
    expect(options?.fresh).toBeUndefined();
    // 够用 = 能用、没在冷却、没满、这一轮没试过。
    expect(options?.enough?.({ member: B, label: 'b', state: 'ok', view: view('anthropic') })).toBe(true);
    expect(options?.enough?.({ member: A, label: 'a', state: 'offline' })).toBe(false);
    router.markCooling('anthropic', B.key, START + 60_000);
    expect(options?.enough?.({ member: B, label: 'b', state: 'ok', view: view('anthropic') })).toBe(false);

    await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL, exclude: new Set([A.key]), fresh: true });
    expect(resolveMembers.mock.calls[1][2]?.fresh).toBe(true);
  });
});
