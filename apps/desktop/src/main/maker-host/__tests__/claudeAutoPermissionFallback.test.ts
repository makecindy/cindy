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

  /**
   * 漏检可观测性(issue #1579):这条链路是 Auto 档唯一的自救通道,它的两个前置条件
   * (会话请求头、id 反解)任一不满足就整条静默失效。以前两处 early return 什么都不记,
   * 排障时日志里没有任何线索指向这里。
   */
  describe('missed-detection visibility', () => {
    function createObserver(resolve: (sdkSessionId: string) => string | null, t: () => number) {
      const logger = { info: vi.fn(), warn: vi.fn() };
      return { logger, observer: createClaudeAutoClassifierFailureObserver(resolve, { now: t, logger }) };
    }

    /** 取某条 warn 携带的计数快照。 */
    function warnCounters(logger: { warn: ReturnType<typeof vi.fn> }, callIndex = 0) {
      return (logger.warn.mock.calls[callIndex]?.[1] as { counters?: Record<string, number> })?.counters;
    }

    it('warns when an error response carries no session header', () => {
      const listener = vi.fn();
      setClaudeAutoClassifierUnavailableListener(listener);
      const { logger, observer } = createObserver(() => 'session-1', () => 0);

      expect(observer(ctx({ status: 429, requestHeaders: {} }))).toBeUndefined();

      expect(listener).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain('without session header');
      expect(warnCounters(logger)).toMatchObject({
        errorsMissingSessionHeader: 1,
        classifierFailures: 0,
      });
    });

    it('warns when the sdk session id cannot be resolved', () => {
      const { logger, observer } = createObserver(() => null, () => 0);

      expect(observer(ctx({ status: 500 }))).toBeUndefined();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain('unresolvable sdk session id');
      expect(warnCounters(logger)).toMatchObject({ errorsUnresolvedSession: 1 });
    });

    it('counts non-classifier error responses without warning about them', () => {
      // 普通 turn 的错误响应也流经这里,是正常大头 —— 只计数,不刷 warn。
      const { logger, observer } = createObserver(() => 'session-1', () => 0);

      observer(ctx({ status: 429, requestBody: requestBody({ system: 'ordinary assistant' }) }));
      expect(logger.warn).not.toHaveBeenCalled();

      // 让它随下一条真漏检的 warn 一起显形,充当识别率的分母。
      observer(ctx({ status: 429, requestHeaders: {} }));
      expect(warnCounters(logger)).toMatchObject({
        errorsNotClassifier: 1,
        errorsMissingSessionHeader: 1,
      });
    });

    /**
     * 「识别规则本身失效」必须能独立发现:CC 若改了分类器的 system 前缀或 max_tokens
     * 上界,所有真实分类器请求都会掉进 errorsNotClassifier —— 那时既没有漏检 warn
     * (它们在身份判据之后)、也没有升级 debug(永远识别不出来),整条链路重新全静默。
     * 所以这个计数要有自己的周期性快照(codex P2)。
     */
    /**
     * 三条漏检 warn 都可能不触发(比如分类器前缀变了 → 全部落 errorsNotClassifier),
     * 那时只有这条周期快照能保证「分类器在报错但我们没识别出来」在日志里留下痕迹。
     *
     * **刻意不做自动判定** —— 判定需要「本该被识别的请求数」作分母,而漏检时这个分母
     * 拿不到:连续计数会被任意形态的命中清零、比例判据对部分形态漂移不敏感、全局计数又会
     * 被共享 proxy 上无关 runtime 的错误推进。改为只落原始计数,判断交给看日志的人。
     */
    it('periodically snapshots the raw tallies at a production-visible level', () => {
      let t = 0;
      const { logger, observer } = createObserver(() => 'session-1', () => t);
      const notClassifier = requestBody({ system: 'ordinary assistant' });

      observer(ctx({ status: 429, requestBody: notClassifier }));
      // info 级:打包版默认 level=info,debug 会被 logger 的 shouldLog 丢掉。
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info.mock.calls[0][0]).toContain('observation snapshot');
      // **首条快照必须带上触发它的样本** —— 放在分类之前的话这里会是全零,而后续样本
      // 又都被限流吞掉,短时故障等于什么都没留下(codex P2)。
      expect((logger.info.mock.calls[0][1] as { counters?: Record<string, number> })?.counters)
        .toMatchObject({ errorsNotClassifier: 1 });

      // 30 分钟窗口内限流,不刷屏。
      for (let i = 0; i < 20; i += 1) {
        t += 60_000;
        observer(ctx({ status: 429, requestBody: notClassifier }));
      }
      expect(logger.info).toHaveBeenCalledTimes(1);

      // 越窗后再落一条,快照里 classifierFailures 恒为 0 而 errorsNotClassifier 在涨 ——
      // 这就是排障时判断「身份判据变了」的依据,不需要代码替他判定。
      t += 30 * 60_000;
      observer(ctx({ status: 429, requestBody: notClassifier }));
      expect(logger.info).toHaveBeenCalledTimes(2);
      expect((logger.info.mock.calls[1]?.[1] as { counters?: Record<string, number> })?.counters)
        .toMatchObject({ classifierFailures: 0, errorsNotClassifier: 22 });
      // 全程不刷 warn —— 它只留给真正的归属漏检。
      expect(logger.warn).not.toHaveBeenCalled();
    });

    /**
     * observer 挂在**共享**的 anthropic-compat-proxy 上(见 anthropic-compat-proxy-host
     * 的 composeResponseObservers):普通 turn、PI 以及其它复用该 proxy 的 runtime 的响应
     * 全都流经这里。身份判据必须最先过,否则这些无关响应会把漏检计数顶满,而那两个计数
     * 存在的唯一目的就是回答「分类器在报错但我们没识别出来吗」。
     */
    describe('does not let unrelated runtimes pollute the tallies', () => {
      /** PI 等其它 runtime 的请求:既不是分类器身份,也不带 cc 会话头。 */
      const foreignBody = Buffer.from(JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 64_000,
        messages: [],
      }));

      it('ignores a headerless error response that is not a classifier request', () => {
        const { logger, observer } = createObserver(() => 'session-1', () => 0);

        observer(ctx({ status: 429, requestHeaders: {}, requestBody: foreignBody }));
        observer(ctx({ status: 500, requestHeaders: {}, requestBody: foreignBody }));

        // 只算分母,不算漏检、不刷 warn。
        expect(logger.warn).not.toHaveBeenCalled();
        // 用一条真漏检把计数带出来核对。
        observer(ctx({ status: 429, requestHeaders: {} }));
        expect(warnCounters(logger)).toMatchObject({
          errorsNotClassifier: 2,
          errorsMissingSessionHeader: 1,
          errorsUnresolvedSession: 0,
        });
      });

      it('ignores an error response whose session id is unresolvable but is not a classifier request', () => {
        const { logger, observer } = createObserver(() => null, () => 0);

        observer(ctx({ status: 429, requestBody: foreignBody }));

        expect(logger.warn).not.toHaveBeenCalled();
      });

      it('ignores headerless success responses from other runtimes while a Claude tally exists', () => {
        let t = 0;
        const { logger, observer } = createObserver(() => 'session-1', () => t);

        observer(ctx({ status: 429 })); // 某个 Claude 会话留下记账 → observer 级 size 非零
        t += 1_000;

        // 混合运行时:PI 的 SSE 成功响应不带 cc 会话头,不得记成「恢复漏检」。
        observer(ctx({ status: 200, requestHeaders: {}, requestBody: foreignBody }));
        expect(logger.warn).not.toHaveBeenCalled();

        // 真正的分类器 2xx 缺头才算。
        observer(ctx({ status: 200, requestHeaders: {} }));
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(warnCounters(logger)).toMatchObject({ recoveryMissingSessionHeader: 1 });
      });
    });

    it('throttles the same reason but keeps different reasons independent', () => {
      let t = 0;
      const { logger, observer } = createObserver(
        (sdkId) => (sdkId === 'sdk-known' ? 'session-1' : null),
        () => t,
      );

      // 同一原因连发:60s 窗口内只出一条。
      for (let i = 0; i < 5; i += 1) {
        t += 1_000;
        observer(ctx({ status: 429, requestHeaders: {} }));
      }
      expect(logger.warn).toHaveBeenCalledTimes(1);

      // 另一个原因不被前者的限流窗口饿死。
      observer(ctx({ status: 429, requestHeaders: { 'x-claude-code-session-id': 'sdk-unknown' } }));
      expect(logger.warn).toHaveBeenCalledTimes(2);

      // 越过窗口后同一原因重新可见 —— 持续故障不能只报一次就消失。
      t += 60_000; // OBSERVER_WARN_THROTTLE_MS(与 TRANSIENT_* 同款:常量不导出,测试写字面量)
      observer(ctx({ status: 429, requestHeaders: {} }));
      expect(logger.warn).toHaveBeenCalledTimes(3);
      expect(warnCounters(logger, 2)).toMatchObject({ errorsMissingSessionHeader: 6 });
    });

    it('warns when a success response cannot clear an existing transient tally', () => {
      let t = 0;
      const { logger, observer } = createObserver(() => 'session-1', () => t);

      observer(ctx({ status: 429 })); // 建立一条记账
      t += 1_000;
      // 恢复响应缺 header → 找不到要清哪一条账。
      expect(observer(ctx({ status: 200, requestHeaders: {} }))).toBeUndefined();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain('recovery reset skipped');
      expect(warnCounters(logger)).toMatchObject({ recoveryMissingSessionHeader: 1 });
    });

    it('logs the escalation with the full tally and stays silent without a logger', () => {
      const signals: unknown[] = [];
      setClaudeAutoClassifierUnavailableListener((signal) => signals.push(signal));
      const { logger, observer } = createObserver(() => 'session-1', () => 0);

      observer(ctx({ status: 400 })); // 确定性 4xx → 立即升级
      expect(signals).toHaveLength(1);
      // info 上现在有两类:入口的周期快照 + 这条升级记录。按消息挑出升级那条。
      const escalation = logger.info.mock.calls.find(
        ([message]) => String(message).includes('escalated'),
      );
      expect(escalation).toBeDefined();
      expect((escalation?.[1] as { counters?: Record<string, number> })?.counters)
        .toMatchObject({ classifierFailures: 1 });

      // 不注入 logger 时整段退化为纯计数,不得抛。
      const silent = createClaudeAutoClassifierFailureObserver(() => null);
      expect(() => silent(ctx({ status: 429, requestHeaders: {} }))).not.toThrow();
    });
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
