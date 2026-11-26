import type Database from 'better-sqlite3';

export interface UsageAttribution {
  provider: string;
  billingSource: string;
  modelUnconfirmed?: boolean;
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
     cache_read_tokens,cache_create_tokens,updated_at,acp_missing_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(day,agent_kind,model,cost_currency) DO UPDATE SET
      acp_missing_price=CASE WHEN excluded.agent_kind='acp' THEN COALESCE(acp_missing_price, 1) OR excluded.acp_missing_price END,
      cost_amount=cost_amount+excluded.cost_amount,
      cost_is_approximate=cost_is_approximate OR excluded.cost_is_approximate,
      input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,
      cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,
      cache_create_tokens=cache_create_tokens+excluded.cache_create_tokens,
      updated_at=MAX(updated_at,excluded.updated_at)`)
    .run(row.day, row.agentKind, row.model, row.currency, row.amount, Number(row.approximate), ...counts, row.recordedAt,
      row.agentKind === 'acp' ? Number(!row.approximate) : null);
  if (!row.attribution || !counts.some(n => n > 0)) return;
  const utcDay = new Date(row.recordedAt).toISOString().slice(0, 10);
  const model = row.attribution.modelUnconfirmed ? 'unknown' : row.model.replace(/#billing=(subscription|api)$/, '');
  db.prepare(`INSERT INTO daily_token_attribution
    (day,provider,billing_source,model,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(day,provider,billing_source,model) DO UPDATE SET
      input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,
      cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,
      cache_create_tokens=cache_create_tokens+excluded.cache_create_tokens`)
    .run(utcDay, row.attribution.provider, row.attribution.billingSource, model, ...counts);
  db.prepare(`INSERT INTO token_reporting_first_day(provider,billing,model,generation,input,output,cache_read,cache_write)
    SELECT ?,?,?,generation,?,?,?,? FROM token_reporting_window WHERE id=1 AND day=? AND starts_at<=?
    ON CONFLICT(provider,billing,model) DO UPDATE SET generation=excluded.generation,
      input=excluded.input+CASE WHEN generation=excluded.generation THEN input ELSE 0 END,
      output=excluded.output+CASE WHEN generation=excluded.generation THEN output ELSE 0 END,
      cache_read=excluded.cache_read+CASE WHEN generation=excluded.generation THEN cache_read ELSE 0 END,
      cache_write=excluded.cache_write+CASE WHEN generation=excluded.generation THEN cache_write ELSE 0 END`)
    .run(row.attribution.provider, row.attribution.billingSource, model, ...counts, utcDay, row.recordedAt);
}
