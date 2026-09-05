/**
 * usageBroadcaster — agent 今日累计 (cost / token) 广播,maker-ipc/usage.ts 的数据源。
 *
 * 设计:
 *   - Claude / Codex API: USD 累计 (持久化 sessions table 的 daily_spend, 跨 session 求和)
 *   - Codex 订阅: token 累计 (in-memory, app 重启 reset —— 订阅模式不产生真实 API cost,
 *             所以走 token; 不持久化是因为 token 数本身不是核算依据,粗略观感够了)
 *   - 切日: localDayKey() 与 currentSnapshot.day 不一致时 in-memory snapshot reset
 *           (Claude 走 SQLite per-day row, 不需要 in-memory reset)
 *
 * IPC 广播:
 *   - USAGE_TODAY_SPEND_CHANGED    每 turn done 后推 Claude USD 累计
 *   - USAGE_TODAY_TOKENS_CHANGED   每 turn done 后推 Codex token 累计 (按 agentKind)
 *   - USAGE_CODEX_ACCOUNT_CHANGED  推 Codex 账号订阅用量快照
 *   - USAGE_CLAUDE_SUBSCRIPTION_CHANGED 推 Claude 订阅账号余量快照 (5h/周/分模型窗口)
 *
 * 用户:
 *   - maker-ipc/register.ts: 在 maker:event done 时 record (Claude / Codex API → recordTurnSpend,
 *     Codex → recordCodexTurnUsage)
 *   - maker-ipc/usage.ts: maker:usage:today(agentKind) handler 读 readAgentTodayUsage
 */

import { BrowserWindow } from 'electron';

import { isTrustedAppRendererWindow } from './security/trustedAppRenderer.js';

import { incrementDailySpend, getTodaySpend, localDayKey } from './localDb/dailySpend';
import { getGatewayModelPricing } from './usage/modelPricing';
import type { XaiRateLimitSnapshot } from '../shared/xaiRateLimit';
import { incrementDailyModelUsage, type DailyModelUsageDelta } from './localDb/dailyModelUsage';
import { getCurrentDbClientUserId, getDbClient } from './localDb/client/current';
import {
  mergeClaudeSubscriptionUsageSnapshot,
  type ClaudeSubscriptionUsageSnapshot,
} from '../shared/claudeSubscriptionUsage';
import type { XaiSubscriptionUsageSnapshot } from '../shared/xaiSubscriptionUsage';
import type { AgentKind } from '@cindy/maker-core';

import {
  UNSAFE_BUCKET_KEYS,
  codexLimitBucketKey,
  isCodexBucketStale,
} from '@cindy/maker-shared/codex-usage-buckets';

import { createLogger } from './logger';
import { tapWindowBroadcast } from './device-link/broadcast-tap.js';
import type { RegionalMoney } from '../shared/regionalMoney.js';

const log = createLogger('usageBroadcaster');

/** IPC channel: main → renderer 推今日累计值变化 (Claude USD)。 */
export const USAGE_TODAY_SPEND_CHANGED = 'usage:today-spend-changed';
/** IPC channel: main → renderer 推今日 token 累计变化 (Codex)。 */
export const USAGE_TODAY_TOKENS_CHANGED = 'usage:today-tokens-changed';
/** IPC channel: main → renderer 推 Codex 账号订阅用量变化。 */
export const USAGE_CODEX_ACCOUNT_CHANGED = 'usage:codex-account-changed';
/** IPC channel: main → renderer 推 xAI(SuperGrok bridge)上游限流快照变化。 */
export const USAGE_XAI_RATE_LIMIT_CHANGED = 'usage:xai-rate-limit-changed';
/** IPC channel: main → renderer 推 Claude 订阅账号余量变化 (端点刷新 / headers 旁路)。 */
export const USAGE_CLAUDE_SUBSCRIPTION_CHANGED = 'usage:claude-subscription-changed';
/** IPC channel: main → renderer 推 SuperGrok 账号周用量快照。 */
export const USAGE_XAI_SUBSCRIPTION_CHANGED = 'usage:xai-subscription-changed';

export interface TodaySpendPayload {
  /** 本地时区 YYYY-MM-DD。 */
  day: string;
  money: RegionalMoney;
  /** Global/旧客户端兼容；CN 新金额绝不伪装为 USD。 */
  costUsd?: number;
}

/** 跨 agent 统一的 today usage 形状 —— maker:usage:today(agentKind) 返回值。 */
export interface AgentTodayUsage {
  day: string;
  money?: RegionalMoney;
  /** 仅 USD 时的旧客户端兼容投影。 */
  costUsd?: number;
  /** Codex 有值, Claude undefined (Claude 链路走 cost 不走 token)。 */
  totalTokens?: number;
  /** Codex 详细分项, Claude undefined。 */
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes?: number | null;
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
  rateLimitReachedType?: string | null;
  source?: 'openai-web' | 'codex-app-server' | string | null;
  updatedAt?: number | null;
  accountId?: string | null;
}

// ── Claude USD (持久化, 跨 session 求和) ─────────────────────────────────────

/**
 * maker-ipc done 事件后调用 (Claude 链路)。
 * - costUsd 是 per-turn delta (cumulative - lastReported, 在 register.ts 里算好)
 * - 写库 + 广播是同步调用,不阻塞 turn 收尾 (SQLite better-sqlite3 是同步的, O(1) upsert)
 */
export async function recordTurnSpend(
  money: RegionalMoney,
  ts: number = Date.now(),
): Promise<void> {
  try {
    const result = await incrementDailySpend(money, ts);
    broadcastTodaySpend({
      day: result.day,
      money: result.money,
      ...(result.money.currency === 'USD'
        ? { costUsd: result.money.amount }
        : {}),
    });
  } catch (err) {
    // 写库失败不应阻塞主流程 —— 仅日志
    log.warn(
      'recordTurnSpend failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Claude 今日 USD 累计 (供 IPC handler / 内部消费)。 */
export async function readTodaySpend(): Promise<TodaySpendPayload> {
  // getTodaySpend 要按账本币种从多币种日账里挑行，而账本币种由报价快照恢复。
  // getGatewayModelPricing 只读内存或磁盘快照、不发网络请求，等它一下就能避免冷启动首帧
  // 按兜底币种折叠掉本账号真正的那一行（与 usageHistory 里同一个理由）。
  await getGatewayModelPricing().catch(() => null);
  const money = await getTodaySpend();
  return {
    day: localDayKey(),
    money,
    ...(money.currency === 'USD' ? { costUsd: money.amount } : {}),
  };
}

/**
 * 重新广播当前 Claude 今日 USD 快照(不写库)—— 订阅轮只写 daily_model_usage
 * (cost=0, 不走 recordTurnSpend), renderer 的 useUsageHistory 以 spend/tokens push
 * 为仪表盘刷新信号, 用它通知"按模型数据有更新"(对齐 rebroadcastCodexTodayUsage)。
 */
export async function rebroadcastTodaySpend(): Promise<void> {
  try {
    broadcastTodaySpend(await readTodaySpend());
  } catch (err) {
    log.warn(
      'rebroadcastTodaySpend failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * maker-ipc done 事件后调用 (Claude / Codex 共用) — 按模型记一笔 per-turn 增量
 * 到 daily_model_usage 表 (首页仪表盘"按模型拆分"用)。
 * fire-and-forget: 写库失败只日志, 不阻塞主流程; 不额外广播
 * (renderer 复用 USAGE_TODAY_SPEND_CHANGED / USAGE_TODAY_TOKENS_CHANGED 作刷新触发)。
 */
export async function recordModelTurnUsage(
  delta: DailyModelUsageDelta,
  ts: number = Date.now(),
): Promise<void> {
  try {
    await incrementDailyModelUsage(delta, ts);
  } catch (err) {
    log.warn(
      'recordModelTurnUsage failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Codex token (in-memory, app 启动 reset) ──────────────────────────────────
// 从 vendor/codex/codexUsageBroadcaster.ts 搬过来, vendor 那个文件随 codex 元 IPC
// 一起退役。U4: USD 不持久化, Codex token 同样不持久化 (跨日切自动 reset, 跨重启从零)。

interface CodexTokenSnapshot {
  day: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  total: number;
}

let codexTodaySnapshot: CodexTokenSnapshot = blankCodexSnapshot();

function blankCodexSnapshot(): CodexTokenSnapshot {
  return {
    day: localDayKey(),
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    total: 0,
  };
}

/** codex/index.ts 在 turn.completed 时翻译过的 done.data.usage 形状 (camelCase, 对齐 Anthropic 风)。 */
interface CodexTurnUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

/**
 * maker-ipc done 事件后调用 (Codex 链路)。
 * usage 缺失或非 object 时静默忽略 (防呆)。
 */
export function recordCodexTurnUsage(usage: unknown): void {
  if (!usage || typeof usage !== 'object') return;
  const u = usage as CodexTurnUsage;

  // 切日检测: localDayKey 与 snapshot.day 不一致 → 整体 reset 后再累加
  const today = localDayKey();
  if (today !== codexTodaySnapshot.day) {
    codexTodaySnapshot = blankCodexSnapshot();
  }

  const promptDelta = Number(u.promptTokens) || 0;
  const completionDelta = Number(u.completionTokens) || 0;
  const reasoningDelta = Number(u.reasoningTokens) || 0;
  const cachedDelta = Number(u.cachedTokens) || 0;

  codexTodaySnapshot = {
    day: today,
    promptTokens: codexTodaySnapshot.promptTokens + promptDelta,
    completionTokens: codexTodaySnapshot.completionTokens + completionDelta,
    reasoningTokens: codexTodaySnapshot.reasoningTokens + reasoningDelta,
    cachedTokens: codexTodaySnapshot.cachedTokens + cachedDelta,
    total: codexTodaySnapshot.total + promptDelta + completionDelta + cachedDelta,
  };

  broadcastCodexTokens(codexTodaySnapshot);
}

/** 重新广播当前 Codex token 快照, 用于延迟模型用量写入后触发 renderer 刷新。 */
export function rebroadcastCodexTodayUsage(): void {
  const today = localDayKey();
  if (today !== codexTodaySnapshot.day) {
    codexTodaySnapshot = blankCodexSnapshot();
  }
  broadcastCodexTokens(codexTodaySnapshot);
}

/** Codex 今日 token 累计 (供 IPC handler / 内部消费)。renderer 拉取时也做切日兜底。 */
function readCodexTodaySnapshot(): CodexTokenSnapshot {
  const today = localDayKey();
  if (today !== codexTodaySnapshot.day) codexTodaySnapshot = blankCodexSnapshot();
  return codexTodaySnapshot;
}

// ── 跨 agent 统一查询 (maker:usage:today(agentKind) handler 用) ───────────────

export async function readAgentTodayUsage(agentKind: AgentKind): Promise<AgentTodayUsage> {
  if (agentKind === 'claude-code') {
    const s = await readTodaySpend();
    return {
      day: s.day,
      money: s.money,
      ...(s.costUsd !== undefined ? { costUsd: s.costUsd } : {}),
    };
  }
  if (agentKind === 'codex') {
    const s = readCodexTodaySnapshot();
    return {
      day: s.day,
      totalTokens: s.total,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      reasoningTokens: s.reasoningTokens,
      cachedTokens: s.cachedTokens,
    };
  }
  // 未知 agentKind: 返回空 snapshot (TS 完备性, 不抛错让 UI 优雅 fallback)
  return { day: localDayKey() };
}

// ── Codex account usage (persisted latest snapshot, 按来源分槽) ──────────────
//
// 账号可能同时存在多个限额桶(主 codex 配额 + 模型专属促销桶, 如
// GPT-5.3-Codex-Spark / codex_bengalfox), 且两个数据源报告的桶可能不同:
//   - codex-app-server: 每 turn account_usage 事件 / rateLimits 读 —— CLI 会话
//     实际消耗的配额, Codex 会话 chip 的权威来源;
//   - openai-web (WHAM): chatgpt.com/backend-api/wham/usage —— 为 cc + chatgpt/
//     bridge 会话引入(bridge 轮不产生 app-server 事件), 报告的桶与 CLI 可能不同。
// 单槽存储会让两个来源互相覆盖(2026-07-24 用户实报: Codex chip 突然跳成
// 「8天 剩余 100%」—— WHAM 的 Spark 桶窗口顶掉了 app-server 的主配额窗口)。
// 分槽后各源只更新自己的槽, 消费方按会话形态选槽(CLI → 顶层, bridge →
// webSnapshot), payload 形状对旧消费者(mobile 防御解析)加性兼容。
//
// **同源内还要按 limitId 再分桶**(2026-07-25 用户复报: 用 gpt-5.6-sol 的会话里
// chip 仍显示「8天 剩余 100%」, 持久化 app 槽是 codex_bengalfox /
// GPT-5.3-Codex-Spark 的 7 天窗口)。app-server 的 account/rateLimits/updated 每次
// 只推**一个**桶(带 limitId, 即该 turn 实际消耗的桶); 用过 Spark 类模型专属桶后,
// 它会覆盖主配额桶并挂在全局缓存上, 之后所有 Codex 会话的 chip 都读到它。
// 桶表按 limitId 隔离, 同桶才 merge。renderer 按**当前会话模型**匹配桶
// (limitName 命中模型 → 该桶; 否则通用桶, 由稳定桶键 'codex'/缺省桶识别;
// 都不匹配 → 不显示 app-server 配额, 绝不退到别的模型的桶)——
// **不能**用 account_usage 事件判会话归属: 它是账号级 fan-out, host 把同一条
// 广播给所有 subscriber 再各自包 sessionId(见 app-server host.routeNotification)。
// 详见 useAccountUsage.matchCodexBucketForModel。

/**
 * 组合 payload:
 *   - 顶层 = app-server **最近更新的**桶(旧消费者与冷启动兜底, 形状不变);
 *   - appServerBuckets = app-server 全部桶(按 limitId), renderer 据会话选桶;
 *   - webSnapshot = WHAM 槽。
 * 后两者都是加性字段, 旧消费者(mobile 防御解析)忽略即退化为原行为。
 */
export interface CodexAccountUsagePayload extends RateLimitSnapshot {
  webSnapshot?: RateLimitSnapshot | null;
  appServerBuckets?: Record<string, RateLimitSnapshot> | null;
}

let codexAccountUsageOwner: string | null = null;
/**
 * 冷缓存 hydration 是否**成功读到过库**(读到空行也算)。
 *
 * 落库守卫的判据 —— merge 的底子可信才允许写回。读库失败 / owner 未初始化被跳过时
 * 内存是空的, 此时任何 merge 结果都不代表账号真实状态, 写回会抹掉库里的有效数据。
 * 不能改用「payload 内容看起来是否有用」判断: 合法的空(限额解除、credits 清零)与
 * 事故的空形状完全一致, 按内容判会把前者一并拦下。
 *
 * 它同时充当「无需再读库」的判据 —— 读失败时保持 false, 下一次 record / read 会重试。
 * 若另设一个「已加载」标志并在失败时也置位, 一次瞬时 db busy 就会让本进程之后
 * 所有落库被永久跳过。
 */
let codexAccountUsageHydrated = false;
// 并发 record 必须等同一次 SQLite 读完成后再按到达顺序 merge(与 claude 侧同款) ——
// 否则第二笔会在 loaded 已被置位、内存却仍为空时 merge 出全 null payload。
let codexAccountUsageLoadPromise: Promise<void> | null = null;
/** app-server 桶表: limitId → 该桶最近快照(同桶 merge, 跨桶隔离)。 */
let codexAppServerBuckets: Record<string, RateLimitSnapshot> = {};
/** 最近更新的 app-server 桶键 —— 顶层兼容位取它。 */
let codexAppServerLatestBucketKey: string | null = null;
let codexWebAccountUsageSnapshot: RateLimitSnapshot | null = null;

/**
 * 剪掉陈旧桶(保留最近更新桶本身, 它是顶层兼容位的来源)。桶表持久化且纯累加,
 * 不剪枝会让促销结束后的旧桶永远留着并被模型匹配选中(review 反馈)。
 */
function pruneStaleCodexBuckets(nowMs: number): void {
  const next: Record<string, RateLimitSnapshot> = {};
  for (const [key, bucket] of Object.entries(codexAppServerBuckets)) {
    if (key !== codexAppServerLatestBucketKey && isCodexBucketStale(bucket, nowMs)) continue;
    next[key] = bucket;
  }
  codexAppServerBuckets = next;
}

/** 当前 app-server 展示快照(最近更新桶);无桶 → null。 */
function currentCodexAppServerSnapshot(): RateLimitSnapshot | null {
  if (codexAppServerLatestBucketKey) {
    return codexAppServerBuckets[codexAppServerLatestBucketKey] ?? null;
  }
  const keys = Object.keys(codexAppServerBuckets);
  return keys.length > 0 ? codexAppServerBuckets[keys[keys.length - 1]] ?? null : null;
}

function currentAccountUsageOwner(): string | null {
  try {
    return getCurrentDbClientUserId();
  } catch {
    return null;
  }
}

function resetCodexAccountUsageCacheIfOwnerChanged(): void {
  const owner = currentAccountUsageOwner();
  if (owner === codexAccountUsageOwner) return;
  codexAccountUsageOwner = owner;
  codexAccountUsageHydrated = false;
  codexAppServerBuckets = {};
  codexAppServerLatestBucketKey = null;
  codexWebAccountUsageSnapshot = null;
}

/** 顶层槽是否有可展示内容(区分「空 app 槽 + 仅 web 槽」的 payload)。 */
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

/** 两槽 → 组合 payload;两槽全空 → null。 */
function buildCodexAccountUsagePayload(): CodexAccountUsagePayload | null {
  const app = currentCodexAppServerSnapshot();
  const web = codexWebAccountUsageSnapshot;
  const buckets = Object.keys(codexAppServerBuckets).length > 0
    ? codexAppServerBuckets
    : null;
  if (!app && !web) return null;
  if (!app && web) {
    // web-only: 顶层无 CLI 数据, 但归属字段必须上浮 —— WHAM reader 用顶层
    // accountId 判断缓存归属(codexAccountUsageRefresh), 缺失会被当成账号失配,
    // 每次读都清缓存 + 强刷(bridge-only 用户 warm-start 永远拿 null)。
    // accountId / updatedAt 不算「内容」(hasCodexSnapshotContent), 归槽水合
    // 不会据此伪造出 app 槽。
    return { accountId: web.accountId, updatedAt: web.updatedAt, webSnapshot: web };
  }
  return {
    ...(app as RateLimitSnapshot),
    webSnapshot: web ?? null,
    appServerBuckets: buckets,
  };
}

/**
 * 持久化行 → 两槽。新格式带 webSnapshot 键;旧格式是单快照 —— 按其 source
 * 归入对应槽(旧行可能是被 WHAM 污染过的单槽杂交体, 归 web 槽即自然隔离)。
 */
export function splitPersistedCodexAccountUsage(parsed: Record<string, unknown>): {
  appServerBuckets: Record<string, RateLimitSnapshot>;
  /** 落库时的最近更新桶键(顶层兼容位派生);未知 → null。 */
  latestBucketKey: string | null;
  web: RateLimitSnapshot | null;
} {
  if ('webSnapshot' in parsed) {
    const { webSnapshot, appServerBuckets, ...rest } = parsed as CodexAccountUsagePayload;
    // 新格式带桶表 → 直接水合; 只有顶层(分桶前写入的行)→ 下面按其 limitId 归桶。
    const buckets = isPlainRecord(appServerBuckets)
      ? sanitizeCodexBuckets(appServerBuckets)
      : {};
    // 顶层兼容位记录的就是落库时的最近更新桶 —— 水合必须据此恢复, 否则
    // 「A→B→A」后重启会按对象键序错选 B(覆盖已有键不会移到末尾, review 反馈)。
    const latestBucketKey = hasCodexSnapshotContent(rest) ? codexLimitBucketKey(rest) : null;
    // 但这个键必须在桶表里真的存在。本仓写入路径两者恒一致(顶层就是从桶表取
    // 的), 外部/损坏/跨版本行却可能给出桶表里没有的键 —— 那样
    // currentCodexAppServerSnapshot() 直接返 null, app-server 配额会一直空到
    // 下一次推送(review 反馈)。顶层快照本身就是那个桶的内容, 补种回去即可。
    // codexLimitBucketKey 已把 __proto__ 等危险键映射成缺省桶, 补种不会污染原型。
    if (latestBucketKey && !Object.prototype.hasOwnProperty.call(buckets, latestBucketKey)) {
      buckets[latestBucketKey] = rest as RateLimitSnapshot;
    }
    return {
      appServerBuckets: buckets,
      latestBucketKey,
      // 拒绝数组等畸形持久化值(与 renderer 的 isRateLimitSnapshot 守卫同口径),
      // 否则损坏行会被当有效快照再次广播 + 回写。
      web: isPlainRecord(webSnapshot) ? (webSnapshot as RateLimitSnapshot) : null,
    };
  }
  const legacy = parsed as RateLimitSnapshot;
  if (legacy.source === 'openai-web') {
    return { appServerBuckets: {}, latestBucketKey: null, web: legacy };
  }
  const hasContent = hasCodexSnapshotContent(legacy);
  return {
    appServerBuckets: hasContent ? { [codexLimitBucketKey(legacy)]: legacy } : {},
    latestBucketKey: hasContent ? codexLimitBucketKey(legacy) : null,
    web: null,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 桶表水合守卫: 丢掉非对象条目, 不让损坏行被当有效快照广播 / 回写。 */
function sanitizeCodexBuckets(raw: Record<string, unknown>): Record<string, RateLimitSnapshot> {
  const out: Record<string, RateLimitSnapshot> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (UNSAFE_BUCKET_KEYS.has(key)) continue;
    if (isPlainRecord(value)) out[key] = value as RateLimitSnapshot;
  }
  return out;
}

function mergeCodexAccountUsageSnapshot(
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
      // Preserve the known generic placeholder shapes (no window fields, or
      // both null). A single explicit null is authoritative for withdrawing
      // that window while its omitted sibling remains sparse.
      && (incomingHasPrimary === incomingHasSecondary)
    );
  // account/rateLimits/updated is sparse: an app-server notification may refresh
  // only primary or secondary. A missing sibling means "not included in this
  // update", not "the window was removed". Preserve each omitted window
  // independently so a one-window tick cannot make the other quota disappear.
  // WHAM snapshots are full reads and must still be allowed to clear a window;
  // an explicit reached marker is authoritative for clearing both windows.
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
    // 身份元数据不可被部分通知抹掉(limitName 丢失会让模型专属桶伪装成通用桶)。
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

async function ensureCodexAccountUsageLoaded(): Promise<void> {
  resetCodexAccountUsageCacheIfOwnerChanged();
  if (codexAccountUsageHydrated) return;
  if (!codexAccountUsageLoadPromise) {
    // 句柄的清理必须放在 await 之后, 不能放进下面 IIFE 的 finally —— owner 缺失时
    // IIFE 会在首个 await 之前同步走完, 它 finally 里清掉的句柄随即被本行的赋值写回,
    // 之后 ensure 永远复用这个已 resolve 的 Promise, 再也不查库(hydrated 也就永远
    // 是 false, 本进程之后所有落库都被守卫跳过)。
    codexAccountUsageLoadPromise = (async () => {
      try {
        if (!codexAccountUsageOwner) return;
        const row = await getDbClient().queryOne<{ snapshot?: string | null }>(
          'SELECT snapshot FROM account_usage_snapshots WHERE agent_kind = ?',
          ['codex'],
        );
        // 读到库就算 hydrated(无行 = 确认库里本来就没有), 之后允许落库。置位放在
        // JSON.parse 之前: 损坏行解析失败仍应允许被新快照覆盖, 否则一条坏行会永久
        // 堵死写入。
        codexAccountUsageHydrated = true;
        if (!row?.snapshot) return;
        const parsed = JSON.parse(row.snapshot);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const slots = splitPersistedCodexAccountUsage(parsed as Record<string, unknown>);
          // hydration 不覆盖内存 —— 首次读失败后重试期间, 内存里可能已经装着那段时间
          // 收到的**更新**观测(它们因守卫未能落库)。库里的行比它们旧, 直接赋值会让 UI
          // 回退到旧额度, 且那些观测永远等不到落库时机。
          //
          // 但也不能按桶键整体覆盖: 那段时间收到的可能是 windowless 稀疏事件, 留下的是
          // 一个非空、却全 null 的同名桶 —— 整桶覆盖会抹掉持久化桶里的窗口, 正好复现
          // 本次要防的损坏。逐桶走常规 merge(持久化桶作 previous), 稀疏事件即按既有
          // 语义保住旧窗口。
          const persistedBuckets = slots.appServerBuckets;
          const mergedBuckets: Record<string, RateLimitSnapshot> = { ...persistedBuckets };
          for (const [key, pending] of Object.entries(codexAppServerBuckets)) {
            mergedBuckets[key] = mergeCodexAccountUsageSnapshot(persistedBuckets[key] ?? null, pending);
          }
          codexAppServerBuckets = mergedBuckets;
          codexAppServerLatestBucketKey = codexAppServerLatestBucketKey ?? slots.latestBucketKey;
          codexWebAccountUsageSnapshot = codexWebAccountUsageSnapshot
            ? mergeCodexAccountUsageSnapshot(slots.web, codexWebAccountUsageSnapshot)
            : slots.web;
        }
      } catch (err) {
        log.warn(
          'readCodexAccountUsageSnapshot failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  }
  try {
    await codexAccountUsageLoadPromise;
  } finally {
    // hydrated 仅在读成功时置位 —— 读失败清掉句柄即留下重试机会。
    codexAccountUsageLoadPromise = null;
  }
}

export async function recordCodexAccountUsageSnapshot(snapshot: unknown): Promise<void> {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;

  await ensureCodexAccountUsageLoaded();
  // 按来源路由到自己的槽 —— 槽内 merge 保留原有的 windowless / 部分字段兜底
  // 语义, 但两个来源不再互相覆盖窗口(见本节头注释)。
  const incoming = snapshot as RateLimitSnapshot;
  if (incoming.source === 'openai-web') {
    codexWebAccountUsageSnapshot = mergeCodexAccountUsageSnapshot(
      codexWebAccountUsageSnapshot,
      incoming,
    );
  } else {
    // 同 limitId 桶内 merge(保留 windowless / 部分字段兜底语义), 跨桶隔离 ——
    // Spark 类模型专属桶不得覆盖主配额桶(见本节头注释)。
    //
    // account/rateLimits/updated 是**稀疏滚动更新**(app-server 0.144 契约原文:
    // "Clients should merge available values into the most recent
    // account/rateLimits/read response or refetch that snapshot. Nullable account
    // metadata may be unavailable in a rolling update and does not clear a
    // previously observed value.")。因此缺 limitId 时不能当作「缺省桶」新建 ——
    // 那会把模型专属窗口塞进通用桶、显示给所有会话(review 反馈)。按契约并入
    // 最近观察到的桶; 尚无任何桶时才落缺省桶(此时无歧义)。
    const bucketKey = incoming.limitId
      ? codexLimitBucketKey(incoming)
      : codexAppServerLatestBucketKey ?? codexLimitBucketKey(incoming);
    codexAppServerBuckets = {
      ...codexAppServerBuckets,
      [bucketKey]: mergeCodexAccountUsageSnapshot(
        codexAppServerBuckets[bucketKey] ?? null,
        incoming,
      ),
    };
    codexAppServerLatestBucketKey = bucketKey;
    pruneStaleCodexBuckets(Date.now());
  }
  const payload = buildCodexAccountUsagePayload();
  broadcastCodexAccountUsage(payload);

  // merge 的底子不可信时不写回, 见 codexAccountUsageHydrated。
  if (!codexAccountUsageHydrated) {
    log.warn('skip persisting codex account usage snapshot: hydration unavailable');
    return;
  }

  try {
    await getDbClient().exec(
      `INSERT INTO account_usage_snapshots (agent_kind, snapshot, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_kind) DO UPDATE SET
         snapshot = excluded.snapshot,
         updated_at = excluded.updated_at`,
      ['codex', JSON.stringify(payload), Date.now()],
    );
  } catch (err) {
    log.warn(
      'recordCodexAccountUsageSnapshot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function clearCodexAccountUsageSnapshot(): Promise<void> {
  resetCodexAccountUsageCacheIfOwnerChanged();
  // clear 后库里的状态是已知的(行被删掉): 既不必再读库, 之后到达的快照也可正常落库。
  codexAccountUsageHydrated = true;
  codexAppServerBuckets = {};
  codexAppServerLatestBucketKey = null;
  codexWebAccountUsageSnapshot = null;
  broadcastCodexAccountUsage(null);

  try {
    await getDbClient().exec(
      'DELETE FROM account_usage_snapshots WHERE agent_kind = ?',
      ['codex'],
    );
  } catch (err) {
    log.warn(
      'clearCodexAccountUsageSnapshot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function readCodexAccountUsageSnapshot(): Promise<CodexAccountUsagePayload | null> {
  await ensureCodexAccountUsageLoaded();
  return buildCodexAccountUsagePayload();
}

// ── xAI(SuperGrok bridge)限流快照 ─────────────────────────────────────────
// api.x.ai 没有 ChatGPT 那种 5h/周订阅窗口端点,只有响应头里的 x-ratelimit-* 限流信息
// (bridge 每个成功请求解析回调一次)。纯内存、不落库 —— 数据是请求级瞬时值,重启后等下一个
// xai/ 轮自然补上;拿不到头时 renderer 诚实降级为仅价值估算。

// 快照形状在 shared/xaiRateLimit.ts(main / renderer 共用一份定义,防两处漂移)。
export type { XaiRateLimitSnapshot } from '../shared/xaiRateLimit';

/** bridge onRateLimit 回调入口:广播 renderer(renderer 侧 hook 自带模块级缓存,无拉取端点)。 */
export function recordXaiRateLimitSnapshot(info: Omit<XaiRateLimitSnapshot, 'updatedAt'>): void {
  const snapshot: XaiRateLimitSnapshot = { ...info, updatedAt: Date.now() };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_XAI_RATE_LIMIT_CHANGED, snapshot);
    }
  }
  // device-link:tooltip 尽力显示被控端限流头(bridge 每成功请求至多一帧,低频)。
  tapWindowBroadcast(USAGE_XAI_RATE_LIMIT_CHANGED, snapshot);
}

/**
 * 清空 xAI 限流快照(广播 null)。xAI 登出 / 重新登录(可能换账号)时调用 ——
 * 快照是账号级的,登出后没有下一个成功响应来覆盖,不清会让旧账号的余量一直挂在 chip 上。
 */
export function clearXaiRateLimitSnapshot(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_XAI_RATE_LIMIT_CHANGED, null);
    }
  }
  // device-link:登出 / 换号清除同步给控制端(远程 tooltip 不得挂旧账号余量)。
  tapWindowBroadcast(USAGE_XAI_RATE_LIMIT_CHANGED, null);
}


// ── Claude subscription usage (persisted latest snapshot) ───────────────────
// 与上面 Codex account usage 段对称:内存缓存 + account_usage_snapshots 落库
// (agent_kind='claude-code') + 广播。数据源有两个(oauth 端点全量 / unified headers
// 增量),merge 语义在 shared/claudeSubscriptionUsage.ts。

// owner 是否已初始化 —— 区分「main 启动后从未读过 owner」与「owner 真的变化」。
// 首次初始化不是失效事件(缓存本来就空), 不得 bump 世代: record 在 ensure 之前
// 捕获世代, 若首次初始化也 bump, 每次 main 启动后的**第一笔**快照会被世代复查
// 误丢(headers 单笔 + 端点 180s 节流时, chip 要空到下一次刷新)。
let claudeSubscriptionUsageOwnerInitialized = false;
let claudeSubscriptionUsageOwner: string | null = null;
/** 与 codex 侧 codexAccountUsageHydrated 同义: 落库守卫 + 「无需再读库」的判据。 */
let claudeSubscriptionUsageHydrated = false;
let claudeSubscriptionUsageSnapshot: ClaudeSubscriptionUsageSnapshot | null = null;
// 冷缓存 hydration 的 in-flight promise —— 并发 record 必须等同一次 SQLite 读完成后
// 再按到达顺序 merge, 否则后到的新快照会先写、再被读回的旧持久化行覆盖。
let claudeSubscriptionUsageLoadPromise: Promise<void> | null = null;
// 世代计数: clear / owner 变化时 +1, 让仍在飞的 hydration 放弃赋值(不复活旧数据)。
let claudeSubscriptionUsageGeneration = 0;

function resetClaudeSubscriptionUsageCacheIfOwnerChanged(): void {
  const owner = currentAccountUsageOwner();
  if (claudeSubscriptionUsageOwnerInitialized && owner === claudeSubscriptionUsageOwner) return;
  const isFirstInit = !claudeSubscriptionUsageOwnerInitialized;
  claudeSubscriptionUsageOwnerInitialized = true;
  claudeSubscriptionUsageOwner = owner;
  // 首次初始化: loaded / snapshot 本就是初值, 世代不 bump(见上方注释)。
  if (isFirstInit) return;
  claudeSubscriptionUsageHydrated = false;
  claudeSubscriptionUsageSnapshot = null;
  claudeSubscriptionUsageGeneration += 1;
}

async function ensureClaudeSubscriptionUsageLoaded(): Promise<void> {
  resetClaudeSubscriptionUsageCacheIfOwnerChanged();
  if (claudeSubscriptionUsageHydrated) return;
  if (!claudeSubscriptionUsageLoadPromise) {
    const generation = claudeSubscriptionUsageGeneration;
    claudeSubscriptionUsageLoadPromise = (async () => {
      try {
        if (!claudeSubscriptionUsageOwner) return;
        const row = await getDbClient().queryOne<{ snapshot?: string | null }>(
          'SELECT snapshot FROM account_usage_snapshots WHERE agent_kind = ?',
          ['claude-code'],
        );
        // clear / owner 变化抢先发生 → 本次读结果作废, 不覆盖更新的内存状态。
        if (generation !== claudeSubscriptionUsageGeneration) return;
        // 读到库就算 hydrated(理由同 codex 侧, 含损坏行仍允许被覆盖)。
        claudeSubscriptionUsageHydrated = true;
        if (!row?.snapshot) return;
        const parsed = JSON.parse(row.snapshot);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          // 理由同 codex 侧: 内存里可能是重试期间收到的更新快照, 库里的行是旧的 ——
          // 以持久化行为底、内存增量在上做一次常规 merge, 而不是直接赋值。
          const persisted = parsed as ClaudeSubscriptionUsageSnapshot;
          claudeSubscriptionUsageSnapshot = claudeSubscriptionUsageSnapshot
            ? mergeClaudeSubscriptionUsageSnapshot(persisted, claudeSubscriptionUsageSnapshot)
            : persisted;
        }
      } catch (err) {
        log.warn(
          'readClaudeSubscriptionUsageSnapshot failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  }
  try {
    await claudeSubscriptionUsageLoadPromise;
  } finally {
    // 清理放在 await 之后, 理由同 codex 侧: owner 缺失时 IIFE 同步走完, 放进它的
    // finally 会被外层赋值写回, 之后永远复用这个已 resolve 的 Promise。
    claudeSubscriptionUsageLoadPromise = null;
  }
}

export async function recordClaudeSubscriptionUsageSnapshot(snapshot: unknown): Promise<void> {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;

  // 世代守卫与 hydration 内部一致: record 是 fire-and-forget, await 期间 clear
  // (登出 / 换号) 或 owner 变化抢先发生时, 本笔必须整体丢弃 —— 否则恢复后的
  // merge / 广播 / 写库会把刚清掉的数据复活。
  const generation = claudeSubscriptionUsageGeneration;
  await ensureClaudeSubscriptionUsageLoaded();
  if (generation !== claudeSubscriptionUsageGeneration) return;

  const next = mergeClaudeSubscriptionUsageSnapshot(
    claudeSubscriptionUsageSnapshot,
    snapshot as ClaudeSubscriptionUsageSnapshot,
  );
  claudeSubscriptionUsageSnapshot = next;
  broadcastClaudeSubscriptionUsage(next);

  // 与 codex 侧同一条保护: merge 的底子不可信时不写回。
  if (!claudeSubscriptionUsageHydrated) {
    log.warn('skip persisting claude subscription usage snapshot: hydration unavailable');
    return;
  }

  try {
    await getDbClient().exec(
      `INSERT INTO account_usage_snapshots (agent_kind, snapshot, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_kind) DO UPDATE SET
         snapshot = excluded.snapshot,
         updated_at = excluded.updated_at`,
      ['claude-code', JSON.stringify(next), Date.now()],
    );
    if (generation !== claudeSubscriptionUsageGeneration) {
      // clear 在写库 await 期间抢先: 内存已被 clear 正确置 null, 但本 INSERT 可能
      // 晚于 clear 的 DELETE 落盘 —— 补偿删除, 防止下次冷启动 hydration 读回残留。
      await getDbClient().exec(
        'DELETE FROM account_usage_snapshots WHERE agent_kind = ?',
        ['claude-code'],
      );
    }
  } catch (err) {
    log.warn(
      'recordClaudeSubscriptionUsageSnapshot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function clearClaudeSubscriptionUsageSnapshot(): Promise<void> {
  resetClaudeSubscriptionUsageCacheIfOwnerChanged();
  // clear 后库里的状态是已知的(行被删掉): 既不必再读库, 之后到达的快照也可正常落库。
  claudeSubscriptionUsageHydrated = true;
  claudeSubscriptionUsageSnapshot = null;
  // 仍在飞的冷缓存 hydration 必须作废 —— 否则它读回的旧持久化行会复活刚清掉的数据。
  claudeSubscriptionUsageGeneration += 1;
  broadcastClaudeSubscriptionUsage(null);

  try {
    await getDbClient().exec(
      'DELETE FROM account_usage_snapshots WHERE agent_kind = ?',
      ['claude-code'],
    );
  } catch (err) {
    log.warn(
      'clearClaudeSubscriptionUsageSnapshot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function readClaudeSubscriptionUsageSnapshot(): Promise<ClaudeSubscriptionUsageSnapshot | null> {
  await ensureClaudeSubscriptionUsageLoaded();
  return claudeSubscriptionUsageSnapshot;
}

// ── xAI / SuperGrok subscription usage (persisted latest snapshot) ──────────
// agent_kind='xai'。单源全量替换,没有 headers 增量 merge。

const XAI_SUBSCRIPTION_USAGE_KIND = 'xai';

let xaiSubscriptionUsageOwnerInitialized = false;
let xaiSubscriptionUsageOwner: string | null = null;
let xaiSubscriptionUsageHydrated = false;
let xaiSubscriptionUsageSnapshot: XaiSubscriptionUsageSnapshot | null = null;
let xaiSubscriptionUsageLoadPromise: Promise<void> | null = null;
let xaiSubscriptionUsageGeneration = 0;
/**
 * 磁盘 hydrate 不能直接给 Renderer。换号后若 DELETE 没落盘就退出,
 * 冷启动只按 agent_kind='xai' 读会把账号 A 的套餐/周用量交给账号 B。
 * 只有本进程成功 record 过一次当前凭证的快照,才允许读出。
 */
let xaiSubscriptionUsageServable = false;

function resetXaiSubscriptionUsageCacheIfOwnerChanged(): void {
  const owner = currentAccountUsageOwner();
  if (xaiSubscriptionUsageOwnerInitialized && owner === xaiSubscriptionUsageOwner) return;
  const isFirstInit = !xaiSubscriptionUsageOwnerInitialized;
  xaiSubscriptionUsageOwnerInitialized = true;
  xaiSubscriptionUsageOwner = owner;
  if (isFirstInit) return;
  xaiSubscriptionUsageHydrated = false;
  xaiSubscriptionUsageSnapshot = null;
  xaiSubscriptionUsageServable = false;
  xaiSubscriptionUsageGeneration += 1;
}

async function ensureXaiSubscriptionUsageLoaded(): Promise<void> {
  resetXaiSubscriptionUsageCacheIfOwnerChanged();
  if (xaiSubscriptionUsageHydrated) return;
  if (!xaiSubscriptionUsageLoadPromise) {
    const generation = xaiSubscriptionUsageGeneration;
    xaiSubscriptionUsageLoadPromise = (async () => {
      try {
        if (!xaiSubscriptionUsageOwner) return;
        const row = await getDbClient().queryOne<{ snapshot?: string | null }>(
          'SELECT snapshot FROM account_usage_snapshots WHERE agent_kind = ?',
          [XAI_SUBSCRIPTION_USAGE_KIND],
        );
        if (generation !== xaiSubscriptionUsageGeneration) return;
        xaiSubscriptionUsageHydrated = true;
        if (!row?.snapshot) return;
        const parsed = JSON.parse(row.snapshot);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const persisted = parsed as XaiSubscriptionUsageSnapshot;
          // record() 可能在 hydration 失败期间已经把更新的快照放进内存;
          // 迟到的磁盘行只能补空,不能盖掉更新的内存值。
          if (!xaiSubscriptionUsageSnapshot) {
            xaiSubscriptionUsageSnapshot = persisted;
          } else {
            const memoryAt = xaiSubscriptionUsageSnapshot.updatedAt ?? 0;
            const diskAt = persisted.updatedAt ?? 0;
            if (diskAt > memoryAt) xaiSubscriptionUsageSnapshot = persisted;
          }
        }
      } catch (err) {
        log.warn(
          'readXaiSubscriptionUsageSnapshot failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  }
  try {
    await xaiSubscriptionUsageLoadPromise;
  } finally {
    xaiSubscriptionUsageLoadPromise = null;
  }
}

export async function recordXaiSubscriptionUsageSnapshot(snapshot: unknown): Promise<void> {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;

  const generation = xaiSubscriptionUsageGeneration;
  await ensureXaiSubscriptionUsageLoaded();
  if (generation !== xaiSubscriptionUsageGeneration) return;

  const incoming = snapshot as XaiSubscriptionUsageSnapshot;
  const current = xaiSubscriptionUsageSnapshot;
  // 磁盘 hydrate 在本进程 record 之前不可信。无指纹的首次写入不得并入旧账号字段。
  if (!xaiSubscriptionUsageServable || !current) {
    xaiSubscriptionUsageSnapshot = incoming;
  } else if (
    current.accountFingerprint
    && incoming.accountFingerprint
    && current.accountFingerprint !== incoming.accountFingerprint
  ) {
    xaiSubscriptionUsageSnapshot = incoming;
  } else {
    // 已核验的同账号:只覆盖解析到的字段。incoming 里的 null 不能把套餐/周百分比抹掉。
    xaiSubscriptionUsageSnapshot = {
      planLabel: incoming.planLabel ?? current.planLabel ?? null,
      creditUsagePercent: incoming.creditUsagePercent ?? current.creditUsagePercent ?? null,
      resetsAt: incoming.resetsAt ?? current.resetsAt ?? null,
      productUsage: incoming.productUsage ?? current.productUsage ?? [],
      prepaidBalance: incoming.prepaidBalance ?? current.prepaidBalance ?? null,
      source: incoming.source ?? current.source ?? null,
      updatedAt: incoming.updatedAt ?? current.updatedAt ?? null,
      accountFingerprint: incoming.accountFingerprint ?? current.accountFingerprint ?? null,
    };
  }
  const next = xaiSubscriptionUsageSnapshot;
  xaiSubscriptionUsageServable = true;
  broadcastXaiSubscriptionUsage(next);

  if (!xaiSubscriptionUsageHydrated) {
    log.warn('skip persisting xai subscription usage snapshot: hydration unavailable');
    return;
  }

  try {
    await getDbClient().exec(
      `INSERT INTO account_usage_snapshots (agent_kind, snapshot, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_kind) DO UPDATE SET
         snapshot = excluded.snapshot,
         updated_at = excluded.updated_at`,
      [XAI_SUBSCRIPTION_USAGE_KIND, JSON.stringify(next), Date.now()],
    );
    if (generation !== xaiSubscriptionUsageGeneration) {
      await getDbClient().exec(
        'DELETE FROM account_usage_snapshots WHERE agent_kind = ?',
        [XAI_SUBSCRIPTION_USAGE_KIND],
      );
    }
  } catch (err) {
    log.warn(
      'recordXaiSubscriptionUsageSnapshot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function clearXaiSubscriptionUsageSnapshot(): Promise<void> {
  resetXaiSubscriptionUsageCacheIfOwnerChanged();
  xaiSubscriptionUsageHydrated = true;
  xaiSubscriptionUsageSnapshot = null;
  xaiSubscriptionUsageServable = false;
  xaiSubscriptionUsageGeneration += 1;
  broadcastXaiSubscriptionUsage(null);

  try {
    await getDbClient().exec(
      'DELETE FROM account_usage_snapshots WHERE agent_kind = ?',
      [XAI_SUBSCRIPTION_USAGE_KIND],
    );
  } catch (err) {
    log.warn(
      'clearXaiSubscriptionUsageSnapshot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function readXaiSubscriptionUsageSnapshot(): Promise<XaiSubscriptionUsageSnapshot | null> {
  await ensureXaiSubscriptionUsageLoaded();
  return xaiSubscriptionUsageServable ? xaiSubscriptionUsageSnapshot : null;
}

// ── 内部广播 ─────────────────────────────────────────────────────────────────

function broadcastTodaySpend(payload: TodaySpendPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_TODAY_SPEND_CHANGED, payload);
    }
  }
}

function broadcastCodexTokens(payload: CodexTokenSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_TODAY_TOKENS_CHANGED, payload);
    }
  }
}

function broadcastCodexAccountUsage(payload: RateLimitSnapshot | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_CODEX_ACCOUNT_CHANGED, payload);
    }
  }
  // device-link:控制端远程 codex / chatgpt-bridge 会话 chip 镜像被控端限额窗口。
  // 频率上限:app-server 每 turn 记录一次、WHAM 刷新 10s 节流;无链路时 O(1) no-op。
  tapWindowBroadcast(USAGE_CODEX_ACCOUNT_CHANGED, payload);
}

function broadcastClaudeSubscriptionUsage(payload: ClaudeSubscriptionUsageSnapshot | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_CLAUDE_SUBSCRIPTION_CHANGED, payload);
    }
  }
  // device-link:控制端远程订阅会话的 chip 镜像被控端余量。频率上限由上游保证
  // (headers 观察器签名去抖 + 端点 180s 节流),无 active 链路时 tap 是 O(1) no-op。
  tapWindowBroadcast(USAGE_CLAUDE_SUBSCRIPTION_CHANGED, payload);
}

function broadcastXaiSubscriptionUsage(payload: XaiSubscriptionUsageSnapshot | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppRendererWindow(win)) continue;
    win.webContents.send(USAGE_XAI_SUBSCRIPTION_CHANGED, payload);
  }
  // device-link:控制端远程 xai 形态会话 chip 镜像被控端周用量(账号级,低频)。
  tapWindowBroadcast(USAGE_XAI_SUBSCRIPTION_CHANGED, payload);
}
