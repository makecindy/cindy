import type { AgentKind } from '@cindy/model-providers';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { isUserProviderSession } from '../maker-host/provider-route.js';
import { getSessionFastMode } from '../maker-host/session-effort-store.js';
import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.desktop.js';
import type { UsageBillingSource } from '@cindy/maker-shared/usage-cost-details';
import { isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId } from '../maker-host/subscription-account-auth.js';
import { normalizeModelIdForPricing } from '../usage/turnCostCalculator.js';

/** Non-secret billing identity captured with the existing product-turn metadata.
 * Deleting or editing a connection must not reclassify requests already sent.
 */
export function captureTurnUsageContext(sessionId: string, selectedModel?: string) {
  const providerId = getSessionProvider(sessionId);
  const provider = providerId
    ? getActiveCatalog().providers.find(provider => provider.id === providerId)
    : undefined;
  const accessKind = provider?.access?.kind;
  const normalizedSelectedModel = selectedModel?.trim()
    ? normalizeModelIdForPricing(selectedModel)
    : undefined;
  const opaqueEntries: Array<[AgentKind, readonly string[]]> = [];
  for (const [agent, models] of Object.entries(provider?.models ?? {})) {
    if (!Array.isArray(models)) continue;
    const ids = [...new Set(
      models
        .filter(model => model.opaqueModelId === true || model.discoveredSource?.kind === 'magpie')
        .map(model => normalizeModelIdForPricing(model.id)),
    )];
    if (ids.length > 0) opaqueEntries.push([agent as AgentKind, ids]);
  }
  const opaqueModelIdsByAgent = opaqueEntries.length > 0
    ? Object.fromEntries(opaqueEntries) as Partial<Record<AgentKind, readonly string[]>>
    : undefined;
  return {
    providerId,
    providerName: provider?.name,
    accessKind,
    ...(normalizedSelectedModel && normalizedSelectedModel !== 'unknown'
      ? { selectedModel: normalizedSelectedModel }
      : {}),
    ...(opaqueModelIdsByAgent ? { opaqueModelIdsByAgent } : {}),
    isUserProviderRoute: isUserProviderSession(sessionId),
    subscriptionKind: isOpenAiSubscriptionProviderId(providerId) ? 'codex' as const
      : isClaudeSubscriptionProviderId(providerId) ? 'claude' as const
        : isXaiSubscriptionProviderId(providerId) ? 'xai' as const : null,
    piFastMode: getSessionFastMode(sessionId),
  };
}
export type TurnUsageContext = ReturnType<typeof captureTurnUsageContext>;

export function turnBillingSource(context: TurnUsageContext, route: string): UsageBillingSource {
  if (route === 'xd-gateway' && context.providerId !== 'xd') {
    return { providerId: 'xd', billingSource: 'cindy-ai' };
  }
  return {
    ...(context.providerId ? { providerId: context.providerId } : {}),
    ...(context.providerName ? { providerName: context.providerName } : {}),
    billingSource: route === 'subscription' ? 'subscription' : route === 'xd-gateway' ? 'cindy-ai'
      : route === 'provider-api' ? 'provider' : 'unknown',
  };
}
