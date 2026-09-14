export const BOT_MODEL_CHAIN_MAX = 5;

export type BotHarness = 'claude' | 'codex' | 'pi';

/** One complete, ordered Bot runtime route. */
export interface BotModelRoute {
  harness: BotHarness;
  model: string;
  providerId: string | null;
  effort: string;
  fastMode: boolean;
}

/** Runtime-control uses the same full route identity as the Bot editor. */
export function botModelRouteRuntimeKey(
  route: Pick<BotModelRoute, 'harness' | 'providerId' | 'model'>,
): string {
  const agentKind = route.harness === 'claude' ? 'claude-code' : route.harness;
  return `${agentKind}\u0000${route.providerId ?? ''}\u0000${route.model}`;
}

export function normalizeBotHarness(value: unknown): BotHarness {
  return value === 'codex' || value === 'pi' || value === 'claude' ? value : 'claude';
}

export function normalizeBotModelRoute(value: unknown): BotModelRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.model !== 'string' || !record.model.trim()) return null;
  return {
    harness: normalizeBotHarness(record.harness),
    model: record.model.trim(),
    providerId:
      typeof record.providerId === 'string' && record.providerId.trim()
        ? record.providerId.trim()
        : null,
    effort: typeof record.effort === 'string' ? record.effort : '',
    fastMode: record.fastMode === true,
  };
}

/**
 * Read the ordered route chain while preserving every legacy single-model Bot.
 * Duplicate routes are dropped because retrying the same endpoint cannot recover it.
 */
export function normalizeBotModelChain(
  value: unknown,
  legacy?: Record<string, unknown> | null,
): BotModelRoute[] {
  const candidates = Array.isArray(value)
    ? value.map(normalizeBotModelRoute).filter((item): item is BotModelRoute => item !== null)
    : [];
  if (candidates.length === 0 && legacy) {
    const single = normalizeBotModelRoute(legacy);
    if (single) candidates.push(single);
  }
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const key = `${item.harness}\u0000${item.providerId ?? ''}\u0000${item.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, BOT_MODEL_CHAIN_MAX);
}

export function primaryBotModelRoute(
  value: unknown,
  legacy?: Record<string, unknown> | null,
): BotModelRoute | null {
  return normalizeBotModelChain(value, legacy)[0] ?? null;
}

/** Select the next explicit route; never invent one from the global catalog. */
export function nextBotModelRoute(
  value: unknown,
  current: Pick<BotModelRoute, 'harness' | 'model' | 'providerId'>,
  visitedRoutes: readonly string[] = [],
  isUsable: (route: BotModelRoute) => boolean = () => true,
): BotModelRoute | null {
  const chain = normalizeBotModelChain(value);
  let currentIndex = chain.findIndex((route) =>
    route.harness === current.harness
    && route.model === current.model
    && route.providerId === current.providerId);
  if (currentIndex < 0) {
    // A null provider is a single explicit "let the harness resolve it" route,
    // not a wildcard over every source serving the same model. Prefer a real
    // provider match above; only use this legacy/default route when unique.
    const implicitMatches = chain
      .map((route, index) => ({ route, index }))
      .filter(({ route }) =>
        route.harness === current.harness
        && route.model === current.model
        && route.providerId === null);
    if (implicitMatches.length === 1) currentIndex = implicitMatches[0]!.index;
  }
  if (currentIndex < 0) {
    const legacyMatches = chain
      .map((route, index) => ({ route, index }))
      .filter(({ route }) => route.harness === current.harness && route.model === current.model);
    if (legacyMatches.length === 1) currentIndex = legacyMatches[0]!.index;
  }
  for (let index = currentIndex + 1; index < chain.length; index += 1) {
    const route = chain[index]!;
    if (!isUsable(route)) continue;
    const runtimeKey = botModelRouteRuntimeKey(route);
    if (visitedRoutes.includes(runtimeKey)) continue;
    return route;
  }
  return null;
}
