/**
 * Claude 原生 Auto 分类器故障检测与 Cindy fallback 切换。
 *
 * 观察器只读 proxy 响应元数据，不改写响应；coordinator 在确认会话仍为 Auto 后，
 * 只把运行期 reviewer 切到 Cindy，不改用户设置、不广播 Auto→Ask，也不弹确认。
 */

import type { PermissionMode } from '@cindy/maker-core';
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
 * 观察器需要的日志面:warn 报漏检、info 落周期快照。两级都在打包版默认 level=info 下会
 * 落盘(debug 会被 logger 的 shouldLog 丢掉,故不用)。与 coordinator 的 FallbackLogger
 * 刻意不共用 —— 那边还需要 debug。
 */
interface ClassifierObserverLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 观察器生命周期内的识别记账。挂在限流日志上,用来回答一个排障时问不出来的问题:
 * 「分类器正在报错,但我们到底有没有识别出来?」
 *
 * `classifierFailures` 是识别成功数;它与两个漏检计数的比例才是识别率信号。
 * `errorsNotClassifier` 是**正常**的大头,不参与漏检判断,单列出来只为让另外两个计数有分母。
 *
 * **所有计数都在「已确认是 Auto 分类器请求」之后才累加。** observer 挂在共享的
 * anthropic-compat-proxy 上,普通 turn、PI 与其它复用该 proxy 的 runtime 的响应同样流经
 * 这里;若先按归属失败记账,那些无关响应会把漏检计数顶满,识别率信号就废了。
 */
interface ClassifierObserverCounters {
  /** 分类器请求 + 有 header + 反解成功 → 真正识别出的分类器故障。 */
  classifierFailures: number;
  /** **分类器请求**的错误响应缺 x-claude-code-session-id → 无法归属会话,漏检。 */
  errorsMissingSessionHeader: number;
  /** **分类器请求**的错误响应有 header 但反解不出业务会话 id → 漏检。 */
  errorsUnresolvedSession: number;
  /** 错误响应的 body 不是分类器请求 → 正常(普通 turn / PI / 其它 runtime)。 */
  errorsNotClassifier: number;
  /** 有瞬时记账时,**分类器请求**的 2xx 缺 header → 这一轮「恢复即清零」不会发生。 */
  recoveryMissingSessionHeader: number;
}

/**
 * 同一漏检原因的 warn 限流间隔。漏检是**每个**错误响应都可能触发的,不限流会在上游
 * 持续故障时把日志刷爆;但也不能只报一次 —— 排障的人需要知道它还在持续发生。
 */
const OBSERVER_WARN_THROTTLE_MS = 60_000;

/**
 * 观测快照间隔。
 *
 * **刻意不做「识别规则是否失效」的自动判定。** 那需要「本该被识别的请求数」当分母,而漏检
 * 时这个分母恰恰拿不到 —— 前几轮 review 反复在这个精度上打转都是同一个原因:连续计数会被
 * 任意一种形态的命中清零(交错到达时另一形态 100% 漂移也报不出来)、比例判据对部分形态漂移
 * 不敏感、全局计数又会被共享 proxy 上无关 runtime 的错误推进。
 *
 * 所以改成只把原始计数定期落盘,判断交给看日志的人:`classifierFailures` 长期为 0 而
 * `errorsNotClassifier` 在涨,就该怀疑身份判据(system 前缀 / max_tokens 上界)变了。
 * 用 **info** 级 —— 打包版默认 level=info,debug 会被 logger 的 shouldLog 直接丢掉。
 * 只在处理过错误响应时输出,30 分钟一条,正常运行噪音可忽略。
 */
const OBSERVER_SNAPSHOT_INTERVAL_MS = 30 * 60_000;

/**
 * 创建只读响应观察器。成功路径(status < 400,含 2xx/3xx)几乎恒为 O(1) 短路——
 * 仅当**该会话已有瞬时故障记账**时才 parse body 确认「分类器已恢复」并清零计数;
 * 无记账时不 parse、不返回 sink,不碰 SSE 热路径。
 *
 * fallback 信号分两类:
 * - 非瞬时 4xx(400/401/403/404/422 等确定性错误)→ 立即通知协调器(与 #596 前一致);
 * - 瞬时 408/429/5xx → 按上方 episode 阈值记账,持续故障才通知。
 *
 * 这条链路是 Auto 档唯一的自救通道,而它的两个前置条件(会话请求头、id 反解)任一不满足
 * 就整条静默失效 —— 会话被留在无限 fail-closed,而日志里没有任何线索指向这里。所以两处
 * 提前返回都带限流 warn 与识别记账(见 ClassifierObserverCounters,issue #1579)。记账与
 * 日志都是旁路的:不改判定、不改短路顺序,logger 缺省时整段退化为纯计数。
 */
export function createClaudeAutoClassifierFailureObserver(
  resolveSessionId: (sdkSessionId: string) => string | null,
  opts: { now?: () => number; logger?: ClassifierObserverLogger } = {},
): ResponseObserver {
  const now = opts.now ?? Date.now;
  const logger = opts.logger;
  // key = sdkSessionId(cc 侧会话 id,请求头自带,成功路径无需反解);
  // value = 各 episode 的起始时间戳,升序。
  const transientEpisodes = new Map<string, number[]>();
  const counters: ClassifierObserverCounters = {
    classifierFailures: 0,
    errorsMissingSessionHeader: 0,
    errorsUnresolvedSession: 0,
    errorsNotClassifier: 0,
    recoveryMissingSessionHeader: 0,
  };
  /** 每个 reason 各自限流,免得高频的那个把另一个饿死。 */
  const lastLogAt = new Map<string, number>();
  const logThrottled = (
    level: 'warn' | 'info',
    reason: string,
    fields: Record<string, unknown>,
    intervalMs: number = OBSERVER_WARN_THROTTLE_MS,
  ): void => {
    if (!logger) return;
    const ts = now();
    const last = lastLogAt.get(reason);
    if (last !== undefined && ts - last < intervalMs) return;
    lastLogAt.set(reason, ts);
    logger[level](`auto classifier failure observer: ${reason}`, {
      ...fields,
      counters: { ...counters },
    });
  };
  const warnThrottled = (reason: string, fields: Record<string, unknown>): void =>
    logThrottled('warn', reason, fields);
  const infoThrottled = (reason: string, fields: Record<string, unknown>, intervalMs: number): void =>
    logThrottled('info', reason, fields, intervalMs);
  /**
   * 周期性把原始计数落盘。**必须在本次响应的计数已经递增之后调用** —— 放在分类之前的话,
   * 首条快照恒为全零,而后续样本又都被限流吞掉,短时故障等于没留下有效计数(codex P2)。
   */
  const snapshotTallies = (status: number): void => {
    infoThrottled(
      'classifier observation snapshot',
      { status },
      OBSERVER_SNAPSHOT_INTERVAL_MS,
    );
  };

  return (ctx: ResponseObserverCtx) => {
    if (ctx.status < 400) {
      // 分类器恢复 → 清零该会话的瞬时故障记账。仅在有记账时才 parse body。
      if (transientEpisodes.size === 0) return undefined;
      const sdkSessionId = ctx.requestHeaders['x-claude-code-session-id'];
      if (!sdkSessionId) {
        // 拿不到 header 就找不到要清哪一条账。后果有界(记账最终会因窗口过期被弃),
        // 但期间该会话可能被残账提前推过升级阈值,值得在日志里可见。
        //
        // 只有**确认是分类器请求**才算漏检:observer 挂在共享的 anthropic-compat-proxy 上,
        // PI 与其它 runtime 的成功响应同样不带这个头,不先过滤会让混合运行时持续制造假告警
        // (`transientEpisodes.size` 是整个 observer 级的,任意一个 Claude 会话有记账就非零)。
        // 判据顺序按成本排:先 2xx(3xx 本就不清账)、再 parse —— 只有走到这里的少数响应付这笔。
        if (ctx.status >= 200 && ctx.status < 300 && isClaudeAutoClassifierRequest(ctx.requestBody)) {
          counters.recoveryMissingSessionHeader += 1;
          warnThrottled('success response without session header; recovery reset skipped', {
            status: ctx.status,
            trackedSessions: transientEpisodes.size,
          });
        }
        return undefined;
      }
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
    // 身份判据必须**最先**过:observer 挂在共享的 anthropic-compat-proxy 上,普通 turn、
    // PI 以及其它复用该 proxy 的 runtime 的 4xx/5xx 全都流经这里。若先按「缺会话头 /
    // 反解失败」记漏检,这些无关错误会把 errorsMissingSessionHeader / errorsUnresolvedSession
    // 顶满,识别率信号彻底失效 —— 而这两个计数存在的唯一目的就是回答「分类器在报错但我们
    // 没识别出来吗」。代价是错误响应一律 parse 一次 body(原注释已认定该成本可忽略)。
    if (!isClaudeAutoClassifierRequest(ctx.requestBody)) {
      // 正常大头:非分类器的错误响应。只计数当分母 —— 判定交给周期快照(见
      // OBSERVER_SNAPSHOT_INTERVAL_MS 注释),这里不做推断。
      counters.errorsNotClassifier += 1;
      snapshotTallies(ctx.status);
      return undefined;
    }
    const sdkSessionId = ctx.requestHeaders['x-claude-code-session-id'];
    if (!sdkSessionId) {
      // 上游未回传原请求头(SDK 版本差异、代理链改写、部分错误响应本就不带)→ 无法归属,
      // 该会话的分类器故障永远不会升级到 Cindy fallback。
      counters.errorsMissingSessionHeader += 1;
      warnThrottled('error response without session header; classifier failure unattributable', {
        status: ctx.status,
      });
      return undefined;
    }
    const sessionId = resolveSessionId(sdkSessionId);
    if (!sessionId) {
      // 映射尚未建立 / 会话刚 resume / 映射表已清理。同样导致故障不会升级。
      counters.errorsUnresolvedSession += 1;
      warnThrottled('error response with unresolvable sdk session id', {
        status: ctx.status,
        sdkSessionId,
      });
      return undefined;
    }
    counters.classifierFailures += 1;
    snapshotTallies(ctx.status);

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

    // 识别成功且已过阈值的那一刻记一条,带完整计数 —— coordinator 侧的日志只覆盖
    // 「切换成功/失败」,看不到「识别到了但被 episode 阈值挡住」的那些。
    // info 级:这一刻本就低频(真的持续故障才走到),且打包版默认 level=info 会落盘。
    logger?.info('auto classifier failure escalated; notifying fallback coordinator', {
      sessionId,
      status: ctx.status,
      counters: { ...counters },
    });

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
    dedupedRetries: 0,
    skippedNotAuto: 0,
    skippedNonClaude: 0,
    skippedUnsupported: 0,
    failed: 0,
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
