/**
 * Endpoint discovery for `providers.yaml` entries (ROADMAP 2.2a).
 *
 * For each configured endpoint, ask it which models it serves: Ollama via `/api/tags`, the
 * others via the OpenAI-style `/models` (under `/v1` unless the base URL already ends in it).
 * The result is plain data (online / offline / error plus model ids) for the picker. It makes
 * requests only to the base URLs the owner listed, sends the key (from the env var named by
 * `keyEnv`) only to that same host, refuses redirects so a key cannot be bounced elsewhere,
 * and never throws.
 */

import type { ProviderFileEntry } from '@cindy/model-providers/providers-file';

export type EndpointStatus = 'online' | 'offline' | 'error';

export interface EndpointProbe {
  id: string;
  status: EndpointStatus;
  models: string[];
  latencyMs: number;
  /** Set for `offline` (connect failure / timeout) and `error` (reachable but unusable reply). */
  error?: string;
}

export interface DiscoveryOptions {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** URL of the model-list endpoint for an entry. */
export function modelsUrl(entry: Pick<ProviderFileEntry, 'kind' | 'baseUrl'>): string {
  const base = entry.baseUrl.replace(/\/+$/, '');
  if (entry.kind === 'ollama') return `${base}/api/tags`;
  return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

function extractModelIds(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const rec = body as Record<string, unknown>;
  const list = Array.isArray(rec.data) ? rec.data : Array.isArray(rec.models) ? rec.models : null;
  if (!list) return null;
  const ids: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') ids.push(item);
    else if (typeof item === 'object' && item !== null) {
      const m = item as Record<string, unknown>;
      const id = [m.id, m.name, m.model].find((v) => typeof v === 'string' && v);
      if (typeof id === 'string') ids.push(id);
    }
  }
  return [...new Set(ids)].sort();
}

export async function probeEndpoint(entry: ProviderFileEntry, options: DiscoveryOptions = {}): Promise<EndpointProbe> {
  const { timeoutMs = 2000, env = process.env, fetchImpl = fetch } = options;
  const started = Date.now();
  const done = (status: EndpointStatus, models: string[], error?: string): EndpointProbe => ({
    id: entry.id,
    status,
    models,
    latencyMs: Date.now() - started,
    ...(error ? { error } : {}),
  });

  const headers: Record<string, string> = { accept: 'application/json' };
  if (entry.keyEnv) {
    const key = env[entry.keyEnv];
    if (key) headers.authorization = `Bearer ${key}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(modelsUrl(entry), { headers, signal: controller.signal, redirect: 'error' });
    if (!res.ok) return done('error', [], `HTTP ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return done('error', [], 'reply is not JSON');
    }
    const models = extractModelIds(body);
    return models ? done('online', models) : done('error', [], 'reply has no model list');
  } catch (error) {
    const aborted = controller.signal.aborted;
    return done('offline', [], aborted ? `no reply within ${timeoutMs} ms` : error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

let latestDiscoveredEndpointModels = new Map<string, string[]>();

export function getLatestDiscoveredModels(): Map<string, string[]> {
  return latestDiscoveredEndpointModels;
}

export function setLatestDiscoveredModels(models: Map<string, string[]>): void {
  latestDiscoveredEndpointModels = models;
}

/** Probe all entries in parallel; result order follows `entries`. */
export async function discoverEndpoints(entries: ProviderFileEntry[], options: DiscoveryOptions = {}): Promise<EndpointProbe[]> {
  const probes = await Promise.all(entries.map((e) => probeEndpoint(e, options)));
  const map = new Map<string, string[]>();
  for (const probe of probes) {
    if (probe.status === 'online' && probe.models.length > 0) {
      map.set(probe.id, probe.models);
    }
  }
  latestDiscoveredEndpointModels = map;
  return probes;
}
