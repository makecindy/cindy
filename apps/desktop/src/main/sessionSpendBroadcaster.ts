/**
 * sessionSpendBroadcaster — main 端单一负责 session 级 usage 持久化。
 *
 * 管三类字段:
 *   1. cost: sessions.total_cost_usd —— 增量 += delta (SDK 子进程内累计的 cost,
 *      跨 resume 不能丢, 所以走 main 端 delta 累加)
 *   2. tokens: sessions.total_token_usage —— 增量 += delta (Codex token 累计, tooltip
 *      / debug 可用;订阅模式的 token 价值不写入 total_cost_usd)
 *   3. context: sessions.context_tokens / context_window —— 绝对覆盖
 *      (反映"最后一次 API call 快照", 不是累加)
 *
 * 与 usageBroadcaster 关系：
 *   - usageBroadcaster 管"今日"维度（daily_spend 表）
 *   - 本模块管"per-session"维度（sessions.* 列）
 *   - register.ts 在 done / status 事件算出值后调本模块, 写库 + 广播
 *
 * 为什么 context 也放 main 而不留在 renderer：renderer 通过 sessionService.update
 * 写库会有多 window 竞写 (同一 session 在两个窗口打开), main 端单一入口才能消除竞态。
 */

import { BrowserWindow } from 'electron';
import { sql } from 'drizzle-orm';

import { sessions } from './localDb/schema';
import { getDbClient } from './localDb/client/current';
import { createLogger } from './logger';
import { tapWindowBroadcast } from './device-link/broadcast-tap.js';
import {
  addRegionalMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  type RegionalMoney,
} from '../shared/regionalMoney.js';

const log = createLogger('sessionSpendBroadcaster');

/** IPC channel: main → renderer 推单 session 累计 cost 变化。 */
export const USAGE_SESSION_SPEND_CHANGED = 'usage:session-spend-changed';
/** IPC channel: main → renderer 推单 session 累计 token 变化。 */
export const USAGE_SESSION_TOKENS_CHANGED = 'usage:session-tokens-changed';

/**
 * IPC channel: main → renderer 推单 session 的 context 快照变化。
 *
 * 实时 UI 刷新 (运行中圆环动) 走的是 status event 广播 (renderer agentStatus),
 * 这个 channel 当前**只**为以后 history 列表 / 未打开 session 的 chip 等场景预留,
 * 本次 renderer 暂不订阅 —— 但落库本身仍会触发广播, 接入零成本。
 */
export const USAGE_SESSION_CONTEXT_CHANGED = 'usage:session-context-changed';

export interface SessionSpendPayload {
  sessionId: string;
  totalMoney: RegionalMoney;
  /** 仅当累计金额仍是 USD 时给旧 renderer 的兼容投影。 */
  totalCostUsd?: number;
}

export interface SessionTokensPayload {
  sessionId: string;
  /** session 终身累计 token（已持久化到 sessions.total_token_usage）。 */
  totalTokens: number;
}

export interface SessionContextPayload {
  sessionId: string;
  contextTokens: number;
  contextWindow: number;
}

/**
 * 给 session 累加一笔 turn delta：UPDATE sessions SET total_cost_usd += delta，
 * 然后回读最新值并广播。
 *
 * 极小 / 非法 delta 跳过（与 dailySpend 同阈值）。
 */
export async function recordSessionTurnSpend(
  sessionId: string,
  money: RegionalMoney,
): Promise<void> {
  if (!sessionId) return;
  const normalized = normalizeRegionalMoney(money);
  if (!normalized || normalized.amount < 1e-10) return;
  try {
    const db = getDbClient().drizzle;
    // 单币种累计列:币种守卫必须在同一条 UPDATE 里用 CASE 表达 —— 先查再写
    // 有 TOCTOU 窗口,并发首写会把不同币种的裸数字加进同一列。冲突段原子地
    // 弃掉(列保持原币种),下方回读后 warn 留痕。
    const sameCurrency = sql`(${sessions.totalCostCurrency} IS NULL OR ${sessions.totalCostCurrency} = ${normalized.currency})`;
    await db.update(sessions)
      .set({
        totalCostAmount: sql`CASE WHEN ${sameCurrency} THEN ${sessions.totalCostAmount} + ${normalized.amount} ELSE ${sessions.totalCostAmount} END`,
        totalCostCurrency: sql`CASE WHEN ${sameCurrency} THEN ${normalized.currency} ELSE ${sessions.totalCostCurrency} END`,
        totalCostIsApproximate: sql`CASE WHEN ${sameCurrency} THEN (${sessions.totalCostIsApproximate} OR ${normalized.approximate ? 1 : 0}) ELSE ${sessions.totalCostIsApproximate} END`,
      })
      .where(sql`${sessions.id} = ${sessionId}`)
      .run();
    const row = await db
      .select({
        totalCostUsd: sessions.totalCostUsd,
        totalCostAmount: sessions.totalCostAmount,
        totalCostCurrency: sessions.totalCostCurrency,
        totalCostIsApproximate: sessions.totalCostIsApproximate,
      })
      .from(sessions)
      .where(sql`${sessions.id} = ${sessionId}`)
      .get();
    if (
      row?.totalCostCurrency &&
      row.totalCostCurrency !== normalized.currency
    ) {
      log.warn('recordSessionTurnSpend dropped a conflicting-currency segment');
    }
    const legacy = legacyUsdMoney(row?.totalCostUsd ?? 0);
    const current = normalizeRegionalMoney({
      amount: row?.totalCostAmount ?? 0,
      currency: row?.totalCostCurrency ?? normalized.currency,
      approximate: row?.totalCostIsApproximate ?? false,
      kind: 'actual-cost',
    });
    const totalMoney =
      legacy.amount > 0 && current
        ? legacy.currency === current.currency
          ? addRegionalMoney([legacy, current])
          : current
        : current ?? legacy;
    broadcast({
      sessionId,
      totalMoney,
      ...(totalMoney.currency === 'USD'
        ? { totalCostUsd: totalMoney.amount }
        : {}),
    });
  } catch (err) {
    log.warn(
      'recordSessionTurnSpend failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function broadcast(payload: SessionSpendPayload): void {
  // device-link 旁路:控制端经 sessions topic(列表订阅常开,会话未打开也不丢)收到
  // 累计 cost 镜像(本模块走裸 UPDATE、不发 sessions:patched,没有这条 tap 控制端的
  // $ 永远不更新)。
  tapWindowBroadcast(USAGE_SESSION_SPEND_CHANGED, payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_SESSION_SPEND_CHANGED, payload);
    }
  }
}

/** 给 session 累加一笔 turn token delta，然后回读最新值并广播。 */
export async function recordSessionTurnTokens(sessionId: string, tokenDelta: number): Promise<void> {
  if (!sessionId) return;
  if (!Number.isFinite(tokenDelta) || tokenDelta <= 0) return;
  try {
    const db = getDbClient().drizzle;
    await db.update(sessions)
      .set({ totalTokenUsage: sql`${sessions.totalTokenUsage} + ${Math.floor(tokenDelta)}` })
      .where(sql`${sessions.id} = ${sessionId}`)
      .run();
    const row = await db
      .select({ totalTokenUsage: sessions.totalTokenUsage })
      .from(sessions)
      .where(sql`${sessions.id} = ${sessionId}`)
      .get();
    broadcastTokens({ sessionId, totalTokens: row?.totalTokenUsage ?? 0 });
  } catch (err) {
    log.warn(
      'recordSessionTurnTokens failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function broadcastTokens(payload: SessionTokensPayload): void {
  tapWindowBroadcast(USAGE_SESSION_TOKENS_CHANGED, payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_SESSION_TOKENS_CHANGED, payload);
    }
  }
}

/**
 * 写入本 session 的 context 快照 (turn 结束时由 register.ts 调)。
 *
 * 字段写入语义:
 *   - contextTokens: 总是覆盖写 (包括 0 —— SDK 自动压缩后真值可能很小, 不能因 ">0"
 *     就守住老值, 否则圆环永远不会回落)
 *     例外: 0/0 是中断 compact 可能产生的 placeholder, 不能覆盖已知快照。
 *   - contextWindow: 仅在 > 0 时写 (0 = "SDK 未给", 不能覆盖已有真值;
 *     与 usage-tracker.ts:84-86 setContextWindow 同语义)
 *
 * 调用方 (register.ts) 已确保只在 turn end 调一次, 不会高频 IO。
 */
export async function recordSessionContextSnapshot(
  sessionId: string,
  contextTokens: number,
  contextWindow: number,
): Promise<void> {
  if (!sessionId) return;
  if (!Number.isFinite(contextTokens) || contextTokens < 0) return;
  if (contextTokens === 0 && (!Number.isFinite(contextWindow) || contextWindow <= 0)) return;
  try {
    const db = getDbClient().drizzle;
    const updates: { contextTokens: number; contextWindow?: number } = {
      contextTokens: Math.floor(contextTokens),
    };
    if (Number.isFinite(contextWindow) && contextWindow > 0) {
      updates.contextWindow = Math.floor(contextWindow);
    }
    await db.update(sessions)
      .set(updates)
      .where(sql`${sessions.id} = ${sessionId}`)
      .run();
    // 回读保证广播的是 DB 最终值 (而非入参 —— contextWindow 可能没改)
    const row = await db
      .select({
        contextTokens: sessions.contextTokens,
        contextWindow: sessions.contextWindow,
      })
      .from(sessions)
      .where(sql`${sessions.id} = ${sessionId}`)
      .get();
    broadcastContext({
      sessionId,
      contextTokens: row?.contextTokens ?? 0,
      contextWindow: row?.contextWindow ?? 0,
    });
  } catch (err) {
    log.warn(
      'recordSessionContextSnapshot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function broadcastContext(payload: SessionContextPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_SESSION_CONTEXT_CHANGED, payload);
    }
  }
}
