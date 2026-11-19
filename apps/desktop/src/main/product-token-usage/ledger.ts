import { createHmac } from 'node:crypto';
import { BUNDLED_CATALOG, PROVIDER_MODEL_CATALOG } from '@cindy/model-providers';
import type { DbClient } from '../localDb/client/DbClient.js';

export type Counts = [number, number, number, number];
interface LedgerRow {
  day: string;
  provider: string;
  billing: string;
  model: string;
  ordinary: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface Grant {
  secret: string;
  day: string;
  baseline: Record<string, Counts>;
  acknowledged: Record<string, string>;
}
export interface Contribution {
  day: string;
  reporter: string;
  cell: string;
  source: string;
  billing: string;
  model: string;
  counts: Counts;
}

// One SQLite statement pins a consistent snapshot across both independent receipt sources.
export function readLedger(db: Pick<DbClient, 'query'>, firstDay: string): Promise<LedgerRow[]> {
  return db.query<LedgerRow>(
    `SELECT day,provider,billing,model,
    sum(i) ordinary,sum(o) output,sum(r) cacheRead,sum(w) cacheWrite FROM (
      SELECT day,provider,billing_source billing,model,input_tokens i,output_tokens o,
        cache_read_tokens r,cache_create_tokens w FROM daily_token_attribution WHERE day >= ?
      UNION ALL SELECT date(recorded_at/1000,'unixepoch'),provider_id,
        CASE WHEN provider_id='xd' THEN 'cindy-ai' ELSE 'unknown' END,model,
        coalesce(input_tokens,0),coalesce(output_tokens,0),coalesce(cache_read_tokens,0),
        coalesce(cache_create_tokens,0) FROM auxiliary_usage_receipts
        WHERE day >= date(?, '-1 day') AND recorded_at >= ?
    ) GROUP BY day,provider,billing,model ORDER BY day,provider,billing,model`,
    [firstDay, firstDay, Date.parse(firstDay + 'T00:00:00Z')],
  );
}

const sources = new Set([
  'xd',
  'openai',
  'anthropic',
  'xai',
  ...(BUNDLED_CATALOG.presets ?? []).map((p) => 'preset:' + p.id),
]);
const models = new Map<string, string>();
for (const [provider, entries] of Object.entries(PROVIDER_MODEL_CATALOG.providers)) {
  for (const m of entries) {
    models.set(m.id, m.id);
    models.set(provider + '/' + m.id, m.id);
  }
}
const registry = BUNDLED_CATALOG.modelRegistry;
const routeAliases = new Map<string, string>();
for (const m of registry?.models ?? []) {
  for (const alias of [
    m.id,
    m.id.split('/').slice(1).join('/'),
    ...m.routes.map((r) => r.modelId),
  ]) {
    if (!alias) continue;
    const prior = routeAliases.get(alias);
    routeAliases.set(alias, prior && prior !== m.id ? alias : m.id);
  }
}
for (const [alias, id] of routeAliases) models.set(alias, id);
for (const m of registry?.baseModels ?? []) {
  for (const alias of [m.id, ...(m.aliases ?? [])]) models.set(alias, m.id);
}
for (const m of registry?.localModels?.models ?? []) {
  for (const variant of m.variants ?? [])
    if (variant.libraryName) models.set(variant.libraryName, m.id);
}
function publicModel(raw: string) {
  const bare = raw.replace(/\[\d+[km]\]$/i, '');
  return (
    models.get(bare) ??
    models.get(bare.replace(/^(?:chatgpt|codex|x-ai|x-ai-grok|anthropic-claude)\//, '')) ??
    (raw === 'unknown' || !raw ? 'unknown' : 'other')
  );
}
function digest(secret: string, parts: string[]) {
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(JSON.stringify(parts))
    .digest('hex');
}
function cellKey(secret: string, row: LedgerRow) {
  return digest(secret, ['cell', row.day, row.provider, row.billing, row.model]);
}
function counts(row: LedgerRow): Counts {
  return [row.ordinary, row.output, row.cacheRead, row.cacheWrite];
}
export function newGrant(secret: string, day: string, rows: LedgerRow[]): Grant {
  return {
    secret,
    day,
    baseline: Object.fromEntries(rows.map((r) => [cellKey(secret, r), counts(r)])),
    acknowledged: {},
  };
}
export function contribution(grant: Grant, row: LedgerRow): Contribution | null {
  const cell = cellKey(grant.secret, row);
  const current = counts(row);
  const previous = grant.baseline[cell];
  const delta = current.map((n, i) => n - (previous?.[i] ?? 0)) as Counts;
  if (!delta.every((n) => Number.isSafeInteger(n) && n >= 0) || !delta.some((n) => n > 0))
    return null;
  return {
    day: row.day,
    reporter: digest(grant.secret, ['reporter', row.day]),
    cell,
    source: sources.has(row.provider)
      ? row.provider
      : row.provider === 'unknown'
        ? 'unknown'
        : 'other',
    billing: ['cindy-ai', 'subscription', 'provider'].includes(row.billing)
      ? row.billing
      : 'unknown',
    model: publicModel(row.model),
    counts: delta,
  };
}
