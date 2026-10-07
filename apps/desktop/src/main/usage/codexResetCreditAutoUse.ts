/**
 * Codex 重置（rate-limit reset credit）自动使用。只对用户在设置里逐个开启的 OpenAI
 * 订阅账号生效，默认关闭。本模块只判断「该不该用」：读额度与扣卡都走现有的重置服务
 * （usage/codexRateLimitReset.ts），扣卡前后的身份核对、幂等键与并发共用都在那里。
 *
 * 1. **周配额用完**（`resolveUsageLimit`）：任务因配额耗尽中断时由 host 调用。按任务模型
 *    选限额桶后重新读一次：账号此刻没被用满的窗口卡住（别的任务刚用过重置、窗口刚好
 *    重新开始），直接续跑；只有周窗口（≥ 1 天）用满、手里有重置时才用一张；只是 5 小时
 *    窗口满了不用，它会自己恢复。一次重置让周窗口重新开始，再用满要再花一整周的配额，
 *    本身就有上限，不另外限次。
 *
 * 2. **重置快过期**（`noteRateLimits` 排定时）：重置一用，窗口立刻重新计算，窗口里剩下的
 *    配额就作废了；而新窗口什么时候开始都一样。所以快过期的重置要尽量晚用：过期前
 *    `RESET_CREDIT_EXPIRY_LEAD_MS`。唯一提前的情况是账号此刻已被用满的窗口卡住、而且在
 *    那个时间点之前恢复不了，再等也用不上剩余配额，不如立即用掉让账号恢复可用。窗口
 *    一点都没用过时不用，任它过期：用了也没有可重置的东西。
 *    不轮询：每次读到额度（用量区、手机读额度、应用启动）时，按最早过期那张给每个账号
 *    排一个定时；到点再读一次确认后才扣。
 *
 * 时间一律用墙钟（Date.now）：重置按墙钟过期。睡眠期间定时器不走，醒来后由 host 调
 * `reschedule` 按当前时间重排。
 */

import { normalizeAccountRateLimitSnapshot } from '@cindy/maker-core';
import type { ConsumeAccountRateLimitResetCreditOutcome } from '@cindy/maker-core';
import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import type {
  MobileCodexRateLimitResetResult,
  MobileCodexRateLimitsResult,
} from '@cindy/maker-shared/device-link-contract';
import { matchesDeterministicUsageExhaustionText } from '@cindy/maker-shared/error-redaction';

import type { CodexResetCreditAutoUseRecord } from '../../shared/codexResetCreditAutoUse.js';

const MINUTE_MS = 60_000;

/** 快过期的重置在过期前多久用掉：尽量晚，同时给一次失败留出重试的余量。 */
export const RESET_CREDIT_EXPIRY_LEAD_MS = 30 * MINUTE_MS;
/** 应用启动后多久为开启的账号读一次额度：避开启动高峰。 */
const STARTUP_READ_DELAY_MS = MINUTE_MS;
/** setTimeout 的上限（约 24.8 天）；更远的先定到上限，到点再重排。 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** 窗口时长不短于一天才算周窗口。 */
const WEEKLY_WINDOW_MIN_MINUTES = 24 * 60;

type RateLimitSnapshotView = MobileCodexRateLimitsResult['rateLimits'];

/** 一个账号配额窗口的判定视图；时间统一为毫秒。 */
export interface QuotaWindowView {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAtMs: number | null;
}

/** 一个限额桶的窗口。 */
export function quotaWindows(snapshot: RateLimitSnapshotView | null | undefined): QuotaWindowView[] {
  if (!snapshot) return [];
  const normalized = normalizeAccountRateLimitSnapshot({
    primary: snapshot.primary ?? null,
    secondary: snapshot.secondary ?? null,
  });
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

/**
 * 任务模型对应的限额桶：模型专属桶优先，否则通用桶；`modelId` 为 null 时取通用桶。
 * 与设置页、任务卡上的用量展示同一套选桶规则。
 */
export function quotaBucketFor(
  result: MobileCodexRateLimitsResult,
  modelId: string | null,
  nowMs: number,
): RateLimitSnapshotView {
  const buckets = result.rateLimitsByLimitId ?? {
    [result.rateLimits.limitId ?? 'codex']: result.rateLimits,
  };
  return matchCodexBucketForModel(buckets, modelId, nowMs) ?? result.rateLimits;
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

/** 有没有用满的周窗口（还没到它自己的重置时间）。 */
export function weeklyQuotaUsedUp(windows: readonly QuotaWindowView[], nowMs: number): boolean {
  return windows.some(
    (window) =>
      window.windowMinutes !== null &&
      window.windowMinutes >= WEEKLY_WINDOW_MIN_MINUTES &&
      window.usedPercent >= 100 &&
      (window.resetsAtMs === null || window.resetsAtMs > nowMs),
  );
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

/** 快过期重置的处理计划：不处理、现在就用，或排到某个时刻再看。 */
export type ExpiringPlan =
  | { action: 'none' }
  | { action: 'spend-now'; expiresAtMs: number }
  | { action: 'at'; atMs: number; expiresAtMs: number };

/**
 * 按一次额度读取结果给快过期的重置排计划。重置服务给的 offer 就是最早过期的那张；
 * 它不会过期、读不到明细或此刻没有 offer 时不处理。
 */
export function planExpiringCredit(result: MobileCodexRateLimitsResult, nowMs: number): ExpiringPlan {
  const expiresAt = result.resetOffer?.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return { action: 'none' };
  const expiresAtMs = expiresAt * 1000;
  const windows = quotaWindows(quotaBucketFor(result, null, nowMs));
  const spendAt = expiringCreditSpendAt(expiresAtMs, nowMs, quotaHeldUp(windows));
  if (spendAt === null) return { action: 'none' };
  if (spendAt > nowMs) return { action: 'at', atMs: spendAt, expiresAtMs };
  // 到点了但窗口一点没用过：任它过期。之后用了配额，下一次读额度会重新判断。
  return hasUsedQuota(windows) ? { action: 'spend-now', expiresAtMs } : { action: 'none' };
}

/**
 * 终态错误是否像「账号配额耗尽」。只用来决定要不要去读账号；真正是否用重置以读到
 * 的窗口为准，所以这里宁宽勿漏。
 */
export function isCodexUsageLimitSignal(signals: {
  message?: string;
  codexErrorInfo?: string;
}): boolean {
  if (signals.codexErrorInfo === 'usageLimitExceeded') return true;
  return typeof signals.message === 'string' && matchesDeterministicUsageExhaustionText(signals.message);
}

/** 一次配额耗尽的处理结果。 */
export type UsageLimitResolution =
  /** 用掉了一次重置。 */
  | { kind: 'reset' }
  /** 账号此刻没被卡住（别的任务刚用过重置等），不用重置直接续跑。 */
  | { kind: 'restored' }
  /** 没用重置：卡住的只是短窗口、没有可用的重置，或开关已关。 */
  | { kind: 'skipped'; why: 'short-window' | 'no-credit' | 'disabled' }
  | { kind: 'failed'; outcome?: ConsumeAccountRateLimitResetCreditOutcome; error?: string };

interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export interface CodexResetCreditAutoUseDeps {
  /** 开启了自动使用、且仍是 OpenAI 订阅账号的连接。 */
  enabledProviderIds(): string[];
  isEnabled(providerId: string): boolean;
  /** 现有重置服务的读取：读额度、核对身份、给出绑定账号的 offer（最早过期的那张）。 */
  readRateLimits(providerId: string): Promise<MobileCodexRateLimitsResult>;
  /** 现有重置服务的扣卡：同一 offer 只扣一次，结果不确定时重试沿用同一个幂等键。 */
  consumeReset(providerId: string, idempotencyKey: string): Promise<MobileCodexRateLimitResetResult>;
  /** 自动用掉了一次：留记录；快过期那条路径还要发桌面通知。 */
  onAutoUsed(providerId: string, record: CodexResetCreditAutoUseRecord): void;
  /** 当前 Cindy 账号作用域；变了就丢弃旧作用域的定时与进行中的判断。 */
  scopeKey(): string;
  log: Logger;
  now?: () => number;
}

export interface CodexResetCreditAutoUse {
  /** 同步预判：这个账号开了自动使用。为 false 时 host 不接管，错误照常呈现。 */
  mayUseForUsageLimit(providerId: string): boolean;
  /**
   * 处理一次配额耗尽。`onSpending` 在确定要用重置、真正扣卡之前调用，host 据此把
   * 「正在检查配额」切到「正在用一次重置」。
   */
  resolveUsageLimit(
    providerId: string,
    modelId: string | null,
    onSpending?: () => void,
  ): Promise<UsageLimitResolution>;
  /** 读到一次额度：按最早过期的那张重排（或取消）这个账号的定时。 */
  noteRateLimits(providerId: string, result: MobileCodexRateLimitsResult): void;
  /** 开关变化：关闭即取消定时，开启时读一次额度来排定时。 */
  noteSettingChanged(providerId: string): void;
  /** 睡眠醒来等时钟跳变后，按当前时间重排所有定时。 */
  reschedule(): void;
  /** 应用启动：稍后为开启的账号各读一次额度。 */
  start(): void;
  stop(): void;
}

interface ExpiringEntry {
  scope: string;
  result: MobileCodexRateLimitsResult;
  timer: ReturnType<typeof setTimeout> | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCodexResetCreditAutoUse(
  deps: CodexResetCreditAutoUseDeps,
): CodexResetCreditAutoUse {
  const now = deps.now ?? Date.now;
  const expiring = new Map<string, ExpiringEntry>();
  const usageLimitInflight = new Map<
    string,
    { scope: string; promise: Promise<UsageLimitResolution>; onSpending: Array<() => void> }
  >();
  const expiringInflight = new Set<string>();
  let startupTimer: ReturnType<typeof setTimeout> | null = null;

  /** 留记录与通知失败不能把一次已经扣成的重置说成失败。 */
  const reportAutoUsed = (providerId: string, record: CodexResetCreditAutoUseRecord): void => {
    try {
      deps.onAutoUsed(providerId, record);
    } catch (error) {
      deps.log.warn('codex reset auto-use report failed', { providerId, error: errorMessage(error) });
    }
  };

  const cancel = (providerId: string): void => {
    const entry = expiring.get(providerId);
    if (entry?.timer) clearTimeout(entry.timer);
    expiring.delete(providerId);
  };

  const dropOtherScopes = (): string => {
    const scope = deps.scopeKey();
    for (const [providerId, entry] of expiring) {
      if (entry.scope !== scope) cancel(providerId);
    }
    for (const [key, inflight] of usageLimitInflight) {
      if (inflight.scope !== scope) usageLimitInflight.delete(key);
    }
    return scope;
  };

  /** 定时到点：再读一次，重置还在、窗口用过、开关仍开，才扣。 */
  const spendExpiring = async (providerId: string, scope: string): Promise<void> => {
    if (expiringInflight.has(providerId)) return;
    expiringInflight.add(providerId);
    try {
      if (deps.scopeKey() !== scope || !deps.isEnabled(providerId)) {
        cancel(providerId);
        return;
      }
      const result = await deps.readRateLimits(providerId);
      if (deps.scopeKey() !== scope) return;
      const plan = planExpiringCredit(result, now());
      const offer = result.resetOffer;
      if (plan.action !== 'spend-now' || !offer) {
        schedule(providerId, result);
        return;
      }
      if (!deps.isEnabled(providerId)) {
        cancel(providerId);
        return;
      }
      const consumed = await deps.consumeReset(providerId, offer.idempotencyKey);
      if (deps.scopeKey() !== scope) return;
      if (consumed.outcome === 'reset') {
        deps.log.info('codex reset about to expire used', {
          providerId,
          expiresAt: plan.expiresAtMs,
        });
        reportAutoUsed(providerId, { atMs: now(), kind: 'expiring' });
      } else {
        deps.log.info('codex reset about to expire not used', {
          providerId,
          outcome: consumed.outcome,
        });
      }
      // 用掉之后排下一张；读回失败就等下一次读额度。
      if (consumed.rateLimits) schedule(providerId, consumed.rateLimits);
      else cancel(providerId);
    } catch (error) {
      // 不确定扣没扣：重置服务会冻结这次的幂等键，下一次读额度时再按结果重排。
      cancel(providerId);
      deps.log.warn('codex reset about to expire failed', {
        providerId,
        error: errorMessage(error),
      });
    } finally {
      expiringInflight.delete(providerId);
    }
  };

  function schedule(providerId: string, result: MobileCodexRateLimitsResult): void {
    const scope = dropOtherScopes();
    cancel(providerId);
    if (!deps.isEnabled(providerId)) return;
    const plan = planExpiringCredit(result, now());
    if (plan.action === 'none') return;
    const entry: ExpiringEntry = { scope, result, timer: null };
    expiring.set(providerId, entry);
    const delay = plan.action === 'spend-now' ? 0 : Math.min(plan.atMs - now(), MAX_TIMER_DELAY_MS);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (expiring.get(providerId) !== entry) return;
      if (plan.action === 'at' && now() < plan.atMs) {
        // 超长定时分段到点，或时钟回拨：按记下的读数重排。
        schedule(providerId, entry.result);
        return;
      }
      void spendExpiring(providerId, scope);
    }, delay);
    entry.timer.unref?.();
  }

  const resolve = async (
    providerId: string,
    modelId: string | null,
    scope: string,
    onSpending: () => void,
  ): Promise<UsageLimitResolution> => {
    if (!deps.isEnabled(providerId)) return { kind: 'skipped', why: 'disabled' };
    try {
      const result = await deps.readRateLimits(providerId);
      if (deps.scopeKey() !== scope) return { kind: 'failed', error: 'Cindy account scope changed' };
      schedule(providerId, result);
      const readAt = now();
      const windows = quotaWindows(quotaBucketFor(result, modelId, readAt));
      if (!quotaHeldUp(windows).stopped) return { kind: 'restored' };
      if (!weeklyQuotaUsedUp(windows, readAt)) return { kind: 'skipped', why: 'short-window' };
      const offer = result.resetOffer;
      const available = Math.floor(result.rateLimitResetCredits?.availableCount ?? 0);
      if (!offer || available <= 0) return { kind: 'skipped', why: 'no-credit' };
      // 读额度期间关掉了开关：不扣。
      if (!deps.isEnabled(providerId)) return { kind: 'skipped', why: 'disabled' };
      onSpending();
      const consumed = await deps.consumeReset(providerId, offer.idempotencyKey);
      if (consumed.rateLimits && deps.scopeKey() === scope) schedule(providerId, consumed.rateLimits);
      switch (consumed.outcome) {
        case 'reset':
          deps.log.info('codex reset used for usage limit', { providerId });
          reportAutoUsed(providerId, { atMs: now(), kind: 'usage-limit' });
          return { kind: 'reset' };
        case 'nothingToReset':
          // 后端说没有可重置的窗口：账号已经不卡了。
          return { kind: 'restored' };
        case 'noCredit':
          return { kind: 'skipped', why: 'no-credit' };
        default:
          deps.log.info('codex reset not used for usage limit', {
            providerId,
            outcome: consumed.outcome,
          });
          return { kind: 'failed', outcome: consumed.outcome };
      }
    } catch (error) {
      deps.log.warn('codex reset for usage limit failed', {
        providerId,
        error: errorMessage(error),
      });
      return { kind: 'failed', error: errorMessage(error) };
    }
  };

  const service: CodexResetCreditAutoUse = {
    mayUseForUsageLimit(providerId) {
      return deps.isEnabled(providerId);
    },

    resolveUsageLimit(providerId, modelId, onSpending) {
      const scope = dropOtherScopes();
      // 同一账号、同一限额桶的多个任务同时撞上：共用进行中的那一次，不各用一张。
      const key = `${providerId}\u0000${modelId ?? ''}`;
      const inflight = usageLimitInflight.get(key);
      if (inflight) {
        if (onSpending) inflight.onSpending.push(onSpending);
        return inflight.promise;
      }
      const listeners = onSpending ? [onSpending] : [];
      const promise = resolve(providerId, modelId, scope, () => {
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            deps.log.warn('codex reset spending listener failed', { error: errorMessage(error) });
          }
        }
      }).finally(() => {
        if (usageLimitInflight.get(key)?.promise === promise) usageLimitInflight.delete(key);
      });
      usageLimitInflight.set(key, { scope, promise, onSpending: listeners });
      return promise;
    },

    noteRateLimits(providerId, result) {
      schedule(providerId, result);
    },

    noteSettingChanged(providerId) {
      cancel(providerId);
      if (!deps.isEnabled(providerId)) return;
      void deps
        .readRateLimits(providerId)
        .then((result) => schedule(providerId, result))
        .catch((error) => {
          deps.log.warn('codex reset auto-use read failed', { providerId, error: errorMessage(error) });
        });
    },

    reschedule() {
      for (const [providerId, entry] of [...expiring]) schedule(providerId, entry.result);
    },

    start() {
      if (startupTimer) return;
      startupTimer = setTimeout(() => {
        startupTimer = null;
        for (const providerId of deps.enabledProviderIds()) service.noteSettingChanged(providerId);
      }, STARTUP_READ_DELAY_MS);
      startupTimer.unref?.();
    },

    stop() {
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = null;
      for (const providerId of [...expiring.keys()]) cancel(providerId);
    },
  };
  return service;
}
