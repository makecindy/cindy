import type { AgentKind, Provider, ProviderView } from '@cindy/model-providers';

export const OPENCODE_GO_USAGE_WINDOWS = ['rolling', 'weekly', 'monthly'] as const;
export type OpenCodeGoUsageWindowId = (typeof OPENCODE_GO_USAGE_WINDOWS)[number];

export interface OpenCodeGoUsageSnapshot {
  kind: 'opencode-go-quota';
  windows: Array<{
    id: OpenCodeGoUsageWindowId;
    usedPercent: number;
    limited: boolean;
    /** Epoch milliseconds; null when the upstream omitted an invalid reset. */
    resetsAt: number | null;
  }>;
  fetchedAt: number;
}

/** Resolve only OpenCode Go's official inference route, never a user proxy. */
export function opencodeGoUsageEndpoint(upstream: string): string | null {
  try {
    const url = new URL(upstream);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.origin !== 'https://opencode.ai') return null;
    if (!['/zen/go', '/zen/go/v1'].includes(url.pathname.replace(/\/+$/, ''))) return null;
    return 'https://opencode.ai/zen/go/v1/usage';
  } catch {
    return null;
  }
}

export function isOpenCodeGoProvider(
  provider: Provider | ProviderView | undefined | null,
  agent?: AgentKind,
): boolean {
  if (!provider || provider.auth?.method !== 'apiKey') return false;
  const routes = agent ? [provider.routing?.[agent]] : Object.values(provider.routing ?? {});
  return routes.some(
    (route) => route && !route.disabled && opencodeGoUsageEndpoint(route.upstream) !== null,
  );
}

/** Remote provider views intentionally omit execution routes and keys. */
export function isOpenCodeGoProviderView(
  provider: ProviderView | undefined | null,
  agent?: AgentKind,
): boolean {
  // The catalog preset is stored through custom_providers, so the live view is
  // normally `source: 'user'`. Match its official route rather than the id to
  // support copied/renamed connections; the key is still sent only upstream.
  if (!provider) return false;
  const agents = (provider as ProviderView & { opencodeGoUsageAgents?: unknown })
    .opencodeGoUsageAgents;
  if (
    Array.isArray(agents) &&
    agents.length > 0 &&
    agents.every((value) => ['claude-code', 'codex', 'pi'].includes(value))
  ) {
    return agent ? agents.includes(agent) : true;
  }
  return isOpenCodeGoProvider(provider, agent);
}

/**
 * Parse the official Go allowance without estimating balances. The endpoint returns
 * three independent percentages and reset instants; a missing meter stays missing.
 */
export function parseOpenCodeGoUsage(value: unknown, fetchedAt: number): OpenCodeGoUsageSnapshot {
  const object = (candidate: unknown): candidate is Record<string, unknown> =>
    !!candidate && typeof candidate === 'object' && !Array.isArray(candidate);
  if (!object(value) || !object(value.usage)) throw new Error('invalid OpenCode Go usage response');
  const windows: OpenCodeGoUsageSnapshot['windows'] = [];
  for (const id of OPENCODE_GO_USAGE_WINDOWS) {
    const meter = value.usage[id];
    if (meter == null) continue;
    if (!object(meter)) throw new Error('invalid OpenCode Go usage window');
    if (
      typeof meter.percent !== 'number' ||
      !Number.isFinite(meter.percent) ||
      meter.percent < 0 ||
      meter.percent > 100 ||
      (meter.status !== 'ok' && meter.status !== 'rate-limited')
    ) {
      throw new Error('invalid OpenCode Go usage meter');
    }
    const parsedReset = typeof meter.resetsAt === 'string' ? Date.parse(meter.resetsAt) : NaN;
    windows.push({
      id,
      usedPercent: meter.percent,
      limited: meter.status === 'rate-limited',
      resetsAt: Number.isFinite(parsedReset) && parsedReset > 0 ? parsedReset : null,
    });
  }
  return { kind: 'opencode-go-quota', windows, fetchedAt };
}

export function opencodeGoUsageWindowMinutes(id: OpenCodeGoUsageWindowId): number | undefined {
  if (id === 'rolling') return 300;
  if (id === 'weekly') return 10_080;
  return undefined;
}

export function parseOpenCodeGoUsageRequest(
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
