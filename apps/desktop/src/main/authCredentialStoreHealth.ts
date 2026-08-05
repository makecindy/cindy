/**
 * authCredentialStoreHealth.ts
 * ---------------------------------------------------------------------------
 * 持久凭证库(safeStorage)健康状态机(#1687)。
 *
 * 跟踪的是一种特定的半死状态:refresh token 文件仍在磁盘上,但连续多个刷新周期
 * 都读不出来(钥匙串拒绝 / 加密不可用 / 解密失败)。单次抖动必须保持瞬时语义
 * (authManager 的 transient 分支,不得强踢用户);只有**连续** N 次失败才升级为
 * `unavailable`,让 renderer 显示可操作提示。任何一次成功读取立即复位——
 * 「连续」是这个状态机的全部语义,失败与成功交替时永不升级。
 *
 * 刻意不做的事:
 *  - 不落盘:进程内状态,重启后重新计数(重启本身就是用户可尝试的恢复动作);
 *  - 不主动探测 safeStorage:macOS 上 isEncryptionAvailable() 本身可能触发
 *    钥匙串授权弹窗(见 credentials-and-local-storage.md),只被动消费
 *    authManager 刷新路径上已经发生的读取结果;
 *  - 不区分底层原因:ACL 冲突 / 用户拒绝授权 / 条目损坏对上层处置完全一致
 *    (Issue #1687 的「根因边界」——不把某一种底层触发条件写成唯一原因)。
 *
 * 阈值 × 运行时重试间隔(RUNTIME_REFRESH_RETRY_MS = 60s)≈ 5 分钟持续失败才
 * 升级,与 Issue 期望的「短暂不可用可以重试,持续 T 分钟后必须升级」一致。
 */

export const CREDENTIAL_STORE_UNREADABLE_ESCALATION_THRESHOLD = 5;

export interface CredentialStoreHealth {
  /** 当前是否处于「持久凭证库不可用」升级态。 */
  readonly unavailable: boolean;
  /**
   * 记一次「文件仍在但读不出」的刷新失败。
   * 返回 true 表示本次调用刚好跨过阈值、状态翻转为 unavailable(调用方应广播);
   * 已处于 unavailable 时继续失败不再返回 true,避免重复广播。
   */
  noteReadFailure(): boolean;
  /**
   * 记一次成功的持久凭证读取,连续失败计数清零。
   * 返回 true 表示此前处于 unavailable、状态刚恢复(调用方应广播)。
   */
  noteRecovered(): boolean;
  /** 无条件复位(登出 / 会话过期整体清态时用),不返回翻转信号。 */
  reset(): void;
}

export function createCredentialStoreHealth(
  threshold: number = CREDENTIAL_STORE_UNREADABLE_ESCALATION_THRESHOLD,
): CredentialStoreHealth {
  let consecutiveFailures = 0;
  let unavailable = false;
  return {
    get unavailable(): boolean {
      return unavailable;
    },
    noteReadFailure(): boolean {
      consecutiveFailures += 1;
      if (unavailable || consecutiveFailures < threshold) return false;
      unavailable = true;
      return true;
    },
    noteRecovered(): boolean {
      consecutiveFailures = 0;
      if (!unavailable) return false;
      unavailable = false;
      return true;
    },
    reset(): void {
      consecutiveFailures = 0;
      unavailable = false;
    },
  };
}
