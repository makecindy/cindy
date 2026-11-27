import type { AgentKind } from '@cindy/model-providers';
import {
  isOfficialAnthropicProviderConnection,
  normalizeModelIdForPricing,
  resolveOfficialAnthropicModelsForAgent,
  type BillingRoute,
} from '../usage/turnCostCalculator.js';
import { isSubscriptionDirectRoute, isExclusiveXaiModelId, XAI_MODEL_PREFIX } from '../../shared/subscriptionModels.js';
import { isUserProviderSession } from '../maker-host/provider-route.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { getSessionFastMode } from '../maker-host/session-effort-store.js';
import { isOpenAiSubscriptionProviderId } from './turnUsagePorts.js';
import type { UsageBillingSource } from '@cindy/maker-shared/usage-cost-details';
import { isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId } from '../maker-host/subscription-account-kind.js';

/** Non-secret billing identity captured with the existing product-turn metadata.
 * Deleting or editing a connection must not reclassify requests already sent.
 */
export function captureTurnUsageContext(
  sessionId: string,
  providerId = getSessionProvider(sessionId),
  agent?: 'codex' | 'claude-code' | 'pi',
  selectedModel?: string,
) {
  const provider = providerId ? getActiveCatalog().providers.find(item => item.id === providerId) : undefined;
  const normalizedSelectedModel = selectedModel?.trim()
    ? normalizeModelIdForPricing(selectedModel)
    : undefined;
  const opaqueEntries: Array<[AgentKind, readonly string[]]> = [];
  for (const [entryAgent, models] of Object.entries(provider?.models ?? {})) {
    if (!Array.isArray(models)) continue;
    const ids = [...new Set(
      models
        .filter(model => model.opaqueModelId === true || model.discoveredSource?.kind === 'magpie')
        .map(model => normalizeModelIdForPricing(model.id)),
    )];
    if (ids.length > 0) opaqueEntries.push([entryAgent as AgentKind, ids]);
  }
  const opaqueModelIdsByAgent = opaqueEntries.length > 0
    ? Object.fromEntries(opaqueEntries) as Partial<Record<AgentKind, readonly string[]>>
    : undefined;
  const officialAnthropic = agent
    ? resolveOfficialAnthropicModelsForAgent(provider, providerId, agent)
    : {
        officialAnthropicApi: isOfficialAnthropicProviderConnection(providerId, provider),
      };
  return {
    providerId,
    ...(agent && provider?.routing?.[agent]?.usagePresetId ? { usagePresetId: provider.routing[agent]!.usagePresetId } : {}),
    providerName: provider?.name,
    accessKind: provider?.access?.kind,
    ...(normalizedSelectedModel && normalizedSelectedModel !== 'unknown'
      ? { selectedModel: normalizedSelectedModel }
      : {}),
    ...(opaqueModelIdsByAgent ? { opaqueModelIdsByAgent } : {}),
    ...(officialAnthropic.officialAnthropicApi || (provider && providerId !== 'anthropic')
      ? { officialAnthropicApi: officialAnthropic.officialAnthropicApi }
      : {}),
    ...(officialAnthropic.officialAnthropicModels
      ? { officialAnthropicModels: officialAnthropic.officialAnthropicModels }
      : {}),
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
