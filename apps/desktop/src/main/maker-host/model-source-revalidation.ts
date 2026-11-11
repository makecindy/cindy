import type { AgentKind, CustomProviderConfig, DiscoveredModel } from '@cindy/model-providers';
import { isCurrentModelSource, modelSourceRequestSignature } from './model-source-snapshots.js';

const AGENTS = ['claude-code', 'codex', 'pi'] as const;
const FAILURE_RETRY_MS = 5 * 60_000;

interface ModelSourceRevalidationDeps {
  fetchModels(config: CustomProviderConfig, agent: AgentKind, isCurrent: () => boolean): Promise<DiscoveredModel[] | null | { retryAt: number }>;
  save(id: string, previous: CustomProviderConfig, next: CustomProviderConfig): Promise<boolean>;
  credentialRevision(id: string): number;
  isMutating(id: string): boolean;
  now(): number;
}

/** Revalidate old display provenance without importing models or changing user overrides.
 * Concurrent catalog loads share discovery; failed reads retry only on a later
 * load after a cooldown. No timer or credential persistence. */
export function createModelSourceRevalidator(deps: ModelSourceRevalidationDeps) {
  const reads = new Map<string, {
    signature: string;
    retryAt: number;
    promise: Promise<Array<{ agent: AgentKind; models: DiscoveredModel[] | null }>>;
  }>();
  let activeScope: string | undefined;
  return async (configs: readonly CustomProviderConfig[], scope: string, ownerIsCurrent: () => boolean): Promise<boolean> => {
    if (!ownerIsCurrent()) return false;
    if (activeScope !== scope) { reads.clear(); activeScope = scope; }
    const results = await Promise.all(configs.map(async config => {
      const agents = AGENTS.filter(agent => config.runtimes[agent]?.models.some(model =>
        model.discoveredSource && !isCurrentModelSource(model.discoveredSource)));
      if (!agents.length || deps.isMutating(config.id)) return false;
      const revision = deps.credentialRevision(config.id);
      const isCurrent = () => ownerIsCurrent() && !deps.isMutating(config.id)
        && revision === deps.credentialRevision(config.id);
      // Runtime headers may contain secrets: retain only a process-local HMAC as
      // the cache key, never serialized requests or cleartext credentials.
      // Source-only writes must not bypass a failed runtime's cooldown or cause
      // rediscovery when another engine finished successfully.
      const requests = AGENTS.map(agent => {
        const runtime = config.runtimes[agent];
        return runtime && [agent, runtime.baseUrl, runtime.modelsUrl, runtime.wireProtocol, runtime.headersState, runtime.headers];
      });
      const signature = modelSourceRequestSignature(JSON.stringify([scope, revision, config.auth, requests]), {});
      let read = reads.get(config.id);
      if (!read || read.signature !== signature || deps.now() >= read.retryAt) {
        let retryAt = 0;
        const promise = Promise.all(agents.map(async agent => {
          const result = await Promise.resolve().then(() => isCurrent() ? deps.fetchModels(config, agent, isCurrent) : null).catch(() => null);
          if (result && !Array.isArray(result)) retryAt = Math.max(retryAt, result.retryAt);
          // Retain only source fields for saved IDs, never the full catalog.
          const ids = new Set(config.runtimes[agent]!.models.map(model => model.id));
          return { agent, models: Array.isArray(result) ? result.filter(model => ids.has(model.id)).map(model => ({
            id: model.id, name: '', discoveredSource: model.discoveredSource,
          })) : null };
        }));
        read = { signature, retryAt: Infinity, promise };
        reads.set(config.id, read);
        const entry = read;
        void promise.then(rows => {
          if (rows.some(row => row.models === null)) entry.retryAt = Math.max(deps.now() + FAILURE_RETRY_MS, retryAt);
        });
      }
      const rows = await read.promise;
      if (!isCurrent()) return false;
      const runtimes = { ...config.runtimes };
      let changed = false;
      for (const { agent, models } of rows) {
        const runtime = runtimes[agent];
        if (!models || !runtime || !agents.includes(agent)) continue;
        const discovered = new Map(models.map(model => [model.id, model.discoveredSource]));
        runtimes[agent] = { ...runtime, models: runtime.models.map(model => {
          const { discoveredSource: _old, ...rest } = model;
          const source = discovered.get(model.id);
          return { ...rest, ...(source ? { discoveredSource: source } : {}) };
        }) };
        changed = true;
      }
      // CAS also rejects edits/deletion while the request was in flight. The
      // ordinary store strips transient secure headers before writing SQLite.
      const saved = changed && isCurrent() && await deps.save(config.id, config, { ...config, runtimes });
      if (reads.get(config.id) === read) {
        // Release successful results after CAS; keep only failed runtime markers
        // and their deadline. A CAS miss can retry discovery after the cooldown.
        const failed = rows.filter(row => row.models === null);
        if (saved && !failed.length) reads.delete(config.id);
        else {
          read.promise = Promise.resolve(failed);
          if (!saved && changed) read.retryAt = Math.max(deps.now() + FAILURE_RETRY_MS, Number.isFinite(read.retryAt) ? read.retryAt : 0);
        }
      }
      return saved;
    }));
    return results.some(Boolean);
  };
}
