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

describe('codex app-server limit buckets', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryOne.mockReset().mockResolvedValue(null);
    mocks.exec.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentUserId.mockReturnValue('user-1');
  });

  // 2026-07-25 用户实报的真实污染行: app 槽被模型专属促销桶(Spark)占据,
  // 于是 gpt-5.6-sol 会话的 chip 显示「8天 剩余 100%」。
  const SPARK_BUCKET = {
    limitId: 'codex_bengalfox',
    limitName: 'GPT-5.3-Codex-Spark',
    primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_785_548_762, windowMinutes: 10_080 },
    secondary: null,
    source: 'codex-app-server',
  };

  it('keeps different limit buckets isolated instead of overwriting each other', async () => {
    const broadcaster = await import('../usageBroadcaster');
    await broadcaster.recordCodexAccountUsageSnapshot(APP_SERVER_SNAPSHOT);
    await broadcaster.recordCodexAccountUsageSnapshot(SPARK_BUCKET);

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    // 顶层 = 最近更新桶(兼容位), 但主桶数据必须完整活在桶表里
    expect(payload?.limitId).toBe('codex_bengalfox');
    expect(payload?.appServerBuckets?.codex?.primary?.usedPercent).toBe(82);
    expect(payload?.appServerBuckets?.codex?.secondary?.usedPercent).toBe(55);
    expect(payload?.appServerBuckets?.codex_bengalfox?.primary?.usedPercent).toBe(0);
    // 跨桶不得合并成杂交体: Spark 桶没有 secondary, 不该继承主桶的
    expect(payload?.appServerBuckets?.codex_bengalfox?.secondary ?? null).toBeNull();
  });

  it('merges repeated updates within the same bucket', async () => {
    const broadcaster = await import('../usageBroadcaster');
    await broadcaster.recordCodexAccountUsageSnapshot(APP_SERVER_SNAPSHOT);
    await broadcaster.recordCodexAccountUsageSnapshot({
      ...APP_SERVER_SNAPSHOT,
      primary: { usedPercent: 91, windowMinutes: 300, resetsAt: 1_800_000_000 },
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(Object.keys(payload?.appServerBuckets ?? {})).toEqual(['codex']);
    expect(payload?.appServerBuckets?.codex?.primary?.usedPercent).toBe(91);
  });

  it('hydrates a pre-bucket persisted row into its matching bucket', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // 分槽版(有 webSnapshot 键、无 appServerBuckets)写下的行 —— 顶层是 Spark 桶
    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({ ...SPARK_BUCKET, webSnapshot: null }),
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(payload?.appServerBuckets?.codex_bengalfox?.limitName).toBe('GPT-5.3-Codex-Spark');
    // 主桶此时未知: 表里只有 Spark 桶, 主桶会在下一个 turn 事件到达时建立
    expect(Object.keys(payload?.appServerBuckets ?? {})).toEqual(['codex_bengalfox']);
  });

  it('round-trips the bucket table through persistence', async () => {
    const broadcaster = await import('../usageBroadcaster');
    await broadcaster.recordCodexAccountUsageSnapshot(APP_SERVER_SNAPSHOT);
    await broadcaster.recordCodexAccountUsageSnapshot(SPARK_BUCKET);
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persistedJson = lastExecParams[1] as string;

    vi.resetModules();
    const rehydrated = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({ snapshot: persistedJson });
    const payload = await rehydrated.readCodexAccountUsageSnapshot();
    expect(payload?.appServerBuckets?.codex?.primary?.usedPercent).toBe(82);
    expect(payload?.appServerBuckets?.codex_bengalfox?.primary?.usedPercent).toBe(0);
  });

  it('drops malformed bucket entries on hydration', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({
        ...APP_SERVER_SNAPSHOT,
        webSnapshot: null,
        appServerBuckets: { codex: APP_SERVER_SNAPSHOT, broken: [], alsoBroken: 'nope' },
      }),
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(Object.keys(payload?.appServerBuckets ?? {})).toEqual(['codex']);
  });
});

describe('codex bucket edge cases (review follow-up)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryOne.mockReset().mockResolvedValue(null);
    mocks.exec.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentUserId.mockReturnValue('user-1');
  });

  const BUCKET_A = {
    limitId: 'codex',
    primary: { usedPercent: 40, windowMinutes: 300, resetsAt: 1_800_000_000 },
    source: 'codex-app-server',
  };
  const BUCKET_B = {
    limitId: 'codex_bengalfox',
    limitName: 'GPT-5.3-Codex-Spark',
    primary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: 1_785_548_762 },
    source: 'codex-app-server',
  };

  it('restores the latest bucket after A → B → A across a restart', async () => {
    const broadcaster = await import('../usageBroadcaster');
    await broadcaster.recordCodexAccountUsageSnapshot(BUCKET_A);
    await broadcaster.recordCodexAccountUsageSnapshot(BUCKET_B);
    await broadcaster.recordCodexAccountUsageSnapshot({
      ...BUCKET_A,
      primary: { usedPercent: 58, windowMinutes: 300, resetsAt: 1_800_000_000 },
    });
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persistedJson = lastExecParams[1] as string;

    vi.resetModules();
    const rehydrated = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({ snapshot: persistedJson });
    const payload = await rehydrated.readCodexAccountUsageSnapshot();
    // 覆盖已有键不会把它移到对象末尾 —— 顶层兼容位必须仍是最近更新的 A
    expect(payload?.limitId).toBe('codex');
    expect(payload?.primary?.usedPercent).toBe(58);
  });

  it('never uses prototype-polluting limitIds as bucket keys', async () => {
    const broadcaster = await import('../usageBroadcaster');
    await broadcaster.recordCodexAccountUsageSnapshot({
      ...BUCKET_A,
      limitId: '__proto__',
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(Object.keys(payload?.appServerBuckets ?? {})).toEqual(['__default__']);
    expect(({} as Record<string, unknown>).primary).toBeUndefined();
  });

  it('drops prototype-polluting keys when hydrating a bucket table', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({
        ...BUCKET_A,
        webSnapshot: null,
        appServerBuckets: { codex: BUCKET_A, __proto__: BUCKET_B },
      }),
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(Object.keys(payload?.appServerBuckets ?? {})).toEqual(['codex']);
  });

  // 本仓写入路径不会产出这种行(顶层就是从桶表取的), 但外部 / 损坏 / 跨版本行
  // 可能给出桶表里没有的最近桶键。旧实现会让 currentCodexAppServerSnapshot()
  // 返 null —— app-server 配额一直空到下一次推送(review 反馈)。
  it('re-seeds the latest bucket when a persisted row references a missing key', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({
        ...BUCKET_A,
        webSnapshot: null,
        // 顶层是 codex, 桶表却只有无 ID 更新建出来的缺省桶
        appServerBuckets: { __default__: { ...BUCKET_B, limitId: undefined } },
      }),
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    // 顶层配额没有消失, 且它自己的桶被补种回桶表
    expect(payload?.limitId).toBe('codex');
    expect(payload?.primary?.usedPercent).toBe(40);
    expect(Object.keys(payload?.appServerBuckets ?? {}).sort()).toEqual(['__default__', 'codex']);
  });

  it('keeps hydration safe when the missing latest key is prototype-polluting', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({
        ...BUCKET_A,
        limitId: '__proto__',
        webSnapshot: null,
        appServerBuckets: {},
      }),
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    // 危险 limitId 早在 codexLimitBucketKey 就被映射成缺省桶, 补种不污染原型
    expect(Object.keys(payload?.appServerBuckets ?? {})).toEqual(['__default__']);
    expect(({} as Record<string, unknown>).primary).toBeUndefined();
  });
});

describe('codex stale bucket pruning', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryOne.mockReset().mockResolvedValue(null);
    mocks.exec.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentUserId.mockReturnValue('user-1');
  });

  it('prunes buckets whose windows expired long ago, keeping the latest one', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // 促销早已结束的 Spark 桶(窗口过点远超宽限)
    await broadcaster.recordCodexAccountUsageSnapshot({
      limitId: 'codex_bengalfox',
      limitName: 'GPT-5.3-Codex-Spark',
      primary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: 1_600_000_000 },
      source: 'codex-app-server',
    });
    // 新的通用桶事件到来 → 触发剪枝
    await broadcaster.recordCodexAccountUsageSnapshot({
      limitId: 'codex',
      primary: { usedPercent: 51, windowMinutes: 300, resetsAt: 4_100_000_000 },
      source: 'codex-app-server',
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(Object.keys(payload?.appServerBuckets ?? {})).toEqual(['codex']);
  });

  it('never prunes the latest bucket even if its window looks expired', async () => {
    const broadcaster = await import('../usageBroadcaster');
    await broadcaster.recordCodexAccountUsageSnapshot({
      limitId: 'codex',
      primary: { usedPercent: 51, windowMinutes: 300, resetsAt: 1_600_000_000 },
      source: 'codex-app-server',
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(Object.keys(payload?.appServerBuckets ?? {})).toEqual(['codex']);
  });
});

describe('sparse rate-limit updates without a limitId', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryOne.mockReset().mockResolvedValue(null);
    mocks.exec.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentUserId.mockReturnValue('user-1');
  });

  const SPARK = {
    limitId: 'codex_bengalfox',
    limitName: 'GPT-5.3-Codex-Spark',
    primary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: 4_100_000_000 },
    source: 'codex-app-server',
  };

  it('merges an id-less sparse update into the most recent bucket, not the default one', async () => {
    const broadcaster = await import('../usageBroadcaster');
    await broadcaster.recordCodexAccountUsageSnapshot(SPARK);
    // app-server 契约: 稀疏更新缺 limitId 时合并进最近一次结果, 不得另建缺省桶
    await broadcaster.recordCodexAccountUsageSnapshot({
      primary: { usedPercent: 14, windowMinutes: 10_080, resetsAt: 4_100_000_000 },
      source: 'codex-app-server',
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(Object.keys(payload?.appServerBuckets ?? {})).toEqual(['codex_bengalfox']);
    expect(payload?.appServerBuckets?.codex_bengalfox?.primary?.usedPercent).toBe(14);
    // 身份元数据不被稀疏更新清除
    expect(payload?.appServerBuckets?.codex_bengalfox?.limitName).toBe('GPT-5.3-Codex-Spark');
  });

  it('falls back to the default bucket when nothing has been observed yet', async () => {
    const broadcaster = await import('../usageBroadcaster');
    await broadcaster.recordCodexAccountUsageSnapshot({
      primary: { usedPercent: 9, windowMinutes: 300, resetsAt: 4_100_000_000 },
      source: 'codex-app-server',
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(Object.keys(payload?.appServerBuckets ?? {})).toEqual(['__default__']);
  });
});
