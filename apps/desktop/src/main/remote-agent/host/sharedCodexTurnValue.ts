import type { AgentEvent } from '@cindy/maker-core';
import { isCodexGatewayWireModel } from '@cindy/model-providers';
import { getCodexProviderSubscriptionValuePrice, getReferenceModelPricing, readModelPriceOverridesSnapshot } from '../../usage/referenceModelPricingCore.js';
import { computePriceQuoteTurnMoney, normalizeModelIdForPricing, normalizeTurnUsageSegments, sumTurnUsageSegments } from '../../usage/turnCostCalculator.js';
import type { SharedTurnValue } from '../sharedTurnValue.js';

/** Runs only on a bound OpenAI subscription. Price each native request once, including cache and tier. */
export function sharedCodexTurnValue(providerId: string, engineProviderId: string, event: AgentEvent): SharedTurnValue | undefined {
  const usage = (event.data as { usage?: {
    execution?: { providerId?: string; credentialMode?: string; model?: string };
    promptTokens?: number; completionTokens?: number; cachedTokens?: number; cacheCreationTokens?: number; segments?: unknown;
  } } | null)?.usage;
  if (event.source !== 'codex' || event.type !== 'done' || !usage || usage.execution?.providerId !== engineProviderId ||
      usage.execution.credentialMode !== 'oauth-bearer' || !usage.execution.model || isCodexGatewayWireModel(usage.execution.model)) return;
  const segments = normalizeTurnUsageSegments(usage.segments);
  const totals = sumTurnUsageSegments(segments);
  if (!segments.length || totals.inputTokens !== usage.promptTokens || totals.outputTokens !== usage.completionTokens ||
      totals.cacheReadTokens !== usage.cachedTokens || totals.cacheCreateTokens !== usage.cacheCreationTokens) return;
  const overrides = readModelPriceOverridesSnapshot();
  const pricing = getReferenceModelPricing({ overrides });
  const quotes = new Map<string, NonNullable<ReturnType<typeof getCodexProviderSubscriptionValuePrice>>>();
  let total: SharedTurnValue | undefined;
  for (const segment of segments) {
    if (!segment.model || isCodexGatewayWireModel(segment.model) ||
        (!segment.modelConfirmed && segment.model !== usage.execution.model)) return;
    const model = normalizeModelIdForPricing(segment.model);
    let price = quotes.get(model);
    if (!price) {
      price = getCodexProviderSubscriptionValuePrice(providerId, model, pricing, undefined, overrides);
      if (!price) return;
      quotes.set(model, price);
    }
    const money = computePriceQuoteTurnMoney(segment, price, [segment]);
    if (money?.kind !== 'value-estimate' || (total && total.currency !== money.currency)) return;
    total = { amount: (total?.amount ?? 0) + money.amount, currency: money.currency };
  }
  return total && Number.isFinite(total.amount) && total.amount > 0 ? total : undefined;
}
