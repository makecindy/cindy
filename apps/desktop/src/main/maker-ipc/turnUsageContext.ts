import type { BillingRoute } from '../usage/turnCostCalculator.js';
import { isSubscriptionDirectRoute, isExclusiveXaiModelId, XAI_MODEL_PREFIX } from '../../shared/subscriptionModels.js';
import { isUserProviderSession } from '../maker-host/provider-route.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { getSessionFastMode } from '../maker-host/session-effort-store.js';
import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.desktop.js';
import type { UsageBillingSource } from '@cindy/maker-shared/usage-cost-details';
import { isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId } from '../maker-host/subscription-account-auth.js';

/** Non-secret billing identity captured with the existing product-turn metadata.
 * Deleting or editing a connection must not reclassify requests already sent.
 */
export function captureTurnUsageContext(sessionId: string, providerId = getSessionProvider(sessionId), agent?: 'codex' | 'claude-code' | 'pi') {
  const provider = providerId ? getActiveCatalog().providers.find(item => item.id === providerId) : undefined;
  return {
    providerId,
    ...(agent && provider?.routing?.[agent]?.usagePresetId ? { usagePresetId: provider.routing[agent]!.usagePresetId } : {}),
    providerName: provider?.name,
    accessKind: provider?.access?.kind,
    isUserProviderRoute: isUserProviderSession(sessionId, providerId),
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

/** Keep native subscription account aliases in local configuration. The ledger
 * needs the provider family and the billing method, never the account name. */
export function tokenAttribution(billing: UsageBillingSource, context: TurnUsageContext) {
  const family = context.subscriptionKind === 'claude' ? 'anthropic'
    : context.subscriptionKind === 'codex' ? 'openai' : context.subscriptionKind;
  const provider = billing.billingSource === 'subscription' && family && billing.providerId === context.providerId
    ? family : billing.billingSource === 'provider' && billing.providerId === context.providerId && context.usagePresetId
      ? `preset:${context.usagePresetId}` : billing.providerId;
  return { provider: provider ?? '', billingSource: billing.billingSource ?? 'unknown' };
}

export function piModelBilling(context: TurnUsageContext, model: string) {
  const direct = !context.isUserProviderRoute && isSubscriptionDirectRoute(model);
  const subscription = direct || context.subscriptionKind !== null || context.accessKind === 'subscription';
  const route: BillingRoute = subscription ? 'subscription' : context.isUserProviderRoute ? 'provider-api' : 'xd-gateway';
  const billing = turnBillingSource(context, route);
  if (direct && (!context.providerId || context.providerId === 'xd')) {
    return { route, billing: { billingSource: 'subscription' as const, providerId: model.startsWith(XAI_MODEL_PREFIX) || isExclusiveXaiModelId(model) ? 'xai' : 'openai' } };
  }
  return { route, billing };
}
