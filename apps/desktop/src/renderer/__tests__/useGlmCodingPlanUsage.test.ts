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

import { describe, expect, it } from 'vitest';

import {
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
