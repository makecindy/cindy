/**
 * Refresh-token 失效判定 —— 与 Electron / 网络层解耦的纯逻辑,供 authManager 的冷启动
 * `initialize()` 与运行时 `refresh()` 共用,并可独立单测(authManager 本身依赖 Electron,
 * 无法在 node 测试环境直接 import)。
 *
 * 背景:给服务端 `/api/auth/refresh` 加限流后,若冷启动把**任何** `!ok`(含 429 限流、5xx、
 * 断网 status:0、无识别码的 4xx)都当成凭据失效而删除本地 refresh token,会把携带有效凭据的
 * 用户永久登出。只有下面这组「确定性」错误码才代表 refresh token 本身确实无效、应当清除并要求
 * 重新登录;其余一律视为瞬时失败、保留 token,留待下次启动 / refresh 自愈。
 */

/** 服务端判定 refresh token 本身无效、必须清除本地凭据的确定性错误码。 */
export const DEFINITIVE_REFRESH_FAILURE_CODES: ReadonlySet<string> = new Set([
  'REFRESH_TOKEN_EXPIRED',
  'INVALID_REFRESH_TOKEN',
  'DEVICE_MISMATCH',
  'MEMBERSHIP_DISABLED',
]);

/** 只有这个错误码可能来自同机多实例轮换竞态;其它确定性错误换 token 无效。 */
const REPLACEMENT_RETRY_ELIGIBLE_CODES: ReadonlySet<string> = new Set(['INVALID_REFRESH_TOKEN']);

/** `/api/auth/refresh` 错误响应体的最小形状(只关心 error.code)。 */
export interface RefreshErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * 判断一次 `/api/auth/refresh` 调用结果是否为「确定性凭据失效」——即应当从本地清除
 * refresh token。返回 `false` 表示:要么成功,要么是应当**保留** token 的瞬时失败
 * (429 限流 / 5xx / 断网 status:0 / 无识别码的 4xx)。
 *
 * @param result apiFetch 返回值的最小子集:`ok` + 响应体 `data`。
 */
export function isDefinitiveRefreshFailure(result: { ok: boolean; data: unknown }): boolean {
  if (result.ok) return false;
  const code = (result.data as RefreshErrorBody | null)?.error?.code;
  return typeof code === 'string' && DEFINITIVE_REFRESH_FAILURE_CODES.has(code);
}

function getRefreshErrorCode(result: { data: unknown }): string | undefined {
  return (result.data as RefreshErrorBody | null)?.error?.code;
}

function isReplacementRetryEligibleFailure(result: { ok: boolean; data: unknown }): boolean {
  if (result.ok) return false;
  const code = getRefreshErrorCode(result);
  return typeof code === 'string' && REPLACEMENT_RETRY_ELIGIBLE_CODES.has(code);
}

/**
 * 同机多实例共享 userData 时,refresh token 可能被另一个实例先一步轮换:
 * A/B 读到同一枚旧 token,A 成功并把新 token 写回磁盘,B 随后以旧 token
 * 命中 INVALID_REFRESH_TOKEN。此时磁盘上的 token 已不同于 B 本次请求用的
 * token,不能把它当成真正登出,应改用新 token 重试一次。
 */
export function getRefreshTokenReplacementCandidate(
  requestedToken: string,
  latestStoredToken: string | null,
): string | null {
  return pickRefreshTokenReplacementCandidate(requestedToken, [latestStoredToken]);
}

/**
 * 从多个磁盘凭证来源里挑出可用于追赶的替换 token —— 按传入顺序取第一枚
 * 「非空且不等于本次请求所用」的 token。
 *
 * 为什么需要多来源:凭证文件正在做 legacy → v1 的格式迁移(见 authManager 的
 * `AUTH_SESSION_KEY` / `LEGACY_RESOURCE_REFRESH_TOKEN_KEY`)。共享 userData 的
 * 双开窗口里,两个实例可能一个写 v1、一个写 legacy;只认单一来源的一方永远追不上
 * 另一方轮换出的新 token,会把本可自愈的竞态判成确定性失效并强制重登。
 */
export function pickRefreshTokenReplacementCandidate(
  requestedToken: string,
  candidates: readonly (string | null | undefined)[],
): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === requestedToken) continue;
    return candidate;
  }
  return null;
}

/**
 * 会话失效的展示分类 —— 客户端内部分类,从不透传服务端 message / 内部细节。
 * renderer 按 reason 映射本地化文案,让用户区分「被顶下线」与「自然过期」等成因。
 */
export type SessionExpiredReason =
  /** 凭证已被其他设备/实例替换或吊销(replacement-retry 追不上新 token)。 */
  | 'replaced-elsewhere'
  /** refresh token 自然过期。 */
  | 'expired'
  /** 凭证与本机设备指纹不匹配(如 userData 被复制到别的机器)。 */
  | 'device-mismatch'
  /** 账号被禁用 / 删除。 */
  | 'account-unavailable'
  /** 本机凭证文件被共享 userData 的外部实例清除(磁盘 token 消失但本会话活着)。 */
  | 'credential-lost'
  /** 无法归因的确定性失效,走通用文案。 */
  | 'unknown';

/** 把服务端确定性失效码映射为展示分类;未识别码一律 unknown(通用文案兜底)。 */
export function resolveSessionExpiredReason(code: string | undefined): SessionExpiredReason {
  switch (code) {
    case 'INVALID_REFRESH_TOKEN':
      return 'replaced-elsewhere';
    case 'REFRESH_TOKEN_EXPIRED':
      return 'expired';
    case 'DEVICE_MISMATCH':
      return 'device-mismatch';
    case 'MEMBERSHIP_DISABLED':
      return 'account-unavailable';
    default:
      return 'unknown';
  }
}

export type RefreshFailureAction =
  | { kind: 'transient-failure' }
  | { kind: 'definitive-failure' }
  | { kind: 'replacement-retry'; refreshToken: string };

/**
 * 把 refresh 失败分为三类:
 * - transient: 网络/限流/服务端临时问题,保留 token 后续自愈;
 * - definitive: 当前磁盘 token 也已失败,清态重登;
 * - replacement-retry: 本次请求用的是 stale token,磁盘已有别的实例写入的新 token。
 */
export function resolveRefreshFailureAction(
  result: {
    ok: boolean;
    data: unknown;
  },
  requestedToken: string,
  latestStoredToken: string | null,
): RefreshFailureAction {
  if (!isDefinitiveRefreshFailure(result)) return { kind: 'transient-failure' };
  if (!isReplacementRetryEligibleFailure(result)) return { kind: 'definitive-failure' };
  const replacement = getRefreshTokenReplacementCandidate(requestedToken, latestStoredToken);
  if (replacement) return { kind: 'replacement-retry', refreshToken: replacement };
  return { kind: 'definitive-failure' };
}

/** `runRefreshWithTransientRetry` 的单次请求结果(apiFetch 返回值的最小子集)。 */
export interface RefreshFetchResult<T> {
  ok: boolean;
  status: number;
  data: T;
}

/** 每次失败时回传给调用方的诊断信息(供日志)。 */
export interface RefreshFailureInfo {
  /** 第几次请求(1-based)。 */
  attempt: number;
  status: number;
  /** 服务端错误码;断网 / 无结构响应时为 undefined。 */
  code?: string;
  /** 是否确定性凭据失效(true 则不会再重试)。 */
  definitive: boolean;
  /** 本次失败后是否还会重试。 */
  willRetry: boolean;
}

/** stale refresh token 替换重试时的诊断信息(供日志)。 */
export interface RefreshReplacementRetryInfo {
  /** 第几次替换重试(1-based)。 */
  replacementRetry: number;
  /** 截至本次替换前已经发出的总请求数。 */
  attempts: number;
  status: number;
  /** 服务端错误码;断网 / 无结构响应时为 undefined。 */
  code?: string;
}

/** stale token 失败但磁盘还没落新 token 时,延迟重读前的诊断信息。 */
export interface RefreshReplacementRecheckInfo {
  /** 截至本次重读前已经发出的总请求数。 */
  attempts: number;
  status: number;
  /** 服务端错误码;断网 / 无结构响应时为 undefined。 */
  code?: string;
  delayMs: number;
}

/**
 * 带瞬时失败重试的 refresh 请求编排。
 *
 * 背景:冷启动 `initialize()` 此前只发**一次** `/api/auth/refresh`,撞上网络抖动 /
 * 429 限流 / 5xx 时虽然(自 PR #323 起)会保留 token,但当次启动仍直接以未登录进登录页,
 * 用户看到的就是「重启莫名被登出、重开一次又好了」。本函数把「瞬时失败短暂退避后重试」
 * 抽成与 Electron / 网络层解耦的纯编排,冷启动与单测共用。
 *
 * 重试规则:仅当 `!ok` 且 **非**确定性凭据失效时重试;确定性失效(token 真的无效)
 * 立即返回不浪费请求。默认最多 3 次请求(重试前分别退避 1s / 2s)。
 *
 * 注意:若某次请求在服务端已完成轮换但响应丢失(极窄窗口),重试会以已消费的旧 token
 * 命中 INVALID_REFRESH_TOKEN——这是轮换模型固有 hazard,不重试时下次启动同样会命中,
 * 重试并不扩大损害面。
 */
/**
 * 服务端 refresh 路由的 rate-limit 窗口长度(ms)。
 * 对应 `apps/server/src/routes/auth.ts` 的 `authIpRateLimit('refresh', 60)` → windowMs: 60_000。
 * 收到 429 时退避至少这么久,保证重试落在新窗口内。
 */
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function runRefreshWithTransientRetry<T>(
  doRefresh: () => Promise<RefreshFetchResult<T>>,
  opts?: {
    /** 每次重试前的退避毫秒数;数组长度即最大重试次数。默认 [1000, 2000]。 */
    retryDelaysMs?: readonly number[];
    /**
     * 收到 429 时的退避毫秒数。默认 RATE_LIMIT_WINDOW_MS(60s),保证重试落在新窗口内。
     * 传 0 表示"不为 429 重试"——立即返回、保留 token(适合同步阻塞路径如冷启动,
     * 避免 UI 卡住分钟级又无法在短退避内成功)。
     */
    rateLimitDelayMs?: number;
    /** 注入以便单测;默认 setTimeout 实现。 */
    sleep?: (ms: number) => Promise<void>;
    /** 每次失败回调(含最后一次),供调用方打日志;不得抛异常。 */
    onFailure?: (info: RefreshFailureInfo) => void;
  },
): Promise<{ result: RefreshFetchResult<T>; attempts: number }> {
  const retryDelaysMs = opts?.retryDelaysMs ?? [1000, 2000];
  const rateLimitDelayMs = opts?.rateLimitDelayMs ?? RATE_LIMIT_WINDOW_MS;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let result = await doRefresh();
  let attempts = 1;
  for (const delayMs of retryDelaysMs) {
    if (result.ok) break;
    const definitive = isDefinitiveRefreshFailure(result);
    const skipRateLimited = result.status === 429 && rateLimitDelayMs <= 0;
    opts?.onFailure?.({
      attempt: attempts,
      status: result.status,
      code: (result.data as RefreshErrorBody | null)?.error?.code,
      definitive,
      willRetry: !definitive && !skipRateLimited,
    });
    if (definitive) return { result, attempts };
    if (skipRateLimited) return { result, attempts };
    const effectiveDelay = result.status === 429 ? rateLimitDelayMs : delayMs;
    await sleep(effectiveDelay);
    result = await doRefresh();
    attempts += 1;
  }
  if (!result.ok) {
    opts?.onFailure?.({
      attempt: attempts,
      status: result.status,
      code: (result.data as RefreshErrorBody | null)?.error?.code,
      definitive: isDefinitiveRefreshFailure(result),
      willRetry: false,
    });
  }
  return { result, attempts };
}

/**
 * 在瞬时失败重试外,额外处理同机多实例共享 userData 的 refresh-token 轮换竞态:
 * 如果本次请求用的 token 已失败,但磁盘 token 已被别的实例更新,则用磁盘新 token
 * 再跑一轮 refresh。只有当前磁盘 token 也失败时,调用方才应清登录态。
 */
export async function runRefreshWithReplacementRetry<T>(
  initialRefreshToken: string,
  opts: {
    doRefresh: (refreshToken: string) => Promise<RefreshFetchResult<T>>;
    /**
     * 读磁盘上所有凭证来源的当前值(如 v1 记录与 legacy 裸 token),按优先级排列。
     *
     * 必须交出**全部**来源、由本函数统一筛选,不能由调用方先折叠成单个候选:
     * 排除「本轮已被拒过的 token」这一步只有拿到完整候选集才做得对。调用方先按
     * 优先级折叠的话,首选来源里那枚已失效的 token 会把后面来源里真正有效的那枚
     * 挤掉,最终以确定性失效收场并连带删掉有效凭证。
     */
    readLatestStoredTokens: () => readonly (string | null | undefined)[];
    /** 不传则单次请求;传入则每一枚 token 内部按 transient 规则重试。 */
    transientRetry?: {
      retryDelaysMs?: readonly number[];
      rateLimitDelayMs?: number;
      sleep?: (ms: number) => Promise<void>;
      onFailure?: (info: RefreshFailureInfo) => void;
    };
    /** 默认最多允许 2 次“磁盘 token 已被替换”的追赶重试。 */
    maxReplacementRetries?: number;
    /**
     * INVALID_REFRESH_TOKEN 但磁盘 token 仍未变化时,短暂等待后再读磁盘。
     * 用来覆盖“服务端已消费旧 token,但赢家实例还没把新 token 写回本地”的窗口。
     */
    replacementRecheck?: {
      delaysMs?: readonly number[];
      sleep?: (ms: number) => Promise<void>;
      onBeforeRecheck?: (info: RefreshReplacementRecheckInfo) => void;
    };
    onReplacementRetry?: (info: RefreshReplacementRetryInfo) => void;
  },
): Promise<{
  result: RefreshFetchResult<T>;
  attempts: number;
  requestedToken: string;
  replacementRetries: number;
  replacementRetryExhausted: boolean;
  failureAction?: RefreshFailureAction;
  /**
   * 本轮被服务端拒过的**所有** token,按首次尝试顺序。
   *
   * 调用方清理磁盘凭证时必须逐一比对这份清单,而不是只认最初那一枚:一旦本轮从另一个
   * 来源追赶过(replacement-retry),磁盘上现存的那枚就是清单里较晚的那一个,只拿最初
   * 的 token 做 compare-and-delete 会一律 `changed`,把已确认失效的凭证留在盘上。
   */
  rejectedTokens: readonly string[];
}> {
  let requestedToken = initialRefreshToken;
  let attempts = 0;
  let replacementRetries = 0;
  const maxReplacementRetries = Math.max(0, opts.maxReplacementRetries ?? 2);
  const replacementRecheckDelaysMs = opts.replacementRecheck?.delaysMs ?? [];
  const replacementRecheckSleep =
    opts.replacementRecheck?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /**
   * 本轮已经被服务端拒过的 token。
   *
   * 多来源候选(v1 / legacy)可能互为「对方眼里的替换 token」:磁盘上两个文件分叉时,
   * 只排除**紧邻的上一枚**会让两枚 token 来回被选中,耗尽 maxReplacementRetries 后
   * 以 `replacement-retry` 收尾——runtime 于是每 60s 重试一枚已知无效的凭证而永不
   * 过期,冷启动则保留不可用凭证并以未登录启动(既不自愈也不明确告知用户)。
   * 已经拒过的 token 不再算替换候选,两枚都试过就如实落到 definitive-failure。
   */
  const rejectedTokens = new Set<string>();

  /**
   * 读全部来源 → **先剔掉本轮已被拒过的** → 再按优先级挑替换候选。
   *
   * 顺序是要点:先折叠后过滤会漏掉有效凭证——v1 存着已拒的 A、legacy 存着有效的 C 时,
   * 折叠只交出 A(v1 优先),随后 A 被判已拒,于是整轮以确定性失效收场,C 从未被试过,
   * 还会连同 C 一起被清掉。
   */
  const nextReplacementCandidate = (requestedToken: string): string | null =>
    pickRefreshTokenReplacementCandidate(
      requestedToken,
      opts.readLatestStoredTokens().filter((token) => !token || !rejectedTokens.has(token)),
    );

  while (true) {
    const run = opts.transientRetry
      ? await runRefreshWithTransientRetry(
          () => opts.doRefresh(requestedToken),
          opts.transientRetry,
        )
      : { result: await opts.doRefresh(requestedToken), attempts: 1 };
    attempts += run.attempts;

    if (run.result.ok) {
      return {
        result: run.result,
        attempts,
        requestedToken,
        replacementRetries,
        replacementRetryExhausted: false,
        rejectedTokens: [...rejectedTokens],
      };
    }

    rejectedTokens.add(requestedToken);

    let action = resolveRefreshFailureAction(
      run.result,
      requestedToken,
      nextReplacementCandidate(requestedToken),
    );

    if (action.kind === 'definitive-failure' && isReplacementRetryEligibleFailure(run.result)) {
      for (const delayMs of replacementRecheckDelaysMs) {
        opts.replacementRecheck?.onBeforeRecheck?.({
          attempts,
          status: run.result.status,
          code: getRefreshErrorCode(run.result),
          delayMs,
        });
        if (delayMs > 0) await replacementRecheckSleep(delayMs);
        action = resolveRefreshFailureAction(
          run.result,
          requestedToken,
          nextReplacementCandidate(requestedToken),
        );
        if (action.kind !== 'definitive-failure') break;
      }
    }

    if (action.kind !== 'replacement-retry') {
      return {
        result: run.result,
        attempts,
        requestedToken,
        replacementRetries,
        replacementRetryExhausted: false,
        failureAction: action,
        rejectedTokens: [...rejectedTokens],
      };
    }

    if (replacementRetries >= maxReplacementRetries) {
      return {
        result: run.result,
        attempts,
        requestedToken,
        replacementRetries,
        replacementRetryExhausted: true,
        failureAction: action,
        rejectedTokens: [...rejectedTokens],
      };
    }

    replacementRetries += 1;
    opts.onReplacementRetry?.({
      replacementRetry: replacementRetries,
      attempts,
      status: run.result.status,
      code: (run.result.data as RefreshErrorBody | null)?.error?.code,
    });
    requestedToken = action.refreshToken;
  }
}
