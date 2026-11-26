import type { AgentKind, NativeSubscriptionAuth, ProviderView } from '@cindy/model-providers';
import { effectiveSourceIdForModel, NATIVE_SUBSCRIPTION_DEFAULT_PROVIDER_IDS } from '@cindy/model-providers';
import type { AccountUsageLimit } from '../../shared/accountUsageLimit.js';
import { readTurnUsageResetAt } from '../goal-host/usageLimit.js';
import type { InterruptedTurnErrorSignals } from './interruptedTurnAutoResume.js';

export interface SessionUsageRoute {
  agentKind: AgentKind;
  providerId: string | null;
  modelId: string | null;
  agentDeviceId: string | null;
  remoteHostId: string | null;
  sdkSessionId: string | null;
}

export interface SessionUsageResetDeps {
  now(): number;
  scopeKey(): string;
  localFamilyOf(agent: AgentKind, providerId: string | null): NativeSubscriptionAuth | null;
  readRemoteProviders(deviceId: string): Promise<ProviderView[]>;
  readLocalLimit(route: SessionUsageRoute, family: NativeSubscriptionAuth): Promise<AccountUsageLimit | null | undefined>;
  readRemoteLimit(route: SessionUsageRoute & { providerId: string; agentDeviceId: string }, family: NativeSubscriptionAuth): Promise<AccountUsageLimit | null>;
  unavailable(error: unknown): void;
}

function defaultSubscriptionFamily(providerId: string | null): NativeSubscriptionAuth | null {
  return (Object.entries(NATIVE_SUBSCRIPTION_DEFAULT_PROVIDER_IDS)
    .find(([, id]) => id === providerId)?.[0] as NativeSubscriptionAuth | undefined) ?? null;
}

/** Structured reset → the actual account's dated windows → trustworthy error text. */
export async function resolveSessionUsageReset(
  route: SessionUsageRoute,
  signals: InterruptedTurnErrorSignals,
  deps: SessionUsageResetDeps,
): Promise<number | null> {
  if (signals.providerGroupUsageLimit) return signals.providerGroupUsageLimit.resetAtMs;
  const scope = deps.scopeKey();
  let { providerId } = route;
  let family: NativeSubscriptionAuth | null;
  if (route.agentDeviceId && !route.remoteHostId) {
    // Explicit built-in IDs retain their offline error hints. Other identities,
    // especially null defaults, belong to the target catalog, never this computer.
    family = defaultSubscriptionFamily(providerId);
    if (!family) {
      try {
        const views = await deps.readRemoteProviders(route.agentDeviceId);
        if (scope !== deps.scopeKey()) return null;
        providerId ??= route.modelId
          ? effectiveSourceIdForModel(views, null, route.modelId, route.agentKind) : null;
        const provider = views.find(view => view.id === providerId);
        // Native family also appears on API-key routes; only subscription auth
        // may turn a rate-limit hint into an automatic continuation.
        const subscription = provider?.auth.method === 'oauth'
          && (!provider.access || provider.access.kind === 'subscription');
        family = subscription ? provider.auth.native ?? defaultSubscriptionFamily(provider.id) : null;
      } catch (error) {
        deps.unavailable(error);
        return null;
      }
    }
  } else {
    family = deps.localFamilyOf(route.agentKind, providerId);
  }
  if (!family || scope !== deps.scopeKey()) return null;
  const fromError = readTurnUsageResetAt(signals, deps.now(), {
    localTimeZoneTrusted: !route.remoteHostId && !route.agentDeviceId,
  });
  if (fromError !== null && signals.usageResetAt !== undefined) return fromError;
  try {
    const limit = route.remoteHostId ? null : route.agentDeviceId
      ? providerId ? await deps.readRemoteLimit({ ...route, providerId, agentDeviceId: route.agentDeviceId }, family) : null
      : await deps.readLocalLimit({ ...route, providerId }, family);
    if (scope !== deps.scopeKey()) return null;
    if (limit?.limited && limit.resetAtMs !== null) return limit.resetAtMs;
  } catch (error) {
    deps.unavailable(error);
  }
  return scope === deps.scopeKey() ? fromError : null;
}
