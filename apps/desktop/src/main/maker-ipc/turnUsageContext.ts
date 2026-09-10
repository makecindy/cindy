import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { isUserProviderSession } from '../maker-host/provider-route.js';
import { getSessionFastMode } from '../maker-host/session-effort-store.js';
import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.js';
import { isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId } from '../maker-host/subscription-account-auth.js';

/** Non-secret billing identity captured with the existing product-turn metadata.
 * Deleting or editing a connection must not reclassify requests already sent.
 */
export function captureTurnUsageContext(sessionId: string) {
  const providerId = getSessionProvider(sessionId);
  const accessKind = providerId
    ? getActiveCatalog().providers.find(provider => provider.id === providerId)?.access?.kind
    : undefined;
  return {
    providerId,
    accessKind,
    isUserProviderRoute: isUserProviderSession(sessionId),
    subscriptionKind: isOpenAiSubscriptionProviderId(providerId) ? 'codex' as const
      : isClaudeSubscriptionProviderId(providerId) ? 'claude' as const
        : isXaiSubscriptionProviderId(providerId) ? 'xai' as const : null,
    piFastMode: getSessionFastMode(sessionId),
  };
}
export type TurnUsageContext = ReturnType<typeof captureTurnUsageContext>;
