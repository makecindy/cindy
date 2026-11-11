import type { AgentKind, Provider, ProviderView } from '@cindy/model-providers';

export type MiniMaxPlanWindowId = 'rolling' | 'weekly';

/** MiniMax may report rejected credentials in an HTTP 200 business response. */
export class MiniMaxPlanUsageError extends Error {
  readonly code = 'auth' as const;
  constructor() { super('invalid MiniMax plan credentials'); }
}

export interface MiniMaxPlanUsageSnapshot {
  kind: 'minimax-plan-quota';
  windows: Array<{
    id: MiniMaxPlanWindowId;
    model: string | null;
    usedPercent: number;
    resetsAt: number | null;
  }>;
  noPlan: boolean;
  weeklyUnlimited: boolean;
  /** A boosted weekly allowance above 100% cannot be represented as a used meter. */
  boostedWeeklyRemainingPercent: number | null;
  fetchedAt: number;
}

const OFFICIAL_ORIGINS: Readonly<Record<string, string>> = {
  'https://api.minimaxi.com': 'https://www.minimaxi.com',
  'https://api.minimax.io': 'https://www.minimax.io',
};

/** Credentials are sent only to the matching region's fixed official quota endpoint. */
export function minimaxPlanUsageEndpoint(upstream: string): string | null {
  try {
    const url = new URL(upstream);
    if (url.username || url.password || url.search || url.hash) return null;
    const origin = OFFICIAL_ORIGINS[url.origin];
    if (!origin || !['', '/v1', '/anthropic', '/anthropic/v1'].includes(url.pathname.replace(/\/+$/, ''))) return null;
    return `${origin}/v1/token_plan/remains`;
  } catch {
    return null;
  }
}

export function isMiniMaxPlanProvider(
  provider: Provider | ProviderView | undefined | null,
  agent?: AgentKind,
): boolean {
  if (!provider || provider.auth?.method !== 'apiKey') return false;
  return (agent ? [provider.routing?.[agent]] : Object.values(provider.routing ?? {}))
    .some(route => route && !route.disabled && minimaxPlanUsageEndpoint(route.upstream) !== null);
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Official CLI contract: MiniMax-AI/cli src/types/api.ts and src/utils/quota.ts.
 * Explicit remaining percentages take precedence, including time-based 0/0 plans.
 * Legacy *_usage_count means remaining when no percentage is supplied.
 * No monthly allowance is inferred from a billing date or a weekly reset.
 */
export function parseMiniMaxPlanUsage(value: unknown, fetchedAt: number): MiniMaxPlanUsageSnapshot {
  const fail = (): never => { throw new Error('invalid MiniMax plan usage response'); };
  if (!object(value)) return fail();
  if (object(value.base_resp) && value.base_resp.status_code === 1004) throw new MiniMaxPlanUsageError();
  if (value.base_resp !== undefined && (!object(value.base_resp) || value.base_resp.status_code !== 0)) return fail();
  if (!Array.isArray(value.model_remains) || value.model_remains.length > 128) return fail();
  const rows = value.model_remains.filter(object);
  // The current text plan uses a shared general pool. Never substitute media quotas.
  const general = rows.filter(row => row.model_name === 'general');
  const candidates = general.length ? general : rows.filter(row =>
    typeof row.model_name === 'string' && /^(MiniMax-M|coding-plan)/i.test(row.model_name));
  if (general.length > 1) return fail();
  const snapshot: MiniMaxPlanUsageSnapshot = {
    kind: 'minimax-plan-quota', windows: [], noPlan: false,
    weeklyUnlimited: false, boostedWeeklyRemainingPercent: null, fetchedAt,
  };
  for (const row of candidates) {
    if (row.current_interval_status === 3 && row.current_weekly_status === 3
      && row.current_interval_total_count === 0 && row.current_weekly_total_count === 0) {
      snapshot.noPlan = true;
      continue;
    }
    for (const id of ['rolling', 'weekly'] as const) {
      const prefix = id === 'rolling' ? 'current_interval' : 'current_weekly';
      const status = row[`${prefix}_status`];
      if (status === 3) {
        if (id === 'weekly' && general.length) snapshot.weeklyUnlimited = true;
        continue;
      }
      if (status !== undefined && status !== 1 && status !== 2) return fail();
      let remaining = row[`${prefix}_remaining_percent`];
      if (remaining == null) {
        const total = row[`${prefix}_total_count`];
        const count = row[`${prefix}_usage_count`];
        if (!finite(total) || total <= 0 || !finite(count)) continue;
        if (count < 0 || count > total) return fail();
        remaining = count / total * 100;
      }
      if (!finite(remaining) || remaining < 0 || remaining > 100) return fail();
      if (id === 'weekly' && row.weekly_boost_permille != null) {
        const boost = row.weekly_boost_permille;
        if (!finite(boost) || boost <= 0) return fail();
        remaining *= boost / 1000;
        if (remaining > 100) {
          if (general.length) snapshot.boostedWeeklyRemainingPercent = remaining;
          continue;
        }
      }
      const end = row[id === 'rolling' ? 'end_time' : 'weekly_end_time'];
      const duration = row[id === 'rolling' ? 'remains_time' : 'weekly_remains_time'];
      // The official API's end times and remaining durations are milliseconds.
      const resetsAt = finite(end) && end > 0 ? end
        : finite(duration) && duration >= 0 && Number.isSafeInteger(fetchedAt + duration)
          ? fetchedAt + duration : null;
      const window = {
        id, model: row.model_name === 'general' ? null : String(row.model_name),
        usedPercent: 100 - remaining, resetsAt,
      };
      // Legacy responses list model-specific pools. Surface the tightest reported
      // pool per period with its model name rather than inventing a shared total.
      const index = snapshot.windows.findIndex(candidate => candidate.id === id);
      if (index < 0) snapshot.windows.push(window);
      else if (window.usedPercent > snapshot.windows[index].usedPercent) snapshot.windows[index] = window;
    }
  }
  return snapshot;
}
