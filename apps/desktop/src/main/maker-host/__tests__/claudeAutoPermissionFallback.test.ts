import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';

import {
  createClaudeAutoClassifierFailureObserver,
  createClaudeAutoPermissionFallbackCoordinator,
  isClaudeAutoClassifierRequest,
  setClaudeAutoClassifierUnavailableListener,
  type ClaudeAutoPermissionFallbackDeps,
} from '../claude-auto-permission-fallback.js';

/** deps.getSession 的返回形状（模块内部类型，测试里按结构声明即可）。 */
type FallbackSession = NonNullable<ReturnType<ClaudeAutoPermissionFallbackDeps['getSession']>>;

const CLASSIFIER_PREFIX = 'You are a security monitor for autonomous AI coding agents.';

function requestBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 64,
      system: [{ type: 'text', text: `${CLASSIFIER_PREFIX}\nRules` }],
      messages: [],
      ...overrides,
    }),
  );
}

function ctx(overrides: Partial<ResponseObserverCtx> = {}): ResponseObserverCtx {
  return {
    reqId: 1,
    method: 'POST',
    url: '/v1/messages',
    upstreamBase: 'https://relay.example',
    status: 429,
    requestHeaders: { 'x-claude-code-session-id': 'sdk-1' },
    responseHeaders: {},
    requestBody: requestBody(),
    ...overrides,
  };
}

function createDeps(overrides: Partial<ClaudeAutoPermissionFallbackDeps> = {}) {
  const useCindyAutoReviewFallback = vi.fn(async () => {});
  const deps: ClaudeAutoPermissionFallbackDeps = {
    getSession: vi.fn(() => ({ agentKind: 'claude-code', useCindyAutoReviewFallback })),
    getSessionMeta: vi.fn(async () => ({ permissionMode: 'auto' as const })),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { deps, useCindyAutoReviewFallback };
}

/**
 * 手动驱动的恢复调度器 —— 记下每次排期的 delay,由测试显式 run(),不真等冷却。
 */
function createManualRestoreScheduler() {
  const scheduled: Array<{ delayMs: number; run: () => void; cancelled: boolean }> = [];
  const scheduleRestore = vi.fn((run: () => void, delayMs: number) => {
    const entry = { delayMs, run, cancelled: false };
    scheduled.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  });
  return { scheduled, scheduleRestore };
}

/** 让排期的恢复试探跑完(runRestore 是 async 的,void 出去后要等一拍)。 */
async function runScheduled(entry: { run: () => void }): Promise<void> {
  entry.run();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  setClaudeAutoClassifierUnavailableListener(() => {});
});

describe('Claude Auto classifier request detection', () => {
  it('accepts the observed array and string system prompt shapes', () => {
    expect(isClaudeAutoClassifierRequest(requestBody())).toBe(true);
    expect(
      isClaudeAutoClassifierRequest(requestBody({ system: `${CLASSIFIER_PREFIX}\nRules` })),
    ).toBe(true);
  });

  it('skips the leading attribution block injected by oauth-spawn CC (issue #758)', () => {
    // oauth-spawn 归因默认开:system[0] 是 `x-anthropic-billing-header: ...`,
    // 分类器身份前缀在其后 —— 检测必须跳过归因块,否则降级失灵。
    const attribution = {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.112.system; cc_entrypoint=cli; cch=00000;',
    };
    expect(
      isClaudeAutoClassifierRequest(
        requestBody({
          system: [attribution, { type: 'text', text: `${CLASSIFIER_PREFIX}\nRules` }],
        }),
      ),
    ).toBe(true);
    // 归因块后面跟的是普通主 turn prompt → 仍不得命中。
    expect(
      isClaudeAutoClassifierRequest(
        requestBody({
          system: [attribution, { type: 'text', text: 'You are Claude Code, Anthropic official CLI' }],
        }),
      ),
    ).toBe(false);
    // 只有归因块、没有任何身份前缀 → 不命中。
    expect(isClaudeAutoClassifierRequest(requestBody({ system: [attribution] }))).toBe(false);
  });

  it('detects every classifier max_tokens shape (fast 256 / stage1 64 / thinking 8192)', () => {
    // 不再依赖固定 max_tokens——三条分类器路径(含 +k 变体)都必须命中,
    // 否则 fast / thinking 路径的 429 会漏检、不触发降级。
    for (const max_tokens of [64, 256, 8192, 65, 320, 8256, 16384]) {
      expect(isClaudeAutoClassifierRequest(requestBody({ max_tokens }))).toBe(true);
    }
  });

  it('fails closed for malformed or lookalike requests', () => {
    expect(isClaudeAutoClassifierRequest(Buffer.from('{bad json'))).toBe(false);
    expect(isClaudeAutoClassifierRequest(requestBody({ system: 'ordinary assistant' }))).toBe(
      false,
    );
    expect(isClaudeAutoClassifierRequest(requestBody({ system: [] }))).toBe(false);
    // 前缀不匹配的普通主 turn 即使 max_tokens 恰为 64 也不得命中。
    expect(
      isClaudeAutoClassifierRequest(
        requestBody({ system: 'You are Claude Code, Anthropic official CLI' }),
      ),
    ).toBe(false);
    // 防御性副判据:即便 system 恰好以分类器前缀开头,大输出请求(超上界)也不误判为
    // 分类器故障——闭合「前缀碰撞 → 错误降级」的理论窗口。
    expect(isClaudeAutoClassifierRequest(requestBody({ max_tokens: 32000 }))).toBe(false);
    // 缺省 max_tokens(分类器恒会设置)同样不命中。
    expect(
      isClaudeAutoClassifierRequest(
        Buffer.from(JSON.stringify({ system: [{ type: 'text', text: CLASSIFIER_PREFIX }] })),
      ),
    ).toBe(false);
  });
});

describe('createClaudeAutoClassifierFailureObserver', () => {
  it('keeps Auto for a single transient failure burst (one episode)', () => {
    // 一次动作的 SDK retry storm:多个瞬时失败在数秒内到达 → 归并为一个 episode,
    // 不触发降级(#596 保护的场景)。
    const listener = vi.fn();
    setClaudeAutoClassifierUnavailableListener(listener);
    let t = 0;
    const observer = createClaudeAutoClassifierFailureObserver(() => 'session-1', {
      now: () => t,
    });

    for (const status of [408, 429, 503, 529, 429, 429]) {
      t += 1000; // 6 次失败散布在 6 秒内
      expect(observer(ctx({ status }))).toBeUndefined();
    }

    expect(listener).not.toHaveBeenCalled();
  });

  it('escalates persistent transient failures after 3 episodes without a success (#758)', () => {
    const signals: unknown[] = [];
    setClaudeAutoClassifierUnavailableListener((signal) => signals.push(signal));
    let t = 0;
    const observer = createClaudeAutoClassifierFailureObserver(() => 'session-1', {
      now: () => t,
    });

    observer(ctx({ status: 429 })); // episode 1
    t += 31_000;
    observer(ctx({ status: 429 })); // episode 2
    expect(signals).toEqual([]);
    t += 31_000;
    observer(ctx({ status: 429 })); // episode 3 → 升级
    expect(signals).toEqual([
      { sessionId: 'session-1', agentKind: 'claude-code', status: 429 },
    ]);

    // 升级后记账清零:紧接着的失败重新从 episode 1 数起,不会连环降级。
    t += 31_000;
    observer(ctx({ status: 429 }));
    expect(signals).toHaveLength(1);
  });

  it('resets the episode counter when a classifier request succeeds in between', () => {
    const listener = vi.fn();
    setClaudeAutoClassifierUnavailableListener(listener);
    let t = 0;
    const observer = createClaudeAutoClassifierFailureObserver(() => 'session-1', {
      now: () => t,
    });

    observer(ctx({ status: 429 })); // episode 1
    t += 31_000;
    observer(ctx({ status: 503 })); // episode 2
    observer(ctx({ status: 200 })); // 分类器恢复 → 清零
    t += 31_000;
    observer(ctx({ status: 429 })); // 重新从 episode 1 数起
    t += 31_000;
    observer(ctx({ status: 429 })); // episode 2

    expect(listener).not.toHaveBeenCalled();

    // 恢复清零只认分类器请求本身:普通主 turn 的成功响应不得清零其它会话记账。
    t += 31_000;
    observer(ctx({ status: 200, requestBody: requestBody({ system: 'ordinary assistant' }) }));
    observer(ctx({ status: 200, requestBody: Buffer.from('{bad json') })); // 有记账时坏 body 也不得抛
    t += 31_000;
    observer(ctx({ status: 429 })); // episode 3 → 升级(前两段仍在账上)
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not treat 3xx classifier responses as recovery', () => {
    // 3xx 不是分类器真正给出 verdict:若清账,「上游持续 3xx」的故障会永不升级。
    const listener = vi.fn();
    setClaudeAutoClassifierUnavailableListener(listener);
    let t = 0;
    const observer = createClaudeAutoClassifierFailureObserver(() => 'session-1', {
      now: () => t,
    });

    observer(ctx({ status: 429 })); // episode 1
    t += 31_000;
    observer(ctx({ status: 429 })); // episode 2
    observer(ctx({ status: 302 })); // 分类器请求被重定向 → 不得清账
    t += 31_000;
    observer(ctx({ status: 429 })); // episode 3 → 升级(证明前两段仍在账上)
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('expires episodes outside the 10-minute window', () => {
    const listener = vi.fn();
    setClaudeAutoClassifierUnavailableListener(listener);
    let t = 0;
    const observer = createClaudeAutoClassifierFailureObserver(() => 'session-1', {
      now: () => t,
    });

    observer(ctx({ status: 429 })); // episode 1
    t += 31_000;
    observer(ctx({ status: 429 })); // episode 2
    t += 11 * 60_000; // 11 分钟后:前两段过期
    observer(ctx({ status: 429 })); // 只剩这一段
    t += 31_000;
    observer(ctx({ status: 429 })); // 第二段
    expect(listener).not.toHaveBeenCalled();
    t += 31_000;
    observer(ctx({ status: 429 })); // 第三段 → 升级
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clears pending transient episodes when a deterministic failure downgrades immediately', () => {
    const signals: unknown[] = [];
    setClaudeAutoClassifierUnavailableListener((signal) => signals.push(signal));
    let t = 0;
    const observer = createClaudeAutoClassifierFailureObserver(() => 'session-1', {
      now: () => t,
    });

    observer(ctx({ status: 429 })); // episode 1
    t += 31_000;
    observer(ctx({ status: 429 })); // episode 2
    observer(ctx({ status: 401 })); // 确定性错误 → 立即降级,同时清零瞬时记账
    expect(signals).toEqual([
      { sessionId: 'session-1', agentKind: 'claude-code', status: 401 },
    ]);

    // 用户重开 Auto 后:残账已清,单次偶发失败不得被推过阈值,要重新数满 3 段。
    t += 31_000;
    observer(ctx({ status: 429 }));
    t += 31_000;
    observer(ctx({ status: 429 }));
    expect(signals).toHaveLength(1);
    t += 31_000;
    observer(ctx({ status: 429 }));
    expect(signals).toHaveLength(2);
  });

  it('tracks transient episodes per session independently', () => {
    const listener = vi.fn();
    setClaudeAutoClassifierUnavailableListener(listener);
    let t = 0;
    const observer = createClaudeAutoClassifierFailureObserver(
      (sdkId) => (sdkId === 'sdk-1' ? 'session-1' : 'session-2'),
      { now: () => t },
    );

    // 两个任务各自累计 2 段,交错到达 —— 谁都不该被对方推过阈值。
    for (let i = 0; i < 2; i += 1) {
      observer(ctx({ status: 429 }));
      observer(ctx({ status: 429, requestHeaders: { 'x-claude-code-session-id': 'sdk-2' } }));
      t += 31_000;
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('reports non-transient classifier failures with the resolved business session id', () => {
    const signals: unknown[] = [];
    setClaudeAutoClassifierUnavailableListener((signal) => signals.push(signal));
    const observer = createClaudeAutoClassifierFailureObserver((sdkId) =>
      sdkId === 'sdk-1' ? 'session-1' : null,
    );

    expect(observer(ctx({ status: 400 }))).toBeUndefined();
    expect(observer(ctx({ status: 401 }))).toBeUndefined();
    expect(observer(ctx({ status: 403 }))).toBeUndefined();
    expect(observer(ctx({ status: 404 }))).toBeUndefined();
    expect(observer(ctx({ status: 422 }))).toBeUndefined();

    expect(signals).toEqual([
      { sessionId: 'session-1', agentKind: 'claude-code', status: 400 },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 401 },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 403 },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 404 },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 422 },
    ]);
  });

  it('does not parse/report success, redirects, non-classifier bodies, or unresolved sessions', () => {
    const listener = vi.fn();
    setClaudeAutoClassifierUnavailableListener(listener);
    const resolved = createClaudeAutoClassifierFailureObserver(() => 'session-1');
    const unresolved = createClaudeAutoClassifierFailureObserver(() => null);

    resolved(ctx({ status: 200, requestBody: Buffer.from('{bad json') })); // 成功响应不解析
    resolved(ctx({ status: 302 })); // 3xx 重定向:非错误,短路
    // 即便状态码现在落在 4xx 触发区间,非分类器 body(前缀不匹配)仍不得上报。
    resolved(ctx({ status: 400, requestBody: requestBody({ system: 'ordinary assistant' }) }));
    unresolved(ctx()); // 无法反解会话 id
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createClaudeAutoPermissionFallbackCoordinator', () => {
  it('keeps the persisted Auto preference and switches only the runtime reviewer', async () => {
    const { deps, useCindyAutoReviewFallback } = createDeps();
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(true);
    expect(useCindyAutoReviewFallback).toHaveBeenCalledTimes(1);
    expect(deps.getSessionMeta).toHaveBeenCalledWith('session-1');
    expect(deps.logger.info).toHaveBeenCalledWith(
      'auto permission classifier unavailable; session kept on Auto with Cindy fallback',
      expect.objectContaining({ sessionId: 'session-1', status: 429 }),
    );
  });

  it('accumulates classifier-failure counters across signals and logs them on fallback', async () => {
    const { deps } = createDeps({
      getSessionMeta: vi
        .fn()
        .mockResolvedValueOnce({ permissionMode: 'ask' })
        .mockResolvedValueOnce({ permissionMode: 'auto' }),
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-skip', status: 429 })).resolves.toBe(false);
    await expect(fallback({ sessionId: 'session-1', status: 503 })).resolves.toBe(true);

    expect(deps.logger.info).toHaveBeenCalledWith(
      'auto permission classifier unavailable; session kept on Auto with Cindy fallback',
      expect.objectContaining({
        counters: expect.objectContaining({
          detected: 2,
          switched: 1,
          skippedNotAuto: 1,
          dedupedRetries: 0,
        }),
      }),
    );
  });

  it('deduplicates concurrent failures for the same session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, useCindyAutoReviewFallback } = createDeps();
    useCindyAutoReviewFallback.mockImplementation(async () => gate);
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    const first = fallback({ sessionId: 'session-1', status: 429 });
    await vi.waitFor(() => expect(useCindyAutoReviewFallback).toHaveBeenCalledTimes(1));
    await expect(fallback({ sessionId: 'session-1', status: 503 })).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(useCindyAutoReviewFallback).toHaveBeenCalledTimes(1);
  });

  it('skips non-auto, mismatched-agent, and unsupported sessions', async () => {
    const notAuto = createDeps({
      getSessionMeta: vi.fn(async () => ({ permissionMode: 'ask' as const })),
    });
    const mismatched = createDeps({
      getSession: vi.fn(() => ({
        agentKind: 'codex',
        useCindyAutoReviewFallback: vi.fn(async () => {}),
      })),
    });
    const unsupported = createDeps({
      getSession: vi.fn(() => ({ agentKind: 'claude-code' })),
    });

    await expect(
      createClaudeAutoPermissionFallbackCoordinator(notAuto.deps)({
        sessionId: 'session-1',
        status: 429,
      }),
    ).resolves.toBe(false);
    await expect(
      createClaudeAutoPermissionFallbackCoordinator(mismatched.deps)({
        sessionId: 'session-1',
        status: 429,
      }),
    ).resolves.toBe(false);
    await expect(
      createClaudeAutoPermissionFallbackCoordinator(unsupported.deps)({
        sessionId: 'session-1',
        status: 429,
      }),
    ).resolves.toBe(false);
    expect(notAuto.useCindyAutoReviewFallback).not.toHaveBeenCalled();
    expect(mismatched.useCindyAutoReviewFallback).not.toHaveBeenCalled();
    expect(unsupported.useCindyAutoReviewFallback).not.toHaveBeenCalled();
  });

  it('accepts a matching agent signal without changing the stored permission mode', async () => {
    const useCindyAutoReviewFallback = vi.fn(async () => {});
    const { deps } = createDeps({
      getSession: vi.fn(() => ({ agentKind: 'codex', useCindyAutoReviewFallback })),
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({
      sessionId: 'session-codex',
      agentKind: 'codex',
      status: 408,
    })).resolves.toBe(true);
    expect(useCindyAutoReviewFallback).toHaveBeenCalledTimes(1);
    expect(deps.getSessionMeta).toHaveBeenCalledTimes(1);
  });

  it('logs and returns false when the runtime fallback switch fails', async () => {
    const runtimeFallback = vi.fn(async () => {
      throw new Error('runtime unavailable');
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => ({
        agentKind: 'claude-code',
        useCindyAutoReviewFallback: runtimeFallback,
      })),
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(false);
    expect(runtimeFallback).toHaveBeenCalledOnce();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'auto permission fallback failed',
      expect.objectContaining({ error: 'runtime unavailable' }),
    );
  });
});

/**
 * 切回原生审阅的乐观试探(issue #1578)。
 *
 * 缺了它,一次瞬时抖动就把会话永久钉在 Cindy fallback 上 —— 会话内没有恢复路径,用户
 * 只能新开会话。恢复只能靠时间驱动:切换那一刻 handle 已把 SDK 切到 `default` 档,原生
 * 分类器不再被调用,proxy 观察器永远收不到它的 2xx(而且该会话的瞬时记账也已清零)。
 */
describe('native Auto reviewer restore attempts', () => {
  function createRestorableDeps(overrides: Partial<ClaudeAutoPermissionFallbackDeps> = {}) {
    const useCindyAutoReviewFallback = vi.fn(async () => {});
    const restoreNativeAutoReview = vi.fn(async () => 'restored' as const);
    const { scheduled, scheduleRestore } = createManualRestoreScheduler();
    const { deps } = createDeps({
      getSession: vi.fn(() => ({
        agentKind: 'claude-code',
        useCindyAutoReviewFallback,
        restoreNativeAutoReview,
      })),
      scheduleRestore,
      ...overrides,
    });
    return { deps, useCindyAutoReviewFallback, restoreNativeAutoReview, scheduled };
  }

  it('schedules the first attempt after the base cooldown and then restores', async () => {
    const { deps, restoreNativeAutoReview, scheduled } = createRestorableDeps();
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(5 * 60_000); // RESTORE_COOLDOWN_BASE_MS

    await runScheduled(scheduled[0]);
    expect(restoreNativeAutoReview).toHaveBeenCalledOnce();
    expect(deps.logger.info).toHaveBeenCalledWith(
      'restored native Auto reviewer after cooldown',
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });

  it('doubles the cooldown on every re-switch and caps it at one hour', async () => {
    const { deps, scheduled } = createRestorableDeps();
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    // 每次重新切到 fallback 说明上一次试探白跑了 —— 退避加倍,别每 5 分钟把用户重新
    // 推进一次硬拒绝窗口。
    for (let i = 0; i < 6; i += 1) {
      await fallback({ sessionId: 'session-1', status: 429 });
    }
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([
      5 * 60_000,
      10 * 60_000,
      20 * 60_000,
      40 * 60_000,
      60 * 60_000, // 封顶
      60 * 60_000,
    ]);
    // 前几轮的在飞试探都被作废,只有最后一轮有效。
    expect(scheduled.slice(0, -1).every((entry) => entry.cancelled)).toBe(true);
    expect(scheduled.at(-1)?.cancelled).toBe(false);
  });

  it('skips the attempt when the session left Auto during the cooldown', async () => {
    let permissionMode: 'auto' | 'ask' = 'auto';
    const { deps, restoreNativeAutoReview, scheduled } = createRestorableDeps({
      getSessionMeta: vi.fn(async () => ({ permissionMode })),
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await fallback({ sessionId: 'session-1', status: 429 });
    permissionMode = 'ask'; // 用户自己收紧了权限档
    await runScheduled(scheduled[0]);

    expect(restoreNativeAutoReview).not.toHaveBeenCalled();
    expect(deps.logger.debug).toHaveBeenCalledWith(
      'skip native Auto reviewer restore attempt',
      expect.objectContaining({ permissionMode: 'ask' }),
    );
  });

  it('skips the attempt when the session is gone by the time the cooldown ends', async () => {
    const useCindyAutoReviewFallback = vi.fn(async () => {});
    const restoreNativeAutoReview = vi.fn(async () => 'restored' as const);
    const { scheduled, scheduleRestore } = createManualRestoreScheduler();
    let alive = true;
    const { deps } = createDeps({
      getSession: vi.fn((): FallbackSession | undefined => (alive
        ? { agentKind: 'claude-code', useCindyAutoReviewFallback, restoreNativeAutoReview }
        : undefined)),
      scheduleRestore,
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await fallback({ sessionId: 'session-1', status: 429 });
    alive = false; // 会话已关闭
    await runScheduled(scheduled[0]);

    expect(restoreNativeAutoReview).not.toHaveBeenCalled();
    expect(deps.logger.debug).toHaveBeenCalledWith(
      'skip native Auto reviewer restore attempt',
      expect.objectContaining({ hasSession: false }),
    );
  });

  it('does not schedule anything for a handle without the symmetric entry point', async () => {
    const { scheduled, scheduleRestore } = createManualRestoreScheduler();
    const { deps } = createDeps({ scheduleRestore }); // 默认 handle 没有 restoreNativeAutoReview
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(true);
    expect(scheduled).toHaveLength(0);
  });

  it('reschedules a failing restore attempt instead of dropping it', async () => {
    const { deps, scheduled } = createRestorableDeps({
      getSession: vi.fn(() => ({
        agentKind: 'claude-code',
        useCindyAutoReviewFallback: vi.fn(async () => {}),
        restoreNativeAutoReview: vi.fn(async (): Promise<never> => {
          throw new Error('control channel closed');
        }),
      })),
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await fallback({ sessionId: 'session-1', status: 429 });
    await runScheduled(scheduled[0]);

    expect(deps.logger.warn).toHaveBeenCalledWith(
      'native Auto reviewer restore failed; rescheduling',
      expect.objectContaining({ error: 'control channel closed' }),
    );
    // 一次偶发的 transport 异常不能永久断掉恢复入口。
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1].delayMs).toBe(10 * 60_000);
  });

  /**
   * coordinator 每次「切到 fallback」只排**一次**试探。若那一次恰好落在 rewind / query
   * 重建 / invalid-resume 恢复窗口里，handle 推不动控制请求 —— 静默放弃就等于让这个会话
   * 永久留在 Cindy fallback（greptile / copilot P1 of #1590）。所以 handle 明确返回
   * `blocked`，coordinator 按退避重排。
   */
  describe('outcome drives whether another attempt is scheduled', () => {
    function createDepsWithOutcomes(outcomes: readonly string[]) {
      const restoreNativeAutoReview = vi.fn(async () => outcomes[
        Math.min(restoreNativeAutoReview.mock.calls.length - 1, outcomes.length - 1)
      ] as never);
      const { scheduled, scheduleRestore } = createManualRestoreScheduler();
      const { deps } = createDeps({
        getSession: vi.fn(() => ({
          agentKind: 'claude-code',
          useCindyAutoReviewFallback: vi.fn(async () => {}),
          restoreNativeAutoReview,
        })),
        scheduleRestore,
      });
      return { deps, restoreNativeAutoReview, scheduled };
    }

    it('reschedules with a doubled cooldown while the control channel stays blocked', async () => {
      const { deps, restoreNativeAutoReview, scheduled } =
        createDepsWithOutcomes(['blocked', 'blocked', 'restored']);
      const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

      await fallback({ sessionId: 'session-1', status: 429 });
      expect(scheduled).toHaveLength(1);

      await runScheduled(scheduled[0]);
      expect(scheduled).toHaveLength(2);
      await runScheduled(scheduled[1]);
      expect(scheduled).toHaveLength(3);
      await runScheduled(scheduled[2]);

      // 第三次返回 restored → 收口,不再排。
      expect(scheduled).toHaveLength(3);
      expect(restoreNativeAutoReview).toHaveBeenCalledTimes(3);
      // 重排与降级共用退避:5 → 10 → 20 分钟。
      expect(scheduled.map((entry) => entry.delayMs)).toEqual([
        5 * 60_000,
        10 * 60_000,
        20 * 60_000,
      ]);
      expect(deps.logger.info).toHaveBeenCalledWith(
        'restored native Auto reviewer after cooldown',
        expect.objectContaining({ sessionId: 'session-1' }),
      );
    });

    it('does not reschedule when a newer fallback superseded the attempt', async () => {
      // 试探期间该会话又降级了 → 分类器还坏着,那一轮 fallback 自己会排新的试探,
      // 这里重排只会白跑并把退避推高。
      const { deps, scheduled } = createDepsWithOutcomes(['superseded']);
      const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

      await fallback({ sessionId: 'session-1', status: 429 });
      await runScheduled(scheduled[0]);

      expect(scheduled).toHaveLength(1);
      expect(deps.logger.debug).toHaveBeenCalledWith(
        'native Auto reviewer restore did not apply',
        expect.objectContaining({ outcome: 'superseded' }),
      );
    });

    it('does not reschedule when the route cannot serve the native reviewer', async () => {
      // 终态:重排不会让第三方 / 网关路由长出原生分类器。
      const { deps, scheduled } = createDepsWithOutcomes(['unsupported']);
      const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

      await fallback({ sessionId: 'session-1', status: 429 });
      await runScheduled(scheduled[0]);

      expect(scheduled).toHaveLength(1);
      expect(deps.logger.debug).toHaveBeenCalledWith(
        'native Auto reviewer restore did not apply',
        expect.objectContaining({ outcome: 'unsupported' }),
      );
    });
  });
});
