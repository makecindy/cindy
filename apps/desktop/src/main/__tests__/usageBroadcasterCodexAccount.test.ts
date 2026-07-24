/**
 * usageBroadcaster 的 Codex 账号快照分槽单测 —— 两个数据源(codex-app-server /
 * openai-web WHAM)各写各的槽, 不得互相覆盖窗口(2026-07-24 用户实报: WHAM 的
 * Spark 促销桶把 app-server 主配额顶成「8天 剩余 100%」)。
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
  localDayKey: () => '2026-07-24',
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

const APP_SERVER_SNAPSHOT = {
  limitId: 'codex',
  primary: { usedPercent: 82, windowMinutes: 300, resetsAt: 1_800_000_000 },
  secondary: { usedPercent: 55, windowMinutes: 10_080, resetsAt: 1_800_400_000 },
  source: 'codex-app-server',
  updatedAt: 1,
  accountId: 'acc-1',
};

// 典型污染源: WHAM 返回另一个限额桶(模型专属促销桶)的近乎全新 7 天窗口。
const WEB_SNAPSHOT = {
  primary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: 1_800_700_000 },
  secondary: null,
  planType: 'pro',
  source: 'openai-web',
  updatedAt: 2,
  accountId: 'acc-1',
};

describe('codex account usage source slots', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryOne.mockReset().mockResolvedValue(null);
    mocks.exec.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentUserId.mockReturnValue('user-1');
  });

  it('keeps app-server windows when a WHAM snapshot arrives (no cross-source overwrite)', async () => {
    const broadcaster = await import('../usageBroadcaster');

    await broadcaster.recordCodexAccountUsageSnapshot(APP_SERVER_SNAPSHOT);
    await broadcaster.recordCodexAccountUsageSnapshot(WEB_SNAPSHOT);

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    // 顶层(CLI 权威槽)保持 app-server 的 5h/周双窗, 不被 WHAM 的桶顶掉
    expect(payload?.primary?.usedPercent).toBe(82);
    expect(payload?.secondary?.usedPercent).toBe(55);
    expect(payload?.source).toBe('codex-app-server');
    // WHAM 数据完整落在 webSnapshot 槽(bridge 形态消费)
    expect(payload?.webSnapshot?.primary?.usedPercent).toBe(0);
    expect(payload?.webSnapshot?.source).toBe('openai-web');
  });

  it('keeps the web slot intact when app-server events arrive afterwards', async () => {
    const broadcaster = await import('../usageBroadcaster');

    await broadcaster.recordCodexAccountUsageSnapshot(WEB_SNAPSHOT);
    await broadcaster.recordCodexAccountUsageSnapshot(APP_SERVER_SNAPSHOT);

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(payload?.primary?.usedPercent).toBe(82);
    expect(payload?.webSnapshot?.primary?.usedPercent).toBe(0);
  });

  it('hydrates a legacy single-snapshot row into the slot matching its source', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // 旧格式行: 被 WHAM 污染过的单快照(source=openai-web)—— 归 web 槽隔离,
    // 顶层不得把它当成 CLI 配额展示。
    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({ ...WEB_SNAPSHOT, limitId: 'codex_bengalfox' }),
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(payload?.primary).toBeUndefined();
    expect(payload?.webSnapshot?.limitId).toBe('codex_bengalfox');
    // web-only payload 必须上浮归属字段: WHAM reader 用顶层 accountId 判缓存归属,
    // 缺失会被当成账号失配, 每次读都清缓存 + 强刷 (review 反馈)。
    expect(payload?.accountId).toBe('acc-1');
  });

  it('rejects a corrupted array webSnapshot on hydration (与 renderer 守卫同口径)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({ ...APP_SERVER_SNAPSHOT, webSnapshot: [] }),
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(payload?.primary?.usedPercent).toBe(82);
    // 数组不是合法快照: 归 null, 不得被再次广播 / 回写
    expect(payload?.webSnapshot ?? null).toBeNull();
  });

  it('hydrates a legacy app-server row into the top-level slot', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({ snapshot: JSON.stringify(APP_SERVER_SNAPSHOT) });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(payload?.primary?.usedPercent).toBe(82);
    expect(payload?.webSnapshot ?? null).toBeNull();
  });

  it('round-trips the combined payload through persistence', async () => {
    const broadcaster = await import('../usageBroadcaster');
    await broadcaster.recordCodexAccountUsageSnapshot(APP_SERVER_SNAPSHOT);
    await broadcaster.recordCodexAccountUsageSnapshot(WEB_SNAPSHOT);
    // exec(sql, ['codex', json, ts]) —— 取最后一次落库的 JSON 行原文重新水合。
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persistedJson = lastExecParams[1] as string;

    vi.resetModules();
    const rehydrated = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({ snapshot: persistedJson });
    const payload = await rehydrated.readCodexAccountUsageSnapshot();
    expect(payload?.primary?.usedPercent).toBe(82);
    expect(payload?.webSnapshot?.primary?.usedPercent).toBe(0);
  });

  it('clear wipes both slots', async () => {
    const broadcaster = await import('../usageBroadcaster');
    await broadcaster.recordCodexAccountUsageSnapshot(APP_SERVER_SNAPSHOT);
    await broadcaster.recordCodexAccountUsageSnapshot(WEB_SNAPSHOT);
    await broadcaster.clearCodexAccountUsageSnapshot();
    expect(await broadcaster.readCodexAccountUsageSnapshot()).toBeNull();
  });
});
