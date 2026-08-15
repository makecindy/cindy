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

// owner 代际由测试侧可控切换(直接 mock 数据源,不起 React 环境)。
const ownerState = vi.hoisted(() => ({ dataOwnerId: 'owner-1' as string | null }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: ownerState.dataOwnerId }),
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

describe('ownerScopedGlmSnapshots (data owner 隔离, #2768 首轮 ②)', () => {
  beforeEach(() => {
    // 切到新 owner 触发清空,再回到基准 owner,隔离用例间的残留。
    ownerState.dataOwnerId = 'reset-owner';
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
});

describe('isGlmPushOwnerCurrent (推送 owner 世代戳, #2768 r3788720174)', () => {
  beforeEach(() => {
    ownerState.dataOwnerId = 'owner-1';
  });

  it('accepts pushes stamped with the current owner and legacy unstamped pushes', () => {
    expect(isGlmPushOwnerCurrent({ providerId: 'p1', ownerId: 'owner-1', snapshot: SNAPSHOT }))
      .toBe(true);
    // ownerId 缺失 / null(旧版 main / 异常)按未知沿用,不误丢
    expect(isGlmPushOwnerCurrent({ providerId: 'p1', snapshot: SNAPSHOT })).toBe(true);
    expect(isGlmPushOwnerCurrent({ providerId: 'p1', ownerId: null, snapshot: SNAPSHOT }))
      .toBe(true);
  });

  it('rejects late pushes from a previous owner (queued before the account switch)', () => {
    expect(isGlmPushOwnerCurrent({ providerId: 'p1', ownerId: 'owner-old', snapshot: SNAPSHOT }))
      .toBe(false);
  });
});
