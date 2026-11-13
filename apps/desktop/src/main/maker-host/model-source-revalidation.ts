import type { AgentKind, CustomProviderConfig, DiscoveredModel } from '@cindy/model-providers';
import { isCurrentModelSource, modelSourceRequestSignature } from './model-source-snapshots.js';

const AGENTS = ['claude-code', 'codex', 'pi'] as const;
const FAILURE_RETRY_MS = 5 * 60_000;
const MAX_PARALLEL_DISCOVERIES = 4;
type DiscoveryScheduler = <T>(work: () => Promise<T>) => Promise<T>;

/** Local cancellation before dispatch is not a failed upstream read. */
export class ModelSourceRecoveryCanceled extends Error {}

interface ModelSourceRevalidationDeps {
  fetchModels(config: CustomProviderConfig, agent: AgentKind, isCurrent: () => boolean, schedule: DiscoveryScheduler): Promise<DiscoveredModel[] | null | { retryAt: number }>;
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
  async function discover<T>(work: () => Promise<T>): Promise<T> {
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
    promise: Promise<Array<{ agent: AgentKind; models: DiscoveredModel[] | null }>>;
  }>();
  let activeScope: string | undefined;
  return async (configs: readonly CustomProviderConfig[], scope: string, ownerIsCurrent: () => boolean, ownerKey = scope): Promise<boolean> => {
    if (!ownerIsCurrent()) return false;
    if (activeOwner !== ownerKey) { deadlines.clear(); connections = new Map(); activeOwner = ownerKey; }
    if (activeScope !== scope) { reads.clear(); activeScope = scope; }
    const ids = new Set(configs.flatMap(config => AGENTS.filter(agent => config.runtimes[agent])
      .map(agent => JSON.stringify([config.id, agent]))));
    for (const id of deadlines.keys()) if (!ids.has(id)) deadlines.delete(id);
    for (const id of connections.keys()) if (!ids.has(id)) connections.delete(id);
    const ownerConnections = connections;
    const results = await Promise.all(configs.map(async config => {
      const revision = deps.credentialRevision(config.id);
      const isCurrent = () => ownerIsCurrent() && !deps.isMutating(config.id)
        && revision === deps.credentialRevision(config.id);
      // Runtime headers may contain secrets: retain only a process-local HMAC as
      // the cache key, never serialized requests or cleartext credentials.
      // Source-only writes must not bypass a failed runtime's cooldown or cause
      // rediscovery when another engine finished successfully.
      const contexts = AGENTS.flatMap(agent => {
        const runtime = config.runtimes[agent];
        if (!runtime) return [];
        const key = JSON.stringify([config.id, agent]);
        const request = [runtime.baseUrl, runtime.modelsUrl, runtime.wireProtocol, runtime.headersState, runtime.headers];
        const deadlineSignature = modelSourceRequestSignature(JSON.stringify([ownerKey, revision, config.auth, request]), {});
        connections.set(key, deadlineSignature);
        const retainDeadline = (retryAt: number) => {
          // Generation expiry does not revoke a same-connection cooldown. A
          // changed owner/request does, and a late result must never shorten it.
          if (connections !== ownerConnections || connections.get(key) !== deadlineSignature
            || revision !== deps.credentialRevision(config.id) || deps.isMutating(config.id)) return;
          const previous = deadlines.get(key);
          deadlines.set(key, { signature: deadlineSignature, retryAt: Math.max(retryAt,
            previous?.signature === deadlineSignature ? previous.retryAt : 0) });
        };
        const deadline = deadlines.get(key);
        if (deadline && deadline.signature !== deadlineSignature) deadlines.delete(key);
        const cooling = deadline?.signature === deadlineSignature && deps.now() < deadline.retryAt;
        return [{ agent, runtime, deadlineSignature, retainDeadline, cooling }];
      });
      const eligible = contexts.filter(context => !context.cooling && context.runtime.models.some(model =>
        model.discoveredSource && !isCurrentModelSource(model.discoveredSource)));
      if (!eligible.length || deps.isMutating(config.id)) return false;
      const agents = eligible.map(context => context.agent);
      // Cooling eligibility changes independently of the shared in-flight work.
      const signature = modelSourceRequestSignature(JSON.stringify([scope, contexts.map(context =>
        [context.agent, context.deadlineSignature, [...new Set(context.runtime.models.map(model => model.id))].sort()])]), {});
      let read = reads.get(config.id);
      if (!read || read.signature !== signature) {
        const promise = Promise.all(eligible.map(async ({ agent, retainDeadline }) => {
          // The HTTP layer coalesces identical requests before taking a slot;
          // queued sibling runtimes must join the same read rather than refetch.
          const result = await Promise.resolve().then(() => {
            if (!isCurrent()) throw new ModelSourceRecoveryCanceled();
            return deps.fetchModels(config, agent, isCurrent, work => discover(async () => {
              if (!isCurrent()) throw new ModelSourceRecoveryCanceled();
              return work();
            }));
          }).catch(error => error instanceof ModelSourceRecoveryCanceled ? error : null);
          if (result instanceof ModelSourceRecoveryCanceled) return { agent, models: null };
          if (!Array.isArray(result)) {
            const deadline = Math.max(deps.now() + FAILURE_RETRY_MS, result?.retryAt ?? 0);
            retainDeadline(deadline);
          }
          // Retain only source fields for saved IDs, never the full catalog.
          const ids = new Set(config.runtimes[agent]!.models.map(model => model.id));
          return { agent, models: Array.isArray(result) ? result.filter(model => ids.has(model.id)).map(model => ({
            id: model.id, name: '', discoveredSource: model.discoveredSource,
          })) : null };
        }));
        read = { signature, promise };
        reads.set(config.id, read);
      }
      const rows = await read.promise;
      if (!isCurrent()) {
        if (reads.get(config.id) === read) reads.delete(config.id);
        return false;
      }
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
      if (!saved && changed) for (const row of rows) {
        if (row.models) eligible.find(context => context.agent === row.agent)?.retainDeadline(deps.now() + FAILURE_RETRY_MS);
      }
      // Only runtime deadlines survive completion; retaining a settled subset
      // could hide a different runtime whose deadline expires on the next hint.
      if (reads.get(config.id) === read) reads.delete(config.id);
      return saved;
    }));
    return results.some(Boolean);
  };
}
