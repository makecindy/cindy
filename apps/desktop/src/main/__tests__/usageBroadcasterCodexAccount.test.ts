/**
 * usageBroadcaster 的 Codex 账号快照分槽单测 —— 两个数据源(codex-app-server /
 * openai-web WHAM)各写各的槽, 不得互相覆盖窗口(2026-07-24 用户实报: WHAM 的
 * Spark 促销桶把 app-server 主配额顶成「8天 剩余 100%」)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  exec: vi.fn(async () => undefined),
  getCurrentDbClientUserId: vi.fn(() => 'user-1'),
  legacyCurrentUserId: vi.fn(() => null),
  /** 广播到 renderer 的 payload —— 并发用例据此断言不会闪出空快照。 */
  broadcasts: [] as unknown[],
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, payload: unknown) => { mocks.broadcasts.push(payload); },
      },
    }],
  },
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
  getCurrentDbClientUserId: mocks.getCurrentDbClientUserId,
}));
vi.mock('../localDb/index', () => ({
  getCurrentUserId: mocks.legacyCurrentUserId,
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
    mocks.getCurrentDbClientUserId.mockReturnValue('user-1');
    mocks.legacyCurrentUserId.mockReturnValue(null);
    mocks.broadcasts.length = 0;
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
    mocks.getCurrentDbClientUserId.mockReturnValue('user-1');
    mocks.broadcasts.length = 0;
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

  it('keeps the sibling window when a sparse update only carries one window', async () => {
    const broadcaster = await import('../usageBroadcaster');
    await broadcaster.recordCodexAccountUsageSnapshot(APP_SERVER_SNAPSHOT);
    await broadcaster.recordCodexAccountUsageSnapshot({
      limitId: 'codex',
      primary: { usedPercent: 91, windowMinutes: 300, resetsAt: 1_800_000_000 },
      source: 'codex-app-server',
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(payload?.appServerBuckets?.codex?.primary?.usedPercent).toBe(91);
    expect(payload?.appServerBuckets?.codex?.secondary?.usedPercent).toBe(55);
  });

  it('clears an explicitly null window while preserving an omitted sibling', async () => {
    const broadcaster = await import('../usageBroadcaster');
    await broadcaster.recordCodexAccountUsageSnapshot(APP_SERVER_SNAPSHOT);
    await broadcaster.recordCodexAccountUsageSnapshot({
      limitId: 'codex',
      primary: null,
      source: 'codex-app-server',
    });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(payload?.appServerBuckets?.codex?.primary ?? null).toBeNull();
    expect(payload?.appServerBuckets?.codex?.secondary?.usedPercent).toBe(55);
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
    mocks.getCurrentDbClientUserId.mockReturnValue('user-1');
    mocks.broadcasts.length = 0;
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
    mocks.getCurrentDbClientUserId.mockReturnValue('user-1');
    mocks.broadcasts.length = 0;
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

describe('empty snapshot must not clobber the persisted row', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryOne.mockReset().mockResolvedValue(null);
    mocks.exec.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentDbClientUserId.mockReturnValue('user-1');
    mocks.broadcasts.length = 0;
  });

  // 2026-08-11 用户实报的真实覆盖事故: 一条全 null 的 windowless app-server 事件
  // 落在**空的内存缓存**上(hydration 未命中), merge 无旧值可保, 全 null 桶被
  // 无条件 upsert 落库 —— 持久化行里的有效窗口 / credits / planType 永久丢失,
  // 且对消费方是静默失败(JSON 可解析、字段都在、值全 null)。
  const NULL_SPARSE_EVENT = {
    limitId: 'codex',
    limitName: null,
    primary: null,
    secondary: null,
    credits: null,
    planType: null,
    rateLimitReachedType: null,
    source: 'codex-app-server',
  };

  it('skips persistence when hydration failed', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // 冷缓存 hydration 读库失败(db busy 等) → 内存为空, 但持久化行还躺着好数据。
    mocks.queryOne.mockRejectedValue(new Error('db busy'));

    await broadcaster.recordCodexAccountUsageSnapshot(NULL_SPARSE_EVENT);

    // 全 null payload 不得 upsert —— 否则库里的有效行被抹掉且不可恢复。
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  // 读库失败必须保留重试机会: 若把未成功的 hydration 标记成「已加载」, 之后所有刷新
  // 都会在 ensure 开头短路、被落库守卫永久跳过 —— 一次瞬时 db busy 就让本进程再也
  // 无法持久化任何额度数据。
  it('retries hydration after a transient read failure instead of giving up', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockRejectedValueOnce(new Error('db busy'));

    await broadcaster.recordCodexAccountUsageSnapshot(NULL_SPARSE_EVENT);
    expect(mocks.exec).not.toHaveBeenCalled();

    // 库恢复后, 下一笔完整快照必须能重新读库并正常落库。
    mocks.queryOne.mockResolvedValue({ snapshot: JSON.stringify(APP_SERVER_SNAPSHOT) });
    await broadcaster.recordCodexAccountUsageSnapshot({
      limitId: 'codex',
      primary: { usedPercent: 91, windowMinutes: 300, resetsAt: 1_800_000_000 },
      source: 'codex-app-server',
    });

    expect(mocks.exec).toHaveBeenCalled();
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persisted = JSON.parse(lastExecParams[1] as string);
    expect(persisted.primary?.usedPercent).toBe(91);
  });

  // 重试成功时读到的行比内存旧 —— hydration 失败期间收到的观测因守卫未能落库, 只活在
  // 内存里。直接赋值会让 UI 回退到旧额度, 且那些观测永远等不到落库时机。
  it('keeps snapshots received while hydration was failing', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockRejectedValueOnce(new Error('db busy'));

    await broadcaster.recordCodexAccountUsageSnapshot({
      limitId: 'codex',
      primary: { usedPercent: 91, windowMinutes: 300, resetsAt: 1_800_000_000 },
      source: 'codex-app-server',
    });
    expect(mocks.exec).not.toHaveBeenCalled();

    // 重试读到的是更旧的持久化行(82%) —— 不得顶掉内存里的 91%。
    mocks.queryOne.mockResolvedValue({ snapshot: JSON.stringify(APP_SERVER_SNAPSHOT) });
    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(payload?.appServerBuckets?.codex?.primary?.usedPercent).toBe(91);

    // 且这份观测在下一笔事件时随 payload 一并落库, 不会永久停在内存里。
    await broadcaster.recordCodexAccountUsageSnapshot(NULL_SPARSE_EVENT);
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persisted = JSON.parse(lastExecParams[1] as string);
    expect(persisted.primary?.usedPercent).toBe(91);
  });

  // 上一条只覆盖了「失败期间收到完整快照」。稀疏事件留下的是一个非空、却全 null 的
  // 同名桶 —— 若按桶键整体覆盖, 持久化桶里的窗口会被它抹掉并在下一笔事件写回库,
  // 正好复现本次要防的损坏。必须逐桶走常规 merge。
  it('merges a sparse bucket received while hydration was failing field by field', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockRejectedValueOnce(new Error('db busy'));

    await broadcaster.recordCodexAccountUsageSnapshot(NULL_SPARSE_EVENT);
    expect(mocks.exec).not.toHaveBeenCalled();

    // 重试读到同一 limitId 的有效桶(82 / 55) —— 窗口不得被内存里的全 null 桶顶掉。
    mocks.queryOne.mockResolvedValue({ snapshot: JSON.stringify(APP_SERVER_SNAPSHOT) });
    const payload = await broadcaster.readCodexAccountUsageSnapshot();
    expect(payload?.appServerBuckets?.codex?.primary?.usedPercent).toBe(82);
    expect(payload?.appServerBuckets?.codex?.secondary?.usedPercent).toBe(55);

    // 而且下一笔事件写回库时窗口仍在, 不会把损坏落盘。
    await broadcaster.recordCodexAccountUsageSnapshot(NULL_SPARSE_EVENT);
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persisted = JSON.parse(lastExecParams[1] as string);
    expect(persisted.primary?.usedPercent).toBe(82);
  });

  // owner 缺失时 IIFE 在首个 await 之前同步走完 —— 句柄若在它的 finally 里清, 会被
  // 外层赋值写回, 之后 ensure 永远复用这个已 resolve 的 Promise, 再也不查库, 于是
  // hydrated 永远为 false, 本进程之后所有落库都被守卫跳过。
  it('reads the database once the owner becomes available', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.getCurrentDbClientUserId.mockReturnValue(null as unknown as string);

    await broadcaster.recordCodexAccountUsageSnapshot(APP_SERVER_SNAPSHOT);
    expect(mocks.queryOne).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();

    // 用户登录后必须重新查库, 并恢复正常落库。
    mocks.getCurrentDbClientUserId.mockReturnValue('user-1');
    mocks.queryOne.mockResolvedValue(null);
    await broadcaster.recordCodexAccountUsageSnapshot(APP_SERVER_SNAPSHOT);

    expect(mocks.queryOne).toHaveBeenCalled();
    expect(mocks.exec).toHaveBeenCalled();
  });

  it('hydrates through the current DbClient after the legacy database is closed', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // DbClient 接管会关闭 legacy localDb 并清空它的 owner；新 client 仍持有当前用户。
    mocks.legacyCurrentUserId.mockReturnValue(null);
    mocks.getCurrentDbClientUserId.mockReturnValue('user-1');
    mocks.queryOne.mockResolvedValue({ snapshot: JSON.stringify(APP_SERVER_SNAPSHOT) });

    const payload = await broadcaster.readCodexAccountUsageSnapshot();

    expect(mocks.queryOne).toHaveBeenCalledWith(
      'SELECT snapshot FROM account_usage_snapshots WHERE agent_kind = ?',
      ['codex'],
    );
    expect(payload?.primary?.usedPercent).toBe(82);
    expect(payload?.secondary?.usedPercent).toBe(55);
  });

  it('skips persistence when the owner is not initialized yet', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // 启动早期 DbClient owner 尚不可用 → hydration 被跳过, 内存为空。
    mocks.getCurrentDbClientUserId.mockReturnValue(null as unknown as string);

    await broadcaster.recordCodexAccountUsageSnapshot(NULL_SPARSE_EVENT);

    expect(mocks.exec).not.toHaveBeenCalled();
  });

  // 权威的「已达限额」标记本身就是要落库的状态: 它没有窗口是正常的(如 credits
  // 耗尽), 且 isCodexWindowlessFallback 明确把它当权威值 —— merge 会正当地把旧窗口
  // 清成 null。goal-host 的 getAccountLimit 从持久化的 rateLimitReachedType 判
  // limited, 漏存会让重启后暂停的目标直接重新撞进同一个限额。
  const CREDITS_DEPLETED_EVENT = {
    limitId: 'codex',
    primary: null,
    secondary: null,
    rateLimitReachedType: 'credits_depleted',
    source: 'codex-app-server',
  };

  it('persists an authoritative rate-limit-reached marker even without windows', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({ snapshot: JSON.stringify(APP_SERVER_SNAPSHOT) });

    await broadcaster.recordCodexAccountUsageSnapshot(CREDITS_DEPLETED_EVENT);

    expect(mocks.exec).toHaveBeenCalled();
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persisted = JSON.parse(lastExecParams[1] as string);
    expect(persisted.rateLimitReachedType).toBe('credits_depleted');
  });

  it('persists a reached marker on a cold but readable database', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // 库里本来就没有行(首次安装) —— 读成功即底子可信, 照常落库。
    mocks.queryOne.mockResolvedValue(null);

    await broadcaster.recordCodexAccountUsageSnapshot(CREDITS_DEPLETED_EVENT);

    expect(mocks.exec).toHaveBeenCalled();
  });

  it('still persists windowless events merged onto hydrated windows (regression guard)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // hydration 正常命中: windowless 稀疏事件按契约并入已有桶, 窗口保留 → 照常落库。
    mocks.queryOne.mockResolvedValue({ snapshot: JSON.stringify(APP_SERVER_SNAPSHOT) });

    await broadcaster.recordCodexAccountUsageSnapshot(NULL_SPARSE_EVENT);

    expect(mocks.exec).toHaveBeenCalled();
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persisted = JSON.parse(lastExecParams[1] as string);
    expect(persisted.primary?.usedPercent).toBe(82);
    expect(persisted.secondary?.usedPercent).toBe(55);
  });

  // 合法的「限额解除」与事故的空壳形状完全一致 —— 按 payload 内容判会把它一并拦下,
  // 库里的 reached 标记就再也去不掉: goal-host 据此判 limited=true 且没有重置时间,
  // 目标被无限期挂起。判据必须落在「merge 底子是否可信」上。
  it('persists a legitimate clear that removes a previously reached marker', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({ ...CREDITS_DEPLETED_EVENT, webSnapshot: null }),
    });

    await broadcaster.recordCodexAccountUsageSnapshot(NULL_SPARSE_EVENT);

    expect(mocks.exec).toHaveBeenCalled();
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persisted = JSON.parse(lastExecParams[1] as string);
    expect(persisted.rateLimitReachedType ?? null).toBeNull();
  });

  // codexWebUsageResponseToSnapshot 明确接受只有 plan_type / credits 的 WHAM 响应,
  // tooltip 也展示这两项。web-only 账号的首份快照没有任何窗口, 不能因此不落库 ——
  // 否则重启或离线启动就丢了套餐与余额。
  it('persists a web snapshot carrying only plan and credits', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);

    await broadcaster.recordCodexAccountUsageSnapshot({
      primary: null,
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: '12.50' },
      planType: 'prolite',
      source: 'openai-web',
      accountId: 'acc-1',
    });

    expect(mocks.exec).toHaveBeenCalled();
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persisted = JSON.parse(lastExecParams[1] as string);
    expect(persisted.webSnapshot?.planType).toBe('prolite');
    expect(persisted.webSnapshot?.credits?.balance).toBe('12.50');
  });

  // codex 侧原先把 loaded 置位放在 await 之前, 并发的第二笔 record 会立刻返回并在
  // **空内存**上 merge —— 这正是产出全 null payload 的路径(claude 侧早有 load-promise
  // 防住)。可观测的后果是向 renderer 广播一份空快照(chip 闪空), 之后才被 hydration
  // 覆盖回去。串行化后两笔都等同一次读完成, 不存在这个中间态。
  it('never broadcasts an empty snapshot while hydration is still in flight', async () => {
    const broadcaster = await import('../usageBroadcaster');
    let resolveRead!: (value: { snapshot: string } | null) => void;
    mocks.queryOne.mockReturnValue(new Promise((res) => { resolveRead = res; }));

    const first = broadcaster.recordCodexAccountUsageSnapshot(NULL_SPARSE_EVENT);
    const second = broadcaster.recordCodexAccountUsageSnapshot(NULL_SPARSE_EVENT);
    resolveRead({ snapshot: JSON.stringify(APP_SERVER_SNAPSHOT) });
    await Promise.all([first, second]);

    // 每一次广播都必须带着已 hydrate 的窗口, 不能出现窗口为空的中间态。
    expect(mocks.broadcasts.length).toBeGreaterThan(0);
    for (const payload of mocks.broadcasts as Array<{ primary?: { usedPercent?: number } | null }>) {
      expect(payload?.primary?.usedPercent).toBe(82);
    }
    const current = await broadcaster.readCodexAccountUsageSnapshot();
    expect(current?.secondary?.usedPercent).toBe(55);
  });
});

describe('sparse rate-limit updates without a limitId', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryOne.mockReset().mockResolvedValue(null);
    mocks.exec.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentDbClientUserId.mockReturnValue('user-1');
    mocks.broadcasts.length = 0;
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
