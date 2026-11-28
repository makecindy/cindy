/**
 * claudeSubscriptionUsageRefresh — Claude 订阅余量的 cached-first reader(纯逻辑,依赖注入)。
 *
 * 数据由内置 CLI 的 `get_usage` 控制请求提供(CLI 用自己的登录查询,Cindy 不接触凭证),
 * 每次都要拉起一个 CLI 进程,所以:
 *   - IPC 读立即返回缓存快照,后台按节流刷新(recordSnapshot 内部广播给 renderer);
 *   - 节流默认 180s,turn 内的实时性由会话里的 SDK rate_limit_event 增量兜住;
 *   - 失败(CLI 未就绪 / 超时 / 请求报错)指数退避,5min 起 ×2 封顶 30min。
 *
 * 身份维度是 CLI 登录账号的指纹(邮箱派生,不含邮箱原文);指纹变化即换号,节流 / 退避
 * 重新计,持久化快照按指纹校验归属。
 */

import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage.js';
import {
  ADAPTIVE_QUOTA_TIERS,
  MANUAL_QUOTA_REFRESH_COOLDOWN_MS,
  epochSecondsToMs,
  nextExponentialBackoffMs,
  shouldAllowManualQuotaRefresh,
  shouldRefreshAdaptiveQuota,
  type AdaptiveQuotaRefreshTiming,
} from './adaptiveQuotaRefresh.js';

interface ClaudeSubscriptionUsageRefreshDeps {
  /** 当前已连接的 Claude 订阅账号指纹;未连接 → null。账号已连接但指纹未知时返回空串。 */
  readAccount(): string | null;
  /**
   * 拉一次快照。snapshot = 正常;'empty' = CLI **明确**声明账号没有套餐余量(清缓存降级为
   * 无数据)。失败或返回形状无法识别时抛错:退避重试并保留缓存(含会话 rate_limit_event
   * 写入的余量),不把「看不懂」当成「没有」。
   */
  fetchSnapshot(): Promise<ClaudeSubscriptionUsageSnapshot | 'empty'>;
  recordSnapshot(snapshot: ClaudeSubscriptionUsageSnapshot): Promise<void>;
  clearSnapshot(): Promise<void>;
  readCachedSnapshot(): Promise<ClaudeSubscriptionUsageSnapshot | null>;
  now(): number;
  onRefreshError(err: unknown): void;
}

interface ClaudeSubscriptionUsageRefreshOptions {
  throttleMs?: number;
  idleThrottleMs?: number;
  resetMinIntervalMs?: number;
  failureBackoffInitialMs?: number;
  failureBackoffMaxMs?: number;
}

function claudeResetTimesMs(snapshot: ClaudeSubscriptionUsageSnapshot | null | undefined): number[] {
  if (!snapshot) return [];
  const out: number[] = [];
  const fiveHour = epochSecondsToMs(snapshot.fiveHour?.resetsAt);
  const sevenDay = epochSecondsToMs(snapshot.sevenDay?.resetsAt);
  if (fiveHour !== null) out.push(fiveHour);
  if (sevenDay !== null) out.push(sevenDay);
  for (const item of snapshot.scoped ?? []) {
    const resetAt = epochSecondsToMs(item.resetsAt);
    if (resetAt !== null) out.push(resetAt);
  }
  return out;
}

function resolveTiming(options: ClaudeSubscriptionUsageRefreshOptions): AdaptiveQuotaRefreshTiming {
  const tier = ADAPTIVE_QUOTA_TIERS.claudeCli;
  if (options.throttleMs !== undefined) {
    return {
      activeThrottleMs: options.throttleMs,
      idleThrottleMs: options.idleThrottleMs ?? options.throttleMs,
      resetMinIntervalMs: options.resetMinIntervalMs ?? options.throttleMs,
      failureBackoffInitialMs: options.failureBackoffInitialMs ?? tier.failureBackoffInitialMs,
      failureBackoffMaxMs: options.failureBackoffMaxMs ?? tier.failureBackoffMaxMs,
    };
  }
  return {
    activeThrottleMs: tier.activeThrottleMs,
    idleThrottleMs: options.idleThrottleMs ?? tier.idleThrottleMs,
    resetMinIntervalMs: options.resetMinIntervalMs ?? tier.resetMinIntervalMs,
    failureBackoffInitialMs: options.failureBackoffInitialMs ?? tier.failureBackoffInitialMs,
    failureBackoffMaxMs: options.failureBackoffMaxMs ?? tier.failureBackoffMaxMs,
  };
}

export interface ClaudeSubscriptionUsageReader {
  /** cached-first 读(IPC handler 用):立即返回缓存快照,后台按活跃度自适应节流刷新。 */
  read(options?: { fresh?: boolean }): Promise<ClaudeSubscriptionUsageSnapshot | null>;
  /** 显式触发一次后台刷新(turn-done / 面板轮询 / 手动刷新钩子用),同样吃节流 / 退避。 */
  triggerRefresh(options?: { activity?: boolean; manual?: boolean }): void;
  /** 记录一次真实对话活动(例如 SDK rate_limit_event),让后续刷新走活跃档节流。 */
  markActivity(): void;
  /**
   * 登录态变化(CLI 登录 / 登出 / 换号 / Cindy 断开)后的强制同步。未连接时**无条件**清
   * 持久化快照并广播(本进程可能从未观察过登录,磁盘上仍可能残留上一周期的快照)。
   */
  syncForCredentialChange(): Promise<void>;
}

export function createClaudeSubscriptionUsageReader(
  deps: ClaudeSubscriptionUsageRefreshDeps,
  options: ClaudeSubscriptionUsageRefreshOptions = {},
): ClaudeSubscriptionUsageReader {
  const timing = resolveTiming(options);
  const manualCooldownMs = Math.min(MANUAL_QUOTA_REFRESH_COOLDOWN_MS, timing.activeThrottleMs);

  let inFlight: Promise<void> | null = null;
  let inFlightAccount: string | null = null;
  // 节流 / 退避状态按账号记 —— 换号立即重新计。
  let stateAccount: string | null = null;
  let lastRefreshAt = 0;
  let lastAttemptAt = 0;
  let activitySeq = 0;
  let refreshedActivitySeq = 0;
  let lastKnownResetsAtMs: number[] = [];
  let backoffMs = 0;
  let backoffUntil = 0;

  function resetStateForAccount(account: string): void {
    if (stateAccount === account) return;
    stateAccount = account;
    lastRefreshAt = 0;
    lastAttemptAt = 0;
    activitySeq = 0;
    refreshedActivitySeq = 0;
    lastKnownResetsAtMs = [];
    backoffMs = 0;
    backoffUntil = 0;
  }

  function readAccountSafe(): string | null {
    try {
      return deps.readAccount();
    } catch (err) {
      deps.onRefreshError(err);
      return null;
    }
  }

  async function clearSnapshotSafe(): Promise<void> {
    try {
      await deps.clearSnapshot();
    } catch (err) {
      deps.onRefreshError(err);
    }
  }

  /** 缓存快照属于别的账号(同机在 CLI 里换号)。指纹缺失按未知归属沿用,不误清。 */
  function belongsToOtherAccount(
    snapshot: ClaudeSubscriptionUsageSnapshot | null,
    account: string,
  ): boolean {
    return Boolean(
      snapshot?.accountFingerprint && account && snapshot.accountFingerprint !== account,
    );
  }

  function refreshFor(
    account: string,
    opts: { treatAsActive?: boolean; manual?: boolean; resetsAtMs?: number[] } = {},
  ): Promise<void> {
    if (inFlight) {
      // 飞行中的请求属于另一个账号:旧结果会被丢弃,收尾后按当时的账号补一次。
      if (inFlightAccount !== account) {
        return inFlight.then(() => {
          const current = readAccountSafe();
          if (current !== null) return refreshFor(current, opts);
        });
      }
      return inFlight;
    }

    resetStateForAccount(account);
    const now = deps.now();
    const resetsAtMs = opts.resetsAtMs && opts.resetsAtMs.length > 0 ? opts.resetsAtMs : lastKnownResetsAtMs;
    const allowed = opts.manual
      ? shouldAllowManualQuotaRefresh({ now, lastAttemptAt, cooldownMs: manualCooldownMs })
      : shouldRefreshAdaptiveQuota({
          now,
          lastRefreshAt,
          hasActivitySinceRefresh: activitySeq > refreshedActivitySeq,
          resetsAtMs,
          backoffUntil,
          timing,
          treatAsActive: opts.treatAsActive,
        });
    if (!allowed) {
      return Promise.resolve();
    }

    const attemptSeq = activitySeq;
    const prevLastRefreshAt = lastRefreshAt;
    lastRefreshAt = now;
    lastAttemptAt = now;
    inFlightAccount = account;
    inFlight = (async () => {
      try {
        const result = await deps.fetchSnapshot();
        backoffMs = 0;
        backoffUntil = 0;
        if (readAccountSafe() !== account) return;
        refreshedActivitySeq = Math.max(refreshedActivitySeq, attemptSeq);
        if (result === 'empty') {
          lastKnownResetsAtMs = [];
          await deps.clearSnapshot();
          return;
        }
        lastKnownResetsAtMs = claudeResetTimesMs(result);
        await deps.recordSnapshot({
          ...result,
          ...(account ? { accountFingerprint: account } : {}),
        });
      } catch (err) {
        backoffMs = nextExponentialBackoffMs(backoffMs, timing);
        backoffUntil = deps.now() + backoffMs;
        if (backoffMs > 0) lastRefreshAt = prevLastRefreshAt;
        deps.onRefreshError(err);
      } finally {
        inFlight = null;
        inFlightAccount = null;
      }
    })();
    return inFlight;
  }

  return {
    async read(options): Promise<ClaudeSubscriptionUsageSnapshot | null> {
      const account = readAccountSafe();
      if (account === null) return null;
      const cached = await deps.readCachedSnapshot();
      // 读缓存期间换号:按旧账号做的归属判断已失效,既不返回(可能是旧账号的余量)也不清理
      // (新账号的快照可能刚写入)。新账号的余量随登录态同步 / 刷新广播。
      if (readAccountSafe() !== account) return null;
      const otherAccount = belongsToOtherAccount(cached, account);
      if (otherAccount) {
        await clearSnapshotSafe();
      }
      if (readAccountSafe() !== account) return null;
      const resetsAtMs = otherAccount ? [] : claudeResetTimesMs(cached);
      if (options?.fresh) {
        await refreshFor(account, { treatAsActive: true, resetsAtMs });
        const refreshed = await deps.readCachedSnapshot();
        return readAccountSafe() === account && !belongsToOtherAccount(refreshed, account) ? refreshed : null;
      }
      void refreshFor(account, { resetsAtMs });
      return otherAccount ? null : cached;
    },

    triggerRefresh(opts): void {
      const manual = opts?.manual === true;
      if (!manual && opts?.activity !== false) {
        activitySeq += 1;
      }
      // 节流 / 退避预检在读账号之前:本方法被每个 Claude turn-done 无条件调用。
      const now = deps.now();
      if (inFlight) return;
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
      const account = readAccountSafe();
      if (account !== null) void refreshFor(account, manual ? { manual: true } : undefined);
    },

    markActivity(): void {
      activitySeq += 1;
    },

    async syncForCredentialChange(): Promise<void> {
      const account = readAccountSafe();
      if (account === null) {
        stateAccount = null;
        lastRefreshAt = 0;
        lastAttemptAt = 0;
        activitySeq = 0;
        refreshedActivitySeq = 0;
        lastKnownResetsAtMs = [];
        backoffMs = 0;
        backoffUntil = 0;
        await clearSnapshotSafe();
        return;
      }
      const cached = await deps.readCachedSnapshot();
      // 同 read():期间又换号时交给新账号那次同步处理,本次不清理、不刷新。
      if (readAccountSafe() !== account) return;
      if (belongsToOtherAccount(cached, account)) await clearSnapshotSafe();
      void refreshFor(account);
    },
  };
}
