/**
 * model-route-resolver.ts — maps a requested model or route name to its endpoint
 * in `~/.cindy-harness/providers.yaml` and `routing.yaml`.
 *
 * Used by HermesAgent and host-side setModel to route chat turns to local providers
 * (e.g. LM Studio, Ollama) via `--provider custom --base-url <url>`.
 * Returns null when the model is not in providers.yaml (falls back to Hermes home default).
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { getLatestDiscoveredModels } from './discovery.js';
import { loadProvidersFile, type ProviderFileEntry } from './providers-file.js';
import { loadRoutingFile } from './routing-file.js';

export interface ResolvedModelRoute {
  model: string;
  provider: string;
  baseUrl: string;
  apiKey?: string;
  /** The providers.yaml entry id this route uses (e.g. "lmstudio-local"). */
  providerId?: string;
}

/**
 * Last endpoint each discovered model was found on. Discovery forgets a model the moment its
 * endpoint goes offline or unloads it; without this the same model id would stop resolving and
 * be sent to the Hermes home provider instead (a different, possibly paid, endpoint).
 */
const rememberedEndpointByModel = new Map<string, string>();

/** Test-only reset. */
export function resetRememberedModelEndpointsForTest(): void {
  rememberedEndpointByModel.clear();
}

export interface ModelRouteResolverOptions {
  harnessDir?: string;
  env?: Record<string, string | undefined>;
  endpointModels?: Map<string, string[]> | Record<string, string[]>;
}

export function normalizeBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function resolveModelRoute(
  modelId: string | undefined | null,
  options?: ModelRouteResolverOptions,
): ResolvedModelRoute | null {
  if (!modelId) return null;
  const trimmed = modelId.trim();
  if (!trimmed || trimmed === 'hermes-default') return null;

  const harnessDir = options?.harnessDir ?? path.join(os.homedir(), '.cindy-harness');
  const providersFile = path.join(harnessDir, 'providers.yaml');
  const routingFile = path.join(harnessDir, 'routing.yaml');

  const { providers } = loadProvidersFile(providersFile);
  if (providers.length === 0) return null;

  const providerMap = new Map<string, ProviderFileEntry>();
  for (const p of providers) providerMap.set(p.id, p);

  const routing = loadRoutingFile(routingFile, Array.from(providerMap.keys()));

  let targetModel = trimmed;
  let targetProviderId: string | undefined;

  // 1. Direct match on a route name in routing.yaml (e.g. "local-small")
  if (routing.routes && trimmed in routing.routes) {
    const route = routing.routes[trimmed];
    targetModel = route.model;
    targetProviderId = route.provider;
  }

  // 2. Match route by model id in routing.yaml (e.g. model "qwen3-8b" in route "local-small")
  if (!targetProviderId && routing.routes) {
    for (const route of Object.values(routing.routes)) {
      if (route.model === trimmed) {
        targetModel = route.model;
        targetProviderId = route.provider;
        break;
      }
    }
  }

  // 3. Match format "<providerId>/<modelId>" (e.g. "lmstudio-local/qwen3-8b" or "lmstudio-local/google/gemma-4-26b-a4b-qat")
  if (!targetProviderId) {
    for (const pId of providerMap.keys()) {
      if (trimmed.startsWith(`${pId}/`)) {
        targetProviderId = pId;
        targetModel = trimmed.slice(pId.length + 1);
        break;
      }
    }
  }

  // 4. Match against discovered models from local endpoints (or injected endpointModels)
  if (!targetProviderId) {
    const discovered = options?.endpointModels
      ? (options.endpointModels instanceof Map
          ? options.endpointModels
          : new Map(Object.entries(options.endpointModels)))
      : getLatestDiscoveredModels();
    for (const [pId, models] of discovered.entries()) {
      if (providerMap.has(pId) && models.includes(trimmed)) {
        targetProviderId = pId;
        targetModel = trimmed;
        rememberedEndpointByModel.set(trimmed, pId);
        break;
      }
    }
  }

  // 5. A model discovered earlier keeps its endpoint while that endpoint is offline/unloaded,
  // so the turn fails on the right endpoint (preflight) instead of moving to another provider.
  if (!targetProviderId) {
    const remembered = rememberedEndpointByModel.get(trimmed);
    if (remembered && providerMap.has(remembered)) {
      targetProviderId = remembered;
      targetModel = trimmed;
    }
  }

  if (!targetProviderId) return null;

  const entry = providerMap.get(targetProviderId);
  if (!entry) return null;

  const env = options?.env ?? process.env;
  const apiKey = entry.keyEnv ? env[entry.keyEnv] : undefined;

  return {
    model: targetModel,
    provider: 'custom',
    baseUrl: normalizeBaseUrl(entry.baseUrl),
    ...(apiKey ? { apiKey } : {}),
    providerId: targetProviderId,
  };
}
