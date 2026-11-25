/**
 * Two dependencies of the turn usage recorders (sessionClaudeTurnUsage.ts, sessionCodexTurnUsage.ts,
 * sessionPiTurnUsage.ts), moved unchanged from register.ts (2026-11-18). Electron-free, so the Node
 * Host passes the recorders the same two functions as the desktop.
 */
import { eq } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import type { RegionalMoney } from '../../shared/regionalMoney.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';

/**
 * Codex done 事件不带 model id。done 时读取 sessions.model 会被用户中途切模型污染,
 * 所以正常路径在 turn start(status:isRunning true) 时立刻点查并缓存本轮 promise;
 * 这里只作为缺失 start 事件时的兜底。
 */
export async function readSessionModelForUsage(sessionId: string): Promise<string> {
  try {
    const row = await getDbClient()
      .drizzle.select({ model: sessions.model })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    return row?.model || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Zero-value marker for a future subscription turn that was deliberately not
 * priceable. daily_model_usage has no money-kind column, so approximate=true
 * distinguishes this from legacy zero rows that history may still estimate.
 */
export function unpricedSubscriptionValueMarker(): RegionalMoney {
  return {
    amount: 0,
    currency: currentLedgerCurrency(),
    approximate: true,
    kind: 'value-estimate',
    estimateReasons: ['subscription-value', 'reference-price'],
  };
}
