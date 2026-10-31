/**
 * Process-wide built-in provider model refresh coordination.
 *
 * Automatic hints are intentionally cheap for callers: Main filters disconnected
 * providers, applies a per-provider cooldown, joins in-flight work, and swallows
 * source failures after logging. Manual refresh bypasses only the cooldown; it
 * still joins an existing request so two windows cannot refresh the same source
 * concurrently.
 *
 * Additional subscription accounts (user connections with a native Codex or xAI login)
 * follow the built-in family they belong to: whenever `openai` / `xai` is requested,
 * every connected account of that family is refreshed as its own cooldown key. Without
 * this, an added ChatGPT account only refreshed at login or on a manual Settings fetch,
 * so new models never appeared there while the default account already listed them.
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
import { refreshModelsWithCatalog } from './provider-model-refresh.js';

export const PROVIDER_MODEL_AUTO_REFRESH_COOLDOWN_MS = 30 * 60_000;
export const PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS = 5 * 60_000;
export const PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS = 15 * 60_000;

/** Built-in family whose automatic refresh also covers that family's added accounts. */
export type AccountRefreshFamily = Extract<BuiltinRefreshableProviderId, 'openai' | 'xai'>;

/** Added subscription account → family, or null when it has no automatic discovery. */
export function accountRefreshFamily(provider: ProviderView): AccountRefreshFamily | null {
  if (provider.source !== 'user') return null;
  switch (provider.auth?.native) {
    case 'codex':
      return 'openai';
    case 'xai':
      return 'xai';
    default:
      // Independent Claude accounts are retired and never refresh.
      return null;
  }
}

export interface ProviderModelAutoRefreshDeps {
  listProviders(options: { allowSideEffects: true }): Promise<ProviderView[]>;
  refreshProvider(providerId: BuiltinRefreshableProviderId): Promise<void>;
  /**
   * Refresh one connected additional subscription account. Optional so callers without
   * account support keep the built-in-only behavior.
   */
  refreshAccount?: (providerId: string, family: AccountRefreshFamily) => Promise<void>;
  /** Refresh the shared public Catalog independently of any provider connection state. */
  refreshCatalog?: () => Promise<void>;
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
  resetCooldowns(providerId?: string): void;
}

export function createProviderModelRefreshCoordinator(
  deps: ProviderModelAutoRefreshDeps,
  cooldownMs = PROVIDER_MODEL_AUTO_REFRESH_COOLDOWN_MS,
  failureCooldownMs = PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS,
): ProviderModelRefreshCoordinator {
  // Keys are built-in ids or additional account provider ids; each has its own cooldown.
  const inFlight = new Map<
    string,
    {
      promise: Promise<void>;
      scopeGeneration: number;
      providerGeneration: number;
      /** 这次在途请求是否无视冷却(见 refresh 里 forced-follow-up 分支的理由)。 */
      forced: boolean;
    }
  >();
  /** 排在非强制在途请求之后的强制补跑链(按 provider 去重,见 refresh)。 */
  const forcedFollowUp = new Map<string, Promise<void>>();
  const lastAttemptAt = new Map<string, number>();
  const lastFailureAt = new Map<string, number>();
  const providerGenerations = new Map<string, number>();
  /** Account id → family, captured from the latest provider listing. */
  const accountFamilies = new Map<string, AccountRefreshFamily>();
  let catalogInflight: { promise: Promise<void>; scopeGeneration: number } | null = null;
  let catalogLastAttemptAt: number | undefined;
  let catalogLastFailureAt: number | undefined;
  let catalogStartupGraceUntil: number | undefined;
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
    catalogInflight = null;
    catalogLastAttemptAt = undefined;
    catalogLastFailureAt = undefined;
    catalogStartupGraceUntil = undefined;
    deps.log.debug('provider model auto-refresh scope changed', { scopeGeneration });
  }

  function resetCooldowns(providerId?: string): void {
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
    catalogLastAttemptAt = undefined;
    catalogLastFailureAt = undefined;
    catalogStartupGraceUntil = undefined;
  }

  async function refreshCatalogAutomatically(
    trigger: ProviderModelAutoRefreshTrigger,
  ): Promise<void> {
    if (!deps.refreshCatalog) return;
    syncScope();
    // splash 已经 await ensureActiveCatalogLoaded；startup 不重复请求。加载器对 bundled
    // 兜底同样返回成功，故这里不能武断地压 30 分钟——只给 5 分钟启动宽限，服务器刚
    // 恢复时不必等半小时；首次后续成功再进入正常 30 分钟冷却。
    if (trigger === 'startup') {
      catalogStartupGraceUntil =
        deps.now() + PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS;
      return;
    }
    if (catalogInflight?.scopeGeneration === scopeGeneration) {
      return catalogInflight.promise;
    }
    const now = deps.now();
    if (catalogStartupGraceUntil !== undefined) {
      if (now < catalogStartupGraceUntil) {
        deps.log.debug('model catalog auto-refresh skipped by startup grace', {
          trigger,
          remainingMs: catalogStartupGraceUntil - now,
        });
        return;
      }
      catalogStartupGraceUntil = undefined;
    }
    const cooldownStartedAt = catalogLastFailureAt ?? catalogLastAttemptAt;
    const cooldownMs = catalogLastFailureAt === undefined
      ? PROVIDER_MODEL_AUTO_REFRESH_COOLDOWN_MS
      : PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS;
    if (cooldownStartedAt !== undefined && now - cooldownStartedAt < cooldownMs) {
      deps.log.debug('model catalog auto-refresh skipped by cooldown', {
        trigger,
        cooldown: catalogLastFailureAt === undefined ? 'normal' : 'failure-retry',
        remainingMs: cooldownMs - (now - cooldownStartedAt),
      });
      return;
    }

    const generation = scopeGeneration;
    catalogLastAttemptAt = now;
    const flight = Promise.resolve()
      .then(() => deps.refreshCatalog!())
      .then(
        () => {
          if (scopeGeneration === generation) catalogLastFailureAt = undefined;
        },
        (error: unknown) => {
          if (scopeGeneration === generation) catalogLastFailureAt = deps.now();
          deps.log.warn('model catalog auto-refresh failed', {
            trigger,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .finally(() => {
        if (catalogInflight?.promise === flight) catalogInflight = null;
      });
    catalogInflight = { promise: flight, scopeGeneration: generation };
    await flight;
  }

  /**
   * @param bypassJoin 跳过「合并到在途请求」这一步,直接发起新的一次刷新。只由下方
   *   forced-follow-up 链内部使用(它已经等过那次在途请求),外部调用方一律不传 ——
   *   传了就会绕过 in-flight 合并、可能并发起两个 codex app-server。
   */
  function runRefresh(providerId: string): Promise<void> {
    if (isBuiltinRefreshableProviderId(providerId)) return deps.refreshProvider(providerId);
    const family = accountFamilies.get(providerId);
    if (!family || !deps.refreshAccount) {
      return Promise.reject(new Error(`provider '${providerId}' has no automatic model refresh`));
    }
    return deps.refreshAccount(providerId, family);
  }

  function refresh(
    providerId: string,
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
      .then(() => runRefresh(providerId))
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
      const catalogRefresh = refreshCatalogAutomatically(trigger);
      let providers: ProviderView[];
      try {
        providers = await deps.listProviders({ allowSideEffects: true });
      } catch (err) {
        deps.log.warn('provider model auto-refresh could not list providers', {
          trigger,
          error: err instanceof Error ? err.message : String(err),
        });
        await catalogRefresh;
        return;
      }

      // Provider discovery may use the public registry to fill context windows and effort
      // defaults omitted by the provider response. Apply the catalog snapshot first so a
      // concurrent discovery cannot permanently derive capabilities from the previous one.
      await catalogRefresh;
      syncScope();
      const connectedIds = new Set<BuiltinRefreshableProviderId>();
      const connectedAccounts: { id: string; family: AccountRefreshFamily }[] = [];
      for (const provider of providers) {
        if (
          provider.source === 'builtin' &&
          provider.connected &&
          isBuiltinRefreshableProviderId(provider.id)
        ) {
          connectedIds.add(provider.id);
          continue;
        }
        const family = deps.refreshAccount ? accountRefreshFamily(provider) : null;
        if (family && provider.connected) connectedAccounts.push({ id: provider.id, family });
      }

      const requestedIds = providerIds ?? BUILTIN_REFRESHABLE_PROVIDER_IDS;
      // Public Catalog refreshes metadata; each connected account still refreshes its own
      // authoritative membership independently, including xAI `/user` → `/models`.
      // Added accounts ride on their family's request even when the default account itself
      // is disconnected: the family id names the source, not the default connection.
      const accountIds: string[] = [];
      for (const account of connectedAccounts) {
        if (!requestedIds.includes(account.family)) continue;
        accountFamilies.set(account.id, account.family);
        accountIds.push(account.id);
      }
      const ids = requestedIds.filter((id) => connectedIds.has(id));
      // 启动期无视冷却（见 `'startup'` trigger 注释）；in-flight 合并仍生效，所以并发的
      // 启动触发与手动刷新不会各起一次 codex app-server。
      const force = isForcedProviderModelAutoRefreshTrigger(trigger);
      const logFailures = (
        refreshedIds: readonly string[],
        results: PromiseSettledResult<void>[],
      ): void => {
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') return;
          deps.log.warn('provider model auto-refresh failed', {
            trigger,
            providerId: refreshedIds[index],
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          });
        });
      };
      // Added accounts refresh in the background: startup readiness and UI hints await this
      // call, and one stuck account must not delay the first task. Catalog changes are
      // broadcast when the account snapshot applies.
      if (accountIds.length > 0) {
        void Promise.allSettled(accountIds.map((id) => refresh(id, force))).then((results) =>
          logFailures(accountIds, results),
        );
      }
      logFailures(ids, await Promise.allSettled(ids.map((id) => refresh(id, force))));
    },

    async refreshManually(providerId): Promise<void> {
      // Subscription media declarations can change independently of chat discovery.
      // Automatic refresh already loads the shared catalog before calling the provider hook.
      if ((providerId === 'xai' || providerId === 'openai') && deps.refreshCatalog) {
        return refreshModelsWithCatalog({
          refreshCatalog: deps.refreshCatalog,
          refreshModels: () => refresh(providerId, true),
          getScopeKey: () => deps.getScopeKey?.(),
        });
      }
      await refresh(providerId, true);
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

export function resetProviderModelAutoRefreshCooldowns(providerId?: string): void {
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
