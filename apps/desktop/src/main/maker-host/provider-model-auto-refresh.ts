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
  isForcedProviderModelAutoRefreshTrigger,
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
  requestAutoRefresh(
    trigger: ProviderModelAutoRefreshTrigger,
    providerIds?: readonly BuiltinRefreshableProviderId[],
  ): Promise<void>;
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
    {
      promise: Promise<void>;
      scopeGeneration: number;
      providerGeneration: number;
      /** 这次在途请求是否无视冷却(见 refresh 里 forced-follow-up 分支的理由)。 */
      forced: boolean;
    }
  >();
  /** 排在非强制在途请求之后的强制补跑链(按 provider 去重,见 refresh)。 */
  const forcedFollowUp = new Map<BuiltinRefreshableProviderId, Promise<void>>();
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
    // 补跑链跟着在途请求一起作废:它排在**上一个 scope** 的那次请求之后,把新 scope 的
    // 强制请求 join 进去等于让它等一件与自己无关的事。
    forcedFollowUp.clear();
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
      forcedFollowUp.delete(providerId);
      return;
    }
    lastAttemptAt.clear();
    lastFailureAt.clear();
  }

  /**
   * @param bypassJoin 跳过「合并到在途请求」这一步,直接发起新的一次刷新。只由下方
   *   forced-follow-up 链内部使用(它已经等过那次在途请求),外部调用方一律不传 ——
   *   传了就会绕过 in-flight 合并、可能并发起两个 codex app-server。
   */
  function refresh(
    providerId: BuiltinRefreshableProviderId,
    force: boolean,
    bypassJoin = false,
  ): Promise<void> {
    syncScope();
    const providerGeneration = providerGenerations.get(providerId) ?? 0;
    const existing = inFlight.get(providerId);
    if (
      !bypassJoin &&
      existing?.scopeGeneration === scopeGeneration &&
      existing.providerGeneration === providerGeneration
    ) {
      // 同语义(都不强制,或在途那次本来就是强制的)→ 合并,这是 in-flight 去重的本意。
      if (!force || existing.forced) return existing.promise;
      // 强制请求撞上**非强制**在途:不能就这么合并。那次在途可能正是启动早期发起的
      // ——owner 绑定还没认领、网关凭证还没下发,它什么都发现不到 —— 合并进去等于这次
      // 强制刷新从未发生,首启清单不全的问题原样保留到下一个触发时机(PR #1076 review)。
      // 正确做法是排在它后面真跑一次:等它 settle(成败都算 settle),再发起新的一次。
      const pendingFollowUp = forcedFollowUp.get(providerId);
      if (pendingFollowUp) return pendingFollowUp;
      const followUp = existing.promise
        .catch(() => undefined)
        .then(() => refresh(providerId, true, true))
        .finally(() => {
          if (forcedFollowUp.get(providerId) === followUp) forcedFollowUp.delete(providerId);
        });
      forcedFollowUp.set(providerId, followUp);
      return followUp;
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
      forced: force,
    });
    return flight;
  }

  return {
    async requestAutoRefresh(trigger, providerIds): Promise<void> {
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

      const requestedIds = providerIds ?? BUILTIN_REFRESHABLE_PROVIDER_IDS;
      const ids = requestedIds.filter((id) => connectedIds.has(id));
      // 启动期无视冷却（见 `'startup'` trigger 注释）；in-flight 合并仍生效，所以并发的
      // 启动触发与手动刷新不会各起一次 codex app-server。
      const force = isForcedProviderModelAutoRefreshTrigger(trigger);
      const results = await Promise.allSettled(ids.map((id) => refresh(id, force)));
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
  providerIds?: readonly BuiltinRefreshableProviderId[],
): Promise<void> {
  await configuredCoordinator?.requestAutoRefresh(trigger, providerIds);
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
