/**
 * Codex 重置（rate-limit reset credit）自动使用。只对用户在设置里逐个开启的 OpenAI
 * 订阅账号生效，默认关闭。两条互相独立的路径：
 *
 * 1. **周配额用完**（`spendForWeeklyLimit`）：任务因账号配额耗尽而中断时由 host 调用。
 *    只看周窗口（≥ 1 天的窗口用满），5 小时窗口会自己恢复，不为它花重置；每个账号
 *    每个周窗口最多自动用一次，记录落盘，重启后不会再用第二次。用掉之后 host 自动
 *    续跑那个任务。
 *
 * 2. **重置快过期**（`checkExpiring`，后台巡检）：重置一用，窗口立刻重新计算，窗口里
 *    剩下的配额就作废了；而新窗口什么时候开始都一样。所以快过期的重置要尽量晚用：
 *    过期前 `RESET_CREDIT_EXPIRY_LEAD_MS` 才用。唯一提前的情况是账号此刻已被用满的窗口
 *    卡住、而且在那个时间点之前恢复不了——再等也用不上剩余配额，不如立即用掉让账号
 *    恢复可用。窗口一点都没用过时不用，任它过期：用了也没有可重置的东西。
 *    这条路径不占「每周一次」的名额：不用也会白白过期。
 *
 * 两条路径都只用**最早过期**的那张（显式传 creditId），有效期更长的留着；同一账号的
 * 读与用串行在一把锁里，避免两条路径或多个任务同时各用一张。
 *
 * 时间一律用墙钟（Date.now）：重置按墙钟过期，Mac 睡眠期间单调时钟不走。
 */

import { randomUUID } from 'node:crypto';

import { normalizeAccountRateLimitSnapshot } from '@cindy/maker-core';
import type {
  AccountRateLimitSnapshot,
  AccountRateLimitsResponse,
  ConsumeAccountRateLimitResetCreditOutcome,
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
} from '@cindy/maker-core';
import { matchesDeterministicUsageExhaustionText } from '@cindy/maker-shared/error-redaction';

import { normalizeAvailableCount, selectEarliestExpiringCredit } from './codexRateLimitReset.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** 快过期的重置在过期前多久用掉：尽量晚，同时给几次巡检失败或错过留出余量。 */
export const RESET_CREDIT_EXPIRY_LEAD_MS = 30 * MINUTE_MS;
/** 距过期不到这么久时，每 `EXPIRY_CLOSE_MS` 看一次。 */
const EXPIRY_NEAR_MS = HOUR_MS;
/** 临近过期、刚用掉一张、或读/用失败之后的复查间隔；也是后台巡检的节拍。 */
const EXPIRY_CLOSE_MS = 5 * MINUTE_MS;
/** 持有会过期的重置但还没临近：账号可能被用满（届时立即用）或被用掉。 */
const EXPIRY_WATCH_MS = 30 * MINUTE_MS;
/** 没有会过期的重置时最长多久再读一次：期间新发的重置最迟这时被看到。 */
const EXPIRY_FAR_MS = 6 * HOUR_MS;
/** 应用启动后多久做第一次巡检：避开启动高峰。 */
const SWEEP_FIRST_DELAY_MS = 3 * MINUTE_MS;

/** 窗口时长不短于一天才算周窗口。 */
const WEEKLY_WINDOW_MIN_MINUTES = 24 * 60;
/** 周窗口还没用满时，多久之后才再读。 */
const WEEKLY_RETRY_NOT_USED_UP_MS = MINUTE_MS;
/** 没有重置、读失败或没用成时，多久之后才再试。 */
const WEEKLY_RETRY_FAILED_MS = 10 * MINUTE_MS;
/**
 * 本周的重置刚被另一个任务用掉多久以内，后到的中断仍可直接续跑：它们的请求发在
 * 重置之前，账号此刻已经恢复。
 */
const WEEKLY_RECENT_RESET_MS = 10 * MINUTE_MS;

/** 一个账号配额窗口的判定视图；时间统一为毫秒。 */
export interface QuotaWindowView {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAtMs: number | null;
}

/** 账号通用配额（不含按模型计的桶）的窗口。 */
export function accountQuotaWindows(snapshot: AccountRateLimitSnapshot): QuotaWindowView[] {
  const normalized = normalizeAccountRateLimitSnapshot(snapshot);
  const out: QuotaWindowView[] = [];
  for (const window of [normalized.primary, normalized.secondary]) {
    if (!window) continue;
    const usedPercent = Number(window.usedPercent);
    if (!Number.isFinite(usedPercent)) continue;
    const minutes = window.windowMinutes;
    const resetsAt = window.resetsAt;
    out.push({
      usedPercent,
      windowMinutes: typeof minutes === 'number' && minutes > 0 ? minutes : null,
      resetsAtMs:
        typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0
          ? resetsAt * 1000
          : null,
    });
  }
  return out;
}

/** 有没有任何窗口被用过：都没用过时重置没有可重置的东西。 */
export function hasUsedQuota(windows: readonly QuotaWindowView[]): boolean {
  return windows.some((window) => window.usedPercent > 0);
}

/**
 * 账号此刻是否被用满的窗口卡住，以及最晚那个卡住它的窗口何时恢复
 * （`backAtMs` 为 null：有一个没说何时恢复）。
 */
export function quotaHeldUp(windows: readonly QuotaWindowView[]): {
  stopped: boolean;
  backAtMs: number | null;
} {
  let stopped = false;
  let backAtMs: number | null = 0;
  for (const window of windows) {
    if (window.usedPercent < 100) continue;
    stopped = true;
    if (window.resetsAtMs === null) backAtMs = null;
    else if (backAtMs !== null) backAtMs = Math.max(backAtMs, window.resetsAtMs);
  }
  return { stopped, backAtMs: stopped ? backAtMs : null };
}

/** 用满的周窗口何时结束；没有用满的周窗口时为 null。 */
export function weeklyQuotaUsedUpUntil(
  windows: readonly QuotaWindowView[],
  nowMs: number,
): number | null {
  for (const window of windows) {
    if (
      window.windowMinutes !== null &&
      window.windowMinutes >= WEEKLY_WINDOW_MIN_MINUTES &&
      window.usedPercent >= 100 &&
      window.resetsAtMs !== null &&
      window.resetsAtMs > nowMs
    ) {
      return window.resetsAtMs;
    }
  }
  return null;
}

/**
 * 在 `untilMs` 过期的重置何时用掉：过期前 `RESET_CREDIT_EXPIRY_LEAD_MS`，那一刻已过则
 * 现在；账号被卡住且恢复时间（未知也算）不早于那一刻时也是现在。已过期返回 null。
 */
export function expiringCreditSpendAt(
  untilMs: number,
  nowMs: number,
  held: { stopped: boolean; backAtMs: number | null },
): number | null {
  if (untilMs <= nowMs) return null;
  const at = untilMs - RESET_CREDIT_EXPIRY_LEAD_MS;
  if (at <= nowMs) return nowMs;
  if (held.stopped && (held.backAtMs === null || held.backAtMs >= at)) return nowMs;
  return at;
}

/**
 * 持有在 `untilMs` 过期的重置时，下一次什么时候看：临近过期每 `EXPIRY_CLOSE_MS` 一次；
 * 之前每 `EXPIRY_WATCH_MS` 一次但不越过「临近」的起点——保证用掉之前能看好几次，
 * 错过或失败一两次仍来得及。
 */
export function nextExpiringCreditLookAt(untilMs: number, nowMs: number): number {
  const near = untilMs - EXPIRY_NEAR_MS;
  if (near > nowMs) return Math.min(nowMs + EXPIRY_WATCH_MS, near);
  return nowMs + EXPIRY_CLOSE_MS;
}

/** 可用重置里最早的过期时刻（毫秒）；不会过期、没有明细或没有可用重置时为 null。 */
export function soonestCreditExpiryMs(response: AccountRateLimitsResponse): number | null {
  if (normalizeAvailableCount(response.rateLimitResetCredits?.availableCount ?? 0) <= 0) return null;
  const credit = selectEarliestExpiringCredit(response.rateLimitResetCredits?.credits ?? null);
  return credit?.expiresAt != null ? credit.expiresAt * 1000 : null;
}

/**
 * 终态错误是否像「账号配额耗尽」。只用来决定要不要去读账号；真正是否用重置以读到
 * 的周窗口为准，所以这里宁宽勿漏。
 */
export function isCodexUsageLimitSignal(signals: {
  message?: string;
  codexErrorInfo?: string;
}): boolean {
  if (signals.codexErrorInfo === 'usageLimitExceeded') return true;
  return typeof signals.message === 'string' && matchesDeterministicUsageExhaustionText(signals.message);
}

/** 某账号在某个周窗口里自动用过一次重置的记录。 */
export interface WeeklyResetRecord {
  /** 那个周窗口结束的时刻；过了它记录作废。 */
  untilMs: number;
  /** 用掉的时刻。 */
  atMs: number;
}

export type WeeklyLimitResetResult =
  | { kind: 'reset' }
  | { kind: 'restored' }
  | {
      kind: 'skipped';
      why: 'disabled' | 'no-account' | 'already-used' | 'not-used-up' | 'no-credit' | 'backoff';
    }
  | { kind: 'failed'; outcome?: ConsumeAccountRateLimitResetCreditOutcome; error?: string };

export type ExpiringCheckResult =
  | { kind: 'reset' }
  | { kind: 'idle' }
  | { kind: 'failed'; outcome?: ConsumeAccountRateLimitResetCreditOutcome; error?: string };

interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export interface CodexResetCreditAutoUseDeps {
  /** 开启了自动使用、且仍是 OpenAI 订阅账号的供应商。 */
  enabledProviderIds(): string[];
  isEnabled(providerId: string): boolean;
  /** 当前登录的 ChatGPT 工作区 id；不是 OAuth 登录时为 null。 */
  readAccountKey(providerId: string): Promise<string | null>;
  readRateLimits(providerId: string): Promise<AccountRateLimitsResponse>;
  consumeResetCredit(
    providerId: string,
    params: ConsumeAccountRateLimitResetCreditParams,
  ): Promise<ConsumeAccountRateLimitResetCreditResponse>;
  /** 用掉之后刷新额度展示。 */
  afterReset?(providerId: string): void;
  readWeeklyReset(providerId: string, accountKey: string): WeeklyResetRecord | null;
  writeWeeklyReset(providerId: string, accountKey: string, record: WeeklyResetRecord): void;
  /** 当前 Cindy 账号作用域；变了就丢弃旧作用域的内存状态。 */
  scopeKey(): string;
  log: Logger;
  now?: () => number;
  createIdempotencyKey?: () => string;
}

export interface CodexResetCreditAutoUse {
  /**
   * 同步预判：这个账号值不值得为一次配额耗尽去读一次。为 false 时 host 不接管，
   * 错误照常呈现。
   */
  mayUseForUsageLimit(providerId: string): boolean;
  spendForWeeklyLimit(providerId: string): Promise<WeeklyLimitResetResult>;
  checkExpiring(providerId: string): Promise<ExpiringCheckResult>;
  /** 依次检查所有开启的账号。 */
  sweepExpiring(): Promise<void>;
  /** 开关变化后清掉该账号的退避与巡检排期，下次巡检立即重新读。 */
  noteSettingChanged(providerId: string): void;
  start(): void;
  stop(): void;
}

class ScopeChangedError extends Error {
  constructor() {
    super('Cindy account scope changed');
    this.name = 'ScopeChangedError';
  }
}

interface ScopeState {
  scope: string;
  locks: Map<string, Promise<unknown>>;
  weeklyInflight: Map<string, Promise<WeeklyLimitResetResult>>;
  weeklyRetryAt: Map<string, number>;
  lastAccountKey: Map<string, string>;
  expiringNextLookAt: Map<string, number>;
  expiringUntil: Map<string, number>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCodexResetCreditAutoUse(
  deps: CodexResetCreditAutoUseDeps,
): CodexResetCreditAutoUse {
  const now = deps.now ?? Date.now;
  const createIdempotencyKey = deps.createIdempotencyKey ?? randomUUID;
  let state: ScopeState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  const current = (): ScopeState => {
    const scope = deps.scopeKey();
    if (!state || state.scope !== scope) {
      state = {
        scope,
        locks: new Map(),
        weeklyInflight: new Map(),
        weeklyRetryAt: new Map(),
        lastAccountKey: new Map(),
        expiringNextLookAt: new Map(),
        expiringUntil: new Map(),
      };
    }
    return state;
  };

  const assertScope = (owner: ScopeState): void => {
    if (deps.scopeKey() !== owner.scope) throw new ScopeChangedError();
  };

  const withProviderLock = <T>(
    owner: ScopeState,
    providerId: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const previous = owner.locks.get(providerId) ?? Promise.resolve();
    const result = previous.then(run, run);
    const tail = result.catch(() => undefined);
    owner.locks.set(providerId, tail);
    void tail.then(() => {
      if (owner.locks.get(providerId) === tail) owner.locks.delete(providerId);
    });
    return result;
  };

  const consumeEarliest = async (
    owner: ScopeState,
    providerId: string,
    response: AccountRateLimitsResponse,
  ): Promise<ConsumeAccountRateLimitResetCreditResponse | null> => {
    const credits = response.rateLimitResetCredits?.credits ?? null;
    const credit = selectEarliestExpiringCredit(credits);
    // 有明细却没有可用的 Codex 重置：计数与明细不一致，不让后端替我们挑一张。
    if (credits !== null && !credit) return null;
    const result = await deps.consumeResetCredit(providerId, {
      idempotencyKey: createIdempotencyKey(),
      ...(credit ? { creditId: credit.id } : {}),
    });
    assertScope(owner);
    return result;
  };

  const runWeekly = async (owner: ScopeState, providerId: string): Promise<WeeklyLimitResetResult> => {
    if (!deps.isEnabled(providerId)) return { kind: 'skipped', why: 'disabled' };
    if (now() < (owner.weeklyRetryAt.get(providerId) ?? 0)) {
      return { kind: 'skipped', why: 'backoff' };
    }
    try {
      const accountKey = await deps.readAccountKey(providerId);
      assertScope(owner);
      if (!accountKey) {
        // 没有 OAuth 登录（例如未指定来源的任务改走了网关）：一段时间内不再为它接管。
        owner.weeklyRetryAt.set(providerId, now() + WEEKLY_RETRY_FAILED_MS);
        return { kind: 'skipped', why: 'no-account' };
      }
      owner.lastAccountKey.set(providerId, accountKey);
      const response = await deps.readRateLimits(providerId);
      assertScope(owner);
      const windows = accountQuotaWindows(response.rateLimits);
      const readAt = now();
      const record = deps.readWeeklyReset(providerId, accountKey);
      if (record && readAt < record.untilMs) {
        if (readAt - record.atMs <= WEEKLY_RECENT_RESET_MS && !quotaHeldUp(windows).stopped) {
          return { kind: 'restored' };
        }
        return { kind: 'skipped', why: 'already-used' };
      }
      const untilMs = weeklyQuotaUsedUpUntil(windows, readAt);
      if (untilMs === null) {
        owner.weeklyRetryAt.set(providerId, readAt + WEEKLY_RETRY_NOT_USED_UP_MS);
        return { kind: 'skipped', why: 'not-used-up' };
      }
      const consumed =
        normalizeAvailableCount(response.rateLimitResetCredits?.availableCount ?? 0) > 0
          ? await consumeEarliest(owner, providerId, response)
          : null;
      if (!consumed) {
        owner.weeklyRetryAt.set(providerId, now() + WEEKLY_RETRY_FAILED_MS);
        return { kind: 'skipped', why: 'no-credit' };
      }
      if (consumed.outcome !== 'reset') {
        owner.weeklyRetryAt.set(providerId, now() + WEEKLY_RETRY_FAILED_MS);
        deps.log.info('codex reset not used for weekly limit', {
          providerId,
          outcome: consumed.outcome,
        });
        return { kind: 'failed', outcome: consumed.outcome };
      }
      deps.writeWeeklyReset(providerId, accountKey, { untilMs, atMs: now() });
      deps.log.info('codex reset used for weekly limit', { providerId, weekEndsAt: untilMs });
      deps.afterReset?.(providerId);
      return { kind: 'reset' };
    } catch (error) {
      if (error instanceof ScopeChangedError) return { kind: 'failed', error: error.message };
      owner.weeklyRetryAt.set(providerId, now() + WEEKLY_RETRY_FAILED_MS);
      deps.log.warn('codex reset for weekly limit failed', {
        providerId,
        error: errorMessage(error),
      });
      return { kind: 'failed', error: errorMessage(error) };
    }
  };

  const runExpiring = async (owner: ScopeState, providerId: string): Promise<ExpiringCheckResult> => {
    if (!deps.isEnabled(providerId)) return { kind: 'idle' };
    const startedAt = now();
    if (startedAt < (owner.expiringNextLookAt.get(providerId) ?? 0)) return { kind: 'idle' };
    let response: AccountRateLimitsResponse;
    try {
      const accountKey = await deps.readAccountKey(providerId);
      assertScope(owner);
      if (!accountKey) {
        owner.expiringNextLookAt.set(providerId, startedAt + EXPIRY_WATCH_MS);
        return { kind: 'idle' };
      }
      response = await deps.readRateLimits(providerId);
      assertScope(owner);
    } catch (error) {
      if (error instanceof ScopeChangedError) return { kind: 'failed', error: error.message };
      const lastUntil = owner.expiringUntil.get(providerId);
      owner.expiringNextLookAt.set(
        providerId,
        lastUntil !== undefined
          ? nextExpiringCreditLookAt(lastUntil, startedAt)
          : startedAt + EXPIRY_WATCH_MS,
      );
      return { kind: 'failed', error: errorMessage(error) };
    }
    const readAt = now();
    const untilMs = soonestCreditExpiryMs(response);
    if (untilMs === null) {
      owner.expiringUntil.delete(providerId);
      owner.expiringNextLookAt.set(providerId, readAt + EXPIRY_FAR_MS);
      return { kind: 'idle' };
    }
    owner.expiringUntil.set(providerId, untilMs);
    if (untilMs <= readAt) {
      // 已经过期：后面可能紧跟着另一张。
      owner.expiringNextLookAt.set(providerId, readAt + EXPIRY_CLOSE_MS);
      return { kind: 'idle' };
    }
    const windows = accountQuotaWindows(response.rateLimits);
    const spendAt = expiringCreditSpendAt(untilMs, readAt, quotaHeldUp(windows));
    if (spendAt === null || spendAt > readAt || !hasUsedQuota(windows)) {
      owner.expiringNextLookAt.set(providerId, nextExpiringCreditLookAt(untilMs, readAt));
      return { kind: 'idle' };
    }
    try {
      const consumed = await consumeEarliest(owner, providerId, response);
      if (!consumed || consumed.outcome !== 'reset') {
        owner.expiringNextLookAt.set(providerId, nextExpiringCreditLookAt(untilMs, now()));
        if (consumed) {
          deps.log.info('codex reset about to expire not used', {
            providerId,
            outcome: consumed.outcome,
          });
        }
        return consumed ? { kind: 'failed', outcome: consumed.outcome } : { kind: 'idle' };
      }
      owner.expiringNextLookAt.set(providerId, now() + EXPIRY_CLOSE_MS);
      deps.log.info('codex reset about to expire used', { providerId, expiresAt: untilMs });
      deps.afterReset?.(providerId);
      return { kind: 'reset' };
    } catch (error) {
      if (error instanceof ScopeChangedError) return { kind: 'failed', error: error.message };
      owner.expiringNextLookAt.set(providerId, nextExpiringCreditLookAt(untilMs, now()));
      deps.log.warn('codex reset about to expire failed', {
        providerId,
        error: errorMessage(error),
      });
      return { kind: 'failed', error: errorMessage(error) };
    }
  };

  const service: CodexResetCreditAutoUse = {
    mayUseForUsageLimit(providerId) {
      if (!deps.isEnabled(providerId)) return false;
      const owner = current();
      const at = now();
      if (at < (owner.weeklyRetryAt.get(providerId) ?? 0)) return false;
      const accountKey = owner.lastAccountKey.get(providerId);
      if (!accountKey) return true;
      const record = deps.readWeeklyReset(providerId, accountKey);
      return !record || at >= record.untilMs || at - record.atMs <= WEEKLY_RECENT_RESET_MS;
    },

    spendForWeeklyLimit(providerId) {
      const owner = current();
      // 同一账号同时有多个任务撞上配额：共用正在进行的那一次，不各用一张。
      const inflight = owner.weeklyInflight.get(providerId);
      if (inflight) return inflight;
      const run = withProviderLock(owner, providerId, () => runWeekly(owner, providerId)).finally(
        () => {
          if (owner.weeklyInflight.get(providerId) === run) owner.weeklyInflight.delete(providerId);
        },
      );
      owner.weeklyInflight.set(providerId, run);
      return run;
    },

    checkExpiring(providerId) {
      const owner = current();
      return withProviderLock(owner, providerId, () => runExpiring(owner, providerId));
    },

    async sweepExpiring() {
      for (const providerId of deps.enabledProviderIds()) {
        await service.checkExpiring(providerId);
      }
    },

    noteSettingChanged(providerId) {
      const owner = current();
      owner.weeklyRetryAt.delete(providerId);
      owner.expiringNextLookAt.delete(providerId);
      owner.expiringUntil.delete(providerId);
    },

    start() {
      if (timer || running) return;
      const schedule = (delayMs: number) => {
        timer = setTimeout(() => {
          timer = null;
          running = true;
          void service
            .sweepExpiring()
            .catch((error) => {
              deps.log.warn('codex reset expiry sweep failed', { error: errorMessage(error) });
            })
            .finally(() => {
              running = false;
              if (stopped) return;
              schedule(EXPIRY_CLOSE_MS);
            });
        }, delayMs);
        timer.unref?.();
      };
      stopped = false;
      schedule(SWEEP_FIRST_DELAY_MS);
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
  return service;
}
