/**
 * useAccountUsage — 订阅 codex 账号配额 (rate limits) 实时推送。
 *
 * 数据通道:
 *   maker-core codex translator emit AgentEvent { type: 'account_usage', source: 'codex', data: RateLimitSnapshot }
 *   → main register.ts wireSessionToIpc broadcast `maker:event` { sessionId, event }
 *   → preload window.electronAPI.maker.onEvent
 *   → 本 hook 按 sessionId 过滤
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
 *   - 按 sessionId 过滤 (虽然 host 端是 fan-out 给所有 active subscriber, 每个 session 都收一份)
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

let lastCodexAccountUsage: CodexAccountUsageSlots = {
  appServer: null,
  appServerBuckets: Object.create(null) as Record<string, RateLimitSnapshot>,
  web: null,
};

/**
 * 最近观察到的 app-server 桶键 —— 稀疏更新缺 limitId 时并入它(与 main 的
 * codexAppServerLatestBucketKey 同口径)。account/rateLimits/updated 契约:
 * "merge available values into the most recent read response"; 直接按缺省桶
 * 归类会把模型专属窗口暴露成通用桶(review 反馈)。
 */
let lastCodexAppServerBucketKey: string | null = null;

/**
 * 桶表代号 —— app-server 桶表每次被替换时 +1, 供陈旧重选定时器判断「该重算下
 * 一个到期时刻了」。不能拿 snapshot 当这个信号: 变化的桶不是当前选中桶时
 * snapshot 不变(漏重算), 反过来 snapshot 变了也不必然意味着桶表变了(白重排
 * 定时器, review 反馈)。
 */
let codexBucketTableGeneration = 0;

/** 稀疏更新的落桶键: 带 limitId 用它自己的桶; 缺失则并入最近观察到的桶。 */
function resolveIncrementalBucketKey(incoming: RateLimitSnapshot): string {
  if (incoming.limitId) return codexLimitBucketKey(incoming);
  return lastCodexAppServerBucketKey ?? codexLimitBucketKey(incoming);
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
  modelId?: string | null,
): RateLimitSnapshot | null {
  if (quotaSource === 'openai-web') return lastCodexAccountUsage.web;
  const buckets = lastCodexAccountUsage.appServerBuckets;
  // 桶表已建立: 选桶结果就是最终答案 —— 匹配不到宁可不显示 app-server 配额,
  // 也不回退顶层兼容位(它可能正是别的模型的桶, review 反馈)。
  if (Object.keys(buckets).length > 0) return matchCodexBucketForModel(buckets, modelId);
  // 桶表为空(旧 main / 尚无 app-server 数据): 保持旧行为用顶层兼容位。
  return lastCodexAccountUsage.appServer;
}

function readUsageApi(): {
  getAccount?: (agentKind: 'claude-code' | 'codex') => Promise<unknown | null>;
  onCodexAccountChanged?: (cb: (payload: unknown) => void) => () => void;
} | undefined {
  return (window as unknown as {
    electronAPI?: {
      maker?: {
        usage?: {
          getAccount?: (agentKind: 'claude-code' | 'codex') => Promise<unknown | null>;
          onCodexAccountChanged?: (cb: (payload: unknown) => void) => () => void;
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
  const keepPreviousWindows =
    keepPreviousWebFields
    || (hasCodexUsageWindow(previous) && isCodexWindowlessFallback(incoming));

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
    primary: keepPreviousWindows ? previous.primary : incoming.primary,
    secondary: keepPreviousWindows ? previous.secondary : incoming.secondary,
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
  incoming: unknown,
  onApplied: () => void,
  options: { clearOnNull?: boolean } = {},
): void {
  if (incoming === null) {
    if (options.clearOnNull === false) return;
    lastCodexAccountUsage = { appServer: null, appServerBuckets: emptyBucketTable(), web: null };
    lastCodexAppServerBucketKey = null;
    codexBucketTableGeneration += 1;
    onApplied();
    return;
  }
  if (!isRateLimitSnapshot(incoming)) return;
  const parts = splitCodexAccountUsagePayload(incoming);
  // 键存在即生效: 快照 → 槽内 merge; null → 显式清空(组合 payload 是权威全量,
  // 见 splitCodexAccountUsagePayload); 键缺失 → 保留现值(裸快照只带自己的槽)。
  if ('appServer' in parts) {
    if ('appServerBuckets' in parts) {
      // 权威全量: 顶层兼容位就是 main 记录的最近更新桶。
      lastCodexAppServerBucketKey = parts.appServer
        ? codexLimitBucketKey(parts.appServer)
        : null;
    } else if (parts.appServer) {
      lastCodexAppServerBucketKey = resolveIncrementalBucketKey(parts.appServer);
    }
    // 组合 payload 是 main 的权威全量: 顶层直接替换。跨桶 merge 会造出
    // 「B 的 limitId + A 的窗口」杂交体(windowless 兜底会保留旧窗口),
    // 冷启动会话回退顶层时就显示错桶数据(review 反馈)。
    const isAuthoritative = 'appServerBuckets' in parts;
    const nextAppServer = parts.appServer
      ? isAuthoritative
        ? parts.appServer
        : mergeCodexAccountUsageSnapshot(lastCodexAccountUsage.appServer, parts.appServer)
      : null;
    lastCodexAccountUsage = {
      ...lastCodexAccountUsage,
      appServer: nextAppServer,
      // 桶表: 组合 payload 带全量 → 覆盖; 裸 turn 事件 → 只更新自己那个桶
      // (同桶 merge, 跨桶隔离, 与 main 同口径)。
      appServerBuckets: 'appServerBuckets' in parts
        ? parts.appServerBuckets ?? emptyBucketTable()
        : parts.appServer
          ? withCodexBucket(
              lastCodexAccountUsage.appServerBuckets,
              resolveIncrementalBucketKey(parts.appServer),
              parts.appServer,
            )
          : emptyBucketTable(),
    };
    codexBucketTableGeneration += 1;
  }
  if ('web' in parts) {
    lastCodexAccountUsage = {
      ...lastCodexAccountUsage,
      web: parts.web
        ? mergeCodexAccountUsageSnapshot(lastCodexAccountUsage.web, parts.web)
        : null,
    };
  }
  onApplied();
}

// module 级常驻订阅 —— 与组件生命周期解耦: 所有 codex chip 卸载期间发生登出 /
// 换号时, main 的 null / 新 payload 广播也要同步进 module 缓存, 否则下次 mount
// 的 useState initializer 会先 seed 旧账号槽数据闪一帧。幂等安装, 随 renderer
// 进程存活, 不退订(与 useClaudeSubscriptionUsage 的常驻语义一致)。
let moduleSubscriptionInstalled = false;
function ensureModuleSubscription(): void {
  if (moduleSubscriptionInstalled) return;
  const api = readUsageApi();
  if (!api?.onCodexAccountChanged) return;
  moduleSubscriptionInstalled = true;
  api.onCodexAccountChanged((payload: unknown) => {
    applyCodexAccountUsageSnapshot(payload, () => {});
  });
}

/**
 * 主动催一次 Codex 账号用量刷新(chip 悬念期用: 倒计时归零等新快照时)。
 * main 侧 USAGE_ACCOUNT('codex') 即 cached-first + WHAM 后台刷新(10s 节流 +
 * in-flight 去重), 重复调用安全;新快照经 usage:codex-account-changed push 回流,
 * 这里不消费返回值。
 */
export function requestCodexAccountRefresh(): void {
  const api = readUsageApi();
  if (!api?.getAccount) return;
  void api.getAccount('codex').catch(() => {
    /* Best-effort nudge; push 更新仍会刷新 chip。 */
  });
}

export function useAccountUsage(
  sessionId: string | undefined,
  vendorKey: 'cc' | 'codex' | undefined,
  quotaSource: CodexQuotaSource = 'app-server',
  /** 当前会话模型 —— app-server 形态下据它匹配限额桶(见 matchCodexBucketForModel)。 */
  modelId?: string | null,
): RateLimitSnapshot | null {
  // 幂等; 首个 codex 实例装上 module 常驻订阅, 保证之后卸载窗口内的广播(尤其
  // 换号清空)不丢。非 codex 会话不装 —— 从没有 codex chip 消费过就没有可残留
  // 的缓存, 常驻监听纯属白耗(review 反馈)。
  if (vendorKey === 'codex') ensureModuleSubscription();
  const [snapshot, setSnapshot] = useState<RateLimitSnapshot | null>(() =>
    vendorKey === 'codex' ? selectCodexSlot(quotaSource, modelId) : null,
  );
  // 订阅 effect 不把 modelId 放进依赖(切模型不该重装 IPC 订阅, 重装窗口还会漏
  // push);回调经 ref 读最新模型。模型变化时由下方 reselect effect 立即重选。
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  // 桶表代号进 state 才能当定时器依赖; 桶表没变时 setState 同值被 React bail
  // out, 不会多一次渲染。
  const [bucketGeneration, setBucketGeneration] = useState(codexBucketTableGeneration);
  const reselect = useCallback(() => {
    setSnapshot(selectCodexSlot(quotaSource, modelIdRef.current));
    setBucketGeneration(codexBucketTableGeneration);
  }, [quotaSource]);

  // Codex rate limits 是账号级数据, 不是 session 级数据。切回 Codex session /
  // 切模型时按新模型重新选桶(桶表已在缓存里, 无需等下一次 push)。
  useEffect(() => {
    setSnapshot(vendorKey === 'codex' ? selectCodexSlot(quotaSource, modelId) : null);
  }, [sessionId, vendorKey, quotaSource, modelId]);

  // 陈旧转变是纯时间驱动的: 没有新 payload 时也要在到点那一刻重选一次, 否则
  // 常驻挂载的 chip 会一直显示已过期的促销桶(review 反馈)。
  const [staleTick, setStaleTick] = useState(0);
  useEffect(() => {
    if (vendorKey !== 'codex' || quotaSource !== 'app-server') return undefined;
    const now = Date.now();
    const staleAt = nextCodexBucketStaleAtMs(lastCodexAccountUsage.appServerBuckets, now);
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
    void api
      .getAccount('codex')
      .then((persisted) => {
        if (cancelled) return;
        applyCodexAccountUsageSnapshot(
          persisted,
          reselect,
          { clearOnNull: false },
        );
      })
      .catch(() => {
        /* Best-effort warm start; live account_usage events still update the chip. */
      });

    return () => {
      cancelled = true;
    };
  }, [vendorKey, quotaSource, reselect]);

  useEffect(() => {
    if (vendorKey !== 'codex') return;
    const api = readUsageApi();
    if (!api?.onCodexAccountChanged) return;

    let cancelled = false;
    const unsubscribe = api.onCodexAccountChanged((payload: unknown) => {
      if (cancelled) return;
      applyCodexAccountUsageSnapshot(payload, reselect);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [vendorKey, quotaSource, reselect]);

  useEffect(() => {
    if (vendorKey !== 'codex' || !sessionId) return;
    const api = (window as unknown as {
      electronAPI?: {
        maker?: {
          onEvent?: (cb: (data: unknown) => void) => () => void;
        };
      };
    }).electronAPI?.maker;
    if (!api?.onEvent) return;
    let cancelled = false;
    // 注: 这里不再在 turn 事件后拉 getAccount 触发 WHAM 刷新 —— CLI chip 只显示
    // app-server 槽, WHAM 刷新帮不上它, 白耗后台请求(旧行为还会把 WHAM 桶合并
    // 进单槽缓存, 正是「turn 刚结束数据被顶掉」的来源)。bridge 槽的保鲜由
    // main 的 bridge turn-done 触发 + mount 读 + 悬念期催刷负责。
    const unsubscribe = api.onEvent((data: unknown) => {
      if (cancelled) return;
      const payload = data as {
        sessionId?: string;
        event?: { type?: string; source?: string; data?: RateLimitSnapshot };
      };
      if (payload.sessionId !== sessionId) return;
      if (payload.event?.type !== 'account_usage') return;
      if (payload.event.source !== 'codex') return;
      if (!payload.event.data) return;
      // 只更新桶表(事件带 limitId, 进它自己的桶); **不**据此判会话归属 ——
      // 这是账号级 fan-out 事件(见 matchCodexBucketForModel 注释)。
      applyCodexAccountUsageSnapshot(payload.event.data, reselect);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId, vendorKey, quotaSource, reselect]);

  return snapshot;
}
