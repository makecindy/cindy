/**
 * useHermesModelCatalog — real model ids for Hermes sessions.
 *
 * Hermes has no static catalog: the model set is whatever the active provider
 * answers on `{base_url}/models`. The daemon lists them (route from
 * config.yaml, Bearer key from this process' env); here we cache for a minute
 * and expose them as picker descriptors, headed by the "home default" sentinel
 * row (selecting it clears any per-session override).
 */
import {
  projectProviderFileEndpoints,
  type ProviderFileEndpointStatus,
  type ProviderFileEndpointView,
} from '@cindy/model-providers';
import { useEffect, useState } from 'react';

import type { ModelDescriptor } from './useAgentCapabilities';

export interface HermesEndpointStatusSummary {
  id: string;
  status: ProviderFileEndpointStatus;
  local: boolean;
  modelCount: number;
  error?: string;
}

export interface HermesCatalogState {
  /** Picker rows: the home-default sentinel first, then provider and discovered local model ids. */
  descriptors: ModelDescriptor[];
  /** Online/offline status rows for configured providers.yaml endpoints (ROADMAP 2.2b). */
  endpointStatuses: HermesEndpointStatusSummary[];
  /** The home's configured default model id, if any. */
  homeModel: string | null;
  provider: string | null;
  loading: boolean;
  error: string | null;
}

const HERMES_CONTEXT_WINDOW = 200_000;
const CACHE_TTL_MS = 60_000;
export const DISCOVERY_POLL_INTERVAL_MS = 15_000;

export function buildHermesDescriptors(
  route: { model?: string; provider?: string },
  models: readonly string[],
): ModelDescriptor[] {
  const homeLabel = route.model
    ? `Hermes home default (${route.model})`
    : 'Hermes home default';
  const descriptors: ModelDescriptor[] = [
    {
      id: 'hermes-default',
      displayName: homeLabel,
      contextWindow: HERMES_CONTEXT_WINDOW,
      efforts: [],
      defaultEffort: null,
    },
  ];
  for (const id of models) {
    if (id === route.model) continue;
    descriptors.push({
      id,
      displayName: id,
      contextWindow: HERMES_CONTEXT_WINDOW,
      efforts: [],
      defaultEffort: null,
    });
  }
  return descriptors;
}

/**
 * Pure projection of discovered `providers.yaml` endpoints into picker
 * `ModelDescriptor` rows and online/offline endpoint status summaries (ROADMAP 2.2b).
 *
 * Only `online` endpoints contribute loaded models; `offline`/`error` endpoints
 * are surfaced in `endpointStatuses` without exposing stale models.
 */
export function buildDiscoveredEndpointDescriptors(
  endpoints: readonly ProviderFileEndpointView[],
  existingModelIds: ReadonlySet<string> = new Set(),
): {
  descriptors: ModelDescriptor[];
  endpointStatuses: HermesEndpointStatusSummary[];
} {
  const seen = new Set<string>(existingModelIds);
  const descriptors: ModelDescriptor[] = [];
  const endpointStatuses: HermesEndpointStatusSummary[] = [];

  for (const endpoint of endpoints) {
    const loadedModels = endpoint.status === 'online' ? endpoint.models : [];
    endpointStatuses.push({
      id: endpoint.id,
      status: endpoint.status,
      local: endpoint.local,
      modelCount: loadedModels.length,
      ...(endpoint.error ? { error: endpoint.error } : {}),
    });

    if (endpoint.status !== 'online') continue;
    const contextWindow = endpoint.capabilities.contextLength ?? HERMES_CONTEXT_WINDOW;
    for (const rawId of loadedModels) {
      const id = rawId.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      descriptors.push({
        id,
        displayName: `${id} (${endpoint.id})`,
        description: `${endpoint.local ? 'Local' : 'API'} endpoint ${endpoint.id}`,
        contextWindow,
        efforts: [],
        defaultEffort: null,
      });
    }
  }

  return { descriptors, endpointStatuses };
}

interface CacheEntry {
  at: number;
  state: HermesCatalogState;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<HermesCatalogState> | null = null;

async function fetchDiscoveredEndpoints(): Promise<ProviderFileEndpointView[]> {
  const providersApi = window.electronAPI?.maker?.providers;
  if (!providersApi) return [];
  try {
    const [listResult, probes] = await Promise.all([
      providersApi.list(),
      providersApi.discover(),
    ]);
    return projectProviderFileEndpoints(listResult.providers ?? [], probes ?? []);
  } catch {
    return [];
  }
}

async function fetchCatalog(): Promise<HermesCatalogState> {
  const [result, endpoints] = await Promise.all([
    window.electronAPI.maker.hermesConfig.listModels(),
    fetchDiscoveredEndpoints(),
  ]);
  const baseDescriptors = buildHermesDescriptors(result.route ?? {}, result.models ?? []);
  const existingIds = new Set<string>(baseDescriptors.map((d) => d.id));
  if (result.route?.model) existingIds.add(result.route.model);
  const discovered = buildDiscoveredEndpointDescriptors(endpoints, existingIds);
  return {
    descriptors: [...baseDescriptors, ...discovered.descriptors],
    endpointStatuses: discovered.endpointStatuses,
    homeModel: result.route?.model ?? null,
    provider: result.route?.provider ?? null,
    loading: false,
    error: result.error ?? null,
  };
}

export function invalidateHermesModelCatalog(): void {
  cache = null;
}

const EMPTY_CATALOG_STATE: HermesCatalogState = {
  descriptors: [],
  endpointStatuses: [],
  homeModel: null,
  provider: null,
  loading: false,
  error: null,
};

export function useHermesModelCatalog(enabled: boolean): HermesCatalogState {
  const [state, setState] = useState<HermesCatalogState>(
    () => cache?.state ?? EMPTY_CATALOG_STATE,
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const refresh = (bypassCache: boolean) => {
      if (!bypassCache && cache && Date.now() - cache.at < CACHE_TTL_MS) {
        if (!cancelled) setState(cache.state);
        return;
      }
      if (!inFlight) {
        inFlight = fetchCatalog()
          .then((nextState) => {
            cache = { at: Date.now(), state: nextState };
            return nextState;
          })
          .catch((error: unknown): HermesCatalogState => ({
            ...EMPTY_CATALOG_STATE,
            error: error instanceof Error ? error.message : String(error),
          }))
          .finally(() => {
            inFlight = null;
          });
      }
      void inFlight.then((nextState) => {
        if (!cancelled) setState(nextState);
      });
    };

    refresh(false);
    // Poll local/configured endpoints while the Hermes catalog hook is active (ROADMAP 2.2b).
    const timer = setInterval(() => {
      refresh(true);
    }, DISCOVERY_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return enabled ? state : EMPTY_CATALOG_STATE;
}
