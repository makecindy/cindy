import type { AgentKind, CustomProviderConfig, DiscoveredModel } from '@cindy/model-providers';
import { isCurrentModelSource, modelSourceRequestSignature } from './model-source-snapshots.js';

const AGENTS = ['claude-code', 'codex', 'pi'] as const;
const FAILURE_RETRY_MS = 5 * 60_000;
const MAX_PARALLEL_DISCOVERIES = 4;

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
  // Shared across overlapping loads and owner changes, including pagination.
  let running = 0;
  const waiting: Array<() => void> = [];
  async function discover(work: () => ReturnType<ModelSourceRevalidationDeps['fetchModels']>) {
    if (running >= MAX_PARALLEL_DISCOVERIES) await new Promise<void>(resolve => waiting.push(resolve));
    else running++;
    try { return await work(); } finally {
      const next = waiting.shift();
      if (next) next(); else running--;
    }
  }
  // Deadlines contain no model data. Session generation invalidates writes and
  // in-flight reuse, but not a server cooldown for an unchanged owner/connection.
  const deadlines = new Map<string, { signature: string; retryAt: number }>();
  let connections = new Map<string, string>();
  let activeOwner: string | undefined;
  const reads = new Map<string, {
    signature: string;
    retryAt: number;
    promise: Promise<Array<{ agent: AgentKind; models: DiscoveredModel[] | null }>>;
  }>();
  let activeScope: string | undefined;
  return async (configs: readonly CustomProviderConfig[], scope: string, ownerIsCurrent: () => boolean, ownerKey = scope): Promise<boolean> => {
    if (!ownerIsCurrent()) return false;
    if (activeOwner !== ownerKey) { deadlines.clear(); connections = new Map(); activeOwner = ownerKey; }
    if (activeScope !== scope) { reads.clear(); activeScope = scope; }
    const ids = new Set(configs.map(config => config.id));
    for (const id of deadlines.keys()) if (!ids.has(id)) deadlines.delete(id);
    for (const id of connections.keys()) if (!ids.has(id)) connections.delete(id);
    const ownerConnections = connections;
    const results = await Promise.all(configs.map(async config => {
      const agents = AGENTS.filter(agent => config.runtimes[agent]?.models.some(model =>
        model.discoveredSource && !isCurrentModelSource(model.discoveredSource)));
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
      const deadlineSignature = modelSourceRequestSignature(JSON.stringify([ownerKey, revision, config.auth, requests]), {});
      connections.set(config.id, deadlineSignature);
      if (!agents.length || deps.isMutating(config.id)) return false;
      const retainDeadline = (retryAt: number) => {
        // Generation expiry does not revoke a same-connection cooldown. A
        // changed owner/request does, and a late result must never shorten it.
        if (connections !== ownerConnections || connections.get(config.id) !== deadlineSignature
          || revision !== deps.credentialRevision(config.id) || deps.isMutating(config.id)) return;
        const previous = deadlines.get(config.id);
        deadlines.set(config.id, { signature: deadlineSignature, retryAt: Math.max(retryAt,
          previous?.signature === deadlineSignature ? previous.retryAt : 0) });
      };
      const deadline = deadlines.get(config.id);
      if (deadline && deadline.signature !== deadlineSignature) deadlines.delete(config.id);
      else if (deadline && deps.now() < deadline.retryAt) return false;
      let read = reads.get(config.id);
      if (!read || read.signature !== signature || deps.now() >= read.retryAt) {
        let retryAt = 0;
        const promise = Promise.all(agents.map(async agent => {
          const result = await Promise.resolve().then(() => discover(async () =>
            isCurrent() ? deps.fetchModels(config, agent, isCurrent) : null)).catch(() => null);
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
          if (rows.some(row => row.models === null)) {
            entry.retryAt = Math.max(deps.now() + FAILURE_RETRY_MS, retryAt);
            retainDeadline(entry.retryAt);
          }
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
      if (!saved && changed) retainDeadline(deps.now() + FAILURE_RETRY_MS);
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
