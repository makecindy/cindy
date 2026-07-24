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

import { incrementDailySpend, getTodaySpend, localDayKey } from './localDb/dailySpend';
import type { XaiRateLimitSnapshot } from '../shared/xaiRateLimit';
import { incrementDailyModelUsage, type DailyModelUsageDelta } from './localDb/dailyModelUsage';
import { getDbClient } from './localDb/client/current';
import { getCurrentUserId } from './localDb/index';
import {
  mergeClaudeSubscriptionUsageSnapshot,
  type ClaudeSubscriptionUsageSnapshot,
} from '../shared/claudeSubscriptionUsage';
import type { AgentKind } from '@cindy/maker-core';

import { createLogger } from './logger';

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

export interface TodaySpendPayload {
  /** 本地时区 YYYY-MM-DD。 */
  day: string;
  /** 当日累计 USD。 */
  costUsd: number;
}

/** 跨 agent 统一的 today usage 形状 —— maker:usage:today(agentKind) 返回值。 */
export interface AgentTodayUsage {
  day: string;
  /** Claude 有值, Codex undefined (SDK 不报 cost)。 */
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
export async function recordTurnSpend(costUsd: number, ts: number = Date.now()): Promise<void> {
  try {
    const result = await incrementDailySpend(costUsd, ts);
    broadcastTodaySpend({ day: result.day, costUsd: result.costUsd });
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
  return {
    day: localDayKey(),
    costUsd: await getTodaySpend(),
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
    return { day: s.day, costUsd: s.costUsd };
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

/** 组合 payload: 顶层 = codex-app-server 槽(CLI 权威), webSnapshot = WHAM 槽。 */
export interface CodexAccountUsagePayload extends RateLimitSnapshot {
  webSnapshot?: RateLimitSnapshot | null;
}

let codexAccountUsageOwner: string | null = null;
let codexAccountUsageLoaded = false;
let codexAppServerUsageSnapshot: RateLimitSnapshot | null = null;
let codexWebAccountUsageSnapshot: RateLimitSnapshot | null = null;

function currentAccountUsageOwner(): string | null {
  try {
    return getCurrentUserId();
  } catch {
    return null;
  }
}

function resetCodexAccountUsageCacheIfOwnerChanged(): void {
  const owner = currentAccountUsageOwner();
  if (owner === codexAccountUsageOwner) return;
  codexAccountUsageOwner = owner;
  codexAccountUsageLoaded = false;
  codexAppServerUsageSnapshot = null;
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
  const app = codexAppServerUsageSnapshot;
  const web = codexWebAccountUsageSnapshot;
  if (!app && !web) return null;
  if (!app && web) {
    // web-only: 顶层无 CLI 数据, 但归属字段必须上浮 —— WHAM reader 用顶层
    // accountId 判断缓存归属(codexAccountUsageRefresh), 缺失会被当成账号失配,
    // 每次读都清缓存 + 强刷(bridge-only 用户 warm-start 永远拿 null)。
    // accountId / updatedAt 不算「内容」(hasCodexSnapshotContent), 归槽水合
    // 不会据此伪造出 app 槽。
    return { accountId: web.accountId, updatedAt: web.updatedAt, webSnapshot: web };
  }
  return { ...(app as RateLimitSnapshot), webSnapshot: web ?? null };
}

/**
 * 持久化行 → 两槽。新格式带 webSnapshot 键;旧格式是单快照 —— 按其 source
 * 归入对应槽(旧行可能是被 WHAM 污染过的单槽杂交体, 归 web 槽即自然隔离)。
 */
export function splitPersistedCodexAccountUsage(parsed: Record<string, unknown>): {
  appServer: RateLimitSnapshot | null;
  web: RateLimitSnapshot | null;
} {
  if ('webSnapshot' in parsed) {
    const { webSnapshot, ...rest } = parsed as CodexAccountUsagePayload;
    return {
      appServer: hasCodexSnapshotContent(rest) ? rest : null,
      // 拒绝数组等畸形持久化值(与 renderer 的 isRateLimitSnapshot 守卫同口径),
      // 否则损坏行会被当有效快照再次广播 + 回写。
      web: webSnapshot && typeof webSnapshot === 'object' && !Array.isArray(webSnapshot)
        ? webSnapshot
        : null,
    };
  }
  const legacy = parsed as RateLimitSnapshot;
  if (legacy.source === 'openai-web') return { appServer: null, web: legacy };
  return { appServer: hasCodexSnapshotContent(legacy) ? legacy : null, web: null };
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
  if (codexAccountUsageLoaded) return;
  codexAccountUsageLoaded = true;
  if (!codexAccountUsageOwner) return;

  try {
    const row = await getDbClient().queryOne<{ snapshot?: string | null }>(
      'SELECT snapshot FROM account_usage_snapshots WHERE agent_kind = ?',
      ['codex'],
    );
    if (!row?.snapshot) return;
    const parsed = JSON.parse(row.snapshot);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const slots = splitPersistedCodexAccountUsage(parsed as Record<string, unknown>);
      codexAppServerUsageSnapshot = slots.appServer;
      codexWebAccountUsageSnapshot = slots.web;
    }
  } catch (err) {
    log.warn(
      'readCodexAccountUsageSnapshot failed:',
      err instanceof Error ? err.message : String(err),
    );
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
    codexAppServerUsageSnapshot = mergeCodexAccountUsageSnapshot(
      codexAppServerUsageSnapshot,
      incoming,
    );
  }
  const payload = buildCodexAccountUsagePayload();
  broadcastCodexAccountUsage(payload);

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
  codexAccountUsageLoaded = true;
  codexAppServerUsageSnapshot = null;
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
let claudeSubscriptionUsageLoaded = false;
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
  claudeSubscriptionUsageLoaded = false;
  claudeSubscriptionUsageSnapshot = null;
  claudeSubscriptionUsageGeneration += 1;
}

async function ensureClaudeSubscriptionUsageLoaded(): Promise<void> {
  resetClaudeSubscriptionUsageCacheIfOwnerChanged();
  if (claudeSubscriptionUsageLoaded) return;
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
        if (!row?.snapshot) return;
        const parsed = JSON.parse(row.snapshot);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          claudeSubscriptionUsageSnapshot = parsed as ClaudeSubscriptionUsageSnapshot;
        }
      } catch (err) {
        log.warn(
          'readClaudeSubscriptionUsageSnapshot failed:',
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        if (generation === claudeSubscriptionUsageGeneration) {
          claudeSubscriptionUsageLoaded = true;
        }
        claudeSubscriptionUsageLoadPromise = null;
      }
    })();
  }
  await claudeSubscriptionUsageLoadPromise;
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
  claudeSubscriptionUsageLoaded = true;
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
}

function broadcastClaudeSubscriptionUsage(payload: ClaudeSubscriptionUsageSnapshot | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_CLAUDE_SUBSCRIPTION_CHANGED, payload);
    }
  }
}
