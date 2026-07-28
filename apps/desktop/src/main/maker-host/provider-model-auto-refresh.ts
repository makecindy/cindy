/**
 * Process-wide built-in provider model refresh coordination.
 *
 * Automatic hints are intentionally cheap for callers: Main filters disconnected
 * providers, applies a per-provider cooldown, joins in-flight work, and swallows
 * source failures after logging. Manual refresh bypasses only the cooldown; it
 * still joins an existing request so two windows cannot refresh the same source
 * concurrently.
 */

import type { ProviderView } from '@cindy/model-providers';

import {
  BUILTIN_REFRESHABLE_PROVIDER_IDS,
  isBuiltinRefreshableProviderId,
  type BuiltinRefreshableProviderId,
  type ProviderModelAutoRefreshTrigger,
} from '../../shared/providerModelRefresh.js';
import { createLogger, type Logger } from '../logger.js';

export const PROVIDER_MODEL_AUTO_REFRESH_COOLDOWN_MS = 30 * 60_000;
export const PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS = 5 * 60_000;
export const PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS = 15 * 60_000;

export interface ProviderModelAutoRefreshDeps {
  listProviders(options: { allowSideEffects: true }): Promise<ProviderView[]>;
  refreshProvider(providerId: BuiltinRefreshableProviderId): Promise<void>;
  getScopeKey?: () => string | number;
  now(): number;
  log: Pick<Logger, 'debug' | 'warn'>;
}

export interface ProviderModelRefreshCoordinator {
  requestAutoRefresh(trigger: ProviderModelAutoRefreshTrigger): Promise<void>;
  refreshManually(providerId: BuiltinRefreshableProviderId): Promise<void>;
  resetCooldowns(providerId?: BuiltinRefreshableProviderId): void;
}

export function createProviderModelRefreshCoordinator(
  deps: ProviderModelAutoRefreshDeps,
  cooldownMs = PROVIDER_MODEL_AUTO_REFRESH_COOLDOWN_MS,
  failureCooldownMs = PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS,
): ProviderModelRefreshCoordinator {
  const inFlight = new Map<
    BuiltinRefreshableProviderId,
    { promise: Promise<void>; scopeGeneration: number; providerGeneration: number }
  >();
  const lastAttemptAt = new Map<BuiltinRefreshableProviderId, number>();
  const lastFailureAt = new Map<BuiltinRefreshableProviderId, number>();
  const providerGenerations = new Map<BuiltinRefreshableProviderId, number>();
  let scopeKey = deps.getScopeKey?.();
  let scopeGeneration = 0;

  function syncScope(): void {
    const nextScopeKey = deps.getScopeKey?.();
    if (nextScopeKey === scopeKey) return;
    scopeKey = nextScopeKey;
    scopeGeneration += 1;
    lastAttemptAt.clear();
    lastFailureAt.clear();
    inFlight.clear();
    providerGenerations.clear();
    deps.log.debug('provider model auto-refresh scope changed', { scopeGeneration });
  }

  function resetCooldowns(providerId?: BuiltinRefreshableProviderId): void {
    if (providerId) {
      lastAttemptAt.delete(providerId);
      lastFailureAt.delete(providerId);
      providerGenerations.set(
        providerId,
        (providerGenerations.get(providerId) ?? 0) + 1,
      );
      inFlight.delete(providerId);
      return;
    }
    lastAttemptAt.clear();
    lastFailureAt.clear();
  }

  function refresh(
    providerId: BuiltinRefreshableProviderId,
    force: boolean,
  ): Promise<void> {
    syncScope();
    const providerGeneration = providerGenerations.get(providerId) ?? 0;
    const existing = inFlight.get(providerId);
    if (
      existing?.scopeGeneration === scopeGeneration &&
      existing.providerGeneration === providerGeneration
    ) {
      return existing.promise;
    }
    const generation = scopeGeneration;

    const now = deps.now();
    const previousAttempt = lastAttemptAt.get(providerId);
    const previousFailure = lastFailureAt.get(providerId);
    const activeCooldown = previousFailure === undefined ? cooldownMs : failureCooldownMs;
    const cooldownStartedAt = previousFailure ?? previousAttempt;
    if (
      !force &&
      cooldownStartedAt !== undefined &&
      now - cooldownStartedAt < activeCooldown
    ) {
      deps.log.debug('provider model auto-refresh skipped by cooldown', {
        providerId,
        cooldown: previousFailure === undefined ? 'normal' : 'failure-retry',
        remainingMs: activeCooldown - (now - cooldownStartedAt),
      });
      return Promise.resolve();
    }

    lastAttemptAt.set(providerId, now);
    const flight = Promise.resolve()
      .then(() => deps.refreshProvider(providerId))
      .then(
        () => {
          if (
            scopeGeneration === generation &&
            (providerGenerations.get(providerId) ?? 0) === providerGeneration
          ) {
            lastFailureAt.delete(providerId);
          }
        },
        (error: unknown) => {
          if (
            scopeGeneration === generation &&
            (providerGenerations.get(providerId) ?? 0) === providerGeneration
          ) {
            lastFailureAt.set(providerId, deps.now());
          }
          throw error;
        },
      )
      .finally(() => {
        if (inFlight.get(providerId)?.promise === flight) inFlight.delete(providerId);
      });
    inFlight.set(providerId, {
      promise: flight,
      scopeGeneration: generation,
      providerGeneration,
    });
    return flight;
  }

  return {
    async requestAutoRefresh(trigger): Promise<void> {
      syncScope();
      let providers: ProviderView[];
      try {
        providers = await deps.listProviders({ allowSideEffects: true });
      } catch (err) {
        deps.log.warn('provider model auto-refresh could not list providers', {
          trigger,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      syncScope();
      const connectedIds = new Set<BuiltinRefreshableProviderId>();
      for (const provider of providers) {
        if (
          provider.source === 'builtin' &&
          provider.connected &&
          isBuiltinRefreshableProviderId(provider.id)
        ) {
          connectedIds.add(provider.id);
        }
      }

      const ids = BUILTIN_REFRESHABLE_PROVIDER_IDS.filter((id) => connectedIds.has(id));
      const results = await Promise.allSettled(ids.map((id) => refresh(id, false)));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') return;
        deps.log.warn('provider model auto-refresh failed', {
          trigger,
          providerId: ids[index],
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      });
    },

    refreshManually(providerId): Promise<void> {
      return refresh(providerId, true);
    },
    resetCooldowns,
  };
}

let configuredCoordinator: ProviderModelRefreshCoordinator | null = null;
const log = createLogger('provider-model-auto-refresh');

export function configureProviderModelAutoRefresh(
  deps: Omit<ProviderModelAutoRefreshDeps, 'now' | 'log'> &
    Partial<Pick<ProviderModelAutoRefreshDeps, 'now' | 'log'>>,
): void {
  configuredCoordinator = createProviderModelRefreshCoordinator({
    ...deps,
    now: deps.now ?? Date.now,
    log: deps.log ?? log,
  });
}

export function resetProviderModelAutoRefreshCooldowns(
  providerId?: BuiltinRefreshableProviderId,
): void {
  configuredCoordinator?.resetCooldowns(providerId);
}

/**
 * Safe during early bootstrap: focus events can arrive before Maker IPC has
 * configured provider services, in which case the hint is simply ignored.
 */
export async function requestProviderModelAutoRefresh(
  trigger: ProviderModelAutoRefreshTrigger,
): Promise<void> {
  await configuredCoordinator?.requestAutoRefresh(trigger);
}

export async function refreshProviderModelsManually(
  providerId: BuiltinRefreshableProviderId,
): Promise<void> {
  if (!configuredCoordinator) {
    throw new Error('provider model refresh coordinator is not configured');
  }
  await configuredCoordinator.refreshManually(providerId);
}

export interface AppFocusAutoRefreshTracker {
  sync(appFocused: boolean): void;
}

/**
 * Converts global app-focus transitions into a single foreground refresh hint.
 * The first observation establishes state and never refreshes.
 */
export function createAppFocusAutoRefreshTracker(deps: {
  now(): number;
  onMeaningfulForeground(): void;
  backgroundThresholdMs?: number;
}): AppFocusAutoRefreshTracker {
  const threshold =
    deps.backgroundThresholdMs ?? PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS;
  let lastFocused: boolean | null = null;
  let backgroundedAt: number | null = null;

  return {
    sync(appFocused): void {
      if (lastFocused === appFocused) return;
      const now = deps.now();
      const previous = lastFocused;
      lastFocused = appFocused;

      if (!appFocused) {
        backgroundedAt = now;
        return;
      }

      const startedAt = backgroundedAt;
      backgroundedAt = null;
      if (
        previous === false &&
        startedAt !== null &&
        now - startedAt >= threshold
      ) {
        deps.onMeaningfulForeground();
      }
    },
  };
}
