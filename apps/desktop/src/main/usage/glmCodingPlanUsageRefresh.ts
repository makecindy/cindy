/**
 * glmCodingPlanUsageRefresh — GLM Coding Plan 余量的 cached-first reader(纯逻辑,依赖注入)。
 *
 * 形态对齐 claudeSubscriptionUsageRefresh;差异:
 *   - 身份维度是 (providerId, API key 指纹)——GLM Coding Plan 是用户自定义 provider,
 *     同一账号可配多个实例、不同实例可能不同 key,快照按 provider 隔离、换 key 即过期
 *     (不是 Claude 的全局单账号 OAuth)。
 *   - 单一数据源(monitor 端点),无 headers 旁路,无 merge 语义。
 *   - provider 配置 / key 变化走 syncForProviderChange(providerHandlers 的 CRUD 钩子调用):
 *     删除或失去 usage 能力 → 无条件清快照;换 key → 指纹失配清快照 + 立即刷新。
 */

import type { GlmCodingPlanUsageSnapshot } from '../../shared/glmCodingPlanUsage.js';

/** reader 眼中一个可查询的 coding plan provider(由 usage.ts 装配层解析配置得出)。 */
export interface GlmCodingPlanProviderSource {
  providerId: string;
  /** 选定 runtime 的 baseUrl(fetch 层再做白名单收口)。 */
  runtimeBaseUrl: string;
  apiKey: string;
  platform: 'zhipu' | 'zai';
}

export interface GlmCodingPlanUsageRefreshDeps {
  /** 解析 provider 的查询素材;无该 provider / 无 usage 能力 / 无 key → null。 */
  readSource(providerId: string): Promise<GlmCodingPlanProviderSource | null>;
  /**
   * 拉端点快照。返回语义:snapshot = 正常;'empty' = 端点成功但无可解析窗口
   * (清缓存降级为无数据);null = 网络失败等(保留缓存下轮再试)。
   */
  fetchSnapshot(
    source: GlmCodingPlanProviderSource,
  ): Promise<GlmCodingPlanUsageSnapshot | 'empty' | null>;
  recordSnapshot(providerId: string, snapshot: GlmCodingPlanUsageSnapshot): Promise<void>;
  clearSnapshot(providerId: string): Promise<void>;
  readCachedSnapshot(providerId: string): Promise<GlmCodingPlanUsageSnapshot | null>;
  /** API key → 快照归属指纹(与 record 侧同一实现);read() 用它识别换 key 后的过期快照。 */
  fingerprintKey(key: string): string;
  now(): number;
  isUnauthorizedError(err: unknown): boolean;
  isRateLimitedError(err: unknown): boolean;
  onRefreshError(err: unknown): void;
}

export interface GlmCodingPlanUsageRefreshOptions {
  throttleMs?: number;
  rateLimitBackoffInitialMs?: number;
  rateLimitBackoffMaxMs?: number;
}

/** 与官方插件 / Claude 订阅端点同档:180s 节流(未文档化端点,不宜高频打)。 */
const DEFAULT_THROTTLE_MS = 180_000;
const DEFAULT_BACKOFF_INITIAL_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MAX_MS = 30 * 60_000;

interface ProviderRefreshState {
  keyFingerprint: string | null;
  inFlight: Promise<void> | null;
  inFlightKeyFingerprint: string | null;
  lastRefreshAt: number;
  backoffMs: number;
  backoffUntil: number;
  hadSource: boolean;
  /** 无源冷却:source 解析是 DB+safeStorage 读,防渲染层高频 IPC 逐次付费。 */
  noSourceUntil: number;
}

export interface GlmCodingPlanUsageReader {
  /** cached-first 读(IPC handler 用):立即返回缓存快照,后台按节流刷新。 */
  read(providerId: string): Promise<GlmCodingPlanUsageSnapshot | null>;
  /** 显式触发一次后台刷新(chip 悬念期 nudge 用),同样吃节流 / 退避。 */
  triggerRefresh(providerId: string): void;
  /** provider CRUD(key / baseUrl / usage 能力变化或删除)后的强制同步。 */
  syncForProviderChange(providerId: string): Promise<void>;
}

export function createGlmCodingPlanUsageReader(
  deps: GlmCodingPlanUsageRefreshDeps,
  options: GlmCodingPlanUsageRefreshOptions = {},
): GlmCodingPlanUsageReader {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const backoffInitialMs = options.rateLimitBackoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
  const backoffMaxMs = options.rateLimitBackoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;

  const states = new Map<string, ProviderRefreshState>();

  function stateFor(providerId: string): ProviderRefreshState {
    let s = states.get(providerId);
    if (!s) {
      s = {
        keyFingerprint: null,
        inFlight: null,
        inFlightKeyFingerprint: null,
        lastRefreshAt: 0,
        backoffMs: 0,
        backoffUntil: 0,
        hadSource: false,
        noSourceUntil: 0,
      };
      states.set(providerId, s);
    }
    return s;
  }

  function resetThrottleForIdentity(s: ProviderRefreshState, keyFingerprint: string): void {
    if (s.keyFingerprint === keyFingerprint) return;
    s.keyFingerprint = keyFingerprint;
    s.lastRefreshAt = 0;
    s.backoffMs = 0;
    s.backoffUntil = 0;
  }

  async function clearSnapshotQuiet(providerId: string): Promise<void> {
    const s = stateFor(providerId);
    s.keyFingerprint = null;
    s.lastRefreshAt = 0;
    s.backoffMs = 0;
    s.backoffUntil = 0;
    try {
      await deps.clearSnapshot(providerId);
    } catch (err) {
      deps.onRefreshError(err);
    }
  }

  async function readSourceSafe(
    providerId: string,
  ): Promise<GlmCodingPlanProviderSource | null> {
    try {
      return await deps.readSource(providerId);
    } catch (err) {
      deps.onRefreshError(err);
      return null;
    }
  }

  function refreshWith(
    providerId: string,
    source: GlmCodingPlanProviderSource,
  ): Promise<void> {
    const s = stateFor(providerId);
    const keyFingerprint = deps.fingerprintKey(source.apiKey);
    if (s.inFlight) {
      // 飞行中的 fetch 属于另一把 key(换 key):等旧请求收尾后按当时最新源补一次
      // (旧响应会被指纹校验丢弃)。同 key 直接复用旧 promise。
      if (s.inFlightKeyFingerprint !== keyFingerprint) {
        return s.inFlight.finally(() => {
          void readSourceSafe(providerId).then((current) => {
            if (current) void refreshWith(providerId, current);
          });
        });
      }
      return s.inFlight;
    }

    resetThrottleForIdentity(s, keyFingerprint);
    const now = deps.now();
    if (now < s.backoffUntil) return Promise.resolve();
    if (s.lastRefreshAt > 0 && now - s.lastRefreshAt < throttleMs) return Promise.resolve();

    s.lastRefreshAt = now;
    s.inFlightKeyFingerprint = keyFingerprint;
    s.inFlight = (async () => {
      try {
        const result = await deps.fetchSnapshot(source);
        s.backoffMs = 0;
        s.backoffUntil = 0;
        // 换 key 发生在飞行中:旧 key 的响应直接丢弃。
        if (s.inFlightKeyFingerprint !== keyFingerprint) return;
        if (result === 'empty') {
          // 端点成功但无可解析窗口 —— 清快照降级;不动节流状态(防逐次重打敏感端点)。
          try {
            await deps.clearSnapshot(providerId);
          } catch (clearErr) {
            deps.onRefreshError(clearErr);
          }
          return;
        }
        if (result) {
          await deps.recordSnapshot(providerId, {
            ...result,
            keyFingerprint,
          });
        }
      } catch (err) {
        if (deps.isUnauthorizedError(err)) {
          // 只清快照、不动 API key —— 401/403 也可能是套餐类型 / 接口权限不支持;
          // 节流保留,防每个 read 都重打。
          if (s.inFlightKeyFingerprint === keyFingerprint) {
            try {
              await deps.clearSnapshot(providerId);
            } catch (clearErr) {
              deps.onRefreshError(clearErr);
            }
          }
          return;
        }
        if (deps.isRateLimitedError(err)) {
          s.backoffMs = s.backoffMs > 0 ? Math.min(s.backoffMs * 2, backoffMaxMs) : backoffInitialMs;
          s.backoffUntil = deps.now() + s.backoffMs;
          return;
        }
        deps.onRefreshError(err);
      } finally {
        s.inFlight = null;
        s.inFlightKeyFingerprint = null;
      }
    })();
    return s.inFlight;
  }

  return {
    async read(providerId: string): Promise<GlmCodingPlanUsageSnapshot | null> {
      const s = stateFor(providerId);
      const source = await readSourceSafe(providerId);
      if (!source) {
        s.noSourceUntil = deps.now() + throttleMs;
        // 只在「之前有过源」时清一次 —— 普通 provider 的常规读不应反复触发 DELETE。
        if (s.hadSource || s.keyFingerprint !== null) {
          s.hadSource = false;
          await clearSnapshotQuiet(providerId);
        }
        return null;
      }
      s.noSourceUntil = 0;
      s.hadSource = true;

      const cached = await deps.readCachedSnapshot(providerId);
      // 换 key 防串号:持久化快照归属指纹与当前 key 不符 → 立即清除并返回无数据
      // (不等后台刷新)。指纹缺失(异常旧快照)按未知归属沿用,不误清。
      if (
        cached?.keyFingerprint
        && cached.keyFingerprint !== deps.fingerprintKey(source.apiKey)
      ) {
        await clearSnapshotQuiet(providerId);
        void refreshWith(providerId, source);
        return null;
      }
      void refreshWith(providerId, source);
      return cached;
    },

    triggerRefresh(providerId: string): void {
      const s = stateFor(providerId);
      const now = deps.now();
      if (s.inFlight) return;
      if (now < s.backoffUntil) return;
      if (now < s.noSourceUntil) return;
      if (s.lastRefreshAt > 0 && now - s.lastRefreshAt < throttleMs) return;
      void readSourceSafe(providerId).then((source) => {
        if (!source) {
          stateFor(providerId).noSourceUntil = deps.now() + throttleMs;
          return;
        }
        void refreshWith(providerId, source);
      });
    },

    async syncForProviderChange(providerId: string): Promise<void> {
      const s = stateFor(providerId);
      const source = await readSourceSafe(providerId);
      if (!source) {
        // 删除 / 失去 usage 能力:无条件清(本进程可能从未观察过该 provider,但库里
        // 可能残留上一个进程周期的快照),广播 null 让 chip 回占位态。
        s.hadSource = false;
        s.noSourceUntil = deps.now() + throttleMs;
        await clearSnapshotQuiet(providerId);
        return;
      }
      s.noSourceUntil = 0;
      s.hadSource = true;
      const cached = await deps.readCachedSnapshot(providerId);
      if (
        cached?.keyFingerprint
        && cached.keyFingerprint !== deps.fingerprintKey(source.apiKey)
      ) {
        await clearSnapshotQuiet(providerId);
      }
      void refreshWith(providerId, source);
    },
  };
}
