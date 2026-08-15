/**
 * glmCodingPlanUsageRefresh.test.ts
 * ---------------------------------------------------------------------------
 * GLM Coding Plan 余量 reader(per-provider cached-first)单测,形态对齐
 * claudeSubscriptionUsageRefresh.test.ts:
 *   - read(): cached-first 返回缓存 + 触发后台刷新;无源(无 provider / 无 usage 能力 /
 *     无 key)→ 清快照返回 null
 *   - 换 key 防串号: 持久化快照指纹失配 → 立即清除并返回 null(不等后台刷新)
 *   - 401/403 → 只清快照(key 不动);429 → 指数退避保留快照;transport 失败保留快照
 *   - 节流: 同 key 窗口内不重复打端点;'empty' 清快照但保留节流
 *   - syncForProviderChange(): 删除 → 无条件清;换 key → 指纹失配清 + 立即刷新
 */

import { describe, expect, it, vi } from 'vitest';

import type { GlmCodingPlanUsageSnapshot } from '../../../shared/glmCodingPlanUsage';
import {
  createGlmCodingPlanUsageReader,
  type GlmCodingPlanUsageRefreshDeps,
  type GlmCodingPlanProviderSource,
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
  /** true = fetchSnapshot 挂起,由测试用 resolveFetch / rejectFetch 手动收尾(飞行中场景)。 */
  deferFetch?: boolean;
}

function makeHarness(opts: HarnessOptions = {}) {
  let now = 1_000_000;
  const calls = {
    fetch: 0,
    record: [] as GlmCodingPlanUsageSnapshot[],
    clear: 0,
  };
  // 注意 ?? 会把显式 null 吞成默认值 —— 无源场景(null)必须原样保留。
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
    readSource: vi.fn(async () => source),
    fetchSnapshot: vi.fn(async () => {
      calls.fetch += 1;
      // deferred 只作用于首笔 fetch(制造"飞行中");后续 fetch(如换 key 后的链式
      // 补刷)走正常 mock 值,避免复用同一个已 resolve 的 promise 把旧值喂给新请求。
      if (deferredFetch && calls.fetch === 1) return deferredFetch;
      if (opts.fetchError) throw opts.fetchError;
      return opts.fetchResult ?? snapshotOf();
    }),
    recordSnapshot: vi.fn(async (_id, snapshot) => {
      calls.record.push(snapshot);
      cached = snapshot;
    }),
    clearSnapshot: vi.fn(async () => {
      calls.clear += 1;
      cached = null;
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
    resolveFetch: (value: GlmCodingPlanUsageSnapshot | 'empty' | null) => resolveFetch(value),
    rejectFetch: (reason: Error) => rejectFetch(reason),
  };
}

describe('read() — cached-first + 后台刷新', () => {
  it('returns the cached snapshot and refreshes in the background', async () => {
    const h = makeHarness({ cached: snapshotOf({ fiveHour: { utilization: 33, resetsAt: null } }) });
    const result = await h.reader.read(SOURCE_A.providerId);
    expect(result?.fiveHour?.utilization).toBe(33);
    // 后台刷新已发起,且新快照按查询 key 的指纹落库
    await vi.waitFor(() => expect(h.calls.record).toHaveLength(1));
    expect(h.calls.record[0].keyFingerprint).toBe('fp-key-a');
  });

  it('returns null without clearing when a fresh reader sees no usable source', async () => {
    // 普通 provider 的常规读(chip 不会发起,但 IPC 直调可能)不应反复触发 DELETE ——
    // 与 claude reader 同语义;快照清理交给 CRUD 钩子的 syncForProviderChange。
    const h = makeHarness({ source: null, cached: snapshotOf() });
    await expect(h.reader.read(SOURCE_A.providerId)).resolves.toBeNull();
    expect(h.calls.clear).toBe(0);
    expect(h.deps.fetchSnapshot).not.toHaveBeenCalled();
  });

  it('clears once when a previously-queryable provider loses its source', async () => {
    const h = makeHarness({ source: SOURCE_A, cached: snapshotOf() });
    await h.reader.read(SOURCE_A.providerId);
    h.setSource(null);
    await h.reader.read(SOURCE_A.providerId);
    expect(h.calls.clear).toBe(1);
  });

  it('clears a persisted snapshot whose key fingerprint no longer matches (key rotation)', async () => {
    // 库里是旧 key 的快照,当前配置已换 key-b —— 立即清,不把旧账号余量顶给新 key 看。
    const h = makeHarness({
      cached: snapshotOf({ keyFingerprint: 'fp-key-old' }),
    });
    h.setSource(SOURCE_B);
    await expect(h.reader.read(SOURCE_A.providerId)).resolves.toBeNull();
    expect(h.calls.clear).toBe(1);
  });

  it('keeps a fingerprint-less snapshot (unknown ownership, no false clear)', async () => {
    const h = makeHarness({ cached: snapshotOf() });
    await h.reader.read(SOURCE_A.providerId);
    expect(h.calls.clear).toBe(0);
  });
});

describe('refresh semantics — errors / throttle', () => {
  it('clears only the snapshot on 401 (API key untouched by caller contract)', async () => {
    const h = makeHarness({
      cached: snapshotOf(),
      fetchError: new UnauthorizedError('401'),
    });
    await h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.clear).toBe(1));
  });

  it('keeps the snapshot and backs off exponentially on 429', async () => {
    const h = makeHarness({
      cached: snapshotOf(),
      fetchError: new RateLimitedError('429'),
    });
    await h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    expect(h.calls.clear).toBe(0);
    h.advance(THROTTLE_MS + 1);
    h.reader.triggerRefresh(SOURCE_A.providerId);
    // 初始退避 5min 未到 —— 不再打端点
    expect(h.calls.fetch).toBe(1);
    h.advance(5 * 60_000 + 1);
    h.reader.triggerRefresh(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(2));
  });

  it('keeps the last snapshot on transport failure', async () => {
    const h = makeHarness({ cached: snapshotOf(), fetchResult: null });
    await h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    expect(h.calls.clear).toBe(0);
    expect(h.cached()?.fiveHour?.utilization).toBe(40);
  });

  it('clears the snapshot but keeps throttle when the endpoint returns empty', async () => {
    const h = makeHarness({ cached: snapshotOf(), fetchResult: 'empty' });
    await h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.clear).toBe(1));
    // 节流保留:窗口内 triggerRefresh 不再打端点(教育/团队版防逐次重打)
    h.reader.triggerRefresh(SOURCE_A.providerId);
    expect(h.calls.fetch).toBe(1);
  });

  it('throttles repeated reads for the same key', async () => {
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

  it('resets throttle when the key changes (identity change re-arms refresh)', async () => {
    const h = makeHarness();
    await h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.record).toHaveLength(1));
    h.setSource(SOURCE_B);
    h.advance(1_000); // 远未到节流窗口
    await h.reader.read(SOURCE_A.providerId);
    // 等写库完成而不是 fetch 计数 —— fetch 先于 record 两个异步拍。
    await vi.waitFor(() => expect(h.calls.record.at(-1)?.keyFingerprint).toBe('fp-key-b'));
  });
});

describe('syncForProviderChange()', () => {
  it('unconditionally clears the snapshot when the provider is gone (deleted)', async () => {
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
});

describe('per-provider isolation', () => {
  it('keeps throttle and snapshot state independent per provider id', async () => {
    const h = makeHarness();
    await h.reader.read('provider-one');
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    h.setSource({ ...SOURCE_A, providerId: 'provider-two' });
    await h.reader.read('provider-two');
    await vi.waitFor(() => expect(h.calls.fetch).toBe(2));
    // provider-one 的节流不影响 provider-two,反之亦然
    h.setSource(SOURCE_A);
    await h.reader.read('provider-one');
    expect(h.calls.fetch).toBe(2);
  });
});

describe('mid-flight identity change (live currency guard, #2768 首轮 ①)', () => {
  it('discards an old-key response that lands after a key change mid-flight', async () => {
    // key A 的 fetch 在飞行中,provider 换成 key B —— A 的迟到响应(77%)不得落库,
    // 只有 B 的补刷快照(默认 40%)可写(旧实现死守卫恒过,A 会复活已清快照)。
    const h = makeHarness({ deferFetch: true });
    void h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    h.setSource(SOURCE_B);
    await h.reader.syncForProviderChange(SOURCE_A.providerId); // 清快照 + 链式补刷 B
    h.resolveFetch(snapshotOf({ fiveHour: { utilization: 77, resetsAt: null } })); // A 的响应迟到
    // 补刷 B 走正常 mock(40%),写库以 record 为准等
    await vi.waitFor(() => expect(h.calls.record).toHaveLength(1));
    expect(h.calls.record[0].keyFingerprint).toBe('fp-key-b'); // 只写了 B
    expect(h.calls.record[0].fiveHour?.utilization).toBe(40); // A 的 77% 没进来
  });

  it('does not resurrect a snapshot when the provider is deleted mid-flight', async () => {
    const h = makeHarness({ deferFetch: true, cached: snapshotOf() });
    void h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    h.setSource(null);
    await h.reader.syncForProviderChange(SOURCE_A.providerId); // 删除:清快照
    h.resolveFetch(snapshotOf({ fiveHour: { utilization: 88, resetsAt: null } })); // A 迟到
    // 给在飞 continuation 一个微任务排空的机会
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.record).toHaveLength(0); // 无任何写回
    expect(h.cached()).toBeNull(); // 快照保持已清
    expect(h.calls.fetch).toBe(1); // 无源,不补刷
  });

  it('a stale 401 does not clear the new key snapshot', async () => {
    // A 的 fetch 飞行中已换成 B 且 B 快照在手 —— A 的迟到 401 不得清掉 B 的数据。
    const h = makeHarness({ deferFetch: true });
    void h.reader.read(SOURCE_A.providerId);
    await vi.waitFor(() => expect(h.calls.fetch).toBe(1));
    const bSnapshot = snapshotOf({ keyFingerprint: 'fp-key-b' });
    h.setSource(SOURCE_B);
    h.setCached(bSnapshot);
    h.rejectFetch(new UnauthorizedError('401'));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.clear).toBe(0); // 未误清
    expect(h.cached()).toBe(bSnapshot);
  });
});
