import type { AgentKind, Provider, ProviderView } from '@cindy/model-providers';

export const KIMI_USAGE_WINDOWS = [
  'limit_5h',
  'limit_7d',
  'limit_month_total',
  'limit_month_code',
] as const;
export type KimiUsageWindowId = (typeof KIMI_USAGE_WINDOWS)[number];
export interface KimiCodingUsageSnapshot {
  kind: 'kimi-coding-quota';
  windows: Array<{ id: KimiUsageWindowId; usedPercent: number; resetsAt: number | null }>;
  fetchedAt: number;
}

/** Exact product scope, not brand/name matching. Never send a proxy's credential to Kimi. */
export function kimiCodingUsageEndpoint(upstream: string): string | null {
  try {
    const url = new URL(upstream);
    if (url.username || url.password || url.search || url.hash) return null;
    if (!['https://api.kimi.com', 'https://api.kimi.ai'].includes(url.origin)) return null;
    if (!['/coding', '/coding/', '/coding/v1', '/coding/v1/'].includes(url.pathname)) return null;
    return `${url.origin}/coding/v1/usages`;
  } catch {
    return null;
  }
}

export function isKimiCodingProvider(
  provider: Provider | ProviderView | undefined | null,
  agent?: AgentKind,
): boolean {
  if (!provider || !['apiKey', 'oauth'].includes(provider.auth?.method)) return false;
  if (
    provider.auth.method === 'oauth' &&
    !['https://auth.kimi.com/api/oauth/token', 'https://auth.kimi.ai/api/oauth/token'].includes(
      provider.auth.oauth?.tokenUrl ?? '',
    )
  )
    return false;
  return (agent ? [provider.routing?.[agent]] : Object.values(provider.routing ?? {})).some(
    (route) => route && !route.disabled && kimiCodingUsageEndpoint(route.upstream),
  );
}

/** Official kimi-code packages/oauth/src/managed-usage.ts (0c63065fbd73).
 * Ratios are 0..1, not token totals. Missing windows are not unlimited or zero use.
 */
export function parseKimiCodingUsage(value: unknown, fetchedAt: number): KimiCodingUsageSnapshot {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (!object(value) || !object(value.usages)) throw new Error('invalid Kimi usage response');
  const windows: KimiCodingUsageSnapshot['windows'] = [];
  for (const id of KIMI_USAGE_WINDOWS) {
    const entry = value.usages[id];
    if (entry == null) continue;
    if (!object(entry)) throw new Error('invalid Kimi usage window');
    const ratio =
      typeof entry.used_ratio === 'number'
        ? entry.used_ratio
        : typeof entry.used_ratio === 'string' && /^\d+(?:\.\d+)?$/.test(entry.used_ratio)
          ? Number(entry.used_ratio)
          : NaN;
    if (!Number.isFinite(ratio) || ratio < 0) throw new Error('invalid Kimi usage ratio');
    const reset = typeof entry.reset_time === 'string' ? Date.parse(entry.reset_time) : NaN;
    windows.push({
      id,
      usedPercent: Math.min(100, ratio * 100),
      resetsAt: Number.isFinite(reset) && reset > 0 ? reset : null,
    });
  }
  return { kind: 'kimi-coding-quota', windows, fetchedAt };
}

export function kimiUsageWindowMinutes(id: KimiUsageWindowId): number | undefined {
  return id === 'limit_5h' ? 300 : id === 'limit_7d' ? 10_080 : undefined;
}

export function parseKimiUsageRequest(
  input: unknown,
): { providerId: string; agent?: AgentKind; forceRefresh?: boolean } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    typeof value.providerId !== 'string' ||
    !value.providerId.trim() ||
    value.providerId.length > 256
  )
    return null;
  if (value.agent !== undefined && !['claude-code', 'codex', 'pi'].includes(value.agent as string))
    return null;
  if (value.forceRefresh !== undefined && typeof value.forceRefresh !== 'boolean') return null;
  return {
    providerId: value.providerId,
    agent: value.agent as AgentKind | undefined,
    forceRefresh: value.forceRefresh as boolean | undefined,
  };
}

/** The remote catalog strips execution routes. The host may advertise just the
 * supported runtime names; this display hint never authorizes a host-side read. */
export function isKimiCodingProviderView(
  provider: ProviderView | undefined | null,
  agent?: AgentKind,
): boolean {
  if (!provider) return false;
  const agents = (provider as ProviderView & { kimiCodingUsageAgents?: unknown }).kimiCodingUsageAgents;
  if (Array.isArray(agents) && agents.length > 0 && agents.every(value => ['claude-code', 'codex', 'pi'].includes(value))) {
    return agent ? agents.includes(agent) : true;
  }
  return isKimiCodingProvider(provider, agent);
}
