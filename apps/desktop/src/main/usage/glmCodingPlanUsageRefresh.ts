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
  /** 当前身份签名(key 指纹|baseUrl|platform)—— 任一变化都重置节流并触发换装。 */
  identity: string | null;
  inFlight: Promise<void> | null;
  inFlightIdentity: string | null;
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
        identity: null,
        inFlight: null,
        inFlightIdentity: null,
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

  /** 完整身份签名:key 指纹 | baseUrl | platform——任一变化即换人/换端点。 */
  function identityOf(source: GlmCodingPlanProviderSource): string {
    return [
      deps.fingerprintKey(source.apiKey),
      source.runtimeBaseUrl,
      source.platform,
    ].join('|');
  }

  function resetThrottleForIdentity(s: ProviderRefreshState, identity: string): void {
    if (s.identity === identity) return;
    s.identity = identity;
    s.lastRefreshAt = 0;
    s.backoffMs = 0;
    s.backoffUntil = 0;
  }

  async function clearSnapshotQuiet(providerId: string): Promise<void> {
    const s = stateFor(providerId);
    s.identity = null;
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

  /**
   * 飞行中身份是否仍然有效:重读当前源并与飞行发起时的完整身份比对——key 指纹 +
   * baseUrl + platform(对齐 claude reader 的 isRefreshStillCurrent 口径)。换 key /
   * 换端点 / 换平台 / 删除发生在 fetch 途中时,旧配置的响应(含 'empty' / 401 的
   * 清快照副作用)必须整体丢弃 —— 只比 key 指纹不够:同一把 key 改 baseUrl(如
   * zhipu↔zai)后,旧端点的迟到响应同样会污染新配置(#2768 二轮 review r3788456291)。
   * 只在 fetch 完成时调用(每完成一次付一次 source 解析),不在请求热路径上。
   */
  async function isRefreshStillCurrent(
    providerId: string,
    keyFingerprint: string,
    source: GlmCodingPlanProviderSource,
  ): Promise<boolean> {
    const current = await readSourceSafe(providerId);
    if (!current) return false;
    return (
      current.runtimeBaseUrl === source.runtimeBaseUrl
      && current.platform === source.platform
      && deps.fingerprintKey(current.apiKey) === keyFingerprint
    );
  }

  /**
   * 副作用后补偿(四轮 review,Greptile 残余竞态):活体校验通过 → record/clear
   * 完成之间还有一段 await 窗口,provider CRUD 恰在此刻落地时旧副作用仍会执行
   * ——写回旧快照(覆盖 sync 刚清的结果)或清掉新身份刚写入的快照。副作用完成后
   * 再验一次身份,失配则:清掉旧身份写下的东西(clearSnapshotQuiet 顺带把节流身份
   * 重置,补偿刷新不被 180s 窗口卡住),并按当前源立即补刷。口径对齐 usageBroadcaster
   * 段已有的「写库后世代复查 + 补偿删除」模式。
   */
  async function compensateIfStale(
    providerId: string,
    keyFingerprint: string,
    source: GlmCodingPlanProviderSource,
  ): Promise<void> {
    if (await isRefreshStillCurrent(providerId, keyFingerprint, source)) return;
    await clearSnapshotQuiet(providerId);
    const current = await readSourceSafe(providerId);
    if (current) void refreshWith(providerId, current);
  }

  function refreshWith(
    providerId: string,
    source: GlmCodingPlanProviderSource,
  ): Promise<void> {
    const s = stateFor(providerId);
    const keyFingerprint = deps.fingerprintKey(source.apiKey);
    const identity = identityOf(source);
    if (s.inFlight) {
      // 飞行中的 fetch 属于另一身份(换 key / 换端点):等旧请求收尾后按当时最新源
      // 补一次(旧响应会被活体校验丢弃)。同身份直接复用旧 promise。
      if (s.inFlightIdentity !== identity) {
        return s.inFlight.finally(() => {
          void readSourceSafe(providerId).then((current) => {
            if (current) void refreshWith(providerId, current);
          });
        });
      }
      return s.inFlight;
    }

    resetThrottleForIdentity(s, identity);
    const now = deps.now();
    if (now < s.backoffUntil) return Promise.resolve();
    if (s.lastRefreshAt > 0 && now - s.lastRefreshAt < throttleMs) return Promise.resolve();

    s.lastRefreshAt = now;
    s.inFlightIdentity = identity;
    s.inFlight = (async () => {
      try {
        const result = await deps.fetchSnapshot(source);
        s.backoffMs = 0;
        s.backoffUntil = 0;
        // 换 key / 换端点 / 删除发生在飞行中:重读当前源比对完整身份(死守卫教训
        // —— 与自身保存的字段比较恒过,等于没有检查),旧响应整体丢弃。
        if (!(await isRefreshStillCurrent(providerId, keyFingerprint, source))) return;
        if (result === 'empty') {
          // 端点成功但无可解析窗口 —— 清快照降级;不动节流状态(防逐次重打敏感端点)。
          try {
            await deps.clearSnapshot(providerId);
          } catch (clearErr) {
            deps.onRefreshError(clearErr);
          }
          // 清完补偿:窗口期内换装则按当前源立即补刷(空清除可能误删新身份快照)。
          await compensateIfStale(providerId, keyFingerprint, source);
          return;
        }
        if (result) {
          await deps.recordSnapshot(providerId, {
            ...result,
            keyFingerprint,
            // 完整身份随快照落库:同 key 换端点时据此判定持久化快照过期。
            runtimeBaseUrl: source.runtimeBaseUrl,
            platform: source.platform,
          });
          // 写完补偿:校验→写库的 await 窗口内换装则清掉刚写的旧身份快照并补刷。
          await compensateIfStale(providerId, keyFingerprint, source);
        }
      } catch (err) {
        if (deps.isUnauthorizedError(err)) {
          // 只清快照、不动 API key —— 401/403 也可能是套餐类型 / 接口权限不支持;
          // 节流保留,防每个 read 都重打。清快照同样要过活体校验:旧配置的 401
          // 不得把新配置刚写入的快照清掉。
          if (await isRefreshStillCurrent(providerId, keyFingerprint, source)) {
            try {
              await deps.clearSnapshot(providerId);
              // 清完补偿:401 的清快照同样可能落在换装窗口内,误删新身份快照。
              await compensateIfStale(providerId, keyFingerprint, source);
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
        s.inFlightIdentity = null;
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
        if (s.hadSource || s.identity !== null) {
          s.hadSource = false;
          await clearSnapshotQuiet(providerId);
        }
        return null;
      }
      s.noSourceUntil = 0;
      s.hadSource = true;

      const cached = await deps.readCachedSnapshot(providerId);
      // 换 key / 换端点防串号:持久化快照归属身份与当前源不符 → 立即清除并返回
      // 无数据(不等后台刷新)。身份字段缺失(异常旧快照)按未知归属沿用,不误清。
      if (isCachedSnapshotStale(cached, source, deps.fingerprintKey)) {
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
      // 同 key 换 baseUrl / platform 也要清:旧端点的余量不能顶着新配置展示
      // (新请求失败时会无限期残留;#2768 三轮 review r3788613366)。
      if (isCachedSnapshotStale(cached, source, deps.fingerprintKey)) {
        await clearSnapshotQuiet(providerId);
      }
      void refreshWith(providerId, source);
    },
  };
}

/**
 * 持久化快照是否已不属于当前源:key 指纹 / baseUrl / platform 任一失配即过期。
 * 身份字段缺失的旧快照按未知归属沿用(不误清);任一字段在且不等 → 过期。
 */
function isCachedSnapshotStale(
  cached: GlmCodingPlanUsageSnapshot | null,
  source: GlmCodingPlanProviderSource,
  fingerprintKey: (key: string) => string,
): boolean {
  if (!cached) return false;
  if (cached.keyFingerprint && cached.keyFingerprint !== fingerprintKey(source.apiKey)) {
    return true;
  }
  if (cached.runtimeBaseUrl && cached.runtimeBaseUrl !== source.runtimeBaseUrl) {
    return true;
  }
  return cached.platform !== undefined && cached.platform !== source.platform;
}
