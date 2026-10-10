import { codexLimitBucketKey, GENERIC_BUCKET_KEYS, selectCodexUsageForModel } from '@cindy/maker-shared/codex-usage-buckets';
import { shouldFallbackToLegacyCodexUsage } from '@/session/sessionControls';
import { QUOTA_SCOPES, QUOTA_PLANS, finite, record, remaining, resetCount, resetMillis, timestamp, sanitizeQuotaSnapshot, type QuotaPlatform, type QuotaRow, type QuotaSnapshot, type QuotaWindow } from './quotaSnapshot';

export interface WidgetAccount { providerId: string; platform: QuotaPlatform; label: string }
export interface WidgetQuotaReader {
  listProviders(): Promise<unknown>;
  getCodexRateLimits(providerId?: string): Promise<unknown>;
  getAccountUsage(agent: 'codex', providerId?: string): Promise<unknown>;
  getSubscriptionUsage(platform: 'claude' | 'xai', providerId?: string): Promise<unknown>;
}

/** One connected account per platform, in host order. Named accounts never fall back to a builtin. */
export function widgetAccounts(raw: unknown): WidgetAccount[] {
  const { providers, providerOrder } = record(raw);
  if (!Array.isArray(providers)) return [];
  const order = Array.isArray(providerOrder) ? providerOrder.filter((id): id is string => typeof id === 'string') : [];
  const rank = (value: unknown) => { const index = order.indexOf(String(record(value).id)); return index < 0 ? order.length : index; };
  const result: WidgetAccount[] = [];
  for (const value of [...providers].sort((a, b) => rank(a) - rank(b))) {
    const p = record(value), auth = record(p.auth);
    if (p.connected !== true || p.removed === true || p.suspended === true || typeof p.id !== 'string' || !p.id.trim()) continue;
    if (auth.method !== 'oauth') continue;
    const builtin = p.id === 'openai' ? 'codex' : p.id === 'anthropic' ? 'claude' : p.id === 'xai' ? 'xai' : null;
    const platform = auth.native ?? (auth.method === 'oauth' ? builtin : null);
    if (!['codex', 'claude', 'xai'].includes(String(platform)) || result.some(r => r.platform === platform)) continue;
    if (record(p.subscriptionAccount).reconnectRequired === true || record(p.openAiAccount).reconnectRequired === true) continue;
    result.push({ providerId: p.id, platform: platform as QuotaPlatform, label: typeof p.name === 'string' ? p.name.slice(0, 120) : p.id });
  }
  return result.slice(0, 3);
}

const isUnauthorized = (error: unknown) => /PRECONDITION_FAILED|UNAUTHORIZED|reconnect/i.test(String(error));
const unknownRow = (platform: QuotaPlatform): QuotaRow => ({ platform, observedAtMs: null, available: false, status: 'unavailable', windows: [] });
function assertScope(raw: unknown, account: WidgetAccount) {
  const builtin = { codex: 'openai', claude: 'anthropic', xai: 'xai' }[account.platform];
  const echo = record(raw).providerId;
  if ((echo !== undefined && echo !== account.providerId) || (account.providerId !== builtin && echo !== account.providerId)) throw new Error('PRECONDITION_FAILED: Account scope unsupported');
}
function window(kind: QuotaWindow['kind'], raw: unknown, minutes: number | null = null, observedAtMs: number | null = null): QuotaWindow {
  const data = record(raw);
  return { kind, minutes, observedAtMs, remainingPercent: remaining(data.utilization ?? data.usedPercent), resetAtMs: resetMillis(data.resetsAt) };
}

export async function readWidgetAccount(account: WidgetAccount, reader: WidgetQuotaReader, now: () => number): Promise<QuotaRow> {
  if (account.platform === 'codex') {
    let payload: Record<string, unknown>, observedAtMs: number | null, selected: unknown;
    let provenance: QuotaRow['provenance'] = 'codex-control';
    try {
      const raw = await reader.getCodexRateLimits(account.providerId);
      assertScope(raw, account);
      payload = record(raw);
      // This call is the official control read, not a re-read of the legacy persisted cache.
      observedAtMs = now();
      selected = selectCodexUsageForModel({ fallback: payload.rateLimits, byLimitId: payload.rateLimitsByLimitId, nowMs: observedAtMs });
    } catch (error) {
      if (account.providerId !== 'openai' || isUnauthorized(error) || !shouldFallbackToLegacyCodexUsage(error)) throw error;
      const cached = await reader.getAccountUsage('codex');
      // No legacy observation cannot turn a failed live read into a successful empty result.
      if (cached == null) throw error;
      payload = record(cached);
      provenance = 'codex-cache';
      selected = selectCodexUsageForModel({ fallback: payload, appServerBuckets: payload.appServerBuckets, nowMs: now() });
      observedAtMs = timestamp(record(selected).updatedAt ?? payload.updatedAt);
    }
    const limits = record(selected);
    // A model-specific promotional bucket is not the platform's general subscription allowance.
    if (!GENERIC_BUCKET_KEYS.has(codexLimitBucketKey(limits))) return unknownRow('codex');
    const windows = (['primary', 'secondary'] as const).filter(k => limits[k] != null).map(k => {
      const value = record(limits[k]);
      return window(k, value, finite(value.windowMinutes) ? value.windowMinutes : null, observedAtMs);
    });
    return { platform: 'codex', observedAtMs, provenance, plan: planLabel(limits.planType) ?? planLabel(payload.planType) ?? planLabel(record(payload.account).planType),
      // Legacy usage stores do not establish freshness/semantics for earned resets.
      extraResetsRemaining: provenance === 'codex-control' ? resetCount(record(payload.rateLimitResetCredits).availableCount) : null,
      status: windows.length ? 'ready' : 'no-windows', available: windows.some(w => w.remainingPercent !== null), windows };
  }
  const raw = await reader.getSubscriptionUsage(account.platform, account.providerId);
  if (raw === null) return unknownRow(account.platform);
  assertScope(raw, account);
  const data = record(raw);
  const observed = timestamp(data.updatedAt);
  const claudeObserved = (raw: unknown) => {
    const w = record(raw);
    // An old mixed SDK/header cache cannot establish when an untouched weekly window was seen.
    return 'observedAt' in w ? timestamp(w.observedAt) : data.source === 'oauth-endpoint' ? observed : null;
  };
  const windows: QuotaWindow[] = account.platform === 'claude'
    ? (['sevenDay', 'fiveHour'] as const).filter(k => data[k] != null).map(k => window(k, data[k], k === 'fiveHour' ? 300 : 10080, claudeObserved(data[k])))
    : ('creditUsagePercent' in data || 'resetsAt' in data) ? [{ kind: 'week', minutes: 10080, remainingPercent: remaining(data.creditUsagePercent), resetAtMs: resetMillis(data.resetsAt), observedAtMs: observed }] : [];
  if (account.platform === 'claude' && Array.isArray(data.scoped)) {
    for (const raw of data.scoped) {
      const value = record(raw);
      const scope = QUOTA_SCOPES.find(label => new RegExp(`\\b${label}\\b`, 'i').test(String(value.modelDisplayName ?? '')));
      if (scope) windows.push({ ...window('scoped', raw, 10080, claudeObserved(raw)), scope });
    }
  }
  return { platform: account.platform, observedAtMs: observed,
    provenance: account.platform === 'xai' ? 'grok-subscription' : data.source === 'oauth-endpoint' ? 'claude-control' : 'claude-event',
    plan: planLabel(account.platform === 'claude' ? data.subscriptionType : data.planLabel),
    status: windows.length ? 'ready' : 'no-windows', available: windows.some(w => w.remainingPercent !== null), windows };

}

export async function readWidgetQuota(reader: WidgetQuotaReader, now = Date.now): Promise<{ snapshot: QuotaSnapshot; accounts: WidgetAccount[]; transientFailures: WidgetAccount[] }> {
  const accounts = widgetAccounts(await reader.listProviders());
  const transientFailures: WidgetAccount[] = [];
  const rows = await Promise.all(accounts.map(account => readWidgetAccount(account, reader, now).catch(error => {
    const status = isUnauthorized(error) ? 'unauthorized' as const : /unsupported channel|not found/i.test(String(error)) ? 'unsupported' as const : 'unavailable' as const;
    if (status === 'unavailable') transientFailures.push(account);
    return { ...unknownRow(account.platform), status };
  })));
  // Re-check connection and selected account after slow provider reads. A disconnect or reorder
  // must not publish a now-revoked account, even when the mobile device selection did not change.
  const current = widgetAccounts(await reader.listProviders());
  const retained = accounts.map((account, index) => ({ account, row: rows[index] })).filter(({ account }) =>
    current.some(value => value.platform === account.platform && value.providerId === account.providerId));
  return { accounts: retained.map(value => value.account), transientFailures: transientFailures.filter(failed => retained.some(value => value.account === failed)), snapshot: sanitizeQuotaSnapshot({ version: 2, source: 'live-source', connection: 'online', rows: retained.map(value => value.row) }) };
}

/** Only a recognized value explicitly returned by the supplier. Never infer from model access. */
function planLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return QUOTA_PLANS.find(plan => plan.toLowerCase() === raw.trim().toLowerCase()) ?? null;
}
