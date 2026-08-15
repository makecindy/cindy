/**
 * usageBroadcaster 的 GLM Coding Plan 快照段单测 —— per-provider 隔离与冷缓存语义:
 *   - 首笔快照不因 owner 首次初始化被世代复查误丢
 *   - 不同 provider 的快照互不串扰(读写按 provider_id 隔离)
 *   - clear 抢先于 in-flight hydration 时, 读回的旧行不得复活
 *   - record 按新快照全量替换(单数据源, 无 merge)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  exec: vi.fn(async () => undefined),
  getCurrentUserId: vi.fn(() => 'user-1'),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../localDb/dailySpend', () => ({
  incrementDailySpend: vi.fn(),
  getTodaySpend: vi.fn(async () => 0),
  localDayKey: () => '2026-08-14',
}));
vi.mock('../localDb/dailyModelUsage', () => ({
  incrementDailyModelUsage: vi.fn(),
}));
vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({ queryOne: mocks.queryOne, exec: mocks.exec, drizzle: {} }),
}));
vi.mock('../localDb/index', () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

function snapshotOf(utilization: number) {
  return {
    fiveHour: { utilization, resetsAt: null },
    platform: 'zhipu' as const,
    source: 'monitor-endpoint',
    updatedAt: utilization,
    keyFingerprint: 'fp-a',
  };
}

describe('glm coding plan snapshot store (per-provider)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryOne.mockReset();
    mocks.exec.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentUserId.mockReturnValue('user-1');
  });

  it('does not drop the very first snapshot after main start', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);

    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', snapshotOf(10));

    const current = await broadcaster.readGlmCodingPlanUsageSnapshot('p1');
    expect(current?.fiveHour?.utilization).toBe(10);
    expect(mocks.exec).toHaveBeenCalled();
  });

  it('keeps snapshots of different providers isolated', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);

    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', snapshotOf(10));
    await broadcaster.recordGlmCodingPlanUsageSnapshot('p2', snapshotOf(80));

    expect((await broadcaster.readGlmCodingPlanUsageSnapshot('p1'))?.fiveHour?.utilization)
      .toBe(10);
    expect((await broadcaster.readGlmCodingPlanUsageSnapshot('p2'))?.fiveHour?.utilization)
      .toBe(80);
  });

  it('clearing one provider does not resurrect it from a stale hydration read', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // 冷缓存: hydration 读挂起,期间 clear 已把快照置 null
    let resolveRead!: (value: { snapshot: string } | null) => void;
    mocks.queryOne.mockReturnValue(new Promise<{ snapshot: string } | null>((res) => {
      resolveRead = res;
    }));

    const readPromise = broadcaster.readGlmCodingPlanUsageSnapshot('p1');
    await broadcaster.clearGlmCodingPlanUsageSnapshot('p1');
    // 挂起的读现在返回旧行 —— 世代已 bump, 不得复活
    resolveRead({ snapshot: JSON.stringify(snapshotOf(99)) });
    await readPromise;

    // clear 之后的 read 视缓存为已知(hydrated), 不再回库
    mocks.queryOne.mockClear();
    await expect(broadcaster.readGlmCodingPlanUsageSnapshot('p1')).resolves.toBeNull();
  });

  it('clearing one provider does not invalidate another provider in-flight hydration (#2768 二轮 r3788460233)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // p1 的 hydration 挂起中;期间无关的 p2 被 clear —— 旧全局世代实现会把 p1
    // 的在飞读一并作废(误丢后一个 180s 节流窗内无法恢复)。
    let resolveP1!: (value: { snapshot: string } | null) => void;
    const p1Read = new Promise<{ snapshot: string } | null>((res) => { resolveP1 = res; });
    mocks.queryOne.mockImplementation(async (_sql: string, params: unknown[]) =>
      (params[0] === 'p1' ? p1Read : null) as { snapshot: string } | null);

    const readPromise = broadcaster.readGlmCodingPlanUsageSnapshot('p1');
    await broadcaster.clearGlmCodingPlanUsageSnapshot('p2');
    resolveP1({ snapshot: JSON.stringify(snapshotOf(42)) });
    await readPromise;

    // p2 的 clear 不影响 p1 —— 42 正常落到缓存(后续 read 已 hydrated,不再回库)
    mocks.queryOne.mockClear();
    const current = await broadcaster.readGlmCodingPlanUsageSnapshot('p1');
    expect(current?.fiveHour?.utilization).toBe(42);
  });

  it('replaces the snapshot wholesale on record (single source, no merge)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);

    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', snapshotOf(40));
    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', {
      ...snapshotOf(60),
      fiveHour: null,
      monthlyMcp: { utilization: 7, resetsAt: null },
    });

    const current = await broadcaster.readGlmCodingPlanUsageSnapshot('p1');
    expect(current?.fiveHour).toBeNull();
    expect(current?.monthlyMcp?.utilization).toBe(7);
  });

  it('ignores non-object snapshots', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);
    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', 'garbage');
    await broadcaster.recordGlmCodingPlanUsageSnapshot('p1', null);
    await expect(broadcaster.readGlmCodingPlanUsageSnapshot('p1')).resolves.toBeNull();
  });
});
