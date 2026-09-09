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

export interface XaiSubscriptionCredentialInfo {
  accessToken: string;
}

interface XaiSubscriptionUsageRefreshDeps {
  readCredentials(): Promise<XaiSubscriptionCredentialInfo | null>;
  fetchSnapshot(
    args: XaiSubscriptionCredentialInfo,
  ): Promise<XaiSubscriptionUsageSnapshot | 'empty' | null>;
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
  rateLimitBackoffInitialMs?: number;
  rateLimitBackoffMaxMs?: number;
}

const DEFAULT_THROTTLE_MS = 60_000;
const DEFAULT_BACKOFF_INITIAL_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MAX_MS = 30 * 60_000;

export interface XaiSubscriptionUsageReader {
  read(): Promise<XaiSubscriptionUsageSnapshot | null>;
  triggerRefresh(): void;
  syncForCredentialChange(): Promise<void>;
}

export function createXaiSubscriptionUsageReader(
  deps: XaiSubscriptionUsageRefreshDeps,
  options: XaiSubscriptionUsageRefreshOptions = {},
): XaiSubscriptionUsageReader {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const backoffInitialMs = options.rateLimitBackoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
  const backoffMaxMs = options.rateLimitBackoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;

  let inFlight: Promise<void> | null = null;
  let inFlightToken: string | null = null;
  let inFlightGeneration = 0;
  // 只记「需要再跑一次」,不存 token。排空时重读当前凭证,迟到的旧 token 盖不掉新号。
  let queuedReplay = false;
  let lastRefreshAt = 0;
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
      backoffMs = 0;
      backoffUntil = 0;
    }
    try {
      await deps.clearSnapshot();
    } catch (err) {
      deps.onRefreshError(err);
    }
  }

  function markAttemptSettled(): void {
    lastRefreshAt = deps.now();
  }

  async function runRefresh(
    credentials: XaiSubscriptionCredentialInfo,
    generation: number,
  ): Promise<void> {
    try {
      const result = await deps.fetchSnapshot(credentials);
      if (generation !== refreshGeneration) return;
      const stillCurrent = await readCredentialsSafe();
      if (!stillCurrent || stillCurrent.accessToken !== credentials.accessToken) return;
      if (result === 'empty') {
        await deps.clearSnapshot();
        markAttemptSettled();
        backoffMs = 0;
        backoffUntil = 0;
        return;
      }
      if (!result) {
        markAttemptSettled();
        return;
      }
      await deps.recordSnapshot(result);
      markAttemptSettled();
      backoffMs = 0;
      backoffUntil = 0;
    } catch (err) {
      if (generation !== refreshGeneration) return;
      if (deps.isUnauthorizedError(err)) {
        await clearCachedSnapshot({ resetThrottle: false });
        lastRefreshAt = deps.now();
        return;
      }
      if (deps.isRateLimitedError(err)) {
        markAttemptSettled();
        backoffMs = backoffMs > 0
          ? Math.min(backoffMs * 2, backoffMaxMs)
          : backoffInitialMs;
        backoffUntil = deps.now() + backoffMs;
        deps.onRefreshError(err);
        return;
      }
      markAttemptSettled();
      deps.onRefreshError(err);
    }
  }

  function startRefresh(
    credentials: XaiSubscriptionCredentialInfo,
    opts?: { bypassThrottle?: boolean },
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
    if (!opts?.bypassThrottle) {
      if (now < backoffUntil) return;
      if (lastRefreshAt > 0 && now - lastRefreshAt < throttleMs) return;
    }
    const generation = refreshGeneration;
    const startedToken = credentials.accessToken;
    inFlightToken = startedToken;
    inFlightGeneration = generation;
    const pending = runRefresh(credentials, generation).finally(() => {
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
        noCredentialsUntil = deps.now() + throttleMs;
        if (hadCredentials) {
          hadCredentials = false;
          await clearCachedSnapshot({ resetThrottle: true });
        }
        return null;
      }
      noCredentialsUntil = 0;
      hadCredentials = true;
      const cached = await deps.readCachedSnapshot();
      startRefresh(credentials);
      return cached;
    },

    triggerRefresh(): void {
      const now = deps.now();
      if (inFlight) return;
      if (now < backoffUntil) return;
      if (now < noCredentialsUntil) return;
      if (lastRefreshAt > 0 && now - lastRefreshAt < throttleMs) return;
      void (async () => {
        const credentials = await readCredentialsSafe();
        if (!credentials) {
          noCredentialsUntil = deps.now() + throttleMs;
          return;
        }
        noCredentialsUntil = 0;
        hadCredentials = true;
        startRefresh(credentials);
      })();
    },

    async syncForCredentialChange(): Promise<void> {
      // 先清再读凭证:凭证读取稍慢时,并发 read() 不能再把旧快照交出去。
      hadCredentials = false;
      await clearCachedSnapshot({ resetThrottle: true });
      const credentials = await readCredentialsSafe();
      if (!credentials) {
        noCredentialsUntil = deps.now() + throttleMs;
        return;
      }
      noCredentialsUntil = 0;
      hadCredentials = true;
      startRefresh(credentials, { bypassThrottle: true });
    },
  };
}
