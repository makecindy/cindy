/**
 * glmCodingPlanUsageRefresh — GLM Coding Plan 余量的 cached-first reader(纯逻辑,依赖注入)。
 *
 * 形态对齐 claudeSubscriptionUsageRefresh;差异:
 *   - 身份维度是 (providerId, API key 指纹)——GLM Coding Plan 是用户自定义 provider,
 *     同一账号可配多个实例、不同实例可能不同 key,快照按 provider 隔离、换 key 即过期
 *     (不是 Claude 的全局单账号 OAuth)。
 *   - 单一数据源(monitor 端点),无 headers 旁路,无 merge 语义。
 *   - provider 配置 / key 变化走 syncForProviderChange(providerHandlers 的 CRUD 钩子调用):
 *     删除或失去 usage 能力 → 无条件清快照;更新 → 作废在飞提交令牌(fetch 窗口
 *     竞态)且仅身份(key/baseUrl/platform)失配才清快照,改名/加模型类编辑不删。
 */

import type { GlmCodingPlanUsageSnapshot } from '../../shared/glmCodingPlanUsage.js';
import type { GlmUsageWriteToken } from '../usageBroadcaster.js';

/** reader 眼中一个可查询的 coding plan provider(由 usage.ts 装配层解析配置得出)。 */
export interface GlmCodingPlanProviderSource {
  providerId: string;
  /** 选定 runtime 的 baseUrl(fetch 层再做白名单收口)。 */
  runtimeBaseUrl: string;
  apiKey: string;
  platform: 'zhipu' | 'zai';
}

/**
 * readSource 的四态结果:
 *   - source     → 正常素材
 *   - null       → 无该 provider / 无 usage 能力 / 无 key(业务上的"不可查询")
 *   - 'stale-owner' → 读取期间账号切换(素材已不可信,#2768 review r3788644129):
 *                     与"不存在"语义不同 —— 绝不能走清快照路径(那会删掉新账号
 *                     同名 provider 的快照),只能静默放弃本次读。
 *   - 'read-failed' → source 解析抛异常(DB / safeStorage 瞬时故障;#2768 八轮
 *                     review PTJ):同样不是"不存在",任何调用方都不得据此清快照
 *                     或置冷却,只能无副作用地放弃、等下次入口重试。
 */
export type GlmCodingPlanReadSourceResult =
  | GlmCodingPlanProviderSource
  | null
  | 'stale-owner'
  | 'read-failed';

export interface GlmCodingPlanUsageRefreshDeps {
  /** 解析 provider 的查询素材;三态语义见 GlmCodingPlanReadSourceResult。 */
  readSource(providerId: string): Promise<GlmCodingPlanReadSourceResult>;
  /**
   * 拉端点快照。返回语义:snapshot = 正常;'empty' = 端点成功但无可解析窗口
   * (清缓存降级为无数据);null = 网络失败等(保留缓存下轮再试)。
   */
  fetchSnapshot(
    source: GlmCodingPlanProviderSource,
  ): Promise<GlmCodingPlanUsageSnapshot | 'empty' | null>;
  /**
   * 在**发起 fetch 之前**领取条件提交令牌(七轮根因修复):fetch 期间发生
   * provider CRUD(世代 bump)或 owner 切换(epoch 前进)→ 令牌失效 →
   * record/clear 的提交被 store 拒绝。取代「写完再验 + 补偿」——补偿自身
   * 仍是跨 await 的先检查后动作,窗口关不干净(#2768 四~七轮实证)。
   */
  beginWrite(providerId: string): GlmUsageWriteToken;
  /**
   * 只作废在飞令牌、不删快照(CRUD 更新路径):UPDATE handler 对任何字段变更都
   * 触发,但只有身份(key/baseUrl/platform)变化才使快照数据失效 —— 改名/加模型
   * 不删快照,额度显示不断(七轮复审 R2 修正)。
   */
  invalidateWrites(providerId: string): void;
  recordSnapshot(
    providerId: string,
    snapshot: GlmCodingPlanUsageSnapshot,
    token?: GlmUsageWriteToken,
  ): Promise<void>;
  /** 无令牌 = 强制清(CRUD 钩子 / read 身份失配);带令牌 = 条件清('empty'/401)。 */
  clearSnapshot(providerId: string, token?: GlmUsageWriteToken): Promise<void>;
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

/**
 * owner 全出口复核(审计 B + 十一轮 review):包一层 readSource,入口捕获 owner、
 * **每个返回路径**出口复核——包括「无 usage 能力」「无 key」这类提前 return。
 * readOwner 返回的键由装配层决定(usage.ts 注 `(id, appSession.generation)`):
 * 同账号重登世代前进同样判 stale(#2768 十一轮;此前只比 id)。纯函数,owner
 * 读取器由装配层注入。
 */
export function createOwnerGuardedReadSource(
  readOwner: () => string,
  readSource: (providerId: string) => Promise<GlmCodingPlanReadSourceResult>,
): (providerId: string) => Promise<GlmCodingPlanReadSourceResult> {
  return async (providerId) => {
    const ownerAtStart = readOwner();
    const result = await readSource(providerId);
    if (readOwner() !== ownerAtStart) return 'stale-owner';
    return result;
  };
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

  /** 重置节流/退避/身份状态(数据归属变了,旧节流不再适用)。 */
  function resetRefreshState(s: ProviderRefreshState): void {
    s.identity = null;
    s.lastRefreshAt = 0;
    s.backoffMs = 0;
    s.backoffUntil = 0;
  }

  async function clearSnapshotQuiet(providerId: string): Promise<void> {
    resetRefreshState(stateFor(providerId));
    try {
      await deps.clearSnapshot(providerId);
    } catch (err) {
      deps.onRefreshError(err);
    }
  }

  async function readSourceSafe(
    providerId: string,
  ): Promise<GlmCodingPlanReadSourceResult> {
    try {
      return await deps.readSource(providerId);
    } catch (err) {
      // 瞬时故障 ≠ provider 不存在(PTJ):折成独立哨兵,调用方按「无副作用放弃」
      // 处理,绝不走删除/冷却路径。
      deps.onRefreshError(err);
      return 'read-failed';
    }
  }

  function isProviderSource(
    result: GlmCodingPlanReadSourceResult,
  ): result is GlmCodingPlanProviderSource {
    return Boolean(result) && result !== 'stale-owner' && result !== 'read-failed';
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
      // 补一次(旧提交会被令牌拒绝)。同身份直接复用旧 promise。
      if (s.inFlightIdentity !== identity) {
        return s.inFlight.finally(() => {
          void readSourceSafe(providerId).then((current) => {
            if (isProviderSource(current)) void refreshWith(providerId, current);
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
      // 令牌在 fetch 前领取:fetch 期间 CRUD(世代 bump)/ owner 切换(epoch 前进)
      // → 提交被 store 拒绝。覆盖四~七轮全部场景,且不依赖身份字段可区分
      // (两账号身份完全相同时 ownerEpoch 仍不同)。
      const token = deps.beginWrite(providerId);
      try {
        const result = await deps.fetchSnapshot(source);
        s.backoffMs = 0;
        s.backoffUntil = 0;
        if (result === 'empty') {
          // 端点成功但无可解析窗口 —— 带令牌条件清(降级);不动节流状态(防逐次
          // 重打敏感端点)。令牌失效 → 静默放弃,CRUD 已在此期间接管。
          try {
            await deps.clearSnapshot(providerId, token);
          } catch (clearErr) {
            deps.onRefreshError(clearErr);
          }
          return;
        }
        if (result) {
          await deps.recordSnapshot(providerId, {
            ...result,
            keyFingerprint,
            // 完整身份随快照落库:同 key 换端点时据此判定持久化快照过期。
            runtimeBaseUrl: source.runtimeBaseUrl,
            platform: source.platform,
          }, token);
        }
      } catch (err) {
        if (deps.isUnauthorizedError(err)) {
          // 只清快照、不动 API key —— 401/403 也可能是套餐类型 / 接口权限不支持;
          // 节流保留,防每个 read 都重打。条件清同样带令牌:旧配置的 401 不得
          // 清掉新配置刚写入的快照(令牌失效 → 静默放弃)。
          try {
            await deps.clearSnapshot(providerId, token);
          } catch (clearErr) {
            deps.onRefreshError(clearErr);
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
      if (source === 'stale-owner') {
        // 读取期间账号切换:素材不可信,静默放弃 —— 绝不能走清快照路径(会删掉
        // 新账号同名 provider 的快照),也不动冷却/状态(#2768 review r3788644129)。
        return null;
      }
      if (source === 'read-failed') {
        // source 解析瞬时故障(PTJ):与「不存在」不同——不动状态、不清快照,
        // 返回缓存快照,显示不中断;下次入口自然重试。
        return await deps.readCachedSnapshot(providerId);
      }
      if (!source) {
        s.noSourceUntil = deps.now() + throttleMs;
        s.hadSource = false;
        if (s.identity === null) {
          // 从未存在过的 provider 不留状态槽:slug 白名单挡了形状,这里挡数量,
          // states Map 只随真实 provider 增长(#2768 review r3788644122)。
          states.delete(providerId);
        }
        // 读路径不删除任何东西;无源 = 业务上不可查询(无该 provider / 无 usage 能力 /
        // 无 key):返回 null,**不触碰快照存储**(九轮 P1)——此前返回缓存会为每个
        // 语法合法但不存在的 slug 都调 readCachedSnapshot,把 store 的 hydrated Set
        // 与 DB 查询面撑到无限大。「瞬时故障不断显示」由 'read-failed' 哨兵独立
        // 承担(八轮 PTJ);真删除归 CRUD 钩子与 read 身份失配路径。
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
        if (source === 'stale-owner' || source === 'read-failed') return;
        if (!source) {
          const s2 = stateFor(providerId);
          if (!s2.hadSource && s2.identity === null) {
            // 同 read():不存在的 provider 不留状态槽,Map 有界。
            states.delete(providerId);
          } else {
            s2.noSourceUntil = deps.now() + throttleMs;
          }
          return;
        }
        void refreshWith(providerId, source);
      });
    },

    async syncForProviderChange(providerId: string): Promise<void> {
      const s = stateFor(providerId);
      // 作废在飞令牌先于任何异步 source 读取(八轮 review PTF):读配置要过 DB +
      // safeStorage,这段窗口内完成的旧请求仍持有效令牌、照样落库广播;CRUD 事实
      // 已经发生,令牌应立即失效(对齐上游 xaiSubscriptionUsageRefresh 的
      // syncForCredentialChange:先同步 bump 世代、再走慢的凭证读取)。节流重置
      // 同理随迁:数据归属已变,旧窗口不该再约束补刷。
      resetRefreshState(s);
      deps.invalidateWrites(providerId);
      const source = await readSourceSafe(providerId);
      if (source === 'stale-owner' || source === 'read-failed') return;
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
      // CRUD 更新拆两件事(七轮复审 R2 修正):①作废在飞令牌已在入口完成;②删
      // 持久化快照——只有身份(key/baseUrl/platform)失配才删,改名/加模型类编辑
      // 不删,额度显示不断。
      const cached = await deps.readCachedSnapshot(providerId);
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
