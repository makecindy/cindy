import { supportsSubscriptionFastPolicy, type ProviderView } from '@cindy/model-providers';
import type { StartSessionOptions } from '@cindy/maker-core';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { readProviderGroupBinding } from '../provider-group/bindings.js';
import { readProviderGroup } from '../provider-group/store.js';
import { groupFastPolicyStore } from '../provider-group/fastPolicyStore.js';
import { getActiveCatalog } from './active-catalog.js';
import { providerFastPolicy } from './provider-fast-policy-store.js';
import { setSessionFastMode } from './session-effort-store.js';

type Policy = NonNullable<StartSessionOptions['fastModePolicy']>;
const listeners = new Set<() => Promise<void>>();
let timer: ReturnType<typeof setInterval> | undefined;
let suppressedOwner: string | undefined;
const suppressedBySession = new Map<string, Set<string>>();

function ownerSuppression(owner: string): Map<string, Set<string>> | undefined {
  if (activeOwnerScopeKey() !== owner) return undefined;
  if (suppressedOwner !== owner) {
    suppressedOwner = owner;
    suppressedBySession.clear();
  }
  return suppressedBySession;
}

/** Also catches edits from another instance without starting a timer for each task. */
export async function notifySubscriptionFastPolicyChanged(): Promise<void> {
  const results = await Promise.allSettled([...listeners].map((listener) => listener()));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export function createSubscriptionFastPolicy(
  sessionId: string,
  providerId: () => string | null | undefined,
): Policy {
  const owner = activeOwnerScopeKey();
  const isAllowed = () => {
    if (activeOwnerScopeKey() !== owner) return false;
    const id = providerId();
    const provider = getActiveCatalog().providers.find((p) => p.id === id);
    if (!supportsSubscriptionFastPolicy(provider)) return true;
    const binding = readProviderGroupBinding(sessionId);
    const groupAllows =
      !binding ||
      !!binding.groupDeviceId ||
      readProviderGroup(binding.providerId)?.allowFast !== false;
    return providerFastPolicy.allows(id!) && groupAllows && groupFastPolicyStore.allows(sessionId);
  };
  return {
    isAllowed,
    isRequestAllowed() {
      const id = providerId();
      const provider = getActiveCatalog().providers.find((p) => p.id === id);
      return (
        isAllowed() &&
        (!supportsSubscriptionFastPolicy(provider) ||
          !ownerSuppression(owner)
            ?.get(sessionId)
            ?.has(id ?? ''))
      );
    },
    onFastModeChanged(enabled) {
      const id = providerId();
      const provider = getActiveCatalog().providers.find((p) => p.id === id);
      const suppressed = ownerSuppression(owner);
      if (!suppressed || !id || !supportsSubscriptionFastPolicy(provider)) return;
      if (enabled) {
        const ids = suppressed.get(sessionId);
        ids?.delete(id);
        if (!ids?.size) suppressed.delete(sessionId);
      } else {
        const ids = suppressed.get(sessionId) ?? new Set<string>();
        ids.add(id);
        suppressed.set(sessionId, ids);
      }
      setSessionFastMode(sessionId, enabled);
    },
    subscribe(listener) {
      let previous = isAllowed();
      const check = async () => {
        const allowed = isAllowed();
        if (allowed === previous) return;
        await listener();
        previous = allowed;
      };
      listeners.add(check);
      timer ??= setInterval(() => {
        void notifySubscriptionFastPolicyChanged().catch(() => undefined);
      }, 1_000);
      timer.unref?.();
      return () => {
        listeners.delete(check);
        if (!listeners.size) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
  };
}

/** Effective presentation only: raw catalog capabilities and user model patches stay intact. */
export function projectSubscriptionFastPolicy(provider: ProviderView): ProviderView {
  if (!supportsSubscriptionFastPolicy(provider)) return provider;
  const allowFast = providerFastPolicy.allows(provider.id);
  const groupAllowsFast = readProviderGroup(provider.id)?.allowFast !== false;
  const view = { ...provider, subscriptionFastPolicy: { allowFast, groupAllowsFast } };
  if (allowFast && groupAllowsFast) return view;
  return {
    ...view,
    models: Object.fromEntries(
      Object.entries(provider.models).map(([agent, models]) => [
        agent,
        models?.map((model) => ({
          ...model,
          supportsFastMode: false,
          supportsUltrafastMode: false,
        })),
      ]),
    ),
  } as ProviderView;
}
