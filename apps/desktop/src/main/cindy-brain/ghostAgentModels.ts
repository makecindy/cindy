import {
  connectedProvidersForAgent,
  isModelVisible,
  isModelSelectableForNewRoute,
  type ProviderView,
} from '@cindy/model-providers';
import type { GhostAgentModelsResult } from '../../shared/ghost.js';

export const GHOST_AGENT_MODELS_CACHE_MS = 60_000;
export const GHOST_AGENT_MODELS_CACHE_MAX_CATALOGS = 64;
export const GHOST_REMOTE_AGENT_MODELS = ['codex', 'claude-code', 'pi'] as const;
export type GhostAgentLocation = { agentDeviceId: string; name: string };
export type GhostAgentLocationsReadResult =
  | { status: 'complete'; locations: GhostAgentLocation[] }
  | { status: 'degraded'; locations: GhostAgentLocation[] };
type GhostAgentModelsOk = Extract<GhostAgentModelsResult, { ok: true }>;

/** Project each provider separately: the same model can support different efforts per route. */
export function projectGhostAgentModels(views: ProviderView[], availableAgents: readonly string[], visibilityOverride: (agent: 'codex' | 'claude-code' | 'pi', providerId: string, modelId: string) => boolean | undefined = () => undefined): GhostAgentModelsResult {
  const models: GhostAgentModelsOk['models'] = [];
  for (const agent of GHOST_REMOTE_AGENT_MODELS) {
    if (!availableAgents.includes(agent)) continue;
    for (const provider of connectedProvidersForAgent(views, agent)) {
      for (const model of provider.models[agent] ?? []) {
        if (!isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }))
          continue;
        models.push({
          visible: isModelVisible(visibilityOverride(agent, provider.id, model.id), model.defaultEnabled),
          id: model.id,
          name: model.name,
          agent,
          providerId: provider.id,
          providerName: provider.name,
          efforts: [...model.efforts],
          defaultEffort: model.defaultEffort,
        });
      }
    }
  }
  return { ok: true, models };
}

/** Plugin GET /agent-models caches successful locations and per-device catalogs for 60s. */
export function createGhostAgentModelsCache(options: { now?: () => number; ttlMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? GHOST_AGENT_MODELS_CACHE_MS;
  let locations: { owner: string; at: number; value: GhostAgentLocation[] } | null = null;
  const locationReads = new Map<string, Promise<GhostAgentLocation[] | undefined>>();
  const catalogs = new Map<string, { at: number; value: GhostAgentModelsOk }>();
  const catalogReads = new Map<string, Promise<GhostAgentModelsResult>>();
  const pruneExpiredCatalogs = (at: number) => {
    for (const [key, entry] of catalogs) {
      if (at - entry.at >= ttlMs) catalogs.delete(key);
    }
  };
  const storeCatalog = (key: string, value: GhostAgentModelsOk) => {
    const at = now();
    pruneExpiredCatalogs(at);
    catalogs.delete(key);
    while (catalogs.size >= GHOST_AGENT_MODELS_CACHE_MAX_CATALOGS) {
      const oldestKey = catalogs.keys().next().value;
      if (oldestKey === undefined) break;
      catalogs.delete(oldestKey);
    }
    catalogs.set(key, { at, value });
  };

  return {
    locations(
      owner: string,
      read: () => Promise<GhostAgentLocationsReadResult>,
    ): Promise<GhostAgentLocation[] | undefined> {
      if (locations && locations.owner === owner && now() - locations.at < ttlMs) {
        return Promise.resolve(locations.value);
      }
      const inFlight = locationReads.get(owner);
      if (inFlight) return inFlight;

      let pending: Promise<GhostAgentLocation[] | undefined>;
      pending = Promise.resolve()
        .then(read)
        .then((result) => {
          if (result.status !== 'complete') return undefined;
          const value = result.locations;
          locations = { owner, at: now(), value };
          return value;
        })
        .catch(() => undefined)
        .finally(() => {
          if (locationReads.get(owner) === pending) locationReads.delete(owner);
        });
      locationReads.set(owner, pending);
      return pending;
    },
    catalog(
      owner: string,
      agentDeviceId: string,
      read: () => Promise<ProviderView[]>,
    ): Promise<GhostAgentModelsResult> {
      const key = `${owner}\0${agentDeviceId}`;
      const requestedAt = now();
      pruneExpiredCatalogs(requestedAt);
      const hit = catalogs.get(key);
      if (hit) {
        catalogs.delete(key);
        catalogs.set(key, hit);
        return Promise.resolve(hit.value);
      }
      const inFlight = catalogReads.get(key);
      if (inFlight) return inFlight;

      let pending: Promise<GhostAgentModelsResult>;
      pending = Promise.resolve()
        .then(read)
        .then((views): GhostAgentModelsResult => {
          const projected = projectGhostAgentModels(views, GHOST_REMOTE_AGENT_MODELS);
          if (!projected.ok) return { ok: false, errorCode: 'NOT_AVAILABLE', message: 'Model catalog unavailable' };
          const value = { ...projected, agentDeviceId };
          storeCatalog(key, value);
          return value;
        })
        .catch((): GhostAgentModelsResult => ({
          ok: false,
          errorCode: 'NOT_AVAILABLE',
          message: 'Model catalog unavailable',
        }))
        .finally(() => {
          if (catalogReads.get(key) === pending) catalogReads.delete(key);
        });
      catalogReads.set(key, pending);
      return pending;
    },
  };
}
