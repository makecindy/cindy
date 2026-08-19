/**
 * glmCodingPlanUsageRefresh.test.ts
 * ---------------------------------------------------------------------------
 * GLM Coding Plan 余量 reader(per-provider cached-first)单测。
 * 七轮根因修复后的核心机制:**条件提交令牌**——fetch 前领取,fetch 期间 CRUD
 * (世代 bump)/ owner 切换(epoch 前进)→ 提交被 store 拒绝;「写完再验+补偿」
 * 形态(compensateIfStale / cachedBelongsToSource / isRefreshStillCurrent)已删。
 *
 * 覆盖(标注 T1-T4 为独立复审方设定的硬门槛):
 *   - T1: readSource 瞬时失败 → 零 clear、返回缓存快照(读路径不删)
 *   - T2: CRUD 落在 fetch 期间 → 提交被拒(四~七轮全部场景的通用挡板)
 *   - T3: owner 切换落在 fetch 期间且两账号身份字段完全相同 → 新快照存活
 *   - T4: owner 在 readSource await 期间切换且新 owner 同 id provider 无 key
 *         → 不清快照(createOwnerGuardedReadSource 全出口复核)
 */

import { describe, expect, it, vi } from 'vitest';

import type { GlmCodingPlanUsageSnapshot } from '../../../shared/glmCodingPlanUsage';
import {
  createGlmCodingPlanUsageReader,
  createOwnerGuardedReadSource,
  type GlmCodingPlanReadSourceResult,
  type GlmCodingPlanProviderSource,
  type GlmCodingPlanUsageRefreshDeps,
} from '../glmCodingPlanUsageRefresh';

const THROTTLE_MS = 180_000;

const SOURCE_A: GlmCodingPlanProviderSource = {
  providerId: 'zhipu-coding-plan',
  runtimeBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
  apiKey: 'key-a',
  platform: 'zhipu',
};

const SOURCE_B: GlmCodingPlanProviderSource = {
  ...SOURCE_A,
  apiKey: 'key-b',
};

function snapshotOf(overrides: Partial<GlmCodingPlanUsageSnapshot> = {}): GlmCodingPlanUsageSnapshot {
  return {
    fiveHour: { utilization: 40, resetsAt: null },
    monthlyMcp: { utilization: 10, resetsAt: null },
    platform: 'zhipu',
    source: 'monitor-endpoint',
    updatedAt: 1,
    ...overrides,
  };
}

class UnauthorizedError extends Error {}
class RateLimitedError extends Error {}

interface HarnessOptions {
  source?: GlmCodingPlanProviderSource | null;
  cached?: GlmCodingPlanUsageSnapshot | null;
  fetchResult?: GlmCodingPlanUsageSnapshot | 'empty' | null;
  fetchError?: Error;
  /** true = fetchSnapshot 挂起,由测试手动收尾(飞行中场景)。 */
  deferFetch?: boolean;
  /** readSource 抛异常(模拟 safeStorage / DB 瞬时故障,T1)。 */
  readSourceError?: Error;
}

function makeHarness(opts: HarnessOptions = {}) {
  let now = 1_000_000;
  // 令牌语义的内存版 store(与 usageBroadcaster 真实现同构):
  // beginWrite 领取 {generation, ownerEpoch};clear 强制/条件均 bump generation;
  // record/clear 带失效令牌 → 静默拒绝。
  let generation = 0;
  let ownerEpoch = 0;
  const calls = {
    fetch: 0,
    /** 实际落库的快照(被拒提交不计)。 */
    record: [] as GlmCodingPlanUsageSnapshot[],
    /** record 被调用的次数(含被拒)。 */
    recordAttempts: 0,
    clear: 0,
  };
  let source: GlmCodingPlanProviderSource | null
    = opts.source === undefined ? SOURCE_A : opts.source;
  let cached: GlmCodingPlanUsageSnapshot | null = opts.cached ?? null;

  let resolveFetch!: (value: GlmCodingPlanUsageSnapshot | 'empty' | null) => void;
  let rejectFetch!: (reason: Error) => void;
  const deferredFetch = opts.deferFetch === true
    ? new Promise<GlmCodingPlanUsageSnapshot | 'empty' | null>((res, rej) => {
        resolveFetch = res;
        rejectFetch = rej;
      })
    : null;

  const deps: GlmCodingPlanUsageRefreshDeps = {
    readSource: vi.fn(async (): Promise<GlmCodingPlanReadSourceResult> => {
      if (opts.readSourceError) throw opts.readSourceError;
      return source;
    }),
    fetchSnapshot: vi.fn(async () => {
      calls.fetch += 1;
      if (deferredFetch && calls.fetch === 1) return deferredFetch;
      if (opts.fetchError) throw opts.fetchError;
      return opts.fetchResult ?? snapshotOf();
    }),
    beginWrite: vi.fn((providerId: string) => ({ providerId, generation, ownerEpoch, ownerGeneration: 0 })),
    invalidateWrites: vi.fn(() => { generation += 1; }),
    recordSnapshot: vi.fn(async (_id: string, snapshot: GlmCodingPlanUsageSnapshot, token?: { generation: number; ownerEpoch: number; ownerGeneration: number }) => {
      calls.recordAttempts += 1;
      if (token && (token.generation !== generation || token.ownerEpoch !== ownerEpoch)) return;
      calls.record.push(snapshot);
      cached = snapshot;
    }),
    clearSnapshot: vi.fn(async (_id: string, token?: { generation: number; ownerEpoch: number; ownerGeneration: number }) => {
      if (token && (token.generation !== generation || token.ownerEpoch !== ownerEpoch)) return;
      calls.clear += 1;
      cached = null;
      generation += 1; // 与真 store 同构:任何执行的 clear 都 bump 世代
    }),
    readCachedSnapshot: vi.fn(async () => cached),
    fingerprintKey: (key: string) => `fp-${key}`,
    now: () => now,
    isUnauthorizedError: (err) => err instanceof UnauthorizedError,
    isRateLimitedError: (err) => err instanceof RateLimitedError,
    onRefreshError: vi.fn(),
  };

  const reader = createGlmCodingPlanUsageReader(deps, { throttleMs: THROTTLE_MS });
  return {
    reader, deps, calls,
    setSource(next: GlmCodingPlanProviderSource | null) { source = next; },
    setCached(next: GlmCodingPlanUsageSnapshot | null) { cached = next; },
    cached: () => cached,
    advance(ms: number) { now += ms; },
    /** 模拟 fetch 期间发生 provider CRUD(真链路: clear → 世代 bump)。 */
    bumpGeneration() { generation += 1; },
    /** 模拟 fetch 期间发生账号切换(store ownerEpoch 前进)。 */
    bumpOwnerEpoch() { ownerEpoch += 1; },
    resolveFetch: (value: GlmCodingPlanUsageSnapshot | 'empty' | null) => resolveFetch(value),
    rejectFetch: (reason: Error) => rejectFetch(reason),
  };
}

describe('read() — cached-first + 读路径不删', () => {
  it('returns the cached snapshot and refreshes in the background', async () => {
    const h = makeHarness({ cached: snapshotOf({ fiveHour: { utilization: 33, resetsAt: null } }) });
    const result = await h.reader.read(SOURCE_A.providerId);
    expect(result?.fiveHour?.utilization).toBe(33);
    await vi.waitFor(() => expect(h.calls.record).toHaveLength(1));
    expect(h.calls.record[0].keyFingerprint).toBe('fp-key-a');
  });

  it('九轮 P1: no-source reads return null without touching the snapshot store', async () => {
    // 无源 = 业务上不可查询(无 provider / 无 usage 能力 / 无 key)——返回 null 且
    // **不调 readCachedSnapshot**:否则每个语法合法但不存在的 slug 都会在 store 侧
    // hydrated Set 落一个永久槽 + 一次 DB 查询,被注入的 renderer 可无限撑大 main 内存。
    const seed = snapshotOf();
    const h = makeHarness({ source: null, cached: seed });
    const result = await h.reader.read(SOURCE_A.providerId);
    expect(result).toBeNull();
    expect(h.deps.readCachedSnapshot).not.toHaveBeenCalled();
    expect(h.calls.clear).toBe(0);
    expect(h.deps.fetchSnapshot).not.toHaveBeenCalled();
    // 重复读不同 slug:存储面零接触(内存有界的关键断言)
    for (const slug of ['a', 'b', 'c', 'd']) {
      await h.reader.read(slug);
    }
    expect(h.deps.readCachedSnapshot).not.toHaveBeenCalled();
  });

  it('T1: transient readSource failure keeps the snapshot — zero clear, cache returned', async () => {
    // safeStorage / DB 瞬时故障 → readSource 抛异常 → 绝不能把用户余量从磁盘删掉。
    const seed = snapshotOf();
    const h = makeHarness({ readSourceError: new Error('DPAPI unavailable'), cached: seed });
    const result = await h.reader.read(SOURCE_A.providerId);
    expect(result).toBe(seed); // 快照原样返回(同一引用),显示不中断
    expect(h.calls.clear).toBe(0);
    expect(h.deps.fetchSnapshot).not.toHaveBeenCalled();
  });

  it('keeps a fingerprint-less snapshot (legacy shape, unknown ownership)', async () => {
    const legacy = { ...snapshotOf() } as Partial<GlmCodingPlanUsageSnapshot>;
    delete legacy.platform;
    const h = makeHarness({ cached: legacy as GlmCodingPlanUsageSnapshot });
    await h.reader.read(SOURCE_A.providerId);
    expect(h.calls.clear).toBe(0);
  });

  it('clears a persisted snapshot whose key fingerprint no longer matches (cross-restart)', async () => {
    const h = makeHarness({ cached: snapshotOf({ keyFingerprint: 'fp-key-old' }) });
    await h.reader.read(SOURCE_A.providerId);
    expect(h.calls.clear).toBe(1); // 配置级身份失配,强制清(read 有当前源在手)
  });
});

describe('refresh semantics — errors / throttle', () => {
  it('clears (tokened) on 401 but keeps the snapshot and backs off on 429', async () => {
    const h = makeHarness({ cached: snapshotOf(), fetchError: new UnauthorizedError('401') });
    await h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.clear).toBe(1));

    const h2 = makeHarness({ cached: snapshotOf(), fetchError: new RateLimitedError('429') });
    await h2.reader.read(SOURCE_A.providerId);
    await vi2Wait(h2);
    expect(h2.calls.clear).toBe(0);
    h2.advance(THROTTLE_MS + 1);
    h2.reader.triggerRefresh(SOURCE_A.providerId);
    expect(h2.calls.fetch).toBe(1); // 初始退避 5min 内不再打
  });
  async function vi2Wait(h: ReturnType<typeof makeHarness>) {
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
  }

  it('keeps the last snapshot on transport failure', async () => {
    const h = makeHarness({ cached: snapshotOf(), fetchResult: null });
    await h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    expect(h.calls.clear).toBe(0);
    expect(h.cached()?.fiveHour?.utilization).toBe(40);
  });

  it("clears (tokened) on 'empty' but keeps throttle", async () => {
    const h = makeHarness({ cached: snapshotOf(), fetchResult: 'empty' });
    await h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.clear).toBe(1));
    h.reader.triggerRefresh(SOURCE_A.providerId);
    expect(h.calls.fetch).toBe(1); // 节流保留
  });

  it('throttles repeated reads for the same identity', async () => {
    const h = makeHarness();
    await h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    h.advance(THROTTLE_MS - 1);
    await h.reader.read(SOURCE_A.providerId);
    expect(h.calls.fetch).toBe(1);
    h.advance(2_000);
    await h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(2));
  });

  it('resets throttle when the identity changes', async () => {
    const h = makeHarness();
    await h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.record).toHaveLength(1));
    h.setSource(SOURCE_B);
    h.advance(1_000);
    await h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.record.at(-1)?.keyFingerprint).toBe('fp-key-b'));
  });
});

describe('syncForProviderChange() — CRUD 钩子(强制清,无令牌)', () => {
  it('unconditionally clears when the provider is gone (deleted)', async () => {
    const h = makeHarness({ source: null, cached: snapshotOf() });
    await h.reader.syncForProviderChange(SOURCE_A.providerId);
    expect(h.calls.clear).toBe(1);
    expect(h.deps.fetchSnapshot).not.toHaveBeenCalled();
  });

  it('clears a mismatched-fingerprint snapshot and refreshes immediately on key change', async () => {
    const h = makeHarness({ cached: snapshotOf({ keyFingerprint: 'fp-key-old' }) });
    h.setSource(SOURCE_B);
    await h.reader.syncForProviderChange(SOURCE_A.providerId);
    expect(h.calls.clear).toBe(1);
    await vi.waitFor(() => expect(h.calls.record).toHaveLength(1));
    expect(h.calls.record[0].keyFingerprint).toBe('fp-key-b');
  });

  it('is a quiet no-op on stale-owner', async () => {
    const seed = snapshotOf();
    const h = makeHarness({ source: null, cached: seed });
    // readSource 期间切号由 wrapper 转 stale-owner;此处直接验证 reader 对哨兵的行为
    const h2 = makeHarness({ cached: seed });
    (h2.deps.readSource as ReturnType<typeof vi.fn>).mockResolvedValue('stale-owner');
    await h2.reader.syncForProviderChange(SOURCE_A.providerId);
    expect(h2.calls.clear).toBe(0);
    expect(h2.cached()).toBe(seed);
  });
});

describe('T5 — 身份未变的 CRUD 更新(改显示名/加模型类编辑,七轮复审 R2)', () => {
  it('bumps in-flight tokens but keeps the snapshot — quota display survives edits', async () => {
    // 改名/加模型/调 header:UPDATE handler 无差别触发 sync,但身份三字段未变
    // → 不删快照(显示不断),且在飞令牌仍被作废(旧 fetch 结果不落库)。
    const seed = snapshotOf({
      keyFingerprint: 'fp-key-a',
      runtimeBaseUrl: SOURCE_A.runtimeBaseUrl,
    });
    const h = makeHarness({ deferFetch: true, cached: seed });
    void h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    await h.reader.syncForProviderChange(SOURCE_A.providerId); // 身份未变的 CRUD
    h.resolveFetch(snapshotOf({ fiveHour: { utilization: 77, resetsAt: null } })); // 编辑前的 fetch 迟到
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.clear).toBe(0);            // 不删快照
    expect(h.cached()).toBe(seed);            // 显示不断(同一引用)
    expect(h.calls.record).toHaveLength(0);  // 旧令牌已作废 → 编辑前的数据也不落库
    expect(h.deps.invalidateWrites).toHaveBeenCalled();
  });
});

describe('T2 — CRUD 落在 fetch 期间(四~七轮全部场景的通用挡板)', () => {
  it('rejects the stale write when the key changes mid-flight, then refetches the new identity', async () => {
    // fetch 前领取令牌(gen 0);fetch 期间 CRUD:换 key + 清(世代 bump);
    // A 的响应(77%)提交被拒 —— 不落库、不需要补偿。
    const h = makeHarness({ deferFetch: true });
    void h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    h.setSource(SOURCE_B);
    await h.reader.syncForProviderChange(SOURCE_A.providerId); // CRUD 钩子:清(强制,gen→1)
    h.resolveFetch(snapshotOf({ fiveHour: { utilization: 77, resetsAt: null } })); // A 迟到
    await vi.waitFor(() => expect(h.calls.record).toHaveLength(1));
    expect(h.calls.record[0].keyFingerprint).toBe('fp-key-b'); // 只有 B 落库
    expect(h.calls.record[0].fiveHour?.utilization).toBe(40);  // A 的 77% 被拒
    expect(h.calls.recordAttempts).toBe(2); // A 的提交确实被尝试过且被拒
  });

  it('rejects a stale same-key baseUrl-change response mid-flight', async () => {
    const h = makeHarness({ deferFetch: true });
    void h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    h.setSource({ ...SOURCE_A, runtimeBaseUrl: 'https://api.z.ai/api/anthropic' });
    await h.reader.syncForProviderChange(SOURCE_A.providerId);
    h.resolveFetch(snapshotOf({ fiveHour: { utilization: 66, resetsAt: null } })); // 旧端点迟到
    await vi.waitFor(() => expect(h.calls.record).toHaveLength(1));
    expect(h.calls.record[0].fiveHour?.utilization).toBe(40); // 66% 被拒
  });

  it("rejects a stale 'empty' clear mid-flight", async () => {
    // 旧端点的 empty 迟到:条件清带失效令牌 → 静默放弃,新身份数据不被误删。
    const h = makeHarness({ deferFetch: true });
    void h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    h.setSource(SOURCE_B);
    await h.reader.syncForProviderChange(SOURCE_A.providerId); // 清 + gen bump
    h.setCached(snapshotOf({ keyFingerprint: 'fp-key-b' })); // 模拟 B 补刷已落库
    h.resolveFetch('empty'); // 旧请求的 empty 迟到
    await vi.waitFor(() => expect(h.calls.fetch).toBe(2)); // B 的链式补刷
    expect(h.cached()?.keyFingerprint).toBe('fp-key-b'); // 未被误删
  });

  it('rejects a stale 401 clear mid-flight', async () => {
    const h = makeHarness({ deferFetch: true });
    void h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    h.bumpGeneration(); // 模拟 CRUD 期间强制清
    const bSnapshot = snapshotOf({ keyFingerprint: 'fp-key-b' });
    h.setSource(SOURCE_B);
    h.setCached(bSnapshot);
    h.rejectFetch(new UnauthorizedError('401')); // 旧 key 的 401 迟到
    await new Promise((r) => setTimeout(r, 0));
    expect(h.cached()).toBe(bSnapshot); // 未被旧 401 误清
  });
});

describe('T3 — owner 切换落在 fetch 期间,两账号身份字段完全相同', () => {
  it('rejects the old-account write on ownerEpoch alone; new snapshot survives', async () => {
    // 同 providerId / 同 key / 同 baseUrl / 同 platform —— 身份字段完全不可区分,
    // 唯一区分度是 ownerEpoch。令牌方案不依赖身份字段,这是它优于身份比对的根本点。
    const newAccountSnapshot = snapshotOf({ updatedAt: 999 });
    const h = makeHarness({ deferFetch: true });
    void h.reader.read(SOURCE_A.providerId); // 身份 = SOURCE_A(不变)
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    h.bumpOwnerEpoch(); // fetch 期间切号(身份字段全部相同)
    h.setCached(newAccountSnapshot); // 新账号的快照已在库
    h.resolveFetch(snapshotOf({ fiveHour: { utilization: 77, resetsAt: null } })); // 旧账号响应
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.record).toHaveLength(0); // 旧账号写被拒(未落任何库)
    expect(h.cached()).toBe(newAccountSnapshot); // 新账号快照存活(同一引用)
  });
});

describe('T4 — owner 在 readSource await 期间切换(全出口复核)', () => {
  it('createOwnerGuardedReadSource converts an early-return null to stale-owner on owner flip', async () => {
    // 新账号的同 id provider 没配 key → 内层返回 null;若无全出口复核,
    // 这个 null 会被当"已删除"清掉新账号快照 —— 正是五轮哨兵要防的事。
    let owner = 'account-a';
    const guarded = createOwnerGuardedReadSource(
      () => owner,
      async () => null, // 新 owner 的 provider 无 key(提前 return null)
    );
    const pending = guarded('zhipu-coding-plan');
    owner = 'account-b'; // await 期间切号
    await expect(pending).resolves.toBe('stale-owner');
  });

  it('passes through the inner result when the owner is unchanged', async () => {
    const guarded = createOwnerGuardedReadSource(
      () => 'account-a',
      async () => null,
    );
    await expect(guarded('p1')).resolves.toBeNull();
  });

  it('十一轮: treats a same-id generation bump as stale (readOwner key upgraded)', async () => {
    // usage.ts 装配层注入的 owner 键是 `(id, appSession.generation)`——同账号重登
    // id 不变、世代前进,守卫必须判 stale(只比 id 的旧键会放行)。
    let ownerKey = 'account-a:1';
    const guarded = createOwnerGuardedReadSource(
      () => ownerKey,
      async () => null,
    );
    const pending = guarded('zhipu-coding-plan');
    ownerKey = 'account-a:2'; // 同 id 重登
    await expect(pending).resolves.toBe('stale-owner');
  });
});

describe('八轮 PTF — invalidate 先于 source 读取窗口', () => {
  it('rejects an old-key fetch that completes while syncForProviderChange is still reading config', async () => {
    // readSource 要过 DB + safeStorage(此处挂起模拟慢读);CRUD 已发生,旧 fetch
    // 若在这段窗口内完成,令牌必须已失效(八轮前:invalidate 排在 readSource
    // 之后,窗口内旧写照样落库)。
    const h = makeHarness({ deferFetch: true });
    void h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    // readSource 挂起:直接接管 deps.readSource mock
    let resolveSource!: (v: GlmCodingPlanReadSourceResult) => void;
    (h.deps.readSource as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<GlmCodingPlanReadSourceResult>((res) => { resolveSource = res; }),
    );
    const syncPromise = h.reader.syncForProviderChange(SOURCE_A.providerId);
    await new Promise((r) => setTimeout(r, 0));
    h.setSource(SOURCE_B);
    h.resolveFetch(snapshotOf({ fiveHour: { utilization: 77, resetsAt: null } })); // A 迟到(读取窗口内)
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.record).toHaveLength(0); // A 被拒:令牌在 readSource 前已作废
    resolveSource(SOURCE_B); // 慢读返回新 key 配置
    await syncPromise;
    await vi.waitFor(() => expect(h.calls.record).toHaveLength(1));
    expect(h.calls.record[0].keyFingerprint).toBe('fp-key-b'); // 只有 B 链补刷落库
  });
});

describe('八轮 PTJ — source 读取失败 ≠ provider 不存在', () => {
  it('syncForProviderChange keeps the snapshot and clears nothing on a transient readSource failure', async () => {
    // CRUD 钩子里 DB/safeStorage 瞬时抖动:不得把异常折成"已删除"强清有效快照
    // (八轮前:readSourceSafe 折成 null → sync 走强制清,额度消失到重挂载)。
    const seed = snapshotOf({ keyFingerprint: 'fp-key-a' });
    const h = makeHarness({ cached: seed });
    (h.deps.readSource as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db busy'));
    await h.reader.syncForProviderChange(SOURCE_A.providerId);
    expect(h.calls.clear).toBe(0);          // 不清快照
    expect(h.cached()).toBe(seed);          // 有效数据原样存活(同一引用)
    expect(h.deps.fetchSnapshot).not.toHaveBeenCalled(); // 也不发起无凭证出网
  });

  it('read() returns the cached snapshot on a read-failed sentinel (display uninterrupted)', async () => {
    const seed = snapshotOf();
    const h = makeHarness({ cached: seed });
    (h.deps.readSource as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DPAPI busy'));
    const result = await h.reader.read(SOURCE_A.providerId);
    expect(result).toBe(seed); // 瞬时故障返回缓存,不中断显示
    expect(h.calls.clear).toBe(0);
  });
});

describe('九轮 P2 — turn-done 触发路径的 reader 语义', () => {
  it('triggerRefresh on a provider without usage capability is a quiet no-op (no fetch, no leak)', async () => {
    // register 的 turn-done 钩子会对**任何**显式供应商调用触发:非 GLM 供应商必须
    // 静默 no-op——无出网、无状态槽残留(states 自清理),不逐 turn 付费。
    const h = makeHarness({ source: null });
    h.reader.triggerRefresh('some-other-provider');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.deps.fetchSnapshot).not.toHaveBeenCalled();
    expect(h.deps.readCachedSnapshot).not.toHaveBeenCalled();
    expect(h.calls.clear).toBe(0);
  });

  it('triggerRefresh refreshes a real GLM provider under the 180s throttle', async () => {
    const h = makeHarness();
    h.reader.triggerRefresh(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    expect(h.calls.record[0]?.keyFingerprint).toBe('fp-key-a');
    h.reader.triggerRefresh(SOURCE_A.providerId);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.fetch).toBe(1); // 节流窗内不重打
  });
});

describe('per-provider isolation', () => {
  it('keeps throttle and snapshot state independent per provider id', async () => {
    const h = makeHarness();
    await h.reader.read('provider-one');
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    h.setSource({ ...SOURCE_A, providerId: 'provider-two' });
    await h.reader.read('provider-two');
    await vi.waitFor(() => expect(h.calls.fetch).toBe(2));
    h.setSource(SOURCE_A);
    await h.reader.read('provider-one');
    expect(h.calls.fetch).toBe(2);
  });
});
