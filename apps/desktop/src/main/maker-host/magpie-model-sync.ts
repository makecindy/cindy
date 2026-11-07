/**
 * Magpie model-list synchronization.
 *
 * Magpie is connected through the ordinary custom-provider infrastructure
 * (`catalogPresetId: 'magpie'`), so its key stays in safeStorage and its models
 * live in the custom-provider SQLite row. This coordinator only refreshes that
 * catalog:
 *
 *   - additions-only: a model Magpie stops returning keeps routing existing
 *     tasks; existing ids, enabled flags and explicit routes are untouched;
 *   - native-endpoint aware: newly discovered models get a per-model route when
 *     their `native_endpoints` differ from the runtime default;
 *   - cooldown-bound for automatic triggers, bypassable by an explicit refresh;
 *   - status is persisted separately (timestamps + error code only).
 *
 * The gateway key is read per runtime, used for the request and never logged.
 */

import {
  isMagpieCustomProviderConfig,
  magpieRouteForAgent,
  mergeDiscoveredRuntimeModels,
  type AgentKind,
  type CustomProviderConfig,
  type DiscoveredModel,
  type ProviderRuntimeModelConfig,
} from '@cindy/model-providers';

import {
  isProviderModelSyncStale,
  MAGPIE_MODEL_SYNC_COOLDOWN_MS,
  MAGPIE_MODEL_SYNC_FAILURE_COOLDOWN_MS,
  type ProviderModelSyncErrorCode,
  type ProviderModelSyncResult,
  type ProviderModelSyncStatus,
} from '../../shared/magpieModelSync.js';
import type { ProviderModelAutoRefreshTrigger } from '../../shared/providerModelRefresh.js';
import type { Logger } from '../logger.js';
import type {
  ProviderModelsFetchResult,
  ProviderModelsFetchSpec,
} from './provider-model-fetch.js';

export const MAGPIE_SYNC_AGENTS: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];

/** A forced startup refresh still dedupes two startup triggers a minute apart. */
const STARTUP_DEDUP_MS = 60_000;
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface MagpieSyncStatusState {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  failure: { code: string; status?: number; at: number } | null;
}

export interface MagpieSyncStatusStore {
  read(providerId: string): MagpieSyncStatusState | undefined;
  write(providerId: string, state: MagpieSyncStatusState): void;
}

export interface MagpieModelSyncDeps {
  listConfigs(): Promise<CustomProviderConfig[]>;
  getConfig(providerId: string): Promise<CustomProviderConfig | null>;
  readKey(providerId: string, agent: AgentKind): string | null;
  fetchModels(spec: ProviderModelsFetchSpec): Promise<ProviderModelsFetchResult>;
  updateConfigIfUnchanged(
    providerId: string,
    expected: CustomProviderConfig,
    next: CustomProviderConfig,
  ): Promise<boolean>;
  refreshCatalog(): Promise<void>;
  broadcastChanged?(): void;
  getScopeKey?(): string | number;
  appVersion: string;
  now(): number;
  log: Pick<Logger, 'debug' | 'warn'>;
  statusStore: MagpieSyncStatusStore;
}

export interface MagpieModelSyncCoordinator {
  requestAutoRefresh(trigger: ProviderModelAutoRefreshTrigger): Promise<void>;
  syncNow(providerId: string, options?: { afterChange?: boolean }): Promise<ProviderModelSyncResult>;
  getStatus(providerId: string): ProviderModelSyncStatus;
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_CODE_RE.test(value) ? value : fallback;
}

function userAgent(version: string): string {
  const safe = /^[0-9A-Za-z._+-]{1,64}$/.test(version) ? version : 'unknown';
  return `Cindy/${safe}`;
}

function statusFromState(
  providerId: string,
  state: MagpieSyncStatusState | undefined,
  now: number,
): ProviderModelSyncStatus {
  const lastAttemptAt = state?.lastAttemptAt ?? null;
  const lastSuccessAt = state?.lastSuccessAt ?? null;
  const failure = state?.failure ?? null;
  return {
    providerId,
    lastAttemptAt,
    lastSuccessAt,
    failure,
    stale: isProviderModelSyncStale({ lastSuccessAt, failure }, now),
  };
}

function nextState(
  previous: MagpieSyncStatusState | undefined,
  now: number,
  failure: { code: string; status?: number } | null,
): MagpieSyncStatusState {
  return {
    lastAttemptAt: now,
    lastSuccessAt: failure === null ? now : (previous?.lastSuccessAt ?? null),
    failure: failure === null
      ? null
      : { code: safeCode(failure.code, 'UNKNOWN'), at: now, ...(failure.status !== undefined ? { status: failure.status } : {}) },
  };
}

/**
 * Add routes only to newly discovered models. Existing entries keep every
 * user-visible field; touching their route would also make the store drop the
 * stale discovery label through `invalidateEditedProviderMetadata`.
 */
export function mergeMagpieRuntimeModels(
  runtime: Pick<NonNullable<CustomProviderConfig['runtimes'][AgentKind]>, 'baseUrl' | 'wireProtocol' | 'models'>,
  agent: AgentKind,
  discovered: readonly DiscoveredModel[],
): ProviderRuntimeModelConfig[] {
  const byId = new Map(discovered.map((model) => [model.id, model]));
  return mergeDiscoveredRuntimeModels(runtime.models, discovered).map((model) => {
    // Never rewrite an explicit route, API or user selection. A model without
    // one (imported or discovered before this feature) still needs a native
    // path when Magpie declares one; without it the runtime default may be a
    // path the gateway rejects for that model.
    if (model.route || model.api || model.piApi) return model;
    const route = magpieRouteForAgent(
      agent,
      byId.get(model.id)?.nativeEndpoints,
      runtime.baseUrl,
      runtime.wireProtocol,
    );
    return route ? { ...model, route } : model;
  });
}

export function createMagpieModelSyncCoordinator(
  deps: MagpieModelSyncDeps,
  cooldownMs = MAGPIE_MODEL_SYNC_COOLDOWN_MS,
  failureCooldownMs = MAGPIE_MODEL_SYNC_FAILURE_COOLDOWN_MS,
): MagpieModelSyncCoordinator {
  const inFlight = new Map<string, Promise<ProviderModelSyncResult>>();
  let scopeKey = deps.getScopeKey?.();

  function syncScope(): void {
    try {
      const next = deps.getScopeKey?.();
      if (next === scopeKey) return;
      scopeKey = next;
      inFlight.clear();
      deps.log.debug('magpie model sync scope changed', {});
    } catch {
      // Scope reads can race app teardown; keep the last known scope.
    }
  }

  function getStatus(providerId: string): ProviderModelSyncStatus {
    syncScope();
    return statusFromState(providerId, deps.statusStore.read(providerId), deps.now());
  }

  function autoCooldown(providerId: string, now: number): number | undefined {
    const state = deps.statusStore.read(providerId);
    const failureAt = state?.failure?.at;
    const attemptAt = state?.lastAttemptAt ?? null;
    const activeCooldown = failureAt !== undefined ? failureCooldownMs : cooldownMs;
    const startedAt = failureAt ?? attemptAt;
    if (startedAt === null || startedAt === undefined) return undefined;
    const remaining = activeCooldown - (now - startedAt);
    return remaining > 0 ? remaining : undefined;
  }

  function publishStatus(providerId: string, state: MagpieSyncStatusState): void {
    deps.statusStore.write(providerId, state);
    deps.broadcastChanged?.();
  }

  async function performSync(providerId: string): Promise<ProviderModelSyncResult> {
    const scopeAtStart = deps.getScopeKey?.();
    const config = await deps.getConfig(providerId);
    if (deps.getScopeKey?.() !== scopeAtStart) {
      return { ok: false, status: getStatus(providerId), added: 0, code: 'CONFIG_CHANGED' };
    }
    if (!config || !isMagpieCustomProviderConfig(config)) {
      const now = deps.now();
      const status = statusFromState(providerId, deps.statusStore.read(providerId), now);
      return { ok: false, status, added: 0, code: 'NOT_SUPPORTED' };
    }

    const agents = MAGPIE_SYNC_AGENTS.filter((agent) => config.runtimes[agent]);
    if (agents.length === 0) {
      const now = deps.now();
      publishStatus(providerId, nextState(deps.statusStore.read(providerId), now, {
        code: 'NOT_CONFIGURED',
      }));
      return {
        ok: false,
        status: statusFromState(providerId, deps.statusStore.read(providerId), deps.now()),
        added: 0,
        code: 'NOT_CONFIGURED',
      };
    }

    const added = new Set<string>();
    let firstFailure: { code: string; status?: number } | null = null;
    let successes = 0;

    for (const agent of agents) {
      if (deps.getScopeKey?.() !== scopeAtStart) {
        firstFailure ??= { code: 'CONFIG_CHANGED' };
        break;
      }
      const runtime = config.runtimes[agent];
      if (!runtime) continue;
      let apiKey: string | null = null;
      const authMethod = config.auth?.method === 'none' ? 'none' : 'apiKey';
      if (authMethod === 'apiKey') {
        try {
          apiKey = deps.readKey(providerId, agent);
        } catch {
          firstFailure ??= { code: 'KEY_UNAVAILABLE' };
          continue;
        }
        if (!apiKey) {
          firstFailure ??= { code: 'KEY_UNAVAILABLE' };
          continue;
        }
      }

      let result: ProviderModelsFetchResult;
      try {
        result = await deps.fetchModels({
          agent,
          baseUrl: runtime.baseUrl,
          authMethod,
          ...(runtime.wireProtocol ? { wireProtocol: runtime.wireProtocol } : {}),
          modelsUrl: runtime.modelsUrl ?? null,
          apiKey,
          headers: { 'User-Agent': userAgent(deps.appVersion) },
        });
      } catch {
        firstFailure ??= { code: 'UNKNOWN' };
        continue;
      }
      if (!result.ok || !result.models) {
        firstFailure ??= { code: result.code ?? 'DISCOVERY_FAILED', ...(result.status !== undefined ? { status: result.status } : {}) };
        continue;
      }

      // Re-read before every write so a concurrent settings edit wins the CAS
      // instead of being overwritten by this background discovery.
      const latest = await deps.getConfig(providerId);
      if (!latest || !isMagpieCustomProviderConfig(latest) || deps.getScopeKey?.() !== scopeAtStart) {
        firstFailure ??= { code: 'CONFIG_CHANGED' };
        break;
      }
      if (JSON.stringify(latest.auth ?? null) !== JSON.stringify(config.auth ?? null)) {
        firstFailure ??= { code: 'CONFIG_CHANGED' };
        break;
      }
      const latestRuntime = latest.runtimes[agent];
      if (!latestRuntime) continue;
      // The user may have edited this runtime while the request was in flight.
      // Do not attach models discovered from the old endpoint to the new one.
      if (
        latestRuntime.baseUrl !== runtime.baseUrl ||
        latestRuntime.wireProtocol !== runtime.wireProtocol ||
        latestRuntime.modelsUrl !== runtime.modelsUrl
      ) {
        firstFailure ??= { code: 'CONFIG_CHANGED' };
        continue;
      }
      const known = new Set(latestRuntime.models.map((model) => model.id));
      const models = mergeMagpieRuntimeModels(latestRuntime, agent, result.models);
      if (JSON.stringify(models) !== JSON.stringify(latestRuntime.models)) {
        const applied = await deps.updateConfigIfUnchanged(providerId, latest, {
          ...latest,
          runtimes: { ...latest.runtimes, [agent]: { ...latestRuntime, models } },
        });
        if (!applied) {
          firstFailure ??= { code: 'CONFIG_CHANGED' };
          continue;
        }
      }
      for (const model of models) if (!known.has(model.id)) added.add(model.id);
      successes += 1;
    }

    if (deps.getScopeKey?.() !== scopeAtStart) {
      const status = getStatus(providerId);
      return { ok: false, status, added: added.size, code: 'CONFIG_CHANGED' };
    }

    const ok = successes > 0 && firstFailure === null;
    const now = deps.now();
    publishStatus(providerId, nextState(deps.statusStore.read(providerId), now, ok ? null : firstFailure ?? {
      code: 'DISCOVERY_FAILED',
    }));
    if (added.size > 0 || successes > 0) {
      try {
        await deps.refreshCatalog();
      } catch {
        deps.log.warn('magpie model sync catalog refresh failed', { providerId });
      }
    }
    const status = statusFromState(providerId, deps.statusStore.read(providerId), deps.now());
    if (!ok) {
      deps.log.warn('magpie model sync failed', {
        providerId,
        code: status.failure?.code ?? 'UNKNOWN',
      });
    }
    return {
      ok,
      status,
      added: added.size,
      ...(ok ? {} : { code: (status.failure?.code === 'CONFIG_CHANGED'
        ? 'CONFIG_CHANGED'
        : 'DISCOVERY_FAILED') as ProviderModelSyncErrorCode }),
    };
  }

  function syncProvider(providerId: string, force: boolean): Promise<ProviderModelSyncResult> {
    syncScope();
    const existing = inFlight.get(providerId);
    if (existing) return existing;
    const now = deps.now();
    if (!force) {
      const remaining = autoCooldown(providerId, now);
      if (remaining !== undefined) {
        deps.log.debug('magpie model sync skipped by cooldown', { providerId, remainingMs: remaining });
        return Promise.resolve({
          ok: true,
          status: getStatus(providerId),
          added: 0,
        });
      }
    }
    const promise = performSync(providerId)
      .catch(() => {
        // Do not surface raw DB/safeStorage errors to the renderer; the
        // structured status still tells the user the sync did not complete.
        deps.log.warn('magpie model sync crashed', { providerId });
        return {
          ok: false,
          status: getStatus(providerId),
          added: 0,
          code: 'UNKNOWN' as const,
        };
      })
      .finally(() => {
        if (inFlight.get(providerId) === promise) inFlight.delete(providerId);
      });
    inFlight.set(providerId, promise);
    return promise;
  }

  return {
    async requestAutoRefresh(trigger): Promise<void> {
      syncScope();
      let configs: CustomProviderConfig[];
      try {
        configs = await deps.listConfigs();
      } catch {
        deps.log.warn('magpie model sync could not list providers', {
          trigger,
        });
        return;
      }
      const providers = configs.filter(isMagpieCustomProviderConfig);
      if (providers.length === 0) return;
      for (const config of providers) {
        const status = deps.statusStore.read(config.id);
        const startupRecent = trigger === 'startup'
          && status?.lastAttemptAt != null
          && deps.now() - status.lastAttemptAt < STARTUP_DEDUP_MS;
        // Startup may cross a long offline window; it is the one forced trigger.
        // Repeated startup calls within a minute still dedupe.
        const force = trigger === 'startup' && !startupRecent;
        await syncProvider(config.id, force);
      }
    },

    async syncNow(providerId, options): Promise<ProviderModelSyncResult> {
      syncScope();
      const scopeAtStart = deps.getScopeKey?.();
      const pending = options?.afterChange ? inFlight.get(providerId) : undefined;
      if (pending) {
        await pending;
        if (deps.getScopeKey?.() !== scopeAtStart) {
          return { ok: false, status: getStatus(providerId), added: 0, code: 'CONFIG_CHANGED' };
        }
      }
      return syncProvider(providerId, true);
    },

    getStatus,
  };
}

let configuredCoordinator: MagpieModelSyncCoordinator | null = null;
const silentLog: Pick<Logger, 'debug' | 'warn'> = {
  debug: () => undefined,
  warn: () => undefined,
};

export function configureMagpieModelSync(
  deps: Omit<MagpieModelSyncDeps, 'now' | 'log'> & Partial<Pick<MagpieModelSyncDeps, 'now' | 'log'>>,
): void {
  configuredCoordinator = createMagpieModelSyncCoordinator({
    ...deps,
    now: deps.now ?? Date.now,
    log: deps.log ?? silentLog,
  });
}

export async function requestMagpieModelAutoRefresh(
  trigger: ProviderModelAutoRefreshTrigger,
): Promise<void> {
  await configuredCoordinator?.requestAutoRefresh(trigger);
}

export async function syncMagpieProviderNow(
  providerId: string,
): Promise<ProviderModelSyncResult> {
  if (!configuredCoordinator) {
    return {
      ok: false,
      added: 0,
      code: 'NOT_CONFIGURED',
      status: {
        providerId,
        lastAttemptAt: null,
        lastSuccessAt: null,
        failure: null,
        stale: true,
      },
    };
  }
  return configuredCoordinator.syncNow(providerId);
}

export function getMagpieProviderSyncStatus(providerId: string): ProviderModelSyncStatus {
  return configuredCoordinator?.getStatus(providerId) ?? {
    providerId,
    lastAttemptAt: null,
    lastSuccessAt: null,
    failure: null,
    stale: true,
  };
}

/** Fire-and-forget refresh after a committed create/update. */
export async function requestMagpieModelSyncAfterChange(providerId: string): Promise<void> {
  if (!configuredCoordinator) return;
  await configuredCoordinator.syncNow(providerId, { afterChange: true }).catch(() => undefined);
}
