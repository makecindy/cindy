/**
 * useGlmCodingPlanUsage warm read 的 effect 级回归(#2768 七轮 Codex P1 ②)。
 *
 * mount 时 getGlmCodingPlan 的 IPC 挂起期间切账号:resolve 回来的快照属于旧
 * data owner,必须整体丢弃 —— 不得写进新 owner 的 module 缓存(chip 会先 seed
 * 旧账号余量),也不得触发 setState。与 useGlmCodingPlanUsage.test.ts 的纯函数
 * 用例互补:这里验证的是 .then() 里的 owner 复核接线本身。
 */

// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// owner 代际由测试侧可控切换(直接 mock 数据源)。
const ownerState = vi.hoisted(() => ({ dataOwnerId: 'owner-1' as string | null }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: ownerState.dataOwnerId }),
}));

import {
  ownerScopedGlmSnapshots,
  useGlmCodingPlanUsage,
} from '../hooks/useGlmCodingPlanUsage';
import type { GlmCodingPlanUsageSnapshot } from '../../shared/glmCodingPlanUsage';

const SNAPSHOT_A: GlmCodingPlanUsageSnapshot = {
  fiveHour: { utilization: 40, resetsAt: null },
  monthlyMcp: { utilization: 8, resetsAt: null },
  platform: 'zhipu',
  source: 'monitor-endpoint',
  updatedAt: 1,
};

function stubUsageApi(
  getGlmCodingPlan: (providerId: string) => Promise<unknown | null>,
): void {
  vi.stubGlobal('electronAPI', {
    maker: {
      usage: {
        getGlmCodingPlan,
        onGlmCodingPlanUsageChanged: vi.fn(() => () => {}),
      },
    },
  });
}

beforeEach(() => {
  // 切 owner 触发清空再回到基准,隔离用例间 module 缓存残留。
  ownerState.dataOwnerId = 'reset-owner';
  ownerScopedGlmSnapshots();
  ownerState.dataOwnerId = 'owner-1';
  ownerScopedGlmSnapshots();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('warm read owner 复核(#2768 七轮 ②)', () => {
  it('applies the persisted snapshot when the owner is unchanged (control)', async () => {
    stubUsageApi(async () => SNAPSHOT_A);
    const { result } = renderHook(() => useGlmCodingPlanUsage('zhipu-coding-plan', true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toBe(SNAPSHOT_A);
    expect(ownerScopedGlmSnapshots().get('zhipu-coding-plan')).toBe(SNAPSHOT_A);
  });

  it('drops the result when the data owner switches while the IPC is pending', async () => {
    let resolveRead!: (value: unknown | null) => void;
    stubUsageApi(() => new Promise((res) => { resolveRead = res; }));
    const { result } = renderHook(() => useGlmCodingPlanUsage('zhipu-coding-plan', true));
    // IPC 挂起期间切到新账号(同名 provider 复用同一 id)
    ownerState.dataOwnerId = 'owner-2';
    await act(async () => { resolveRead(SNAPSHOT_A); });
    expect(result.current).toBeNull(); // 旧账号余量不 seed 新账号的 chip
    expect(ownerScopedGlmSnapshots().has('zhipu-coding-plan')).toBe(false);
  });

  it('drops a null (clear) result from the previous owner too', async () => {
    // 反向也成立:旧 owner 的清除结果不得把新 owner 刚写入的快照抹掉。
    ownerState.dataOwnerId = 'owner-2';
    ownerScopedGlmSnapshots().set('zhipu-coding-plan', SNAPSHOT_A);
    let resolveRead!: (value: unknown | null) => void;
    stubUsageApi(() => new Promise((res) => { resolveRead = res; }));
    const { result } = renderHook(() => useGlmCodingPlanUsage('zhipu-coding-plan', true));
    ownerState.dataOwnerId = 'owner-3'; // 挂起期间再切
    await act(async () => { resolveRead(null); });
    // hook 状态仍是挂载时 seed 的值 —— 旧 owner 的 clear 未把它误清成 null。
    // (切号后 module 缓存由 ownerScopedGlmSnapshots 自身整体作废,纯函数用例
    // 已覆盖,此处不再经 scoped accessor 断言缓存。)
    expect(result.current).toBe(SNAPSHOT_A);
  });
});
