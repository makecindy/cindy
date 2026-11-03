import { normalizeModelRoute, modelRouteLocationKey, type ModelRoute } from '@cindy/maker-shared/model-route';

export const BOT_MODEL_CHAIN_MAX = 5;

export type BotHarness = 'claude' | 'codex' | 'pi';

export type BotModelRoute = ModelRoute;

/** Runtime-control uses the same full route identity as the Bot editor. */
export function botModelRouteRuntimeKey(
  route: Pick<BotModelRoute, 'harness' | 'providerId' | 'model' | 'agentDeviceId'>,
): string {
  const agentKind = route.harness === 'claude' ? 'claude-code' : route.harness;
  return `${agentKind}\u0000${route.providerId ?? ''}\u0000${route.model}${modelRouteLocationKey(route.agentDeviceId)}`;
}

export function normalizeBotHarness(value: unknown): BotHarness {
  return value === 'codex' || value === 'pi' || value === 'claude' ? value : 'claude';
}

export const normalizeBotModelRoute = normalizeModelRoute;

/** Optional task-specific route. Absence inherits the live primary route, never a stored copy. */
export function readBotTaskModelOverride(value: unknown): BotModelRoute | null {
  if (value === null || value === undefined) return null;
  const record = value as Partial<BotModelRoute>;
  const route = normalizeBotModelRoute(value);
  if (!route || !['claude', 'codex', 'pi'].includes(String(record.harness))
    || (record.providerId !== null && typeof record.providerId !== 'string')
    || typeof record.effort !== 'string' || (typeof record.fastMode !== 'boolean' && record.fastMode !== 'ultrafast')) {
    throw new Error('Invalid task model route');
  }
  return route;
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
    const key = `${item.harness}\u0000${item.providerId ?? ''}\u0000${item.model}${modelRouteLocationKey(item.agentDeviceId)}`;
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

/**
 * Where the current route sits in the companion's chain, or -1 when the chain
 * does not contain it (for example a task whose model the user chose).
 */
export function botModelRouteIndex(
  chain: readonly BotModelRoute[],
  current: Pick<BotModelRoute, 'harness' | 'model' | 'providerId' | 'agentDeviceId'>,
): number {
  const exact = chain.findIndex((route) =>
    route.harness === current.harness
    && route.model === current.model
    && route.providerId === current.providerId
    && (route.agentDeviceId ?? null) === (current.agentDeviceId ?? null));
  if (exact >= 0) return exact;
  // A null provider is a single explicit "let the harness resolve it" route,
  // not a wildcard over every source serving the same model. Prefer a real
  // provider match above; only use this legacy/default route when unique.
  const implicitMatches = chain
    .map((route, index) => ({ route, index }))
    .filter(({ route }) =>
      route.harness === current.harness
      && route.model === current.model
      && route.providerId === null
      && (route.agentDeviceId ?? null) === (current.agentDeviceId ?? null));
  if (implicitMatches.length === 1) return implicitMatches[0]!.index;
  const legacyMatches = chain
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => route.harness === current.harness && route.model === current.model
      && (route.agentDeviceId ?? null) === (current.agentDeviceId ?? null));
  return legacyMatches.length === 1 ? legacyMatches[0]!.index : -1;
}

/** Select the next explicit route; never invent one from the global catalog. */
export function nextBotModelRoute(
  value: unknown,
  current: Pick<BotModelRoute, 'harness' | 'model' | 'providerId' | 'agentDeviceId'>,
  visitedRoutes: readonly string[] = [],
  isUsable: (route: BotModelRoute) => boolean = () => true,
): BotModelRoute | null {
  const chain = normalizeBotModelChain(value);
  const currentIndex = botModelRouteIndex(chain, current);
  for (let index = currentIndex + 1; index < chain.length; index += 1) {
    const route = chain[index]!;
    if (!isUsable(route)) continue;
    const runtimeKey = botModelRouteRuntimeKey(route);
    if (visitedRoutes.includes(runtimeKey)) continue;
    return route;
  }
  return null;
}

/** A saved model selection supersedes an earlier runtime-only fallback. */
export function botProfileModelSelectionChanged(previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  // Legacy profiles may contain only modelChain. Compare the same canonical
  // shape the settings save uses, so adding mirror fields is not a model edit.
  previous = normalizeBotProfileModelChain(previous);
  next = normalizeBotProfileModelChain(next);
  return ['modelChainOverride', 'modelOverride', 'modelChain', 'harness', 'model', 'providerId', 'agentDeviceId', 'effort', 'fastMode']
    .some((key) => JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null));
}

/** Main-owned persistence boundary for the ordered Bot runtime routes. */
export function normalizeBotProfileModelChain(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...value };
  if (Object.prototype.hasOwnProperty.call(next, 'taskModelOverride')) {
    next.taskModelOverride = readBotTaskModelOverride(next.taskModelOverride);
  }
  if (Object.prototype.hasOwnProperty.call(next, 'modelChain')) {
    const chain = normalizeBotModelChain(next.modelChain);
    if (chain.length === 0 && next.modelChainOverride !== null && next.modelOverride !== null) {
      throw new Error('modelChain must contain at least one valid route');
    }
    const primary = chain[0];
    next.modelChain = chain;
    if (primary) {
      next.harness = primary.harness;
      next.model = primary.model;
      next.providerId = primary.providerId;
      next.effort = primary.effort;
      next.fastMode = primary.fastMode;
    }
  }
  if (Array.isArray(next.modelChainOverride)) {
    const override = normalizeBotModelChain(next.modelChainOverride);
    if (override.length === 0) {
      throw new Error('modelChainOverride must contain at least one valid route');
    }
    next.modelChainOverride = override;
  } else if (next.modelChainOverride !== null && next.modelChainOverride !== undefined) {
    throw new Error('modelChainOverride must be an ordered route list or null');
  }
  return next;
}
