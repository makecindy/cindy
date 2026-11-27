import { createHmac } from 'node:crypto';
import { BUNDLED_CATALOG, PROVIDER_MODEL_CATALOG } from '@cindy/model-providers';
import type { DbClient } from '../localDb/client/DbClient.js';

export type Counts = [number, number, number, number];
export type Harness = 'claude-code' | 'codex' | 'pi' | 'auxiliary' | 'unknown';
const KNOWN_HARNESSES = new Set<string>(['claude-code', 'codex', 'pi', 'auxiliary']);
export function normalizeHarness(raw?: string | null): Harness {
  return raw && KNOWN_HARNESSES.has(raw) ? (raw as Harness) : 'unknown';
}
interface LedgerRow {
  day: string;
  provider: string;
  billing: string;
  model: string;
  harness: string;
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
  harness: Harness;
  counts: Counts;
}

// One SQLite statement pins a consistent snapshot across both independent receipt sources.
export function readLedger(db: Pick<DbClient, 'query'>, firstDay: string): Promise<LedgerRow[]> {
  return db.query<LedgerRow>(
    `SELECT day,provider,billing,model,harness,
    sum(i) ordinary,sum(o) output,sum(r) cacheRead,sum(w) cacheWrite FROM (
      SELECT day,provider,billing_source billing,model,harness,input_tokens i,output_tokens o,
        cache_read_tokens r,cache_create_tokens w FROM daily_token_attribution WHERE day >= ?
      UNION ALL SELECT date(recorded_at/1000,'unixepoch'),provider_id,
        CASE WHEN provider_id='xd' THEN 'cindy-ai' ELSE 'unknown' END,model,harness,
        coalesce(input_tokens,0),coalesce(output_tokens,0),coalesce(cache_read_tokens,0),
        coalesce(cache_create_tokens,0) FROM auxiliary_usage_receipts
        WHERE day >= date(?, '-1 day') AND recorded_at >= ?
    ) GROUP BY day,provider,billing,model,harness ORDER BY day,provider,billing,model,harness`,
    [firstDay, firstDay, Date.parse(firstDay + 'T00:00:00Z')],
  );
}

export function readAccountFirstDay(
  db: Pick<DbClient, 'query'>,
  day: string,
  startsAt: number,
  generation: string,
) {
  const end = Date.parse(day + 'T00:00:00Z') + 86400000;
  return db.query<LedgerRow>(
    `SELECT ? day,provider,billing,model,harness,
    sum(i) ordinary,sum(o) output,sum(r) cacheRead,sum(w) cacheWrite FROM (
      SELECT provider,billing,model,harness,input i,output o,cache_read r,cache_write w
      FROM token_reporting_first_day WHERE generation=?
      UNION ALL SELECT provider_id,CASE WHEN provider_id='xd' THEN 'cindy-ai' ELSE 'unknown' END,model,harness,
        coalesce(input_tokens,0),coalesce(output_tokens,0),coalesce(cache_read_tokens,0),coalesce(cache_create_tokens,0)
      FROM auxiliary_usage_receipts WHERE day >= date(?, '-1 day') AND day <= date(?, '+1 day')
        AND recorded_at >= ? AND recorded_at < ?
    ) GROUP BY provider,billing,model,harness`,
    [day, generation, day, day, startsAt, end],
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
for (const provider of BUNDLED_CATALOG.providers ?? []) {
  for (const entries of Object.values(provider.models ?? {})) {
    for (const m of entries) {
      const bare = m.id.replace(/\[\d+[km]\]$/i, '');
      models.set(bare, bare);
    }
  }
}
for (const preset of BUNDLED_CATALOG.presets ?? []) {
  const presetModels = [
    ...(Array.isArray(preset.models) ? preset.models : []),
    ...Object.values(preset.runtimes ?? {}).flatMap((rt) => rt?.models ?? []),
  ];
  for (const m of presetModels) {
    const bare = m.id.replace(/\[\d+[km]\]$/i, '');
    models.set(bare, bare);
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
export function publicModel(raw: string) {
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
  const harness = normalizeHarness(row.harness);
  // Keep legacy 5-tuple keys for migrated 'unknown' rows so upgrading never replays prior totals.
  return digest(
    secret,
    harness === 'unknown'
      ? ['cell', row.day, row.provider, row.billing, row.model]
      : ['cell', row.day, row.provider, row.billing, row.model, harness],
  );
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
    harness: normalizeHarness(row.harness),
    counts: delta,
  };
}
