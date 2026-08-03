import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';

import {
  createClaudeAutoClassifierFailureObserver,
  createClaudeAutoPermissionFallbackCoordinator,
  isClaudeAutoClassifierRequest,
  setClaudeAutoClassifierUnavailableListener,
  type ClaudeAutoClassifierUnavailableSignal,
  type ClaudeAutoPermissionFallbackDeps,
} from '../claude-auto-permission-fallback.js';

const CLASSIFIER_PREFIX = 'You are a security monitor for autonomous AI coding agents.';

/**
 * 收集观察器发出的降级信号。issue #1573 后一次瞬时故障会同时产出「turn 级试探性」
 * 信号流与(达阈值时的)「会话级」终态信号,两者语义完全不同,断言必须按 scope 分开看:
 * 会话级才是 #596 保护的"改变整个会话行为"的那一步。
 */
function collectSignals() {
  const signals: ClaudeAutoClassifierUnavailableSignal[] = [];
  setClaudeAutoClassifierUnavailableListener((signal) => signals.push(signal));
  return {
    all: () => signals,
    scoped: (scope: 'turn' | 'session') => signals.filter((s) => (s.scope ?? 'session') === scope),
  };
}

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
  // 返回类型显式带上 boolean:真实 handle 用 false 表示"已在该降级状态,幂等 no-op"。
  const useCindyAutoReviewFallback = vi.fn(async (): Promise<boolean | void> => {});
  const deps: ClaudeAutoPermissionFallbackDeps = {
    getSession: vi.fn(() => ({ agentKind: 'claude-code', useCindyAutoReviewFallback })),
    getSessionMeta: vi.fn(async () => ({ permissionMode: 'auto' as const })),
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { deps, useCindyAutoReviewFallback };
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
  it('keeps the session on native Auto for a single transient failure burst (one episode)', () => {
    // 一次动作的 SDK retry storm:多个瞬时失败在数秒内到达 → 归并为一个 episode,
    // 不触发**会话级**降级(#596 保护的场景)。
    const signals = collectSignals();
    let t = 0;
    const observer = createClaudeAutoClassifierFailureObserver(() => 'session-1', {
      now: () => t,
    });

    for (const status of [408, 429, 503, 529, 429, 429]) {
      t += 1000; // 6 次失败散布在 6 秒内
      expect(observer(ctx({ status }))).toBeUndefined();
    }

    expect(signals.scoped('session')).toEqual([]);
  });

  it('tentatively falls back on every sub-threshold transient failure (#1573)', () => {
    // #1573:阈值以下不再"什么都不做" —— 每一次分类器故障都立刻把当前 turn 交给
    // Cindy reviewer,否则用户会在攒够 3 段之前连撞 60–90s 的硬拒绝。
    //
    // 刻意不按 episode 去重:试探性降级在 turn 边界自动解除,而 turn 边界与 30s 固定桶
    // 不对齐 —— 同一段内用户连发两条消息时,第二条已回探到原生,漏发信号就等于让这一
    // turn 重新裸奔。重复信号的收敛交给 coordinator 与 agent 侧的幂等层。
    const signals = collectSignals();
    let t = 0;
    const observer = createClaudeAutoClassifierFailureObserver(() => 'session-1', {
      now: () => t,
    });

    for (const status of [429, 503, 408]) {
      t += 1000;
      observer(ctx({ status }));
    }

    expect(signals.all()).toEqual([
      { sessionId: 'session-1', agentKind: 'claude-code', status: 429, scope: 'turn' },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 503, scope: 'turn' },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 408, scope: 'turn' },
    ]);
  });

  it('escalates persistent transient failures after 3 episodes without a success (#758)', () => {
    const signals = collectSignals();
    let t = 0;
    const observer = createClaudeAutoClassifierFailureObserver(() => 'session-1', {
      now: () => t,
    });

    observer(ctx({ status: 429 })); // episode 1
    t += 31_000;
    observer(ctx({ status: 429 })); // episode 2
    expect(signals.scoped('session')).toEqual([]);
    expect(signals.scoped('turn')).toHaveLength(2);
    t += 31_000;
    observer(ctx({ status: 429 })); // episode 3 → 升级
    expect(signals.scoped('session')).toEqual([
      { sessionId: 'session-1', agentKind: 'claude-code', status: 429, scope: 'session' },
    ]);

    // 升级后记账清零:紧接着的失败重新从 episode 1 数起,不会连环升级
    // (但仍会继续试探性兜住每个 turn)。
    t += 31_000;
    observer(ctx({ status: 429 }));
    expect(signals.scoped('session')).toHaveLength(1);
    expect(signals.scoped('turn')).toHaveLength(3);
  });

  it('resets the episode counter when a classifier request succeeds in between', () => {
    const signals = collectSignals();
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

    expect(signals.scoped('session')).toEqual([]);

    // 恢复清零只认分类器请求本身:普通主 turn 的成功响应不得清零其它会话记账。
    t += 31_000;
    observer(ctx({ status: 200, requestBody: requestBody({ system: 'ordinary assistant' }) }));
    observer(ctx({ status: 200, requestBody: Buffer.from('{bad json') })); // 有记账时坏 body 也不得抛
    t += 31_000;
    observer(ctx({ status: 429 })); // episode 3 → 升级(前两段仍在账上)
    expect(signals.scoped('session')).toHaveLength(1);
  });

  it('does not treat 3xx classifier responses as recovery', () => {
    // 3xx 不是分类器真正给出 verdict:若清账,「上游持续 3xx」的故障会永不升级。
    const signals = collectSignals();
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
    expect(signals.scoped('session')).toHaveLength(1);
  });

  it('expires episodes outside the 10-minute window', () => {
    const signals = collectSignals();
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
    expect(signals.scoped('session')).toEqual([]);
    t += 31_000;
    observer(ctx({ status: 429 })); // 第三段 → 升级
    expect(signals.scoped('session')).toHaveLength(1);
  });

  it('clears pending transient episodes when a deterministic failure downgrades immediately', () => {
    const signals = collectSignals();
    let t = 0;
    const observer = createClaudeAutoClassifierFailureObserver(() => 'session-1', {
      now: () => t,
    });

    observer(ctx({ status: 429 })); // episode 1
    t += 31_000;
    observer(ctx({ status: 429 })); // episode 2
    observer(ctx({ status: 401 })); // 确定性错误 → 立即会话级降级,同时清零瞬时记账
    expect(signals.scoped('session')).toEqual([
      { sessionId: 'session-1', agentKind: 'claude-code', status: 401, scope: 'session' },
    ]);

    // 用户重开 Auto 后:残账已清,单次偶发失败不得被推过阈值,要重新数满 3 段。
    t += 31_000;
    observer(ctx({ status: 429 }));
    t += 31_000;
    observer(ctx({ status: 429 }));
    expect(signals.scoped('session')).toHaveLength(1);
    t += 31_000;
    observer(ctx({ status: 429 }));
    expect(signals.scoped('session')).toHaveLength(2);
  });

  it('tracks transient episodes per session independently', () => {
    const signals = collectSignals();
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
    expect(signals.scoped('session')).toEqual([]);
    // 试探性降级是 per-session 各自发的,互不影响。
    expect(signals.scoped('turn').filter((s) => s.sessionId === 'session-1')).toHaveLength(2);
    expect(signals.scoped('turn').filter((s) => s.sessionId === 'session-2')).toHaveLength(2);
  });

  it('reports non-transient classifier failures with the resolved business session id', () => {
    const signals = collectSignals();
    const observer = createClaudeAutoClassifierFailureObserver((sdkId) =>
      sdkId === 'sdk-1' ? 'session-1' : null,
    );

    expect(observer(ctx({ status: 400 }))).toBeUndefined();
    expect(observer(ctx({ status: 401 }))).toBeUndefined();
    expect(observer(ctx({ status: 403 }))).toBeUndefined();
    expect(observer(ctx({ status: 404 }))).toBeUndefined();
    expect(observer(ctx({ status: 422 }))).toBeUndefined();

    // 确定性错误一律会话级:重试不会让它变好,试探性降级只会让用户每个 turn 各撞一次。
    expect(signals.all()).toEqual([
      { sessionId: 'session-1', agentKind: 'claude-code', status: 400, scope: 'session' },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 401, scope: 'session' },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 403, scope: 'session' },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 404, scope: 'session' },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 422, scope: 'session' },
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

    // legacy proxy signal 不带 scope → 仍按会话级终态处理(旧行为不变)。
    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(true);
    expect(useCindyAutoReviewFallback).toHaveBeenCalledWith({ scope: 'session' });
    expect(deps.getSessionMeta).toHaveBeenCalledWith('session-1');
    expect(deps.logger.info).toHaveBeenCalledWith(
      'auto permission classifier unavailable; session kept on Auto with Cindy fallback',
      expect.objectContaining({ sessionId: 'session-1', status: 429, scope: 'session' }),
    );
  });

  it('forwards a turn-scoped signal as a tentative fallback and counts it separately (#1573)', async () => {
    const { deps, useCindyAutoReviewFallback } = createDeps();
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(
      fallback({ sessionId: 'session-1', status: 429, scope: 'turn' }),
    ).resolves.toBe(true);
    expect(useCindyAutoReviewFallback).toHaveBeenCalledWith({ scope: 'turn' });
    // 试探性降级用独立文案 + 独立计数:排障时要能一眼分出"上游抖动"与"持续故障"。
    expect(deps.logger.info).toHaveBeenCalledWith(
      'auto permission classifier unavailable; this turn falls back to Cindy review',
      expect.objectContaining({
        scope: 'turn',
        counters: expect.objectContaining({ switched: 1, switchedTentative: 1 }),
      }),
    );

    await expect(
      fallback({ sessionId: 'session-1', status: 429, scope: 'session' }),
    ).resolves.toBe(true);
    expect(deps.logger.info).toHaveBeenLastCalledWith(
      'auto permission classifier unavailable; session kept on Auto with Cindy fallback',
      expect.objectContaining({
        scope: 'session',
        counters: expect.objectContaining({ switched: 2, switchedTentative: 1 }),
      }),
    );
  });

  it('counts an idempotent runtime no-op separately instead of inflating switched', async () => {
    // 观察器对同一 turn 的 retry storm 会连发 turn 级信号(刻意不去重),agent 侧只有第一条
    // 真正切档、其余返回 false。若把它们都算进 switched,日志里一次抖动会变成"降级十几次",
    // 而 counters 是这个模块唯一的排障通道。
    const { deps, useCindyAutoReviewFallback } = createDeps();
    useCindyAutoReviewFallback.mockResolvedValueOnce(true).mockResolvedValue(false);
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);
    const signal = { sessionId: 'session-1', status: 429, scope: 'turn' as const };

    await expect(fallback(signal)).resolves.toBe(true);
    await expect(fallback(signal)).resolves.toBe(false);
    await expect(fallback(signal)).resolves.toBe(false);

    expect(useCindyAutoReviewFallback).toHaveBeenCalledTimes(3);
    // 重复信号不重复打日志 —— 否则一次上游抖动在日志里会读成"降级了三次"。
    expect(deps.logger.info).toHaveBeenCalledTimes(1);

    // 下一次真正切档(升级为会话级)时回看计数:那两条被吞的信号落在 skippedAlreadyFallback,
    // switched 只记真正改变了运行期 reviewer 的两次。
    useCindyAutoReviewFallback.mockResolvedValueOnce(true);
    await expect(
      fallback({ sessionId: 'session-1', status: 429, scope: 'session' }),
    ).resolves.toBe(true);
    expect(deps.logger.info).toHaveBeenLastCalledWith(
      'auto permission classifier unavailable; session kept on Auto with Cindy fallback',
      expect.objectContaining({
        counters: expect.objectContaining({
          detected: 4,
          switched: 2,
          switchedTentative: 1,
          skippedAlreadyFallback: 2,
        }),
      }),
    );
  });

  it('treats a runtime switch that returns no value as a successful switch', async () => {
    // 兼容不返回值的实现(旧 handle / 其它 agent):只有显式 false 才算"没切"。
    const { deps, useCindyAutoReviewFallback } = createDeps();
    useCindyAutoReviewFallback.mockResolvedValue(undefined);
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(true);
    expect(deps.logger.info).toHaveBeenCalledWith(
      'auto permission classifier unavailable; session kept on Auto with Cindy fallback',
      expect.objectContaining({ counters: expect.objectContaining({ switched: 1 }) }),
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

  it('lets a session-scoped escalation pass through a turn-scoped operation in flight', async () => {
    // 观察器在发出会话级信号**之前**就清掉了 episode 记账,所以这一条被当成重复重试丢掉
    // 就是永久丢失:会话只完成试探性降级,下一 turn 又回探、又让用户撞一次故障。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps, useCindyAutoReviewFallback } = createDeps();
    useCindyAutoReviewFallback.mockImplementationOnce(async () => {
      await gate;
      return true;
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    const turnOp = fallback({ sessionId: 'session-1', status: 429, scope: 'turn' });
    await vi.waitFor(() => expect(useCindyAutoReviewFallback).toHaveBeenCalledTimes(1));

    // turn 级操作仍卡在 handle 调用里,会话级升级必须能穿透。
    await expect(
      fallback({ sessionId: 'session-1', status: 429, scope: 'session' }),
    ).resolves.toBe(true);
    expect(useCindyAutoReviewFallback).toHaveBeenLastCalledWith({ scope: 'session' });
    expect(deps.logger.info).toHaveBeenCalledWith(
      'auto permission classifier unavailable; session kept on Auto with Cindy fallback',
      expect.objectContaining({
        scope: 'session',
        counters: expect.objectContaining({ escalatedInFlight: 1 }),
      }),
    );

    release();
    await expect(turnOp).resolves.toBe(true);
  });

  it('still dedupes same-scope retry storms while an operation is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps, useCindyAutoReviewFallback } = createDeps();
    useCindyAutoReviewFallback.mockImplementationOnce(async () => {
      await gate;
      return true;
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    const turnOp = fallback({ sessionId: 'session-1', status: 429, scope: 'turn' });
    await vi.waitFor(() => expect(useCindyAutoReviewFallback).toHaveBeenCalledTimes(1));

    // 同级信号(turn 级 retry storm)不得因为放开升级而一并穿透。
    await expect(
      fallback({ sessionId: 'session-1', status: 503, scope: 'turn' }),
    ).resolves.toBe(false);
    expect(useCindyAutoReviewFallback).toHaveBeenCalledTimes(1);

    release();
    await expect(turnOp).resolves.toBe(true);
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
