/**
 * xaiSubscriptionUsageRefresh — SuperGrok 周用量 cached-first reader。
 *
 * 单源全量替换。登录 / 登出 / 换号走 syncForCredentialChange:**先清快照再读新凭证**,
 * 避免凭证读取期间并发 read() 把旧账号周用量交出去。
 *
 * 同 token 的并发 refresh 复用 in-flight,不排队加打;只有换了凭证才排队。
 * 节流默认 60s。429 指数退避。401/403 只清配额快照并进入冷却,不断开登录。
 */

import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage.js';
import {
  ADAPTIVE_QUOTA_TIERS,
  MANUAL_QUOTA_REFRESH_COOLDOWN_MS,
  epochSecondsToMs,
  nextExponentialBackoffMs,
  shouldAllowManualQuotaRefresh,
  shouldRefreshAdaptiveQuota,
  type AdaptiveQuotaRefreshTiming,
} from './adaptiveQuotaRefresh.js';

export interface XaiSubscriptionCredentialInfo {
  accessToken: string;
}

interface XaiSubscriptionUsageRefreshDeps {
  readCredentials(): Promise<XaiSubscriptionCredentialInfo | null>;
  fetchSnapshot(
    args: XaiSubscriptionCredentialInfo,
  ): Promise<XaiSubscriptionUsageSnapshot | 'empty' | null>;
  captureBillingRecovery?(): (() => void) | undefined;
  recordSnapshot(snapshot: XaiSubscriptionUsageSnapshot): Promise<void>;
  clearSnapshot(): Promise<void>;
  readCachedSnapshot(): Promise<XaiSubscriptionUsageSnapshot | null>;
  now(): number;
  isUnauthorizedError(err: unknown): boolean;
  isRateLimitedError(err: unknown): boolean;
  onRefreshError(err: unknown): void;
}

interface XaiSubscriptionUsageRefreshOptions {
  throttleMs?: number;
  idleThrottleMs?: number;
  resetMinIntervalMs?: number;
  rateLimitBackoffInitialMs?: number;
  rateLimitBackoffMaxMs?: number;
}

function xaiResetTimesMs(snapshot: XaiSubscriptionUsageSnapshot | null | undefined): number[] {
  const resetAt = epochSecondsToMs(snapshot?.resetsAt);
  return resetAt !== null ? [resetAt] : [];
}

function resolveTiming(options: XaiSubscriptionUsageRefreshOptions): AdaptiveQuotaRefreshTiming {
  const tier = ADAPTIVE_QUOTA_TIERS.xaiSubscription;
  if (options.throttleMs !== undefined) {
    return {
      activeThrottleMs: options.throttleMs,
      idleThrottleMs: options.idleThrottleMs ?? options.throttleMs,
      resetMinIntervalMs: options.resetMinIntervalMs ?? options.throttleMs,
      failureBackoffInitialMs: options.rateLimitBackoffInitialMs ?? tier.failureBackoffInitialMs,
      failureBackoffMaxMs: options.rateLimitBackoffMaxMs ?? tier.failureBackoffMaxMs,
    };
  }
  return {
    activeThrottleMs: tier.activeThrottleMs,
    idleThrottleMs: options.idleThrottleMs ?? tier.idleThrottleMs,
    resetMinIntervalMs: options.resetMinIntervalMs ?? tier.resetMinIntervalMs,
    failureBackoffInitialMs: options.rateLimitBackoffInitialMs ?? tier.failureBackoffInitialMs,
    failureBackoffMaxMs: options.rateLimitBackoffMaxMs ?? tier.failureBackoffMaxMs,
  };
}

export interface XaiSubscriptionUsageReader {
  read(): Promise<XaiSubscriptionUsageSnapshot | null>;
  triggerRefresh(options?: { activity?: boolean; manual?: boolean }): void;
  syncForCredentialChange(): Promise<void>;
}

export function createXaiSubscriptionUsageReader(
  deps: XaiSubscriptionUsageRefreshDeps,
  options: XaiSubscriptionUsageRefreshOptions = {},
): XaiSubscriptionUsageReader {
  const timing = resolveTiming(options);
  const manualCooldownMs = Math.min(MANUAL_QUOTA_REFRESH_COOLDOWN_MS, timing.activeThrottleMs);

  let inFlight: Promise<void> | null = null;
  let inFlightToken: string | null = null;
  let inFlightGeneration = 0;
  // 只记「需要再跑一次」,不存 token。排空时重读当前凭证,迟到的旧 token 盖不掉新号。
  let queuedReplay = false;
  let lastRefreshAt = 0;
  let lastAttemptAt = 0;
  let activitySeq = 0;
  let refreshedActivitySeq = 0;
  let lastKnownResetsAtMs: number[] = [];
  let backoffMs = 0;
  let backoffUntil = 0;
  let hadCredentials = false;
  let noCredentialsUntil = 0;
  let refreshGeneration = 0;

  async function readCredentialsSafe(): Promise<XaiSubscriptionCredentialInfo | null> {
    try {
      return await deps.readCredentials();
    } catch (err) {
      deps.onRefreshError(err);
      return null;
    }
  }

  async function clearCachedSnapshot(opts: { resetThrottle: boolean }): Promise<void> {
    refreshGeneration += 1;
    queuedReplay = false;
    if (opts.resetThrottle) {
      lastRefreshAt = 0;
      lastAttemptAt = 0;
      activitySeq = 0;
      refreshedActivitySeq = 0;
      lastKnownResetsAtMs = [];
      backoffMs = 0;
      backoffUntil = 0;
    }
    try {
      await deps.clearSnapshot();
    } catch (err) {
      deps.onRefreshError(err);
    }
  }

  function markSuccessSettled(): void {
    const now = deps.now();
    lastRefreshAt = now;
    lastAttemptAt = now;
    backoffMs = 0;
    backoffUntil = 0;
  }

  function enterFailureBackoff(): void {
    const now = deps.now();
    lastAttemptAt = now;
    backoffMs = nextExponentialBackoffMs(backoffMs, timing);
    backoffUntil = now + backoffMs;
    if (backoffMs === 0) lastRefreshAt = now;
  }

  async function runRefresh(
    credentials: XaiSubscriptionCredentialInfo,
    generation: number,
    attemptSeq: number,
  ): Promise<void> {
    try {
      const recoverBilling = deps.captureBillingRecovery?.();
      const previous = recoverBilling ? await deps.readCachedSnapshot().catch(() => null) : null;
      const result = await deps.fetchSnapshot(credentials);
      if (generation !== refreshGeneration) return;
      const stillCurrent = await readCredentialsSafe();
      if (!stillCurrent || stillCurrent.accessToken !== credentials.accessToken) return;
      if (result === 'empty') {
        await deps.clearSnapshot();
        markSuccessSettled();
        refreshedActivitySeq = Math.max(refreshedActivitySeq, attemptSeq);
        lastKnownResetsAtMs = [];
        return;
      }
      if (!result) {
        enterFailureBackoff();
        return;
      }
      // Require a change in the authority's billing response for the same subject.
      // Unchanged positive balance, catalog visibility and cached quota alone cannot clear a rejection.
      if (recoverBilling && result.accountFingerprint && previous?.accountFingerprint === result.accountFingerprint &&
          previous.updatedAt != null && result.updatedAt != null && previous.updatedAt < result.updatedAt) {
        const toppedUp = previous.prepaidBalance != null && previous.prepaidBalance <= 0 && (result.prepaidBalance ?? 0) > 0;
        const subscribed = previous.planLabel?.trim().toLowerCase() === 'free' &&
          /^supergrok(?: heavy)?$/i.test(result.planLabel?.trim() ?? '');
        if (toppedUp || subscribed) recoverBilling();
      }
      await deps.recordSnapshot(result);
      markSuccessSettled();
      refreshedActivitySeq = Math.max(refreshedActivitySeq, attemptSeq);
      lastKnownResetsAtMs = xaiResetTimesMs(result);
    } catch (err) {
      if (generation !== refreshGeneration) return;
      if (deps.isUnauthorizedError(err)) {
        await clearCachedSnapshot({ resetThrottle: false });
        const now = deps.now();
        lastRefreshAt = now;
        lastAttemptAt = now;
        backoffMs = 0;
        backoffUntil = 0;
        refreshedActivitySeq = Math.max(refreshedActivitySeq, attemptSeq);
        lastKnownResetsAtMs = [];
        return;
      }
      if (deps.isRateLimitedError(err)) {
        enterFailureBackoff();
        deps.onRefreshError(err);
        return;
      }
      enterFailureBackoff();
      deps.onRefreshError(err);
    }
  }

  function startRefresh(
    credentials: XaiSubscriptionCredentialInfo,
    opts?: { bypassThrottle?: boolean; manual?: boolean; resetsAtMs?: number[] },
  ): void {
    const now = deps.now();
    if (inFlight) {
      // 同凭证且仍是同一世代:复用在途请求。clear 已经提升 generation,
      // 或后来的调用带了别的 token 时,只记「要再跑」,排空时重读当前凭证。
      if (inFlightToken === credentials.accessToken && inFlightGeneration === refreshGeneration) {
        return;
      }
      queuedReplay = true;
      return;
    }
    const resetsAtMs = opts?.resetsAtMs && opts.resetsAtMs.length > 0 ? opts.resetsAtMs : lastKnownResetsAtMs;
    const allowed = opts?.bypassThrottle
      ? true
      : opts?.manual
        ? shouldAllowManualQuotaRefresh({ now, lastAttemptAt, cooldownMs: manualCooldownMs })
        : shouldRefreshAdaptiveQuota({
            now,
            lastRefreshAt,
            hasActivitySinceRefresh: activitySeq > refreshedActivitySeq,
            resetsAtMs,
            backoffUntil,
            timing,
          });
    if (!allowed) {
      return;
    }
    lastAttemptAt = now;
    const attemptSeq = activitySeq;
    const generation = refreshGeneration;
    const startedToken = credentials.accessToken;
    inFlightToken = startedToken;
    inFlightGeneration = generation;
    const pending = runRefresh(credentials, generation, attemptSeq).finally(() => {
      if (inFlight === pending) {
        inFlight = null;
        inFlightToken = null;
        inFlightGeneration = 0;
      }
      const shouldReplay = queuedReplay;
      queuedReplay = false;
      if (!shouldReplay) return;
      void (async () => {
        const latest = await readCredentialsSafe();
        if (!latest) return;
        if (latest.accessToken === startedToken && refreshGeneration === generation) return;
        startRefresh(latest, { bypassThrottle: true });
      })();
    });
    inFlight = pending;
  }

  return {
    async read(): Promise<XaiSubscriptionUsageSnapshot | null> {
      const credentials = await readCredentialsSafe();
      if (!credentials) {
        noCredentialsUntil = deps.now() + timing.activeThrottleMs;
        if (hadCredentials) {
          hadCredentials = false;
          await clearCachedSnapshot({ resetThrottle: true });
        }
        return null;
      }
      noCredentialsUntil = 0;
      hadCredentials = true;
      const cached = await deps.readCachedSnapshot();
      startRefresh(credentials, { resetsAtMs: xaiResetTimesMs(cached) });
      return cached;
    },

    triggerRefresh(opts): void {
      const manual = opts?.manual === true;
      if (!manual && opts?.activity !== false) {
        activitySeq += 1;
      }
      const now = deps.now();
      if (inFlight) return;
      if (!manual && now < noCredentialsUntil) return;
      const allowed = manual
        ? shouldAllowManualQuotaRefresh({ now, lastAttemptAt, cooldownMs: manualCooldownMs })
        : shouldRefreshAdaptiveQuota({
            now,
            lastRefreshAt,
            hasActivitySinceRefresh: activitySeq > refreshedActivitySeq,
            resetsAtMs: lastKnownResetsAtMs,
            backoffUntil,
            timing,
          });
      if (!allowed) return;
      void (async () => {
        const credentials = await readCredentialsSafe();
        if (!credentials) {
          noCredentialsUntil = deps.now() + timing.activeThrottleMs;
          return;
        }
        noCredentialsUntil = 0;
        hadCredentials = true;
        startRefresh(credentials, manual ? { manual: true } : undefined);
      })();
    },

    async syncForCredentialChange(): Promise<void> {
      // 先清再读凭证:凭证读取稍慢时,并发 read() 不能再把旧快照交出去。
      hadCredentials = false;
      await clearCachedSnapshot({ resetThrottle: true });
      const credentials = await readCredentialsSafe();
      if (!credentials) {
        noCredentialsUntil = deps.now() + timing.activeThrottleMs;
        return;
      }
      noCredentialsUntil = 0;
      hadCredentials = true;
      startRefresh(credentials, { bypassThrottle: true });
    },
  };
}
