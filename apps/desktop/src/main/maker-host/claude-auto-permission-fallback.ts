/**
 * Claude 原生 Auto 分类器故障检测与 Cindy fallback 切换。
 *
 * 观察器只读 proxy 响应元数据，不改写响应；coordinator 在确认会话仍为 Auto 后，
 * 只把运行期 reviewer 切到 Cindy，不改用户设置、不广播 Auto→Ask，也不弹确认。
 */

import type { NativeAutoReviewRestoreOutcome, PermissionMode } from '@cindy/maker-core';
import type { ResponseObserver, ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';

const CLASSIFIER_SYSTEM_PREFIX = 'You are a security monitor for autonomous AI coding agents.';

/** Proxy 识别出的单次分类器故障。 */
export interface ClaudeAutoClassifierUnavailableSignal {
  sessionId: string;
  /** Legacy proxy signals omit this and default to Claude. */
  agentKind?: 'claude-code' | 'codex';
  status: number;
}

interface FallbackSession {
  agentKind: string;
  useCindyAutoReviewFallback?(): Promise<void>;
  restoreNativeAutoReview?(): Promise<NativeAutoReviewRestoreOutcome>;
}

interface FallbackLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** 可取消的恢复定时器；注入是为了让测试用假时钟驱动，不必真等冷却。 */
export interface FallbackRestoreTimer {
  cancel(): void;
}

/** coordinator 的 host 依赖；使用回调注入，模块本身不依赖 Electron/DB。 */
export interface ClaudeAutoPermissionFallbackDeps {
  getSession(sessionId: string): FallbackSession | undefined;
  getSessionMeta(sessionId: string): Promise<{ permissionMode?: PermissionMode } | null>;
  logger: FallbackLogger;
  /**
   * 恢复试探的调度器。缺省用 setTimeout + unref（不阻止进程退出）；测试注入假实现。
   */
  scheduleRestore?(run: () => void, delayMs: number): FallbackRestoreTimer;
  /** 退避归零判据用的时钟；缺省 Date.now，测试注入假时钟。 */
  now?(): number;
}

type UnavailableListener = (signal: ClaudeAutoClassifierUnavailableSignal) => void;
let unavailableListener: UnavailableListener = () => {};

/** 由 maker IPC 接线层注入；传 no-op 可在测试/退出时解除。 */
export function setClaudeAutoClassifierUnavailableListener(listener: UnavailableListener): void {
  unavailableListener = listener;
}

/** Vendor response observers use the same host-owned runtime fallback coordinator. */
export function notifyAutoPermissionClassifierUnavailable(
  signal: ClaudeAutoClassifierUnavailableSignal,
): void {
  unavailableListener(signal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * oauth-spawn 的 CC 默认开归因(claude-behavior-flags.ts,issue #758),会把
 * `x-anthropic-billing-header: cc_version=...` 作为 system 数组**第一个** text block
 * 注入 —— 分类器身份前缀被顶到其后。匹配前必须跳过归因块,否则 oauth-spawn 下
 * 分类器故障全部漏检、运行期无法切到 Cindy fallback。
 */
const ATTRIBUTION_SYSTEM_BLOCK_PREFIX = 'x-anthropic-billing-header:';

function classifierIdentityText(system: unknown): string | null {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return null;
  for (const block of system) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      return null;
    }
    if (block.text.startsWith(ATTRIBUTION_SYSTEM_BLOCK_PREFIX)) continue;
    return block.text;
  }
  return null;
}

/**
 * 分类器输出恒为小 token(一个 verdict 或短 thinking):观测到的三种请求形态 max_tokens
 * 为 64+k(2-stage 第一阶段)、256+k(fast)、8192+k(thinking 第二阶段)。取 2x 余量的上界
 * 作防御性副判据——最大形态是 8192+k,16384 远高于它、不会重新引入漏检,同时能把"恰好
 * 以分类器前缀开头的大输出普通请求"挡在外面。
 */
const CLASSIFIER_MAX_TOKENS_CEILING = 16384;

/**
 * 精确识别 Claude Code 内部 Auto 安全分类器请求。双判据都满足才算命中:
 *
 * 主判据 —— 分类器独有的 system 前缀:分类器请求带 `skipSystemPromptPrefix`,其 system 段
 * (跳过可能存在的归因块后)恒以 CLASSIFIER_SYSTEM_PREFIX 开头;普通主 turn 的 system 是
 * Claude Code 常规 prompt,二者完全区分。前缀是分类器身份,本身已足够;
 *
 * 副判据 —— max_tokens 上界(防御性,收窄理论碰撞面):不用固定值(分类器三种形态 max_tokens
 * 各不相同,早期实现取定值 64 只覆盖一条、漏检 fast/thinking,漏检时降级不触发、会话继续
 * fail-closed),改用覆盖全部形态的宽松上界,把"同会话中恰好以分类器前缀开头的大输出请求"
 * 排除掉,避免把它的错误响应(4xx/5xx)误判成分类器故障而错误降级。
 *
 * 只在错误响应(status ≥ 400)路径调用,parse 一次 body 成本可忽略;畸形/无 max_tokens/超上界/无前缀一律 false。
 */
export function isClaudeAutoClassifierRequest(requestBody: Buffer): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody.toString('utf8'));
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (typeof parsed.max_tokens !== 'number' || parsed.max_tokens > CLASSIFIER_MAX_TOKENS_CEILING) {
    return false;
  }
  return classifierIdentityText(parsed.system)?.startsWith(CLASSIFIER_SYSTEM_PREFIX) === true;
}

/**
 * 瞬时故障(408/429/5xx)的升级阈值 —— #596 与 #758 的平衡点:
 *
 * #596 的诉求成立:一次偶发限流不该永久改写用户的 Auto 偏好。但把瞬时状态码
 * **一律**静默吞掉,会让「确定性地返回 429」的故障(如 #758 归因块 429)把用户
 * 留在无限硬失败 + 零提示的死锁里 —— 降级兜底恰恰是那种场景唯一的自救通道。
 *
 * 折中:瞬时失败按「故障段(episode)」记账,连续 EPISODE_THRESHOLD 段且中间
 * 没有任何一次分类器成功 → 视为持续故障,交给协调器切 Cindy fallback。
 *
 * - EPISODE_MS:SDK 对 429/5xx 有自动重试,一次用户动作会在数秒内产生多个失败
 *   响应;30s 内的失败归并为一段,避免把一次动作的 retry storm 数成 N 次。
 *   段以**段起点**为锚(固定桶),刻意不用「距最近一次失败的间隔」做锚:gap 锚定下
 *   「失败每隔几秒持续到达」的确定性故障会被永远归并进同一段、永不达阈,重新退化成
 *   #758 的无限 fail-closed。固定桶的代价是单次动作的 retry 链若拖过 30s 会跨段,
 *   但 SDK 重试退避总时长远短于 30s,而真正连续失败 60s+ 的本就该判为持续故障。
 * - WINDOW_MS:只统计最近 10 分钟——上午两次抖动 + 晚上一次不构成「持续」。
 * - 阈值 3 段 ≈ 持续失败约 1 分钟,或用户间隔性重试 3 次;任一成功立即清零。
 */
const TRANSIENT_EPISODE_MS = 30_000;
const TRANSIENT_WINDOW_MS = 10 * 60_000;
const TRANSIENT_EPISODE_THRESHOLD = 3;
/** 记账表大小上限(防长生命周期 proxy 泄漏);超限时先剔窗口过期项,再剔最老会话。 */
const TRANSIENT_TRACKER_MAX_SESSIONS = 256;

function isTransientClassifierStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * 创建只读响应观察器。成功路径(status < 400,含 2xx/3xx)几乎恒为 O(1) 短路——
 * 仅当**该会话已有瞬时故障记账**时才 parse body 确认「分类器已恢复」并清零计数;
 * 无记账时不 parse、不返回 sink,不碰 SSE 热路径。
 *
 * fallback 信号分两类:
 * - 非瞬时 4xx(400/401/403/404/422 等确定性错误)→ 立即通知协调器(与 #596 前一致);
 * - 瞬时 408/429/5xx → 按上方 episode 阈值记账,持续故障才通知。
 */
export function createClaudeAutoClassifierFailureObserver(
  resolveSessionId: (sdkSessionId: string) => string | null,
  opts: { now?: () => number } = {},
): ResponseObserver {
  const now = opts.now ?? Date.now;
  // key = sdkSessionId(cc 侧会话 id,请求头自带,成功路径无需反解);
  // value = 各 episode 的起始时间戳,升序。
  const transientEpisodes = new Map<string, number[]>();

  return (ctx: ResponseObserverCtx) => {
    if (ctx.status < 400) {
      // 分类器恢复 → 清零该会话的瞬时故障记账。仅在有记账时才 parse body。
      if (transientEpisodes.size === 0) return undefined;
      const sdkSessionId = ctx.requestHeaders['x-claude-code-session-id'];
      if (!sdkSessionId) return undefined;
      const episodes = transientEpisodes.get(sdkSessionId);
      if (!episodes) return undefined;
      // 过期即弃:记账已整体滑出窗口 → 直接删,该会话的后续成功响应回到零开销
      // 短路 —— 不为一条陈年记账无限期 parse 每个成功请求的 body。
      const ts = now();
      if (episodes.length === 0 || ts - episodes[episodes.length - 1] > TRANSIENT_WINDOW_MS) {
        transientEpisodes.delete(sdkSessionId);
        return undefined;
      }
      // 恢复判据只认 2xx:3xx 重定向不代表分类器真正给出 verdict,不得清账 ——
      // 否则「上游持续用 3xx 响应分类器」的故障形态会每轮清零、永不升级,
      // 会话被留在无限 fail-closed。
      if (ctx.status >= 200 && ctx.status < 300 && isClaudeAutoClassifierRequest(ctx.requestBody)) {
        transientEpisodes.delete(sdkSessionId);
      }
      return undefined;
    }
    const sdkSessionId = ctx.requestHeaders['x-claude-code-session-id'];
    if (!sdkSessionId) return undefined;
    const sessionId = resolveSessionId(sdkSessionId);
    if (!sessionId || !isClaudeAutoClassifierRequest(ctx.requestBody)) return undefined;

    if (isTransientClassifierStatus(ctx.status)) {
      const ts = now();
      let episodes = transientEpisodes.get(sdkSessionId);
      if (!episodes) {
        if (transientEpisodes.size >= TRANSIENT_TRACKER_MAX_SESSIONS) {
          for (const [key, starts] of transientEpisodes) {
            if (starts.length === 0 || ts - starts[starts.length - 1] > TRANSIENT_WINDOW_MS) {
              transientEpisodes.delete(key);
            }
          }
          if (transientEpisodes.size >= TRANSIENT_TRACKER_MAX_SESSIONS) {
            // 仍满(极端:256 个会话同时持续故障)→ 剔最早插入的一个,保住新会话的记账。
            const oldest = transientEpisodes.keys().next().value;
            if (oldest !== undefined) transientEpisodes.delete(oldest);
          }
        }
        episodes = [];
        transientEpisodes.set(sdkSessionId, episodes);
      }
      while (episodes.length > 0 && ts - episodes[0] > TRANSIENT_WINDOW_MS) {
        episodes.shift();
      }
      if (episodes.length === 0 || ts - episodes[episodes.length - 1] >= TRANSIENT_EPISODE_MS) {
        episodes.push(ts);
      }
      if (episodes.length < TRANSIENT_EPISODE_THRESHOLD) return undefined;
    }

    // 任何一次通知(瞬时升级或确定性 4xx 立即切 fallback)都清零该会话的瞬时记账:
    // 用户重开 Auto 时从零累计,不因残账被单次偶发失败提前推过阈值。协调器自身有
    // in-flight 去重 + 持久态 CAS,重复信号安全。
    transientEpisodes.delete(sdkSessionId);

    try {
      notifyAutoPermissionClassifierUnavailable({
        sessionId,
        agentKind: 'claude-code',
        status: ctx.status,
      });
    } catch {
      // observer 只能旁路通知；listener 异常不得影响上游响应 pipe。
    }
    return undefined;
  };
}

/**
 * coordinator 生命周期内的分类器故障累计计数。挂在每条切换成功 / 失败日志上,
 * 用现有 logger 落到 apps/desktop/logs/,用于量化故障频率(不新建上报通道)。
 * detected 计每次进入 coordinator 的故障信号(含被 in-flight 去重的 retry storm),
 * switched 计真正切到 Cindy fallback 的会话,其余分别计各类跳过原因。
 */
interface FallbackCounters {
  detected: number;
  switched: number;
  dedupedRetries: number;
  skippedNotAuto: number;
  skippedNonClaude: number;
  skippedUnsupported: number;
  failed: number;
  /** 冷却到期后真正把会话切回原生审阅的次数。 */
  restored: number;
  /** 冷却到期但已不该恢复:会话没了 / 已离开 Auto / handle 不支持 / 路由服务不了原生 /
   * 被新一轮 fallback 作废。都是终态,不重排。 */
  restoreSkipped: number;
  /** restoreNativeAutoReview 抛错。 */
  restoreFailed: number;
  /** 因控制通道被占用 / 抛错而重新排期的次数(退避照常加倍)。 */
  restoreRescheduled: number;
}

/**
 * 切回原生审阅前的冷却 —— 恢复是**乐观试探**,不是「已确认恢复」。
 *
 * 为什么只能靠时间:切到 fallback 时 session handle 已把 SDK 切到 `default` 档,原生
 * 分类器此后不再被调用,proxy 观察器永远收不到它的 2xx;而且切换那一刻就把该会话的瞬时
 * 记账清零了(见上方 notify 前的 delete)。所以系统里没有任何「分类器已恢复」的信号可等,
 * 只能过一段时间试一次。
 *
 * 试错的代价由指数退避兜住:每次重新切到 fallback 都把下一次冷却翻倍(上限 1 小时),
 * 确定性故障最多白试几次就退到低频,不会每 5 分钟把用户重新推进一次硬拒绝窗口。
 */
const RESTORE_COOLDOWN_BASE_MS = 5 * 60_000;
const RESTORE_COOLDOWN_MAX_MS = 60 * 60_000;
/** per-session 恢复状态表上限(防长生命周期泄漏);超限时先剔没有在飞定时器的项。 */
const RESTORE_STATE_MAX_SESSIONS = 256;

/**
 * 退避归零阈值 —— 距上一次降级超过它才认为分类器真的稳住了。
 *
 * `restored` 只说明 `setPermissionMode('auto')` 调用成功,**不**代表上游分类器已恢复:
 * 若它仍在故障,切回原生后会再次降级。所以恢复成功不能清掉 `switches`,否则下一轮永远
 * 从 5 分钟重新起算,用户在持续故障期间每 5 分钟重复经历一次硬拒绝窗口(codex P1)。
 * 取冷却上限的 2 倍:这么久没再降级,说明确实好了。
 */
const BACKOFF_RESET_AFTER_MS = 2 * RESTORE_COOLDOWN_MAX_MS;

interface SessionRestoreState {
  /**
   * 该会话累计的「排期次数」,决定下一次冷却时长。降级与重排(控制通道被占用 / 抛错)
   * 都会 +1 —— 两者都说明「上一次试探没起作用」,退避语义一致,不必分开计。
   * 恢复成功**不**清零(见 BACKOFF_RESET_AFTER_MS)。
   */
  switches: number;
  timer: FallbackRestoreTimer | null;
  /**
   * 本次在飞试探的身份。恢复是异步的,期间新一轮 fallback 可能已在同一个 state 上排了
   * 新定时器;旧试探回来后若无条件删 map 条目,就会丢掉新定时器的记账却不取消它 ——
   * 留下一个无法被 cancel 的孤儿定时器(codex P1)。所以清理前先核对 token 仍是自己。
   */
  attemptToken: number;
  /** 最后一次**降级**的时刻(重排不更新),用于判断退避是否该归零。 */
  lastSwitchedAt: number;
}

function defaultScheduleRestore(run: () => void, delayMs: number): FallbackRestoreTimer {
  const timer = setTimeout(run, delayMs);
  // 恢复试探不是必须完成的工作:进程该退出时不要被它拖住。
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

/**
 * 创建 per-session fallback coordinator。in-flight 集合只防同一轮 429 retry storm；
 * 完成后即释放；session handle 自身保证重复切换幂等。
 *
 * 切换成功后按冷却 + 指数退避安排一次「切回原生审阅」的乐观试探(issue #1578):否则一次
 * 瞬时抖动就把会话永久钉在 Cindy fallback 上,会话内没有任何恢复路径。
 */
export function createClaudeAutoPermissionFallbackCoordinator(
  deps: ClaudeAutoPermissionFallbackDeps,
): (signal: ClaudeAutoClassifierUnavailableSignal) => Promise<boolean> {
  const inFlight = new Set<string>();
  const scheduleRestore = deps.scheduleRestore ?? defaultScheduleRestore;
  const now = deps.now ?? Date.now;
  const restoreStates = new Map<string, SessionRestoreState>();
  const counters: FallbackCounters = {
    detected: 0,
    switched: 0,
    dedupedRetries: 0,
    skippedNotAuto: 0,
    skippedNonClaude: 0,
    skippedUnsupported: 0,
    failed: 0,
    restored: 0,
    restoreSkipped: 0,
    restoreFailed: 0,
    restoreRescheduled: 0,
  };

  /**
   * 只在 map 仍指向本次试探时清掉状态。恢复是异步的,期间新一轮 fallback 可能已经排了
   * 新定时器 —— 无条件 delete 会丢掉它的记账却不取消它(孤儿定时器,codex P1)。
   */
  const releaseAttemptState = (sessionId: string, attemptToken: number): void => {
    if (restoreStates.get(sessionId)?.attemptToken === attemptToken) {
      restoreStates.delete(sessionId);
    }
  };

  const runRestore = async (sessionId: string, attemptToken: number): Promise<void> => {
    const state = restoreStates.get(sessionId);
    // 只清自己那次的 timer 引用;若 map 已被新一轮接管则不碰。
    if (state?.attemptToken === attemptToken) state.timer = null;
    try {
      // 冷却期内用户可能已经关掉会话、切走权限档,或换到不支持原生审阅的路由。
      // 逐项复核当前真相,不用冷却开始时的快照。
      const meta = await deps.getSessionMeta(sessionId);
      const session = deps.getSession(sessionId);
      if (
        meta?.permissionMode !== 'auto'
        || !session
        || session.agentKind !== 'claude-code'
        || !session.restoreNativeAutoReview
      ) {
        counters.restoreSkipped += 1;
        releaseAttemptState(sessionId, attemptToken);
        deps.logger.debug('skip native Auto reviewer restore attempt', {
          sessionId,
          permissionMode: meta?.permissionMode ?? null,
          hasSession: Boolean(session),
          counters: { ...counters },
        });
        return;
      }
      // handle 侧自己判「路由是否支持原生审阅」并在不支持时返回 'unsupported' —— 这里不
      // 重复那套判定,免得两处口径分叉。
      const outcome = await session.restoreNativeAutoReview();
      // 'blocked' = 控制通道正被 rewind / query 重建占用,运行期状态没动。**必须重排**:
      // 每次切到 fallback 只排一次试探,静默放弃等于让这个会话永久留在 fallback
      // (greptile / copilot P1 of #1590)。
      if (outcome === 'blocked') {
        counters.restoreRescheduled += 1;
        deps.logger.debug('native Auto reviewer restore blocked; rescheduling', {
          sessionId,
          switches: state?.switches ?? 0,
          counters: { ...counters },
        });
        scheduleRestoreAttempt(sessionId, { reason: 'blocked' });
        return;
      }
      // 'superseded' = 试探期间该会话又降级了,那一轮自己会排新的试探,这里不重复排。
      // 'unsupported' / 'already-native' 是终态,重排不会变好。
      if (outcome !== 'restored') {
        counters.restoreSkipped += 1;
        releaseAttemptState(sessionId, attemptToken);
        deps.logger.debug('native Auto reviewer restore did not apply', {
          sessionId,
          outcome,
          counters: { ...counters },
        });
        return;
      }
      counters.restored += 1;
      // **刻意不删 state**:`restored` 只说明切档调用成功,不代表上游分类器已恢复。留住
      // `switches`,下一轮降级才会按 10/20/40/60 分钟继续退避,而不是每次都从 5 分钟重来
      // (codex P1)。真正稳住了由 BACKOFF_RESET_AFTER_MS 归零,见 scheduleRestoreAttempt。
      deps.logger.info('restored native Auto reviewer after cooldown', {
        sessionId,
        switches: state?.switches ?? 0,
        counters: { ...counters },
      });
    } catch (error) {
      // 抛错同样不算成功 —— 重排,否则一次偶发的 transport 异常就永久断掉恢复入口。
      counters.restoreFailed += 1;
      deps.logger.warn('native Auto reviewer restore failed; rescheduling', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
        counters: { ...counters },
      });
      scheduleRestoreAttempt(sessionId, { reason: 'error' });
    }
  };

  const scheduleRestoreAttempt = (
    sessionId: string,
    opts: { reason: 'switched' | 'blocked' | 'error' } = { reason: 'switched' },
  ): void => {
    let state = restoreStates.get(sessionId);
    if (!state) {
      if (restoreStates.size >= RESTORE_STATE_MAX_SESSIONS) {
        for (const [key, value] of restoreStates) {
          if (!value.timer) restoreStates.delete(key);
        }
        if (restoreStates.size >= RESTORE_STATE_MAX_SESSIONS) {
          // 仍满(极端:256 个会话同时挂着在飞的试探)→ 剔最早插入的一个并取消它的定时器。
          const oldest = restoreStates.keys().next().value;
          if (oldest !== undefined) {
            restoreStates.get(oldest)?.timer?.cancel();
            restoreStates.delete(oldest);
          }
        }
      }
      state = { switches: 0, timer: null, attemptToken: 0, lastSwitchedAt: now() };
      restoreStates.set(sessionId, state);
    }
    const ts = now();
    // 距上一次**降级**足够久 → 分类器确实稳住过,退避归零重新起算。没有这条,
    // `restored` 之后保留的 switches 会让几小时后的一次偶发抖动直接吃满 1 小时冷却。
    if (opts.reason === 'switched' && ts - state.lastSwitchedAt > BACKOFF_RESET_AFTER_MS) {
      state.switches = 0;
    }
    if (opts.reason === 'switched') state.lastSwitchedAt = ts;
    // 同一会话重新切到 fallback → 上一轮试探作废,退避加倍后重排。
    state.timer?.cancel();
    state.switches += 1;
    state.attemptToken += 1;
    const attemptToken = state.attemptToken;
    const delayMs = Math.min(
      RESTORE_COOLDOWN_BASE_MS * 2 ** (state.switches - 1),
      RESTORE_COOLDOWN_MAX_MS,
    );
    state.timer = scheduleRestore(() => {
      void runRestore(sessionId, attemptToken);
    }, delayMs);
    deps.logger.debug('scheduled native Auto reviewer restore attempt', {
      sessionId,
      reason: opts.reason,
      switches: state.switches,
      delayMs,
    });
  };

  return async (signal) => {
    const signalAgentKind = signal.agentKind ?? 'claude-code';
    counters.detected += 1;
    if (inFlight.has(signal.sessionId)) {
      counters.dedupedRetries += 1;
      return false;
    }
    inFlight.add(signal.sessionId);
    try {
      const before = await deps.getSessionMeta(signal.sessionId);
      if (before?.permissionMode !== 'auto') {
        counters.skippedNotAuto += 1;
        return false;
      }

      const session = deps.getSession(signal.sessionId);
      if (!session || session.agentKind !== signalAgentKind) {
        counters.skippedNonClaude += 1;
        return false;
      }
      if (!session.useCindyAutoReviewFallback) {
        counters.skippedUnsupported += 1;
        return false;
      }
      await session.useCindyAutoReviewFallback();
      counters.switched += 1;
      // 只给能恢复的 handle 排试探:老 handle 没有对称入口时排了也只会白跑一次。
      if (session.restoreNativeAutoReview) scheduleRestoreAttempt(signal.sessionId);
      deps.logger.info('auto permission classifier unavailable; session kept on Auto with Cindy fallback', {
        sessionId: signal.sessionId,
        agentKind: signalAgentKind,
        status: signal.status,
        counters: { ...counters },
      });
      return true;
    } catch (error) {
      counters.failed += 1;
      deps.logger.warn('auto permission fallback failed', {
        sessionId: signal.sessionId,
        status: signal.status,
        error: error instanceof Error ? error.message : String(error),
        counters: { ...counters },
      });
      return false;
    } finally {
      inFlight.delete(signal.sessionId);
    }
  };
}
