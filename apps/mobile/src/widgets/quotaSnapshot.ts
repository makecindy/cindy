/** Allowlisted OS projection. Provider credentials, identity and account fingerprints never cross this boundary. */
export const QUOTA_MAX_AGE_MS = 15 * 60_000;
export const QUOTA_MAX_ROWS = 3;
export const QUOTA_MAX_WINDOWS = 16;
export type QuotaPlatform = 'codex' | 'claude' | 'xai';
export type QuotaWindowKind = 'primary' | 'secondary' | 'fiveHour' | 'sevenDay' | 'week' | 'scoped';
export type QuotaRowStatus = 'ready' | 'no-windows' | 'unavailable' | 'unsupported' | 'unauthorized';
export const QUOTA_PLANS = ['Free', 'Plus', 'Pro', 'Business', 'Enterprise', 'Edu', 'Team', 'Max', 'SuperGrok', 'SuperGrok Heavy'] as const;
export const QUOTA_SCOPES = ['Fable', 'Opus', 'Sonnet', 'Haiku', 'Mythos'] as const;
export interface QuotaWindow {
  kind: QuotaWindowKind;
  scope?: string | null;
  minutes: number | null;
  remainingPercent: number | null;
  resetAtMs: number | null;
  /** Timestamp of this particular source window. Null never means "received now". */
  observedAtMs: number | null;
}
export interface QuotaRow {
  platform: QuotaPlatform;
  plan?: string | null;
  /** Remaining banked resets from the formal Codex read; absent is unknown, never zero. */
  extraResetsRemaining?: number | null;
  status?: QuotaRowStatus;
  provenance?: 'codex-control' | 'codex-cache' | 'claude-control' | 'claude-event' | 'grok-subscription' | 'unknown';
  observedAtMs: number | null;
  available: boolean;
  windows: QuotaWindow[];
}
export interface QuotaSnapshot {
  version: 2;
  source: 'live-source' | 'demo';
  connection: 'online' | 'offline';
  rows: QuotaRow[];
}
export const emptyQuotaSnapshot = (): QuotaSnapshot => ({ version: 2, source: 'live-source', connection: 'offline', rows: [] });
export const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const resetCount = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
export const timestamp = (v: unknown): number | null => finite(v) && v > 0 && v <= 8_640_000_000_000_000 ? v : null;
const percent = (v: unknown): number | null => finite(v) && v >= 0 && v <= 100 ? v : null;
export const remaining = (used: unknown): number | null => percent(used) === null ? null : 100 - (used as number);
export const resetMillis = (seconds: unknown): number | null => timestamp(finite(seconds) ? seconds * 1000 : null);
export const quotaWindowKey = (window: QuotaWindow) => `${window.kind}:${window.scope ?? ''}`;

export function sanitizeQuotaSnapshot(raw: unknown): QuotaSnapshot {
  const value = record(raw);
  // v1 had aggregate freshness only. Discard it; never silently stamp old data as current.
  if (value.version !== 2 || !['live-source', 'demo'].includes(String(value.source)) || !Array.isArray(value.rows)) return emptyQuotaSnapshot();
  const platforms = new Set<string>();
  const rows: QuotaRow[] = [];
  for (const item of value.rows.slice(0, QUOTA_MAX_ROWS)) {
    const row = record(item);
    if (!['codex', 'claude', 'xai'].includes(String(row.platform)) || platforms.has(String(row.platform))) continue;
    platforms.add(String(row.platform));
    const windows: QuotaWindow[] = [];
    const keys = new Set<string>();
    for (const candidate of Array.isArray(row.windows) ? row.windows.slice(0, QUOTA_MAX_WINDOWS) : []) {
      const window = record(candidate);
      if (!['primary', 'secondary', 'fiveHour', 'sevenDay', 'week', 'scoped'].includes(String(window.kind))) continue;
      const scope = QUOTA_SCOPES.find(label => label === window.scope) ?? null;
      if (window.kind === 'scoped' && !scope) continue;
      const key = `${window.kind}:${scope ?? ''}`;
      if (keys.has(key)) continue;
      keys.add(key);
      windows.push({
        kind: window.kind as QuotaWindowKind, scope,
        minutes: finite(window.minutes) && window.minutes > 0 && window.minutes <= 525600 ? window.minutes : null,
        remainingPercent: percent(window.remainingPercent), resetAtMs: timestamp(window.resetAtMs),
        observedAtMs: timestamp(window.observedAtMs),
      });
    }
    rows.push({
      platform: row.platform as QuotaPlatform, plan: QUOTA_PLANS.find(plan => plan === row.plan) ?? null,
      extraResetsRemaining: row.platform === 'codex' ? resetCount(row.extraResetsRemaining) : null,
      status: ['ready', 'no-windows', 'unavailable', 'unsupported', 'unauthorized'].includes(String(row.status)) ? row.status as QuotaRowStatus : 'unavailable',
      provenance: ['codex-control', 'codex-cache', 'claude-control', 'claude-event', 'grok-subscription'].includes(String(row.provenance)) ? row.provenance as QuotaRow['provenance'] : 'unknown',
      observedAtMs: timestamp(row.observedAtMs), available: row.available === true, windows,
    });
  }
  return { version: 2, source: value.source as QuotaSnapshot['source'], connection: value.connection === 'online' ? 'online' : 'offline', rows };
}
export type QuotaDisplayState = 'unavailable' | 'awaitingRefresh' | 'stale' | 'offline' | 'fresh';
export function quotaWindowState(row: QuotaRow, window: QuotaWindow, connection: QuotaSnapshot['connection'], now: number): QuotaDisplayState {
  const observed = window.observedAtMs;
  if (!row.available || window.remainingPercent === null || observed === null || observed > now + 60_000) return 'unavailable';
  if (window.resetAtMs !== null && window.resetAtMs <= now) return 'awaitingRefresh';
  if (now - observed >= QUOTA_MAX_AGE_MS) return 'stale';
  return connection === 'offline' ? 'offline' : 'fresh';
}
