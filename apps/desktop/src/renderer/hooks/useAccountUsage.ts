import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
/**
 * useAccountUsage — 订阅 codex 账号配额 (rate limits) 实时推送。
 *
 * 数据通道:
 *   maker-core codex translator emit AgentEvent { type: 'account_usage', source: 'codex', data: RateLimitSnapshot }
 *   → main 按实际运行账号归档并推送账号级快照
 *   ChatGPT WHAM 后台刷新 emit `usage:codex-account-changed`
 *   → preload window.electronAPI.maker.usage.onCodexAccountChanged
 *   → 本 hook 直接更新账号级快照
 *
 * 按来源分槽(与 main usageBroadcaster 同口径): 账号可能同时存在多个限额桶,
 * codex-app-server(每 turn 事件, CLI 会话消耗的配额)与 openai-web(WHAM,
 * chatgpt/ bridge 消耗的配额)报告的桶可能不同, 单槽缓存会互相覆盖(2026-07-24
 * 用户实报: Codex chip 突然跳成「8天 剩余 100%」)。组合 payload 顶层 =
 * app-server 槽, webSnapshot = WHAM 槽;调用方按会话形态选槽, 不跨槽回退
 * (绝不显示不是这个会话在消耗的配额)。
 *
 * 设计与 useSessionSpend 对齐:
 *   - 只消费按 providerId 隔离的账号读取与推送；待生效选择不代表当前回合账号
 *   - Codex 账号用量是账号级数据, 切 session 时复用最近一次快照, 避免 chip 闪回占位态
 *   - vendorKey !== 'codex' 直接返 null (claude session 不订阅, 节省一次回调过滤开销)
 *
 * 不立类型 import: maker-core 协议层类型不跨包导出, 这里 inline 定义 — 跟
 * useSessionSpend 同惯例 (它也 inline { sessionId, totalCostUsd })。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CODEX_DEFAULT_LIMIT_BUCKET,
  UNSAFE_BUCKET_KEYS,
  codexLimitBucketKey,
  isCodexBucketStale,
  matchCodexBucketForModel,
  nextCodexBucketStaleAtMs,
} from '@cindy/maker-shared/codex-usage-buckets';

export {
  CODEX_DEFAULT_LIMIT_BUCKET,
  codexLimitBucketKey,
  isCodexBucketStale,
  matchCodexBucketForModel,
  nextCodexBucketStaleAtMs,
};

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes?: number | null;
  /** Unix epoch (秒)。 */
  resetsAt?: number | null;
}

export interface CreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string | null;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: CreditsSnapshot | null;
  planType?: string | null;
  /** 'rate_limit_reached' | 'workspace_owner_credits_depleted' | ... | null。 */
  rateLimitReachedType?: string | null;
  source?: 'openai-web' | 'codex-app-server' | string | null;
  updatedAt?: number | null;
  accountId?: string | null;
}

/** chip 选槽依据: Codex CLI 会话消耗 app-server 报告的配额, chatgpt/ bridge 消耗 WHAM 报告的配额。 */
export type CodexQuotaSource = 'app-server' | 'openai-web';

interface CodexAccountUsageSlots {
  /** app-server 展示快照 = 最近更新的桶(冷启动 / 未知会话桶时的兜底)。 */
  appServer: RateLimitSnapshot | null;
  /** app-server 桶表: limitId → 快照。跨桶隔离, 见 main usageBroadcaster 头注释。 */
  appServerBuckets: Record<string, RateLimitSnapshot>;
  web: RateLimitSnapshot | null;
}

interface AccountUsageState {
  slots: CodexAccountUsageSlots;
  latestBucketKey: string | null;
  generation: number;
  revision: number;
  subscribed: boolean;
  unsubscribe?: () => void;
}
const accountUsageStates = new Map<string, AccountUsageState>();
let accountUsageOwner = getDataOwnerGeneration();
function accountUsageState(providerId: string): AccountUsageState {
  const owner = getDataOwnerGeneration();
  if (owner !== accountUsageOwner) {
    for (const cached of accountUsageStates.values()) cached.unsubscribe?.();
    accountUsageStates.clear();
    accountUsageOwner = owner;
  }
  let state = accountUsageStates.get(providerId);
  if (!state) {
    state = { slots: { appServer: null, appServerBuckets: emptyBucketTable(), web: null },
      latestBucketKey: null, generation: 0, revision: 0, subscribed: false };
    accountUsageStates.set(providerId, state);
  }
  return state;
}

/** 稀疏更新的落桶键: 带 limitId 用它自己的桶; 缺失则并入最近观察到的桶。 */
function resolveIncrementalBucketKey(incoming: RateLimitSnapshot, state: AccountUsageState): string {
  if (incoming.limitId) return codexLimitBucketKey(incoming);
  return state.latestBucketKey ?? codexLimitBucketKey(incoming);
}

/**
 * 选槽 + 选桶。app-server 形态下按**当前会话模型**匹配桶(见
 * matchCodexBucketForModel): 账号可能同时有主配额桶与模型专属促销桶
 * (codex_bengalfox / GPT-5.3-Codex-Spark), 不选桶就会显示别的模型的配额
 * (2026-07-25 用户实报: gpt-5.6-sol 会话显示 Spark 桶的「8天 剩余 100%」)。
 * 匹配不到 → 不显示 app-server 配额(见函数体注释); 仅桶表为空时用顶层兼容位。
 */
function selectCodexSlot(
  quotaSource: CodexQuotaSource,
  modelId: string | null | undefined,
  state: AccountUsageState,
): RateLimitSnapshot | null {
  if (quotaSource === 'openai-web') return state.slots.web;
  const buckets = state.slots.appServerBuckets;
  // 桶表已建立: 选桶结果就是最终答案 —— 匹配不到宁可不显示 app-server 配额,
  // 也不回退顶层兼容位(它可能正是别的模型的桶, review 反馈)。
  if (Object.keys(buckets).length > 0) return matchCodexBucketForModel(buckets, modelId);
  // 桶表为空(旧 main / 尚无 app-server 数据): 保持旧行为用顶层兼容位。
  return state.slots.appServer;
}

function readUsageApi(): {
  getAccount?: (agentKind: 'claude-code' | 'codex', providerId?: string) => Promise<unknown | null>;
  onCodexAccountChanged?: (cb: (payload: unknown) => void, providerId?: string) => () => void;
} | undefined {
  return (window as unknown as {
    electronAPI?: {
      maker?: {
        usage?: {
          getAccount?: (agentKind: 'claude-code' | 'codex', providerId?: string) => Promise<unknown | null>;
          onCodexAccountChanged?: (cb: (payload: unknown) => void, providerId?: string) => () => void;
        };
      };
    };
  }).electronAPI?.maker?.usage;
}

function isRateLimitSnapshot(value: unknown): value is RateLimitSnapshot {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 桶表守卫: 丢掉非对象条目与原型污染键(畸形 payload 不得进缓存, 与 main
 * sanitize 同口径)。用 null 原型对象兜底 —— 即便上游再加键也碰不到 Object.prototype。
 */
function sanitizeCodexBuckets(raw: Record<string, unknown>): Record<string, RateLimitSnapshot> {
  const out: Record<string, RateLimitSnapshot> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (UNSAFE_BUCKET_KEYS.has(key)) continue;
    if (isRateLimitSnapshot(value)) out[key] = value;
  }
  return out;
}


/** 空桶表 —— 与 sanitize 同为 null 原型, 保持「桶表永不挂原型链」的不变量。 */
function emptyBucketTable(): Record<string, RateLimitSnapshot> {
  return Object.create(null) as Record<string, RateLimitSnapshot>;
}

/**
 * 增量写入一个桶并返回**新的 null 原型**桶表。不能用对象字面量 spread ——
 * 那会把 sanitize 建立的 null 原型换回 Object.prototype(review 反馈)。
 */
function withCodexBucket(
  buckets: Record<string, RateLimitSnapshot>,
  key: string,
  incoming: RateLimitSnapshot,
): Record<string, RateLimitSnapshot> {
  const next = emptyBucketTable();
  for (const [existingKey, bucket] of Object.entries(buckets)) next[existingKey] = bucket;
  next[key] = mergeCodexAccountUsageSnapshot(buckets[key] ?? null, incoming);
  return next;
}

export function mergeCodexAccountUsageSnapshot(
  previous: RateLimitSnapshot | null,
  incoming: RateLimitSnapshot,
): RateLimitSnapshot {
  if (!previous) return incoming;
  const keepPreviousWebFields =
    previous.source === 'openai-web'
    && incoming.source !== 'openai-web'
    && (isCodexZeroWindowFallback(incoming) || isCodexWindowlessFallback(incoming));
  const incomingHasPrimary = Object.prototype.hasOwnProperty.call(incoming, 'primary');
  const incomingHasSecondary = Object.prototype.hasOwnProperty.call(incoming, 'secondary');
  const keepPreviousWindows =
    keepPreviousWebFields
    || (
      hasCodexUsageWindow(previous)
      && isCodexWindowlessFallback(incoming)
      && (incomingHasPrimary === incomingHasSecondary)
    );
  // 裸 account_usage 是 app-server 的稀疏滚动通知:只带 primary 时 secondary
  // 不是被删除,只是本次没携带(反之亦然)。逐窗保留,避免 renderer 在 main 的
  // 权威组合 payload 到达前先把另一段额度闪没。WHAM 是全量读取,仍允许清窗;
  // reached marker 则是权威清空信号。
  const preserveMissingAppServerWindows =
    previous.source !== 'openai-web'
    && incoming.source !== 'openai-web'
    && !hasCodexRateLimitReached(incoming);

  const incomingCredits = incoming.credits;
  const previousCredits = previous.credits ?? null;
  let credits: CreditsSnapshot | null;
  if (keepPreviousWebFields) {
    credits = previousCredits;
  } else if (incomingCredits) {
    credits = {
      ...incomingCredits,
      balance: incomingCredits.balance ?? (
        incomingCredits.hasCredits ? previousCredits?.balance : undefined
      ),
    };
  } else {
    credits = previousCredits;
  }

  return {
    ...incoming,
    primary: keepPreviousWindows || (preserveMissingAppServerWindows && !incomingHasPrimary)
      ? previous.primary
      : incoming.primary,
    secondary: keepPreviousWindows || (preserveMissingAppServerWindows && !incomingHasSecondary)
      ? previous.secondary
      : incoming.secondary,
    planType: keepPreviousWebFields ? previous.planType : incoming.planType ?? previous.planType,
    credits,
    source: keepPreviousWebFields ? previous.source : incoming.source ?? 'codex-app-server',
    // 身份元数据不可被部分通知抹掉 —— limitName 丢失会让模型专属桶伪装成通用桶
    // (通用桶判定虽已改用桶键, 但 label / 模型匹配仍依赖它; review 反馈)。
    limitId: incoming.limitId ?? previous.limitId,
    limitName: incoming.limitName ?? previous.limitName,
    updatedAt: incoming.updatedAt ?? previous.updatedAt,
    accountId: incoming.accountId ?? previous.accountId,
  };
}

function hasCodexRateLimitReached(snapshot: RateLimitSnapshot): boolean {
  return typeof snapshot.rateLimitReachedType === 'string'
    && snapshot.rateLimitReachedType.length > 0;
}

function isCodexZeroWindowFallback(snapshot: RateLimitSnapshot): boolean {
  if (hasCodexRateLimitReached(snapshot)) return false;
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is RateLimitWindow => Boolean(window),
  );
  if (windows.length === 0) return false;
  return windows.every((window) => window.usedPercent === 0);
}

function hasCodexUsageWindow(snapshot: RateLimitSnapshot): boolean {
  return Boolean(snapshot.primary || snapshot.secondary);
}

function isCodexWindowlessFallback(snapshot: RateLimitSnapshot): boolean {
  if (hasCodexRateLimitReached(snapshot)) return false;
  // Codex app-server can emit a generic `limitId: "codex"` snapshot without
  // window counters. Treat it as non-authoritative for clearing known windows.
  return !snapshot.primary && !snapshot.secondary;
}

/** 顶层槽是否有可展示内容(区分「空 app 槽 + 仅 webSnapshot」的组合 payload)。 */
function hasCodexSnapshotContent(snapshot: RateLimitSnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  return Boolean(
    snapshot.primary
    || snapshot.secondary
    || snapshot.limitId
    || snapshot.planType
    || snapshot.credits
    || snapshot.rateLimitReachedType,
  );
}

/**
 * 入站 payload → 两槽更新(纯函数, 供单测)。三种形状:
 *   - 组合 payload(带 webSnapshot 键, 来自 IPC read / usage push): 是 main 侧
 *     **两槽的权威全量** —— 顶层有内容归 app 槽、无内容 = app 槽显式清空(null);
 *     webSnapshot 同理。不清会让换号 / 切形态后旧槽数据一直挂着(review 反馈)。
 *   - 单快照(per-turn account_usage 事件 / 旧格式): 增量, 按 source 只更新
 *     自己的槽 —— openai-web → web, 其余 → app。
 * 语义: 键缺失 = 本次不携带该槽信息(保留现值); 键为 null = 显式清空。
 */
export function splitCodexAccountUsagePayload(incoming: RateLimitSnapshot): {
  appServer?: RateLimitSnapshot | null;
  appServerBuckets?: Record<string, RateLimitSnapshot> | null;
  web?: RateLimitSnapshot | null;
} {
  if ('webSnapshot' in incoming) {
    const { webSnapshot, appServerBuckets, ...rest } = incoming as RateLimitSnapshot & {
      webSnapshot?: unknown;
      appServerBuckets?: unknown;
    };
    return {
      appServer: hasCodexSnapshotContent(rest) ? rest : null,
      // 桶表随组合 payload 全量下发; 缺失(旧 main / 无 app 数据)→ 显式清空。
      appServerBuckets: isPlainRecord(appServerBuckets)
        ? sanitizeCodexBuckets(appServerBuckets)
        : null,
      web: isRateLimitSnapshot(webSnapshot) ? webSnapshot : null,
    };
  }
  if (incoming.source === 'openai-web') return { web: incoming };
  return { appServer: incoming };
}

function applyCodexAccountUsageSnapshot(
  state: AccountUsageState,
  incoming: unknown,
  onApplied: () => void,
  options: { clearOnNull?: boolean } = {},
): void {
  if (incoming === null) {
    if (options.clearOnNull === false) return;
    state.revision += 1;
    state.slots = { appServer: null, appServerBuckets: emptyBucketTable(), web: null };
    state.latestBucketKey = null;
    state.generation += 1;
    onApplied();
    return;
  }
  if (!isRateLimitSnapshot(incoming)) return;
  state.revision += 1;
  const parts = splitCodexAccountUsagePayload(incoming);
  // 键存在即生效: 快照 → 槽内 merge; null → 显式清空(组合 payload 是权威全量,
  // 见 splitCodexAccountUsagePayload); 键缺失 → 保留现值(裸快照只带自己的槽)。
  if ('appServer' in parts) {
    if ('appServerBuckets' in parts) {
      // 权威全量: 顶层兼容位就是 main 记录的最近更新桶。
      state.latestBucketKey = parts.appServer
        ? codexLimitBucketKey(parts.appServer)
        : null;
    } else if (parts.appServer) {
      state.latestBucketKey = resolveIncrementalBucketKey(parts.appServer, state);
    }
    // 组合 payload 是 main 的权威全量: 顶层直接替换。跨桶 merge 会造出
    // 「B 的 limitId + A 的窗口」杂交体(windowless 兜底会保留旧窗口),
    // 冷启动会话回退顶层时就显示错桶数据(review 反馈)。
    const isAuthoritative = 'appServerBuckets' in parts;
    const nextAppServer = parts.appServer
      ? isAuthoritative
        ? parts.appServer
        : mergeCodexAccountUsageSnapshot(state.slots.appServer, parts.appServer)
      : null;
    state.slots = {
      ...state.slots,
      appServer: nextAppServer,
      // 桶表: 组合 payload 带全量 → 覆盖; 裸 turn 事件 → 只更新自己那个桶
      // (同桶 merge, 跨桶隔离, 与 main 同口径)。
      appServerBuckets: 'appServerBuckets' in parts
        ? parts.appServerBuckets ?? emptyBucketTable()
        : parts.appServer
          ? withCodexBucket(
              state.slots.appServerBuckets,
              resolveIncrementalBucketKey(parts.appServer, state),
              parts.appServer,
            )
          : emptyBucketTable(),
    };
    state.generation += 1;
  }
  if ('web' in parts) {
    state.slots = {
      ...state.slots,
      web: parts.web
        ? mergeCodexAccountUsageSnapshot(state.slots.web, parts.web)
        : null,
    };
  }
  onApplied();
}

// module 级常驻订阅 —— 与组件生命周期解耦: 所有 codex chip 卸载期间发生登出 /
// 换号时, main 的 null / 新 payload 广播也要同步进 module 缓存, 否则下次 mount
// 的 useState initializer 会先 seed 旧账号槽数据闪一帧。幂等安装, 随 renderer
// 进程存活, 不退订(与 useClaudeSubscriptionUsage 的常驻语义一致)。
function ensureModuleSubscription(providerId: string, state: AccountUsageState): void {
  if (state.subscribed) return;
  const api = readUsageApi();
  if (!api?.onCodexAccountChanged) return;
  state.subscribed = true;
  state.unsubscribe = api.onCodexAccountChanged((payload: unknown) => {
    applyCodexAccountUsageSnapshot(state, payload, () => {});
  }, providerId);
}

/**
 * 主动催一次 Codex 账号用量刷新(chip 悬念期用: 倒计时归零等新快照时)。
 * main 侧 USAGE_ACCOUNT('codex') 即 cached-first + WHAM 后台刷新(10s 节流 +
 * in-flight 去重), 重复调用安全;新快照经 usage:codex-account-changed push 回流,
 * 这里不消费返回值。
 */
export function requestCodexAccountRefresh(providerId?: string): void {
  const api = readUsageApi();
  if (!api?.getAccount) return;
  void api.getAccount('codex', providerId).catch(() => {
    /* Best-effort nudge; push 更新仍会刷新 chip。 */
  });
}

export function useAccountUsage(
  sessionId: string | undefined,
  vendorKey: 'cc' | 'codex' | undefined,
  quotaSource: CodexQuotaSource = 'app-server',
  /** 当前会话模型 —— app-server 形态下据它匹配限额桶(见 matchCodexBucketForModel)。 */
  modelId?: string | null,
  providerId = 'openai',
): RateLimitSnapshot | null {
  const state = accountUsageState(providerId);
  // 幂等; 首个 codex 实例装上 module 常驻订阅, 保证之后卸载窗口内的广播(尤其
  // 换号清空)不丢。非 codex 会话不装 —— 从没有 codex chip 消费过就没有可残留
  // 的缓存, 常驻监听纯属白耗(review 反馈)。
  if (vendorKey === 'codex') ensureModuleSubscription(providerId, state);
  const [, setStored] = useState<{ state: AccountUsageState; value: RateLimitSnapshot | null }>(() => ({
    state, value: vendorKey === 'codex' ? selectCodexSlot(quotaSource, modelId, state) : null,
  }));
  // Select synchronously from the current connection/source/model cache.
  const snapshot = vendorKey === 'codex' ? selectCodexSlot(quotaSource, modelId, state) : null;
  const setSnapshot = useCallback((value: RateLimitSnapshot | null) => setStored({ state, value }), [state]);
  // 订阅 effect 不把 modelId 放进依赖(切模型不该重装 IPC 订阅, 重装窗口还会漏
  // push);回调经 ref 读最新模型。模型变化时由下方 reselect effect 立即重选。
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  // 桶表代号进 state 才能当定时器依赖; 桶表没变时 setState 同值被 React bail
  // out, 不会多一次渲染。
  const [bucketGeneration, setBucketGeneration] = useState(state.generation);
  const reselect = useCallback(() => {
    setSnapshot(selectCodexSlot(quotaSource, modelIdRef.current, state));
    setBucketGeneration(state.generation);
  }, [quotaSource, state]);

  // Codex rate limits 是账号级数据, 不是 session 级数据。切回 Codex session /
  // 切模型时按新模型重新选桶(桶表已在缓存里, 无需等下一次 push)。
  useEffect(() => {
    setSnapshot(vendorKey === 'codex' ? selectCodexSlot(quotaSource, modelId, state) : null);
  }, [sessionId, vendorKey, quotaSource, modelId, state]);

  // 陈旧转变是纯时间驱动的: 没有新 payload 时也要在到点那一刻重选一次, 否则
  // 常驻挂载的 chip 会一直显示已过期的促销桶(review 反馈)。
  const [staleTick, setStaleTick] = useState(0);
  useEffect(() => {
    if (vendorKey !== 'codex' || quotaSource !== 'app-server') return undefined;
    const now = Date.now();
    const staleAt = nextCodexBucketStaleAtMs(state.slots.appServerBuckets, now);
    if (staleAt === null) return undefined;
    // setTimeout 上限 ~24.8 天, 超出就分段等待(到期再重算)。
    const delay = Math.min(Math.max(staleAt - now, 0) + 1_000, 6 * 60 * 60 * 1000);
    const timer = window.setTimeout(() => {
      reselect();
      setStaleTick((tick) => tick + 1);
    }, delay);
    return () => window.clearTimeout(timer);
    // bucketGeneration: 桶表变了要重算到期时刻; staleTick: 本次到点后要接着排
    // 下一个桶的到期时刻(纯时间驱动, 期间没有新 payload)。
  }, [vendorKey, quotaSource, reselect, bucketGeneration, staleTick]);

  useEffect(() => {
    if (vendorKey !== 'codex') return;
    const api = readUsageApi();
    if (!api?.getAccount) return;

    let cancelled = false;
    const revision = state.revision;
    void api
      .getAccount('codex', providerId)
      .then((persisted) => {
        if (cancelled || state.revision !== revision) return;
        if (providerId !== 'openai' && persisted && (persisted as { providerId?: string }).providerId !== providerId) return;
        applyCodexAccountUsageSnapshot(
          state, persisted,
          reselect,
          { clearOnNull: false },
        );
      })
      .catch(() => {
        /* Best-effort warm start; account-scoped pushes still update the chip. */
      });

    return () => {
      cancelled = true;
    };
  }, [vendorKey, quotaSource, reselect, providerId, state]);

  useEffect(() => {
    if (vendorKey !== 'codex') return;
    const api = readUsageApi();
    if (!api?.onCodexAccountChanged) return;

    let cancelled = false;
    const unsubscribe = api.onCodexAccountChanged((payload: unknown) => {
      if (cancelled) return;
      applyCodexAccountUsageSnapshot(state, payload, reselect);
    }, providerId);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [vendorKey, quotaSource, reselect, providerId, state]);

  // 不直接消费无 providerId 的 maker:account_usage：同一 session 的待生效账号
  // 可能已切换，事件仍属于旧回合。Main 归档后发出的账号级推送是唯一实时入口。
  return snapshot;
}
