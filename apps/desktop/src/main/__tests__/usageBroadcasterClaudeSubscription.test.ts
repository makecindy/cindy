/**
 * usageBroadcaster 的 Claude 订阅快照段单测 —— 专注冷缓存 hydration 的并发语义:
 *   - 并发 record 等同一次 SQLite 读完成后按到达顺序 merge(旧持久化行不得覆盖新数据)
 *   - clear 抢先于 in-flight hydration 时, 读回的旧行不得复活
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  exec: vi.fn(async () => undefined),
  getCurrentDbClientUserId: vi.fn(() => 'user-1'),
  tapWindowBroadcast: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: mocks.tapWindowBroadcast,
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../localDb/dailySpend', () => ({
  incrementDailySpend: vi.fn(),
  getTodaySpend: vi.fn(async () => 0),
  localDayKey: () => '2026-07-02',
}));
vi.mock('../localDb/dailyModelUsage', () => ({
  incrementDailyModelUsage: vi.fn(),
}));
vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({ queryOne: mocks.queryOne, exec: mocks.exec, drizzle: {} }),
  getCurrentDbClientUserId: mocks.getCurrentDbClientUserId,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('claude subscription snapshot hydration race', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryOne.mockReset();
    mocks.exec.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentDbClientUserId.mockReturnValue('user-1');
    mocks.tapWindowBroadcast.mockReset();
  });

  it('does not drop the very first snapshot after main start (owner init is not invalidation)', async () => {
    // record 在 ensure 之前捕获世代; 首笔快照到达时 owner 尚未初始化, ensure 里的
    // owner 首次初始化若 bump 世代, 这笔会被复查误丢 —— chip 要空到下一次刷新
    // (headers 单笔 + 端点 180s 节流)。首次初始化必须不算失效事件。
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);  // 冷库无持久化行

    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 10 }, source: 'unified-headers', updatedAt: 1,
    });

    const current = await broadcaster.readClaudeSubscriptionUsageSnapshot();
    expect(current?.fiveHour?.utilization).toBe(10);
    // 且已正常落库 (INSERT 被调用)
    expect(mocks.exec).toHaveBeenCalled();
  });

  it('serializes concurrent records behind one hydration read (stale row must not win)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    const dbRead = deferred<{ snapshot: string } | null>();
    mocks.queryOne.mockReturnValue(dbRead.promise);

    // 冷缓存: 两笔 headers 快照并发到达 (5h=10% → 5h=20%), SQLite 读挂起中。
    const recordA = broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 10 }, source: 'unified-headers', updatedAt: 1,
    });
    const recordB = broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 20 }, source: 'unified-headers', updatedAt: 2,
    });

    // 持久化里躺着上个周期的旧行 (5h=5%) —— 读回后不得覆盖两笔新数据。
    dbRead.resolve({
      snapshot: JSON.stringify({ fiveHour: { utilization: 5 }, source: 'oauth-endpoint', updatedAt: 0 }),
    });
    await Promise.all([recordA, recordB]);

    const current = await broadcaster.readClaudeSubscriptionUsageSnapshot();
    expect(current?.fiveHour?.utilization).toBe(20);
    expect(current?.updatedAt).toBe(2);
  });

  it('does not clobber the persisted row with a window-less snapshot when hydration failed', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // 冷缓存 hydration 读库失败 → 内存为空; 一笔 status-only headers 快照
    // (仅 rateLimitStatus, 无任何窗口)到达。merge 无旧值可保 → 全空快照会被
    // 无条件 upsert, 抹掉持久化行里的有效窗口(与 codex 侧同形状的覆盖事故)。
    mocks.queryOne.mockRejectedValue(new Error('db busy'));

    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: null,
      sevenDay: null,
      rateLimitStatus: 'allowed',
      source: 'unified-headers',
      updatedAt: 5,
    });

    expect(mocks.exec).not.toHaveBeenCalled();
  });

  // 与 codex 侧同一条: 读库失败不得把缓存标记成已加载, 否则本进程之后再也无法落库。
  it('retries hydration after a transient read failure instead of giving up', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockRejectedValueOnce(new Error('db busy'));

    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: null, sevenDay: null, rateLimitStatus: 'allowed',
      source: 'unified-headers', updatedAt: 1,
    });
    expect(mocks.exec).not.toHaveBeenCalled();

    mocks.queryOne.mockResolvedValue(null);
    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 42 }, source: 'unified-headers', updatedAt: 2,
    });

    expect(mocks.exec).toHaveBeenCalled();
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persisted = JSON.parse(lastExecParams[1] as string);
    expect(persisted.fiveHour?.utilization).toBe(42);
  });

  // 与 codex 侧同一条: 重试读到的旧行不得顶掉 hydration 失败期间收到的新快照。
  it('keeps snapshots received while hydration was failing', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockRejectedValueOnce(new Error('db busy'));

    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 42 }, source: 'unified-headers', updatedAt: 2,
    });
    expect(mocks.exec).not.toHaveBeenCalled();

    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({
        fiveHour: { utilization: 5 },
        scoped: [{ utilization: 12, modelDisplayName: 'Opus' }],
        source: 'oauth-endpoint',
        updatedAt: 1,
      }),
    });
    const current = await broadcaster.readClaudeSubscriptionUsageSnapshot();
    // 内存里的 42% 胜出, 同时补上库里独有的 scoped(端点源才有, headers 源没有)。
    expect(current?.fiveHour?.utilization).toBe(42);
    expect(current?.scoped?.[0]?.modelDisplayName).toBe('Opus');
  });

  // 与 codex 侧同款: owner 缺失时 IIFE 同步走完, 句柄不能在它的 finally 里清 ——
  // 否则会被外层赋值写回, 之后永远复用这个已 resolve 的 Promise, 再也不查库。
  it('reads the database once the owner becomes available', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.getCurrentDbClientUserId.mockReturnValue(null as unknown as string);

    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 10 }, source: 'unified-headers', updatedAt: 1,
    });
    expect(mocks.queryOne).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();

    // 登录后必须重新查库。跨 owner 变化的那一笔按既有世代语义会被丢弃(它属于换号前
    // 的上下文), 下一笔恢复正常落库。
    mocks.getCurrentDbClientUserId.mockReturnValue('user-1');
    mocks.queryOne.mockResolvedValue(null);
    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 20 }, source: 'unified-headers', updatedAt: 2,
    });
    expect(mocks.queryOne).toHaveBeenCalled();

    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 30 }, source: 'unified-headers', updatedAt: 3,
    });
    expect(mocks.exec).toHaveBeenCalled();
  });

  it('persists a rejected status even without windows (与 codex 侧 reached 标记同口径)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // rejected 是权威的「请求已被拒」信号(isClaudeSubscriptionAlerting 直接据此告警),
    // 缺窗口时也必须落库 —— 否则重启后 chip 不知道当前正被限流。
    mocks.queryOne.mockResolvedValue(null);

    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: null,
      sevenDay: null,
      rateLimitStatus: 'rejected',
      source: 'unified-headers',
      updatedAt: 5,
    });

    expect(mocks.exec).toHaveBeenCalled();
  });

  // 反向转换同样必须落库: 库里是 rejected、后续 allowed 的 status-only 事件没有窗口,
  // 按内容判会被拦下, 库里就永远停在 rejected —— 重启后 chip 挂着一个假的限流警告。
  it('persists an allowed transition that clears a persisted rejected status', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({
        fiveHour: null,
        sevenDay: null,
        rateLimitStatus: 'rejected',
        source: 'unified-headers',
        updatedAt: 1,
      }),
    });

    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: null,
      sevenDay: null,
      rateLimitStatus: 'allowed',
      source: 'unified-headers',
      updatedAt: 5,
    });

    expect(mocks.exec).toHaveBeenCalled();
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persisted = JSON.parse(lastExecParams[1] as string);
    expect(persisted.rateLimitStatus).toBe('allowed');
  });

  it('persists a status-only snapshot merged onto hydrated windows (regression guard)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    // hydration 正常命中 → status-only 增量并入已有窗口, 照常落库且窗口保留。
    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({
        fiveHour: { utilization: 54, resetsAt: 1_786_355_999 },
        source: 'oauth-endpoint',
        updatedAt: 1,
      }),
    });

    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: null,
      sevenDay: null,
      rateLimitStatus: 'allowed',
      source: 'unified-headers',
      updatedAt: 5,
    });

    expect(mocks.exec).toHaveBeenCalled();
    const lastExecParams = (mocks.exec.mock.calls.at(-1) as unknown[] | undefined)?.[1] as unknown[];
    const persisted = JSON.parse(lastExecParams[1] as string);
    expect(persisted.fiveHour?.utilization).toBe(54);
  });

  it('discards an in-flight hydration result when clear wins the race', async () => {
    const broadcaster = await import('../usageBroadcaster');
    const dbRead = deferred<{ snapshot: string } | null>();
    mocks.queryOne.mockReturnValue(dbRead.promise);

    // record 触发冷缓存 hydration (挂起) → clear 抢先完成。
    const record = broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 10 }, source: 'unified-headers', updatedAt: 1,
    });
    await broadcaster.clearClaudeSubscriptionUsageSnapshot();

    dbRead.resolve({
      snapshot: JSON.stringify({ fiveHour: { utilization: 99 }, source: 'oauth-endpoint', updatedAt: 0 }),
    });
    await record;

    // clear 抢先后: hydration 读回的旧持久化行 (5h=99%) 不得复活, 且 record 本身
    // 也因世代复查被整体丢弃 (不 merge / 不广播 / 不写库) —— 快照保持 null。
    const current = await broadcaster.readClaudeSubscriptionUsageSnapshot();
    expect(current).toBeNull();
  });

  it('taps record and clear broadcasts for device-link forwarding (merged snapshot / null)', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);

    await broadcaster.recordClaudeSubscriptionUsageSnapshot({
      fiveHour: { utilization: 10 }, source: 'unified-headers', updatedAt: 1,
    });
    const tapped = mocks.tapWindowBroadcast.mock.calls.find(
      ([channel]) => channel === 'usage:claude-subscription-changed',
    );
    expect(tapped?.[1]).toMatchObject({ fiveHour: { utilization: 10 } });

    mocks.tapWindowBroadcast.mockClear();
    await broadcaster.clearClaudeSubscriptionUsageSnapshot();
    // 登出 / 换号清除也要同步到控制端(null 让远程 chip 回占位态)。
    expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
      'usage:claude-subscription-changed',
      null,
    );
  });

  it('taps codex account broadcasts with the authoritative combined payload', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);

    await broadcaster.recordCodexAccountUsageSnapshot({
      source: 'codex-app-server',
      limitId: 'codex',
      primary: { usedPercent: 3, windowMinutes: 10_080 },
    });

    const tapped = mocks.tapWindowBroadcast.mock.calls.find(
      ([channel]) => channel === 'usage:codex-account-changed',
    );
    // 转发的是组合 payload(远程镜像按整帧替换消费)。
    expect(tapped?.[1]).toMatchObject({ limitId: 'codex' });
  });

  it('taps xai rate-limit record and clear broadcasts', async () => {
    const broadcaster = await import('../usageBroadcaster');

    broadcaster.recordXaiRateLimitSnapshot({ source: 'cli-chat-proxy' } as never);
    expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
      'usage:xai-rate-limit-changed',
      expect.objectContaining({ updatedAt: expect.any(Number) }),
    );

    mocks.tapWindowBroadcast.mockClear();
    broadcaster.clearXaiRateLimitSnapshot();
    expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith('usage:xai-rate-limit-changed', null);
  });
});
