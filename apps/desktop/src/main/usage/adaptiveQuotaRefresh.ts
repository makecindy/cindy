/**
 * adaptiveQuotaRefresh — 第三方模型与插件引擎的统一活跃度自适应配额刷新策略。
 *
 * 设计原则：
 *   - 区分「活跃期（自上次成功刷新后有真实对话/任务活动）」与「空闲期（无新活动，仅面板/后台轮询）」，
 *     避免后台面板、菜单栏、小组件或远端设备在闲置时高频探测第三方上游接口或拉起外部 CLI。
 *   - 仅在已知配额窗口刚刚跨过 resetsAt 且距上次刷新不短于 resetMinIntervalMs 时允许提前重查一次；
 *     刷新后 lastRefreshAt >= resetsAt，不会因陈旧重置时间死循环。
 *   - 失败采用指数退避（×2 至上限），避免上游故障或限流期间持续打爆。
 *   - Cindy AI 自有余额/企业配额（claudeAccountUsage / Model Access 钱包）不使用本模块，保持每轮后实时刷新。
 */

export interface AdaptiveQuotaRefreshTiming {
  /** 自上次刷新后有真实任务活动时的最小刷新间隔（毫秒）。 */
  activeThrottleMs: number;
  /** 无新活动（空闲/被动轮询）时的最小刷新间隔（毫秒）。 */
  idleThrottleMs: number;
  /** 窗口跨过 resetsAt 后允许提前重查的最小间隔（毫秒）。 */
  resetMinIntervalMs: number;
  /** 首次失败后的退避时长（毫秒）。 */
  failureBackoffInitialMs: number;
  /** 连续失败退避上限（毫秒）。 */
  failureBackoffMaxMs: number;
}

export const ADAPTIVE_QUOTA_TIERS = {
  /** ChatGPT Web (`wham/usage`) 订阅配额。 */
  subscriptionWeb: {
    activeThrottleMs: 5 * 60_000,
    idleThrottleMs: 30 * 60_000,
    resetMinIntervalMs: 5 * 60_000,
    failureBackoffInitialMs: 5 * 60_000,
    failureBackoffMaxMs: 30 * 60_000,
  },
  /**
   * SuperGrok (`xAI`) 周用量。
   * 空闲档严格小于 `XAI_USAGE_STALE_MS`（30 分钟），避免空闲缓存未到刷新点就被 UI 标成 stale。
   */
  xaiSubscription: {
    activeThrottleMs: 3 * 60_000,
    idleThrottleMs: 25 * 60_000,
    resetMinIntervalMs: 3 * 60_000,
    failureBackoffInitialMs: 5 * 60_000,
    failureBackoffMaxMs: 30 * 60_000,
  },
  /** 内置 Claude CLI (`get_usage` 子进程)。 */
  claudeCli: {
    activeThrottleMs: 3 * 60_000,
    idleThrottleMs: 30 * 60_000,
    resetMinIntervalMs: 3 * 60_000,
    failureBackoffInitialMs: 5 * 60_000,
    failureBackoffMaxMs: 30 * 60_000,
  },
  /** 插件提供的 ACP 引擎（如 Antigravity / DSH 等外部 CLI 封装）。 */
  pluginHarness: {
    activeThrottleMs: 5 * 60_000,
    idleThrottleMs: 60 * 60_000,
    resetMinIntervalMs: 5 * 60_000,
    failureBackoffInitialMs: 5 * 60_000,
    failureBackoffMaxMs: 60 * 60_000,
  },
  /** 官方第一方 API 余额/套餐查询（DeepSeek / Kimi / 智谱 / OpenCode Go）。 */
  officialProviderApi: {
    activeThrottleMs: 2 * 60_000,
    idleThrottleMs: 30 * 60_000,
    resetMinIntervalMs: 15_000,
    failureBackoffInitialMs: 5 * 60_000,
    failureBackoffMaxMs: 30 * 60_000,
  },
} as const satisfies Record<string, AdaptiveQuotaRefreshTiming>;

export interface AdaptiveQuotaRefreshInput {
  now: number;
  /** 上次刷新时间戳（毫秒）；0 表示从未刷新。 */
  lastRefreshAt: number;
  /** 自上次成功刷新以来是否观察到真实对话/任务活动。 */
  hasActivitySinceRefresh: boolean;
  /** 已知配额窗口的重置时间戳（毫秒）。 */
  resetsAtMs?: readonly (number | null | undefined)[];
  /** 当前退避截止时间（毫秒）。 */
  backoffUntil?: number;
  /** 生效的节流档位。 */
  timing: Pick<AdaptiveQuotaRefreshTiming, 'activeThrottleMs' | 'idleThrottleMs' | 'resetMinIntervalMs'>;
  /** 强制按活跃档判定（例如限额恢复时的 fresh 读取），仍遵守活跃节流与退避。 */
  treatAsActive?: boolean;
}

const CLOCK_BACKWARD_TOLERANCE_MS = 60_000;
/** 显式手动点击刷新的最小冷却时间（毫秒），防连点打爆上游。 */
export const MANUAL_QUOTA_REFRESH_COOLDOWN_MS = 15_000;

/**
 * 判断显式手动刷新是否放行（绕过空闲/活跃缓存与退避，仅保留短冷却）。
 */
export function shouldAllowManualQuotaRefresh(input: {
  now: number;
  lastAttemptAt: number;
  cooldownMs?: number;
}): boolean {
  const { now, lastAttemptAt } = input;
  const cooldownMs = input.cooldownMs ?? MANUAL_QUOTA_REFRESH_COOLDOWN_MS;
  if (!Number.isFinite(lastAttemptAt) || lastAttemptAt <= 0) return true;
  if (lastAttemptAt > now + CLOCK_BACKWARD_TOLERANCE_MS) return true;
  return now - lastAttemptAt >= cooldownMs;
}

/**
 * 判断当前是否应当发起一次新的配额刷新。
 */
export function shouldRefreshAdaptiveQuota(input: AdaptiveQuotaRefreshInput): boolean {
  const { now, lastRefreshAt, timing } = input;
  if (input.backoffUntil !== undefined && input.backoffUntil > 0) {
    if (input.backoffUntil > now) {
      return false;
    }
    // 失败退避窗口刚到期：放行一次重试，不再受更长的旧成功快照空闲 TTL 阻塞。
    return true;
  }
  if (!Number.isFinite(lastRefreshAt) || lastRefreshAt <= 0) {
    return true;
  }
  // 系统时钟大幅回拨到上次刷新之前：放行一次新查询，避免缓存卡死。
  if (lastRefreshAt > now + CLOCK_BACKWARD_TOLERANCE_MS) {
    return true;
  }
  const age = Math.max(0, now - lastRefreshAt);

  if (input.resetsAtMs && age >= timing.resetMinIntervalMs) {
    for (const resetAt of input.resetsAtMs) {
      if (typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt > lastRefreshAt && resetAt <= now) {
        return true;
      }
    }
  }

  const ttl = input.hasActivitySinceRefresh || input.treatAsActive === true
    ? timing.activeThrottleMs
    : timing.idleThrottleMs;
  return age >= ttl;
}

/** 计算下一次指数退避时长（毫秒）。 */
export function nextExponentialBackoffMs(
  currentBackoffMs: number,
  timing: Pick<AdaptiveQuotaRefreshTiming, 'failureBackoffInitialMs' | 'failureBackoffMaxMs'>,
): number {
  if (timing.failureBackoffInitialMs <= 0 || timing.failureBackoffMaxMs <= 0) return 0;
  return currentBackoffMs > 0
    ? Math.min(currentBackoffMs * 2, timing.failureBackoffMaxMs)
    : Math.min(timing.failureBackoffInitialMs, timing.failureBackoffMaxMs);
}

/** 将 epoch 秒转为 epoch 毫秒；无效或非正值返回 null。 */
export function epochSecondsToMs(seconds: number | null | undefined): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : null;
}
