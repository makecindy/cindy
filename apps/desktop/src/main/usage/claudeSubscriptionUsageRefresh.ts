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
  failureBackoffInitialMs?: number;
  failureBackoffMaxMs?: number;
}

const DEFAULT_THROTTLE_MS = 180_000;
const DEFAULT_BACKOFF_INITIAL_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MAX_MS = 30 * 60_000;

export interface ClaudeSubscriptionUsageReader {
  /** cached-first 读(IPC handler 用):立即返回缓存快照,后台按节流刷新。 */
  read(): Promise<ClaudeSubscriptionUsageSnapshot | null>;
  /** 显式触发一次后台刷新(turn-done 钩子用),同样吃节流 / 退避。 */
  triggerRefresh(): void;
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
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const backoffInitialMs = options.failureBackoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
  const backoffMaxMs = options.failureBackoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;

  let inFlight: Promise<void> | null = null;
  let inFlightAccount: string | null = null;
  // 节流 / 退避状态按账号记 —— 换号立即重新计。
  let stateAccount: string | null = null;
  let lastRefreshAt = 0;
  let backoffMs = 0;
  let backoffUntil = 0;

  function resetStateForAccount(account: string): void {
    if (stateAccount === account) return;
    stateAccount = account;
    lastRefreshAt = 0;
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

  function refreshFor(account: string): Promise<void> {
    if (inFlight) {
      // 飞行中的请求属于另一个账号:旧结果会被丢弃,收尾后按当时的账号补一次。
      if (inFlightAccount !== account) {
        return inFlight.finally(() => {
          const current = readAccountSafe();
          if (current !== null) void refreshFor(current);
        });
      }
      return inFlight;
    }

    resetStateForAccount(account);
    const now = deps.now();
    if (now < backoffUntil) return Promise.resolve();
    if (lastRefreshAt > 0 && now - lastRefreshAt < throttleMs) return Promise.resolve();

    lastRefreshAt = now;
    inFlightAccount = account;
    inFlight = (async () => {
      try {
        const result = await deps.fetchSnapshot();
        backoffMs = 0;
        backoffUntil = 0;
        if (readAccountSafe() !== account) return;
        if (result === 'empty') {
          await deps.clearSnapshot();
          return;
        }
        await deps.recordSnapshot({
          ...result,
          ...(account ? { accountFingerprint: account } : {}),
        });
      } catch (err) {
        backoffMs = backoffMs > 0 ? Math.min(backoffMs * 2, backoffMaxMs) : backoffInitialMs;
        backoffUntil = deps.now() + backoffMs;
        deps.onRefreshError(err);
      } finally {
        inFlight = null;
        inFlightAccount = null;
      }
    })();
    return inFlight;
  }

  return {
    async read(): Promise<ClaudeSubscriptionUsageSnapshot | null> {
      const account = readAccountSafe();
      if (account === null) return null;
      const cached = await deps.readCachedSnapshot();
      // 读缓存期间换号:按旧账号做的归属判断已失效,既不返回(可能是旧账号的余量)也不清理
      // (新账号的快照可能刚写入)。新账号的余量随登录态同步 / 刷新广播。
      if (readAccountSafe() !== account) return null;
      if (belongsToOtherAccount(cached, account)) {
        await clearSnapshotSafe();
        void refreshFor(account);
        return null;
      }
      void refreshFor(account);
      return cached;
    },

    triggerRefresh(): void {
      // 节流 / 退避预检在读账号之前:本方法被每个 Claude turn-done 无条件调用。
      const now = deps.now();
      if (inFlight) return;
      if (now < backoffUntil) return;
      if (lastRefreshAt > 0 && now - lastRefreshAt < throttleMs) return;
      const account = readAccountSafe();
      if (account !== null) void refreshFor(account);
    },

    async syncForCredentialChange(): Promise<void> {
      const account = readAccountSafe();
      if (account === null) {
        stateAccount = null;
        lastRefreshAt = 0;
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
