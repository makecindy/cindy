import { createHash } from 'node:crypto';
import { isLoopbackProviderUrl, runtimeCustomProviderId, storedCustomProviderId,
  type AgentKind, type CustomProviderConfig, type ProviderView } from '@cindy/model-providers';
import type { CustomProviderDiscoveryDelta, CustomProviderDiscoverySnapshot } from '../../shared/customProviderUpdate.js';
import type { ProviderModelsFetchResult, ProviderModelsFetchSpec } from './provider-model-fetch.js';
import { createOverrideSettingsFile, type OverrideSettingsFile } from './override-settings-file.js';

export const CUSTOM_PROVIDER_REFRESH_INTERVAL = 24 * 60 * 60 * 1000;
const AGENTS: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];
type Owner = { dataOwnerId: string | null; generation: number };
interface Attempts { version: 1; providers: Record<string, { lastAttemptAt: number }> }

export function createCustomProviderRefreshAttempts(options: {
  filePath(): string;
  scopeKey(): string;
  log: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
}): OverrideSettingsFile<Attempts> {
  return createOverrideSettingsFile<Attempts>({
    ...options, label: 'custom provider refresh', defaults: { version: 1, providers: {} },
    preserveUnreadableFile: true, maxBytes: 1024 * 1024, logLoadedValue: false, logReadErrorDetails: false,
    normalize: raw => {
      const value = raw as Partial<Attempts>;
      if (value.version !== 1 || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers))
        throw new Error('invalid custom provider refresh state');
      return { version: 1, providers: Object.fromEntries(Object.entries(value.providers).filter(([id, entry]) =>
        /^[a-z0-9_-]+$/.test(id) && entry && Number.isSafeInteger(entry.lastAttemptAt) && entry.lastAttemptAt > 0)) };
    },
  });
}

/** Models are excluded: saving an unrelated user's field must never invalidate credentials by itself. */
export function customProviderDiscoverySignature(config: CustomProviderConfig): string {
  return createHash('sha256').update(JSON.stringify({ auth: config.auth,
    runtimes: Object.fromEntries(AGENTS.map(agent => {
      const rt = config.runtimes[agent];
      if (!rt) return [agent, null];
      const { models: _models, ...route } = rt;
      return [agent, route];
    })),
  })).digest('hex');
}

export interface CustomProviderModelRefreshDeps {
  owner(): Owner;
  ready?(): boolean;
  listIds(): Promise<string[]>;
  read(id: string): Promise<{ config: CustomProviderConfig; provider: ProviderView } | null>;
  revision(id: string): number;
  mutating(id: string): boolean;
  credentials(id: string, agent: AgentKind): { apiKey: string | null; headers?: Record<string, string> } | null;
  fetch(spec: ProviderModelsFetchSpec, isCurrent: () => boolean): Promise<ProviderModelsFetchResult>;
  apply(id: string, discovery: CustomProviderDiscoveryDelta[]): Promise<unknown>;
  attempts?: OverrideSettingsFile<Attempts>;
  now?(): number;
}

/** Main owns scheduling, captured credentials and request coalescing; saving uses the existing mutation queue. */
export function createCustomProviderModelRefresh(deps: CustomProviderModelRefreshDeps) {
  const now = deps.now ?? Date.now;
  let memoryScope = '';
  let memory: Record<string, { lastAttemptAt: number }> = {};
  let autoPass: { scope: string; promise: Promise<void> } | undefined;
  const requests = new Map<string, Promise<ProviderModelsFetchResult>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let stopped = false;
  const ownerKey = (owner: Owner) => JSON.stringify([owner.dataOwnerId, owner.generation]);
  const scope = () => ownerKey(deps.owner());
  const current = (key: string) => !stopped && scope() === key && deps.owner().dataOwnerId !== null && deps.ready?.() !== false;
  const state = () => {
    const key = scope();
    if (key !== memoryScope) { memory = {}; memoryScope = key; }
    deps.attempts?.invalidateIfChanged();
    const providers = { ...(deps.attempts?.read().providers ?? {}) };
    for (const [id, entry] of Object.entries(memory)) {
      if (!providers[id] || entry.lastAttemptAt > providers[id].lastAttemptAt) providers[id] = entry;
    }
    return providers;
  };
  const due = (time: number | undefined) => !time || time > now() || now() - time >= CUSTOM_PROVIDER_REFRESH_INTERVAL;

  async function attempt(id: string, key: string, manual: boolean): Promise<boolean> {
    if (!current(key)) return false;
    state();
    let claimed = false;
    let timestamp = now();
    const update = (providers: Attempts['providers']): Attempts['providers'] => {
      if (!current(key)) return providers;
      const previous = Math.max(providers[id]?.lastAttemptAt ?? 0, memory[id]?.lastAttemptAt ?? 0);
      if (manual || due(previous)) {
        claimed = true;
        timestamp = now();
        return { ...providers, [id]: { lastAttemptAt: timestamp } };
      }
      return providers;
    };
    try {
      if (deps.attempts) await deps.attempts.updateAtomic(s => ({ version: 1, providers: update(s.value.providers) }), { preserveDefaults: true });
      else update({});
    } catch {
      // Preserve corrupt/unwritable files. Memory still limits this process; a restart may retry.
      claimed = false;
      update({});
    }
    if (!current(key)) return false;
    if (claimed) memory[id] = { lastAttemptAt: timestamp };
    return claimed;
  }

  async function capture(id: string, agent: AgentKind) {
    const owner = deps.owner();
    const key = ownerKey(owner);
    const revision = deps.revision(id);
    const isCurrent = () => current(key) && !deps.mutating(id) && deps.revision(id) === revision;
    if (!isCurrent()) return null;
    const saved = await deps.read(id);
    if (!saved || !isCurrent()) return null;
    const { config, provider } = saved;
    const rt = config.runtimes[agent];
    if (provider.source !== 'user' || provider.suspended || config.auth?.native || !rt?.baseUrl || provider.routing[agent]?.disabled) return null;
    const credentials = deps.credentials(id, agent);
    if (!credentials || !isCurrent()) return null;
    const authMethod = config.auth?.method ?? 'apiKey';
    if (authMethod === 'apiKey' && !credentials.apiKey && !Object.keys(credentials.headers ?? {}).length) return null;
    if (authMethod === 'none' && (!isLoopbackProviderUrl(rt.baseUrl) || (rt.modelsUrl && !isLoopbackProviderUrl(rt.modelsUrl)))) return null;
    const snapshot: CustomProviderDiscoverySnapshot = {
      providerId: id, agent, ownerGeneration: owner.generation, ownerId: owner.dataOwnerId!,
      credentialRevision: revision, routeSignature: customProviderDiscoverySignature(config),
    };
    const spec: ProviderModelsFetchSpec = { agent, baseUrl: rt.baseUrl, modelsUrl: rt.modelsUrl,
      wireProtocol: rt.wireProtocol, authMethod, apiKey: credentials.apiKey, headers: credentials.headers,
      savedProviderId: runtimeCustomProviderId(id), redirect: 'error' };
    return { snapshot, spec, key, isCurrent };
  }

  async function query(captured: NonNullable<Awaited<ReturnType<typeof capture>>>, manual: boolean) {
    const { snapshot, spec, key, isCurrent } = captured;
    const requestKey = JSON.stringify(snapshot);
    const existing = requests.get(requestKey);
    if (existing) {
      if (manual) await attempt(snapshot.providerId, key, true);
      return isCurrent() ? existing : { ok: false, code: 'AUTH_INVALID' as const };
    }
    // Publish the Promise before waiting on the file lock; manual/automatic callers coalesce here too.
    const promise = (async (): Promise<ProviderModelsFetchResult> => {
      if (manual && !(await attempt(snapshot.providerId, key, true))) return { ok: false, code: 'AUTH_INVALID' };
      if (!isCurrent()) return { ok: false, code: 'AUTH_INVALID' };
      try {
        const result = await deps.fetch(spec, isCurrent);
        return isCurrent() ? { ...result, snapshot } : { ok: false, code: 'AUTH_INVALID' };
      } catch { return { ok: false, code: 'UNKNOWN' }; }
    })();
    requests.set(requestKey, promise);
    try { return await promise; }
    finally { if (requests.get(requestKey) === promise) requests.delete(requestKey); }
  }

  async function fetchSaved(providerId: string, agent: AgentKind): Promise<ProviderModelsFetchResult> {
    const captured = await capture(storedCustomProviderId(providerId), agent);
    if (!captured) return { ok: false, code: 'AUTH_INVALID' };
    const result = await query(captured, true);
    // Re-arm against the reset timestamp even when the request failed.
    if (running) scheduleNext();
    return result;
  }

  async function runPass(key: string): Promise<void> {
    if (!current(key)) return;
    const ids = await deps.listIds();
    if (!current(key)) return;
    try {
      await deps.attempts?.updateAtomic(s => ({ providers: Object.fromEntries(Object.entries(s.value.providers).filter(([id]) => ids.includes(id))) }));
    } catch { /* Cache cleanup cannot prevent model discovery. */ }
    if (!current(key)) return;
    state();
    memory = Object.fromEntries(Object.entries(memory).filter(([id]) => ids.includes(id)));
    for (const id of ids) {
      if (!current(key)) return;
      if (!due(state()[id]?.lastAttemptAt)) continue;
      let connection: CustomProviderDiscoverySnapshot | undefined;
      const discovery: CustomProviderDiscoveryDelta[] = [];
      for (const agent of AGENTS) {
        const captured = await capture(id, agent);
        if (!current(key)) return;
        if (!captured) continue;
        if (connection && (connection.credentialRevision !== captured.snapshot.credentialRevision || connection.routeSignature !== captured.snapshot.routeSignature)) break;
        if (!connection && !(await attempt(id, key, false))) break;
        const result = await query(captured, false);
        connection ??= captured.snapshot;
        if (result.ok && result.models && result.snapshot) discovery.push({ snapshot: result.snapshot, models: result.models });
        if (!captured.isCurrent()) break;
      }
      if (discovery.length && current(key)) {
        try { await deps.apply(id, discovery); } catch { /* Stale or busy: keep the saved configuration. */ }
      }
    }
  }

  async function run(): Promise<void> {
    const key = scope();
    if (autoPass?.scope === key) return autoPass.promise;
    const pass = { scope: key, promise: Promise.resolve() };
    autoPass = pass;
    pass.promise = runPass(key).catch(() => undefined).finally(() => {
      if (autoPass !== pass) return;
      autoPass = undefined;
      if (running) scheduleNext();
    });
    return pass.promise;
  }
  function schedule(delay: number): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void run(); }, delay);
    timer.unref?.();
  }
  function scheduleNext(): void {
    // The local readiness check also covers newly added connections and account initialization.
    // No provider HTTP request runs unless its persisted connection timestamp is due.
    let delay = current(scope()) ? 60 * 60 * 1000 : 60 * 1000;
    if (current(scope())) for (const entry of Object.values(state())) {
      const remaining = entry.lastAttemptAt + CUSTOM_PROVIDER_REFRESH_INTERVAL - now();
      if (remaining > 0) delay = Math.min(delay, remaining);
    }
    schedule(Math.max(1000, delay));
  }
  return { fetchSaved, run, start() { stopped = false; running = true; schedule(0); },
    kick() { if (running) schedule(0); },
    stop() { stopped = true; running = false; if (timer) clearTimeout(timer); timer = undefined; },
  };
}
