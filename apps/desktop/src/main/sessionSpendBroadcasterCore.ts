import { mayRecordTurnUsage, turnUsageBroadcastScope } from './usage/turnUsageAdmission.js';
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

import { BrowserWindow } from './usageBroadcastPorts.js';
import { sql } from 'drizzle-orm';

import { sessions } from './localDb/schema';
import { getDbClient } from './localDb/client/current';
import { recordSessionContextSnapshotWith } from './localDb/sessionContextSnapshotPersistence.js';
import { createLogger } from './logger';
import * as broadcastTap from './device-link/broadcast-tap.js';
import {
  sessionSpendAmounts,
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
  /** All USD spend, including the USD portion of a mixed session. */
  totalCostUsd?: number;
  totalCostUsdIsApproximate?: boolean;
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

type OwnerScope = ReturnType<typeof broadcastTap.captureDataOwnerBroadcastScope>;

function captureOwnerScope(): OwnerScope | null {
  return broadcastTap.captureDataOwnerBroadcastScope?.() ?? null;
}

function isOwnerScopeCurrent(scope: OwnerScope | null): boolean {
  return scope === null || broadcastTap.isDataOwnerBroadcastScopeCurrent?.(scope) !== false;
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
  const ownerScope = captureOwnerScope();
  const normalized = normalizeRegionalMoney(money);
  if (!normalized || normalized.amount < 1e-10) return;
  try {
    const db = getDbClient().drizzle;
    // The two persisted currencies share a legacy USD column. On a mixed session
    // keep CNY in the tagged column and accumulate USD in its dedicated column.
    const keepCny = sql`(${sessions.totalCostCurrency} = 'CNY' AND ${normalized.currency} = 'USD')`;
    const moveUsd = sql`(${sessions.totalCostCurrency} = 'USD' AND ${normalized.currency} = 'CNY')`;
    await db
      .update(sessions)
      .set({
        totalCostUsdIsApproximate: sql`${sessions.totalCostUsdIsApproximate} OR CASE WHEN ${keepCny} THEN ${Number(normalized.approximate)} WHEN ${moveUsd} THEN ${sessions.totalCostIsApproximate} ELSE 0 END`,
        totalCostUsd: sql`${sessions.totalCostUsd} + CASE WHEN ${keepCny} THEN ${normalized.amount} WHEN ${moveUsd} THEN ${sessions.totalCostAmount} ELSE 0 END`,
        totalCostAmount: sql`CASE WHEN ${keepCny} THEN ${sessions.totalCostAmount} WHEN ${moveUsd} THEN ${normalized.amount} ELSE ${sessions.totalCostAmount} + ${normalized.amount} END`,
        totalCostCurrency: sql`CASE WHEN ${keepCny} THEN 'CNY' ELSE ${normalized.currency} END`,
        totalCostIsApproximate: sql`CASE WHEN ${keepCny} THEN ${sessions.totalCostIsApproximate} WHEN ${moveUsd} THEN ${normalized.approximate ? 1 : 0} ELSE (${sessions.totalCostIsApproximate} OR ${normalized.approximate ? 1 : 0}) END`,
      })
      .where(sql`${sessions.id} = ${sessionId}`)
      .run();
    const row = await db
      .select({
        totalCostUsd: sessions.totalCostUsd,
        usdApproximate: sessions.totalCostUsdIsApproximate,
        totalCostAmount: sessions.totalCostAmount,
        totalCostCurrency: sessions.totalCostCurrency,
        totalCostIsApproximate: sessions.totalCostIsApproximate,
      })
      .from(sessions)
      .where(sql`${sessions.id} = ${sessionId}`)
      .get();
    const current = normalizeRegionalMoney({
      amount: row?.totalCostAmount ?? 0,
      currency: row?.totalCostCurrency ?? normalized.currency,
      approximate: row?.totalCostIsApproximate ?? false,
      kind: 'actual-cost',
    });
    broadcastSessionSpend({sessionId, ...sessionSpendAmounts(row?.totalCostUsd ?? 0, current, row?.usdApproximate)}, ownerScope);
  } catch (err) {
    log.warn('recordSessionTurnSpend failed:', err instanceof Error ? err.message : String(err));
  }
}

export function broadcastSessionSpend(payload: SessionSpendPayload, ownerScope: OwnerScope | null = null): void {
  ownerScope = turnUsageBroadcastScope(ownerScope, captureOwnerScope);
  if (!mayRecordTurnUsage() || !isOwnerScopeCurrent(ownerScope)) return;
  const ownerStamp = ownerScope ? ownerScope.ownerStamp : broadcastTap.getSafeDataOwnerPushStamp?.();
  // device-link 旁路:控制端经 sessions topic(列表订阅常开,会话未打开也不丢)收到
  // 累计 cost 镜像(本模块走裸 UPDATE、不发 sessions:patched,没有这条 tap 控制端的
  // $ 永远不更新)。
  if (ownerScope === null) {
    broadcastTap.tapWindowBroadcast(USAGE_SESSION_SPEND_CHANGED, payload);
  } else {
    broadcastTap.tapWindowBroadcast(USAGE_SESSION_SPEND_CHANGED, payload, ownerStamp);
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      if (ownerScope === null) {
        win.webContents.send(USAGE_SESSION_SPEND_CHANGED, payload);
      } else {
        win.webContents.send(USAGE_SESSION_SPEND_CHANGED, payload, ownerStamp);
      }
    }
  }
}

/** 给 session 累加一笔 turn token delta，然后回读最新值并广播。 */
export async function recordSessionTurnTokens(
  sessionId: string,
  tokenDelta: number,
): Promise<void> {
  if (!sessionId) return;
  if (!Number.isFinite(tokenDelta) || tokenDelta <= 0) return;
  const ownerScope = captureOwnerScope();
  try {
    const db = getDbClient().drizzle;
    await db
      .update(sessions)
      .set({ totalTokenUsage: sql`${sessions.totalTokenUsage} + ${Math.floor(tokenDelta)}` })
      .where(sql`${sessions.id} = ${sessionId}`)
      .run();
    const row = await db
      .select({ totalTokenUsage: sessions.totalTokenUsage })
      .from(sessions)
      .where(sql`${sessions.id} = ${sessionId}`)
      .get();
    broadcastSessionTokens({ sessionId, totalTokens: row?.totalTokenUsage ?? 0 }, ownerScope);
  } catch (err) {
    log.warn('recordSessionTurnTokens failed:', err instanceof Error ? err.message : String(err));
  }
}

export function broadcastSessionTokens(payload: SessionTokensPayload, ownerScope: OwnerScope | null = null): void {
  ownerScope = turnUsageBroadcastScope(ownerScope, captureOwnerScope);
  if (!mayRecordTurnUsage() || !isOwnerScopeCurrent(ownerScope)) return;
  const ownerStamp = ownerScope ? ownerScope.ownerStamp : broadcastTap.getSafeDataOwnerPushStamp?.();
  if (ownerScope === null) {
    broadcastTap.tapWindowBroadcast(USAGE_SESSION_TOKENS_CHANGED, payload);
  } else {
    broadcastTap.tapWindowBroadcast(USAGE_SESSION_TOKENS_CHANGED, payload, ownerStamp);
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      if (ownerScope === null) {
        win.webContents.send(USAGE_SESSION_TOKENS_CHANGED, payload);
      } else {
        win.webContents.send(USAGE_SESSION_TOKENS_CHANGED, payload, ownerStamp);
      }
    }
  }
}

/**
 * 写入本 session 的 context 快照（turn 结束或成功的 Pi 压缩边界）。
 *
 * 字段写入语义:
 *   - contextTokens: 总是覆盖写 (包括 0 —— SDK 自动压缩后真值可能很小, 不能因 ">0"
 *     就守住老值, 否则圆环永远不会回落)
 *     例外: 0/0 是中断 compact 可能产生的 placeholder, 不能覆盖已知快照。
 *   - contextWindow: 仅在 > 0 时写 (0 = "SDK 未给", 不能覆盖已有真值;
 *     与 usage-tracker.ts:84-86 setContextWindow 同语义)
 *
 * 调用方仅在这些离散边界记录，不跟随 token 流高频写入。
 */
export async function recordSessionContextSnapshot(
  sessionId: string,
  contextTokens: number,
  contextWindow: number,
): Promise<void> {
  return recordSessionContextSnapshotWith(
    { captureOwnerScope, isOwnerScopeCurrent, broadcastContext, log },
    sessionId, contextTokens, contextWindow,
  );
}

function broadcastContext(payload: SessionContextPayload, ownerScope: OwnerScope | null = null): void {
  const ownerStamp = ownerScope ? ownerScope.ownerStamp : broadcastTap.getSafeDataOwnerPushStamp?.();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      if (ownerScope === null) {
        win.webContents.send(USAGE_SESSION_CONTEXT_CHANGED, payload);
      } else {
        win.webContents.send(USAGE_SESSION_CONTEXT_CHANGED, payload, ownerStamp);
      }
    }
  }
}
