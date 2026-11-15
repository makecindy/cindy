import type Database from 'better-sqlite3';
import type { MediaSpendArgs } from '../../client/tx/types.js';

/** Self-contained: the inline worker also embeds this function. */
export function recordMediaSpend(db: Database.Database, args: MediaSpendArgs) {
  const { day, model, amount, currency, sessionId, userClientId, now } = args;
  if (!Number.isFinite(amount) || amount <= 0 || (currency !== 'USD' && currency !== 'CNY')) {
    throw new Error('Invalid media spend');
  }
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO daily_spend
      (day, cost_amount, cost_currency, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(day, cost_currency) DO UPDATE SET
      cost_amount = cost_amount + excluded.cost_amount, updated_at = excluded.updated_at`,
    ).run(day, amount, currency, now);
    // Media has no chat tokens and must not be attributed to a guessed harness.
    db.prepare(
      `INSERT INTO daily_model_usage
      (day, agent_kind, model, cost_amount, cost_currency, updated_at)
      VALUES (?, 'media', ?, ?, ?, ?)
      ON CONFLICT(day, agent_kind, model, cost_currency) DO UPDATE SET
      cost_amount = cost_amount + excluded.cost_amount, updated_at = excluded.updated_at`,
    ).run(day, model, amount, currency, now);
    if (!sessionId) return null;
    // The submitting user row is the durable attribution, including tool-only
    // runs. Never look up the latest user after the paid response has arrived.
    if (userClientId) {
      const row = db
        .prepare(
          `SELECT agent_meta FROM messages WHERE session_id = ? AND client_id = ? AND role = 'user'`,
        )
        .get(sessionId, userClientId) as { agent_meta: string | null } | undefined;
      if (row) {
        let meta: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(row.agent_meta ?? '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            meta = parsed as Record<string, unknown>;
          }
        } catch {
          /* legacy malformed metadata */
        }
        const costs = (Array.isArray(meta.mediaCosts) ? meta.mediaCosts : []).filter(
          (
            value,
          ): value is {
            amount: number;
            currency: 'USD' | 'CNY';
            approximate: false;
            kind: 'actual-cost';
          } =>
            value &&
            Number.isFinite(value.amount) &&
            value.amount >= 0 &&
            (value.currency === 'USD' || value.currency === 'CNY') &&
            value.kind === 'actual-cost',
        );
        const existing = costs.find((value) => value.currency === currency);
        if (existing) existing.amount += amount;
        else costs.push({ amount, currency, approximate: false, kind: 'actual-cost' });
        meta.mediaCosts = costs;
        const details = Array.isArray(meta.mediaCostDetails) ? meta.mediaCostDetails : [];
        const matching = details.find(value => value?.model === model && value?.providerName === args.providerName
          && value?.money?.currency === currency && Number.isFinite(value?.money?.amount));
        if (matching) matching.money.amount += amount;
        else details.push({ model, category: 'additional', billingSource: 'cindy-ai',
          ...(args.providerName ? { providerName: args.providerName } : {}),
          providerId: 'xd', money: { amount, currency, approximate: false, kind: 'actual-cost' } });
        meta.mediaCostDetails = details;
        db.prepare(`UPDATE messages SET agent_meta = ? WHERE session_id = ? AND client_id = ?`).run(
          JSON.stringify(meta),
          sessionId,
          userClientId,
        );
        const origin = meta.origin as { kind?: string; runId?: string } | undefined;
        if (origin?.kind === 'scheduler' && typeof origin.runId === 'string') {
          // Same message-ledger snapshot policy as runCostLedger: a direct
          // snapshot excludes message costs; mixed snapshots already include them.
          db.prepare(
            `UPDATE schedule_runs SET
            cost_amount = CASE WHEN cost_attribution = 'direct' THEN cost_amount ELSE cost_amount + ? END,
            cost_currency = ?,
            cost_attribution = CASE WHEN cost_attribution IN ('direct', 'mixed') THEN cost_attribution ELSE 'exact' END
            WHERE id = ? AND (cost_currency IS NULL OR cost_currency = ?)`,
          ).run(amount, currency, origin.runId, currency);
        }
      }
    }
    db.prepare(
      `UPDATE sessions SET
      total_cost_amount = CASE WHEN total_cost_currency IS NULL OR total_cost_currency = ?
        THEN total_cost_amount + ? ELSE ? END,
      total_cost_is_approximate = CASE WHEN total_cost_currency IS NULL OR total_cost_currency = ?
        THEN total_cost_is_approximate ELSE 0 END,
      total_cost_currency = ? WHERE id = ?`,
    ).run(currency, amount, amount, currency, currency, sessionId);
    return (
      (db
        .prepare(
          `SELECT total_cost_usd AS legacyUsd, total_cost_amount AS amount,
      total_cost_currency AS currency, total_cost_is_approximate AS approximate
      FROM sessions WHERE id = ?`,
        )
        .get(sessionId) as
        | {
            legacyUsd: number;
            amount: number;
            currency: 'USD' | 'CNY';
            approximate: number;
          }
        | undefined) ?? null
    );
  })();
}
