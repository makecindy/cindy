/**
 * Claude 原生 Auto 分类器故障检测与 Cindy fallback 切换。
 *
 * 观察器只读 proxy 响应元数据，不改写响应；coordinator 在确认会话仍为 Auto 后，
 * 只把运行期 reviewer 切到 Cindy，不改用户设置、不广播 Auto→Ask，也不弹确认。
 *
 * 降级分两级(见 AutoReviewFallbackScope):瞬时故障**每次**都先做 turn 级试探性降级
 * (立刻兜住当前 turn，下一 turn 由 agent 侧回探原生)；攒满 episode 阈值或遇到确定性
 * 4xx 才升级为会话级终态。两级都不改用户偏好、不弹提示 —— 用户全程留在 Auto。
 */

import type { AutoReviewFallbackScope, PermissionMode } from '@cindy/maker-core';
import type { ResponseObserver, ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';

const CLASSIFIER_SYSTEM_PREFIX = 'You are a security monitor for autonomous AI coding agents.';

/** Proxy 识别出的单次分类器故障。 */
export interface ClaudeAutoClassifierUnavailableSignal {
  sessionId: string;
  /** Legacy proxy signals omit this and default to Claude. */
  agentKind?: 'claude-code' | 'codex';
  status: number;
  /**
   * 降级作用范围。'turn' = 试探性(尚未判为持续故障,下一 turn 回探原生);
   * 'session' = 已确认持续故障或确定性错误,本会话不再回探。
   * Legacy proxy signals omit this and default to 'session'.
   */
  scope?: AutoReviewFallbackScope;
}

interface FallbackSession {
  agentKind: string;
  /**
   * 返回 false = 会话已处于该降级状态,本次是幂等 no-op(见 AgentSessionHandle)。
   * 用 `boolean | void` 容忍不返回值的实现:只有显式 false 才算"没切"。
   */
  useCindyAutoReviewFallback?(opts?: { scope?: AutoReviewFallbackScope }): Promise<boolean | void>;
}

interface FallbackLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** coordinator 的 host 依赖；使用回调注入，模块本身不依赖 Electron/DB。 */
export interface ClaudeAutoPermissionFallbackDeps {
  getSession(sessionId: string): FallbackSession | undefined;
  getSessionMeta(sessionId: string): Promise<{ permissionMode?: PermissionMode } | null>;
  logger: FallbackLogger;
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
 * 瞬时故障(408/429/5xx)的**会话级**升级阈值 —— #596 与 #758 的平衡点:
 *
 * #596 的诉求成立:一次偶发限流不该永久改写用户的 Auto 偏好。但把瞬时状态码
 * **一律**静默吞掉,会让「确定性地返回 429」的故障(如 #758 归因块 429)把用户
 * 留在无限硬失败 + 零提示的死锁里 —— 降级兜底恰恰是那种场景唯一的自救通道。
 *
 * 折中:瞬时失败按「故障段(episode)」记账,连续 EPISODE_THRESHOLD 段且中间
 * 没有任何一次分类器成功 → 视为持续故障,交给协调器切**会话级** Cindy fallback。
 *
 * 但阈值以下**不再是"什么都不做"**(issue #1573):原实现在攒够 3 段之前对每一次
 * 分类器故障都只记账,而那段时间里 SDK 对写/执行类工具一律硬拒("cannot determine
 * the safety of Bash"),用户零提示地连撞 60–90 秒。现在阈值以下改为通知**turn 级**
 * 试探性降级:本 turn 剩余工具立刻走 Cindy reviewer(用户无感,也不弹授权),下一
 * turn 起点由 agent 侧回探原生分类器。
 *
 * 由此**升级节奏的物理含义变了**,这是本改动最容易被误读的一点:试探性降级会把 SDK
 * 切到 default 档,cc 随即停发分类器请求 —— 同一段里不会再有失败响应到达。所以段不再
 * 靠"持续失败累计 60s"攒出来,而是靠"连续 3 个 turn 的回探都失败"。副作用是:
 * - 用户若在 30s 内连发多个 turn,回探失败会落回同一个固定桶、段数不涨,会话可能长期
 *   停在试探性降级。这**可以接受**:那种状态下每个 turn 也只在回探的第一个工具上撞一次,
 *   而不是修复前整个窗口期的每个工具都被硬拒 —— 伤害已经小一个数量级;
 * - 反过来,#596 的保护变得更强:偶发抖动更难被推到会话级终态。
 * 真正持续的故障里 turn 间隔通常远大于 30s(用户要读回复、agent 要跑工具),3 段升级仍
 * 会正常发生,#758 的自救通道保持有效。
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
 * fallback 信号按作用范围分两类:
 * - 会话级(scope='session'):非瞬时 4xx(400/401/403/404/422 等确定性错误)立即通知
 *   (与 #596 前一致);瞬时故障攒满 episode 阈值后升级;
 * - turn 级(scope='turn'):瞬时 408/429/5xx 在阈值以下**每次**都通知,先用 Cindy
 *   兜住当前 turn,避免 #1573 的硬拒绝窗口。
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

    const notify = (scope: AutoReviewFallbackScope): void => {
      try {
        notifyAutoPermissionClassifierUnavailable({
          sessionId,
          agentKind: 'claude-code',
          status: ctx.status,
          scope,
        });
      } catch {
        // observer 只能旁路通知；listener 异常不得影响上游响应 pipe。
      }
    };

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
      if (episodes.length < TRANSIENT_EPISODE_THRESHOLD) {
        // 尚未判为持续故障 → 试探性降级,把这一 turn 交给 Cindy reviewer。
        //
        // 刻意**不按 episode 去重**(哪怕本段已通知过):试探性降级在 turn 边界自动解除,
        // 而 turn 边界与 30s 固定桶不对齐 —— 用户在同一段内连发两条消息时,第二条已经
        // 回探回原生,若因"本段通知过"而跳过,这一 turn 就重新裸奔在硬拒绝里。收敛交给
        // 下游的幂等层:coordinator 有 in-flight 去重,agent 侧对同一 turn 的重复信号是
        // no-op(只有回探后的首个信号会真正再切一次档)。
        notify('turn');
        return undefined;
      }
    }

    // 任何一次会话级通知(瞬时升级或确定性 4xx 立即切 fallback)都清零该会话的瞬时记账:
    // 用户重开 Auto 时从零累计,不因残账被单次偶发失败提前推过阈值。协调器自身有
    // in-flight 去重 + 持久态 CAS,重复信号安全。
    transientEpisodes.delete(sdkSessionId);
    notify('session');
    return undefined;
  };
}

/**
 * coordinator 生命周期内的分类器故障累计计数。挂在每条切换成功 / 失败日志上,
 * 用现有 logger 落到 apps/desktop/logs/,用于量化故障频率(不新建上报通道)。
 * detected 计每次进入 coordinator 的故障信号(含被 in-flight 去重的 retry storm),
 * switched 计真正切到 Cindy fallback 的会话,其余分别计各类跳过原因。
 * switchedTentative 是 switched 的子集:turn 级试探性降级(#1573),下一 turn 会回探原生;
 * 二者之差即会话级终态降级次数。两个数一起看才能区分"上游偶发抖动"与"持续故障"。
 * skippedAlreadyFallback 计会话已在该降级状态、本次是幂等 no-op 的信号 —— turn 级信号
 * 刻意不在观察器侧按 episode 去重(见上),重复量落在这里,不许混进 switched 把它冲虚。
 */
interface FallbackCounters {
  detected: number;
  switched: number;
  switchedTentative: number;
  dedupedRetries: number;
  skippedAlreadyFallback: number;
  skippedNotAuto: number;
  skippedNonClaude: number;
  skippedUnsupported: number;
  failed: number;
}

/**
 * 创建 per-session fallback coordinator。in-flight 集合只防同一轮 429 retry storm；
 * 完成后即释放；session handle 自身保证重复切换幂等。
 */
export function createClaudeAutoPermissionFallbackCoordinator(
  deps: ClaudeAutoPermissionFallbackDeps,
): (signal: ClaudeAutoClassifierUnavailableSignal) => Promise<boolean> {
  const inFlight = new Set<string>();
  const counters: FallbackCounters = {
    detected: 0,
    switched: 0,
    switchedTentative: 0,
    dedupedRetries: 0,
    skippedAlreadyFallback: 0,
    skippedNotAuto: 0,
    skippedNonClaude: 0,
    skippedUnsupported: 0,
    failed: 0,
  };

  return async (signal) => {
    const signalAgentKind = signal.agentKind ?? 'claude-code';
    // legacy proxy signal 不带 scope → 按会话级处理(旧行为不变)。
    const scope: AutoReviewFallbackScope = signal.scope ?? 'session';
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
      const switched = await session.useCindyAutoReviewFallback({ scope });
      if (switched === false) {
        // 会话已在该降级状态(同一 turn 内的重复信号 / 已是会话级终态)→ 不重复计数、
        // 不重复打日志,否则一次上游抖动会在日志里放大成"降级了十几次"。
        counters.skippedAlreadyFallback += 1;
        return false;
      }
      counters.switched += 1;
      if (scope === 'turn') counters.switchedTentative += 1;
      deps.logger.info(
        scope === 'turn'
          ? 'auto permission classifier unavailable; this turn falls back to Cindy review'
          : 'auto permission classifier unavailable; session kept on Auto with Cindy fallback',
        {
          sessionId: signal.sessionId,
          agentKind: signalAgentKind,
          status: signal.status,
          scope,
          counters: { ...counters },
        },
      );
      return true;
    } catch (error) {
      counters.failed += 1;
      deps.logger.warn('auto permission fallback failed', {
        sessionId: signal.sessionId,
        status: signal.status,
        scope,
        error: error instanceof Error ? error.message : String(error),
        counters: { ...counters },
      });
      return false;
    } finally {
      inFlight.delete(signal.sessionId);
    }
  };
}
