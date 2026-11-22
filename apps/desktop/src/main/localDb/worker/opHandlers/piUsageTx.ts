import type Database from 'better-sqlite3';

import { writeModelUsage, type UsageAttribution } from './modelUsageTx.js';

export interface PiUsageWrite {
  attribution?: UsageAttribution;
  sessionId: string;
  settlementId: string;
  receiptId: string;
  recordedAt: number;
  day: string;
  model: string;
  currency: 'USD' | 'CNY';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** null commits tokens without waiting for pricing; a later pass adds money once. */
  amount: number | null;
  approximate: boolean;
  actualCost: boolean;
  /** Sanitized request facts and billing context, retained only until priced. */
  pricingPayload?: string;
}

/** Self-contained for the inline worker. Receipt and all aggregates commit together. */
export function recordPiUsage(db: Database.Database, args: PiUsageWrite[], writeModel = writeModelUsage) {
  return db.transaction(() => {
    let changed = false;
    for (const r of args) {
      if (!r.sessionId || !r.settlementId || !r.receiptId || !r.model
          || !/^\d{4}-\d{2}-\d{2}$/.test(r.day)
          || !['USD', 'CNY'].includes(r.currency)
          || !Number.isFinite(r.recordedAt) || (r.amount !== null && (!Number.isFinite(r.amount) || r.amount < 0))
          || [r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreateTokens]
            .some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid Pi usage receipt');
      const inserted = db.prepare(`INSERT INTO pi_usage_receipts
        (session_id, settlement_id, receipt_id, recorded_at, pricing_payload) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING`).run(r.sessionId, r.settlementId, r.receiptId, r.recordedAt, r.pricingPayload ?? null);
      // A replay can also supply facts missing from an older unpriced receipt.
      if (r.pricingPayload) db.prepare(`UPDATE pi_usage_receipts SET pricing_payload = ?
        WHERE session_id = ? AND settlement_id = ? AND receipt_id = ? AND priced = 0 AND pricing_payload IS NULL`)
        .run(r.pricingPayload, r.sessionId, r.settlementId, r.receiptId);
      const priced = r.amount !== null && db.prepare(`UPDATE pi_usage_receipts SET priced = 1, pricing_payload = NULL
        WHERE session_id = ? AND settlement_id = ? AND receipt_id = ? AND priced = 0`)
        .run(r.sessionId, r.settlementId, r.receiptId).changes > 0;
      if (!inserted.changes && !priced) continue;
      changed = true;
      const input = inserted.changes ? r.inputTokens : 0;
      const output = inserted.changes ? r.outputTokens : 0;
      const read = inserted.changes ? r.cacheReadTokens : 0;
      const create = inserted.changes ? r.cacheCreateTokens : 0;
      const amount = priced ? r.amount! : 0;
      const total = input + output + read + create;
      writeModel(db, {
        ...r, agentKind: 'pi', amount, inputTokens: input, outputTokens: output,
        cacheReadTokens: read, cacheCreateTokens: create,
      });
      db.prepare(`INSERT INTO daily_session_usage(day, session_id, tokens, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(day, session_id) DO UPDATE SET tokens = tokens + excluded.tokens,
        updated_at = MAX(updated_at, excluded.updated_at)`).run(r.day, r.sessionId, total, r.recordedAt);
      db.prepare('UPDATE sessions SET total_token_usage = total_token_usage + ? WHERE id = ?').run(total, r.sessionId);
      if (r.actualCost && amount > 0) {
        db.prepare(`INSERT INTO daily_spend(day, cost_currency, cost_amount, cost_is_approximate, updated_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(day, cost_currency) DO UPDATE SET
          cost_amount = cost_amount + excluded.cost_amount,
          cost_is_approximate = cost_is_approximate OR excluded.cost_is_approximate,
          updated_at = MAX(updated_at, excluded.updated_at)`)
          .run(r.day, r.currency, amount, Number(r.approximate), r.recordedAt);
        db.prepare(`UPDATE sessions SET
      total_cost_usd = total_cost_usd + CASE
        WHEN total_cost_currency = 'CNY' AND @currency = 'USD' THEN @amount
        WHEN total_cost_currency = 'USD' AND @currency = 'CNY' THEN total_cost_amount ELSE 0 END,
      total_cost_amount = CASE
        WHEN total_cost_currency = 'CNY' AND @currency = 'USD' THEN total_cost_amount
        WHEN total_cost_currency = 'USD' AND @currency = 'CNY' THEN @amount ELSE total_cost_amount + @amount END,
      total_cost_is_approximate = CASE
        WHEN total_cost_currency = 'CNY' AND @currency = 'USD' THEN total_cost_is_approximate
        WHEN total_cost_currency = 'USD' AND @currency = 'CNY' THEN @approximate ELSE total_cost_is_approximate OR @approximate END,
      total_cost_currency = CASE WHEN total_cost_currency = 'CNY' THEN 'CNY' ELSE @currency END
      WHERE id = @sessionId`).run({ currency: r.currency, amount, approximate: Number(r.approximate), sessionId: r.sessionId });
      }
    }
    return { changed };
  })();
}
