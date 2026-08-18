/**
 * useGlmCodingPlanUsage 纯函数单测。
 *
 * resolvePersistedGlmCodingPlanRead: mount 时 getGlmCodingPlan 返回值的归一化 ——
 * 关键回归是 null 必须映射为 'clear'(main 侧 CRUD 清快照 / 换 key 指纹失配已清,
 * 若清除广播先于 hook 订阅发生, renderer 不清 module cache 会把旧 key 的余量
 * 一直顶在 chip 上)。
 *
 * reduceGlmCodingPlanPush: push payload 按 providerId 过滤 —— 其它 provider 的推送
 * 不得覆盖当前 provider 的缓存。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// owner 代际由测试侧可控切换(直接 mock 数据源,不起 React 环境);generation
// 字段驱动十轮 P1-b 的完整世代比对(同 id 重登场景)。
const ownerState = vi.hoisted(() => ({
  dataOwnerId: 'owner-1' as string | null,
  generation: 0,
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({
    dataOwnerId: ownerState.dataOwnerId,
    generation: ownerState.generation,
  }),
  isDataOwnerGenerationCurrent: (owner: { dataOwnerId: string | null; generation: number }) =>
    owner.dataOwnerId === ownerState.dataOwnerId && owner.generation === ownerState.generation,
  isDataOwnerPushStampCurrent: (stamp: unknown) => {
    const value = stamp as { dataOwnerId?: unknown; ownerGeneration?: unknown };
    return Boolean(value && typeof value === 'object')
      && value.dataOwnerId === ownerState.dataOwnerId
      && value.ownerGeneration === ownerState.generation;
  },
}));

import {
  isGlmPushOwnerCurrent,
  ownerScopedGlmSnapshots,
  reduceGlmCodingPlanPush,
  resolvePersistedGlmCodingPlanRead,
} from '../hooks/useGlmCodingPlanUsage';

const SNAPSHOT = {
  fiveHour: { utilization: 40, resetsAt: null },
  monthlyMcp: { utilization: 8, resetsAt: null },
  platform: 'zhipu' as const,
  source: 'monitor-endpoint',
  updatedAt: 1,
};

describe('resolvePersistedGlmCodingPlanRead', () => {
  it('maps null to clear (main already dropped the snapshot; renderer must follow)', () => {
    expect(resolvePersistedGlmCodingPlanRead(null)).toEqual({ action: 'clear' });
  });

  it('applies snapshot-shaped objects', () => {
    expect(resolvePersistedGlmCodingPlanRead(SNAPSHOT)).toEqual({
      action: 'apply',
      snapshot: SNAPSHOT,
    });
  });

  it('ignores malformed payloads without touching current state', () => {
    expect(resolvePersistedGlmCodingPlanRead(undefined)).toEqual({ action: 'ignore' });
    expect(resolvePersistedGlmCodingPlanRead('nope')).toEqual({ action: 'ignore' });
    expect(resolvePersistedGlmCodingPlanRead([1, 2])).toEqual({ action: 'ignore' });
  });
});

describe('reduceGlmCodingPlanPush', () => {
  const current = SNAPSHOT;

  it('clears on a null snapshot broadcast for this provider', () => {
    expect(reduceGlmCodingPlanPush(current, {
      providerId: 'p1',
      snapshot: null,
    })).toBeNull();
  });

  it('replaces with pushed snapshots for this provider', () => {
    const next = { ...SNAPSHOT, fiveHour: { utilization: 61, resetsAt: null } };
    expect(reduceGlmCodingPlanPush(current, { providerId: 'p1', snapshot: next })).toBe(next);
  });

  it('keeps current state on malformed payloads', () => {
    expect(reduceGlmCodingPlanPush(current, null)).toBe(current);
    expect(reduceGlmCodingPlanPush(current, { snapshot: SNAPSHOT })).toBe(current);
    expect(reduceGlmCodingPlanPush(current, 'nope')).toBe(current);
  });
});

describe('ownerScopedGlmSnapshots (完整世代隔离, #2768 首轮 ② + 十轮 P1-b)', () => {
  beforeEach(() => {
    // 切到新 owner 触发清空,再回到基准 owner,隔离用例间的残留。
    ownerState.dataOwnerId = 'reset-owner';
    ownerState.generation += 1;
    ownerScopedGlmSnapshots();
    ownerState.dataOwnerId = 'owner-1';
    ownerScopedGlmSnapshots();
  });

  it('clears cached snapshots when the data owner changes (same-named provider)', () => {
    ownerScopedGlmSnapshots().set('zhipu-coding-plan', SNAPSHOT);
    expect(ownerScopedGlmSnapshots().get('zhipu-coding-plan')).toBe(SNAPSHOT);
    // 换号:双账号同名 GLM provider 复用同一 id —— 缓存必须整体作废,
    // 否则新账号 chip 先 seed 旧账号余量(IPC 读失败时无限期)。
    ownerState.dataOwnerId = 'owner-2';
    expect(ownerScopedGlmSnapshots().get('zhipu-coding-plan')).toBeUndefined();
    // 新 owner 的写入不回渗旧 owner
    const next = { ...SNAPSHOT, fiveHour: { utilization: 5, resetsAt: null } };
    ownerScopedGlmSnapshots().set('zhipu-coding-plan', next);
    ownerState.dataOwnerId = 'owner-1';
    expect(ownerScopedGlmSnapshots().get('zhipu-coding-plan')).toBeUndefined();
  });

  it('十轮 P1-b: clears cached snapshots on a same-id re-login (generation bump)', () => {
    // 同账号重登/本地档案恢复:id 不变、世代前进 —— 缓存同样整体作废,
    // 上一会话的余量不直接给下一会话用。
    ownerScopedGlmSnapshots().set('zhipu-coding-plan', SNAPSHOT);
    expect(ownerScopedGlmSnapshots().get('zhipu-coding-plan')).toBe(SNAPSHOT);
    ownerState.generation += 1;
    expect(ownerScopedGlmSnapshots().get('zhipu-coding-plan')).toBeUndefined();
  });
});

describe('isGlmPushOwnerCurrent (推送 owner 世代戳, #2768 r3788720174 + 十轮 P1-b)', () => {
  beforeEach(() => {
    ownerState.dataOwnerId = 'owner-1';
    ownerState.generation = 3;
  });

  it('accepts pushes stamped with the current full owner stamp', () => {
    expect(isGlmPushOwnerCurrent({
      providerId: 'p1',
      ownerStamp: { dataOwnerId: 'owner-1', ownerGeneration: 3 },
      snapshot: SNAPSHOT,
    })).toBe(true);
  });

  it('十轮 P1-b: rejects a full-stamped push queued before a same-id re-login', () => {
    // 重登:dataOwnerId 不变、世代前进 —— 只比 id 的旧实现会放行
    expect(isGlmPushOwnerCurrent({
      providerId: 'p1',
      ownerStamp: { dataOwnerId: 'owner-1', ownerGeneration: 2 },
      snapshot: SNAPSHOT,
    })).toBe(false);
    expect(isGlmPushOwnerCurrent({
      providerId: 'p1',
      ownerStamp: { dataOwnerId: 'owner-old', ownerGeneration: 3 },
      snapshot: SNAPSHOT,
    })).toBe(false);
  });

  it('十轮 P1-b: fail-closed on malformed stamps instead of accepting null-ish stamps', () => {
    // 意见后半句:此前 null/缺字段戳被无条件接受;现在带 ownerStamp 字段就必须是
    // 形状合法且匹配的完整戳。
    expect(isGlmPushOwnerCurrent({ providerId: 'p1', ownerStamp: null, snapshot: SNAPSHOT }))
      .toBe(false);
    expect(isGlmPushOwnerCurrent({
      providerId: 'p1',
      ownerStamp: { dataOwnerId: 'owner-1' }, // 缺 ownerGeneration
      snapshot: SNAPSHOT,
    })).toBe(false);
    expect(isGlmPushOwnerCurrent({
      providerId: 'p1',
      ownerStamp: 'nope',
      snapshot: SNAPSHOT,
    })).toBe(false);
  });

  it('legacy fallback: id-only stamps (old main) keep the previous semantics', () => {
    expect(isGlmPushOwnerCurrent({ providerId: 'p1', ownerId: 'owner-1', snapshot: SNAPSHOT }))
      .toBe(true);
    expect(isGlmPushOwnerCurrent({ providerId: 'p1', ownerId: 'owner-old', snapshot: SNAPSHOT }))
      .toBe(false);
    // 完全无戳的超旧推送按未知沿用,不误丢
    expect(isGlmPushOwnerCurrent({ providerId: 'p1', snapshot: SNAPSHOT })).toBe(true);
  });
});
