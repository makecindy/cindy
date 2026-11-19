import type Database from 'better-sqlite3';

export interface UsageAttribution {
  provider: string;
  billingSource: string;
}

export interface ModelUsageWrite {
  day: string;
  agentKind: string;
  model: string;
  currency: string;
  amount: number;
  approximate: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  recordedAt: number;
  attribution?: UsageAttribution;
}

/** Called inside the same transaction as the session or request ledger. */
export function writeModelUsage(db: Database.Database, row: ModelUsageWrite) {
  const counts = [row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreateTokens];
  db.prepare(`INSERT INTO daily_model_usage
    (day,agent_kind,model,cost_currency,cost_amount,cost_is_approximate,input_tokens,output_tokens,
     cache_read_tokens,cache_create_tokens,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(day,agent_kind,model,cost_currency) DO UPDATE SET
      cost_amount=cost_amount+excluded.cost_amount,
      cost_is_approximate=cost_is_approximate OR excluded.cost_is_approximate,
      input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,
      cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,
      cache_create_tokens=cache_create_tokens+excluded.cache_create_tokens,
      updated_at=MAX(updated_at,excluded.updated_at)`)
    .run(row.day, row.agentKind, row.model, row.currency, row.amount, Number(row.approximate), ...counts, row.recordedAt);
  if (!row.attribution || !counts.some(n => n > 0)) return;
  db.prepare(`INSERT INTO daily_token_attribution
    (day,provider,billing_source,model,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(day,provider,billing_source,model) DO UPDATE SET
      input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,
      cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,
      cache_create_tokens=cache_create_tokens+excluded.cache_create_tokens`)
    .run(new Date(row.recordedAt).toISOString().slice(0, 10), row.attribution.provider,
      row.attribution.billingSource, row.model.replace(/#billing=(subscription|api)$/, ''), ...counts);
}
