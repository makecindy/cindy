/**
 * route-preflight.ts — before a Hermes turn on a providers.yaml endpoint, check the endpoint
 * answers and has the model loaded (ROADMAP 2.4c). Without this a turn on a stopped or
 * unloaded LM Studio / Ollama hangs for minutes inside the Hermes CLI, then surfaces the
 * server's raw error. Never throws; never contacts any host but the listed base URL.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { probeEndpoint, type DiscoveryOptions } from './discovery.js';
import { resolveModelRoute, type ModelRouteResolverOptions } from './model-route-resolver.js';
import { loadProvidersFile } from './providers-file.js';

export type RoutePreflight =
  | { ok: true }
  | { ok: false; reason: 'offline' | 'error' | 'model-not-loaded'; providerId: string; message: string };

export async function preflightModelRoute(
  modelId: string | undefined | null,
  options: ModelRouteResolverOptions & DiscoveryOptions = {},
): Promise<RoutePreflight> {
  const route = resolveModelRoute(modelId, options);
  if (!route?.providerId) return { ok: true }; // Hermes home default route: not ours to check.
  const harnessDir = options.harnessDir ?? path.join(os.homedir(), '.cindy-harness');
  const entry = loadProvidersFile(path.join(harnessDir, 'providers.yaml')).providers
    .find((p) => p.id === route.providerId);
  if (!entry) return { ok: true };

  const probe = await probeEndpoint(entry, { timeoutMs: 2500, ...options });
  const where = `${entry.id} (${entry.baseUrl})`;
  if (probe.status === 'offline') {
    return {
      ok: false, reason: 'offline', providerId: entry.id,
      message: `${where} is not reachable (${probe.error ?? 'no reply'}). Start it, or pick another model.`,
    };
  }
  if (probe.status === 'error') {
    return {
      ok: false, reason: 'error', providerId: entry.id,
      message: `${where} replied with an error (${probe.error ?? 'unknown'}). Check it, or pick another model.`,
    };
  }
  if (!probe.models.includes(route.model)) {
    const loaded = probe.models.length > 0
      ? `Loaded: ${probe.models.slice(0, 5).join(', ')}${probe.models.length > 5 ? ', …' : ''}.`
      : 'No models are loaded.';
    return {
      ok: false, reason: 'model-not-loaded', providerId: entry.id,
      message: `"${route.model}" is not loaded in ${where}. ${loaded} Load it, or pick another model.`,
    };
  }
  return { ok: true };
}
