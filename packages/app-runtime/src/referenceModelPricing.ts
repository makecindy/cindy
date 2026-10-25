
import type { AgentKind } from '@cindy/model-providers';

import {
  getModelPriceQuote,
  modelPricingKey,
  registryPricingCatalog,
  subscriptionDirectPriceQuote,
} from '@cindy/model-providers/modelPriceQuote';
import type { ModelPriceQuote, ModelPricingCatalog } from '@cindy/maker-shared/regional-money';

export type { ModelPriceOverridesSnapshot } from './modelPriceOverrideStore.js';

import type {Catalog} from '@cindy/model-providers';import type {ModelPriceOverridesSnapshot,createModelPriceOverrideStore} from './modelPriceOverrideStore.js';import type {createAccountReferencePrice} from './accountReferencePrice.js';
export interface createReferenceModelPricingHost extends Pick<ReturnType<typeof createModelPriceOverrideStore>,'applyModelPriceOverrides'|'mergeStoredModelPriceOverride'> {getActiveCatalog():Catalog;getByokPricing():ModelPricingCatalog;providerReferencePriceQuote:ReturnType<typeof createAccountReferencePrice>['accountReferencePriceQuote'];broadcast(channel:string,payload:unknown):void;}

export function createReferenceModelPricing(host: createReferenceModelPricingHost) {
const {getActiveCatalog,getByokPricing,providerReferencePriceQuote,applyModelPriceOverrides,mergeStoredModelPriceOverride}=host;


const REFERENCE_MODEL_PRICING_CHANGED_CHANNEL = 'usage:reference-model-pricing-changed';

/** Catalog 刷新只重建非 XD 参考价；registryPricingCatalog 本身也会过滤 XD route。 */
function getReferenceModelPricing(): ModelPricingCatalog {
  const catalog = getActiveCatalog();
  const registry = catalog.modelRegistry;
  const pricing = registryPricingCatalog(registry);
  for (const provider of catalog.providers) {
    // Connection-local prices belong to this account and engine, including OAuth
    // discovery quotes. Publishing only Registry routes dropped them all.
    if (provider.source === 'user' && provider.id !== 'xd') {
      for (const [agent, models] of Object.entries(provider.models)) {
        for (const model of models ?? []) {
          const cost = model.cost;
          if (cost?.input === undefined || cost.output === undefined) continue;
          if (![cost.input, cost.output].every(value => Number.isFinite(value) && value >= 0)) continue;
          (pricing[provider.id] ??= {})[modelPricingKey(model.id, agent as AgentKind)] = {
            providerId: provider.id, modelId: model.id, currency: 'USD',
            source: 'provider-reference', approximate: true,
            inputPerMtok: cost.input, outputPerMtok: cost.output,
            ...(cost.cacheRead !== undefined ? { cacheReadPerMtok: cost.cacheRead } : {}),
            ...(cost.cacheWrite !== undefined ? { cacheCreatePerMtok: cost.cacheWrite } : {}),
          };
        }
      }
    }
    if (provider.auth?.method !== 'oauth' || !provider.auth.native) continue;
    for (const [agent, models] of Object.entries(provider.models)) {
      for (const model of models ?? []) {
        const quote = providerReferencePriceQuote(provider.id, model.id, registry, { agent: agent as AgentKind, officialOnly: true });
        if (quote) (pricing[provider.id] ??= {})[modelPricingKey(model.id, agent as AgentKind)] = quote;
      }
    }
  }
  return { ...applyModelPriceOverrides(pricing, registry), ...getByokPricing() };
}

function broadcastReferenceModelPricing(): void {
  const pricing = getReferenceModelPricing();
  host.broadcast(REFERENCE_MODEL_PRICING_CHANGED_CHANNEL,pricing);
}

/** 按显式来源估算 Codex 订阅轮价值，不读取 XD Gateway 报价。 */
function getCodexProviderSubscriptionValuePrice(
  providerId: string,
  modelId: string,
  pricing: ModelPricingCatalog | null | undefined,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
  agent: AgentKind = 'codex',
): ModelPriceQuote | undefined {
  if (providerId === 'xd') return undefined;
  const effective = getModelPriceQuote(pricing, providerId, modelId, agent);
  if (effective?.source === 'user-override') {
    return (
      mergeStoredModelPriceOverride(
        { providerId, agent, modelId: effective.modelId },
        providerReferencePriceQuote(
          providerId,
          effective.modelId,
          getActiveCatalog().modelRegistry,
          { agent, at, officialOnly: true },
        ),
        overrides,
      ) ?? effective
    );
  }
  const reference = providerReferencePriceQuote(
    providerId,
    modelId,
    getActiveCatalog().modelRegistry,
    { agent, at, officialOnly: true },
  );
  return reference ?? ((getActiveCatalog().modelRegistry?.schemaVersion ?? 0) < 5 && at === undefined ? effective : undefined);
}

function getCodexSubscriptionValuePrice(
  modelId: string,
  pricing: ModelPricingCatalog | null | undefined,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  return getCodexProviderSubscriptionValuePrice('openai', modelId, pricing, at, overrides);
}

function getClaudeSubscriptionValuePrice(
  modelId: string,
  pricing: ModelPricingCatalog | null | undefined,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  return getCodexProviderSubscriptionValuePrice(
    'anthropic', modelId, pricing, at, overrides, 'claude-code',
  );
}

function getSubscriptionDirectValuePrice(
  modelId: string,
  agent?: AgentKind,
  pricing?: ModelPricingCatalog | null,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  const registry = getActiveCatalog().modelRegistry;
  const fallback = subscriptionDirectPriceQuote(modelId, registry, agent, at);
  const routingQuote = fallback ?? subscriptionDirectPriceQuote(modelId, registry, agent);
  if (!routingQuote || routingQuote.providerId === 'xd') return undefined;
  const effective = getModelPriceQuote(pricing, routingQuote.providerId, modelId, agent);
  const quote =
    effective?.source === 'user-override'
      ? agent === undefined
        ? effective
        : (mergeStoredModelPriceOverride(
            { providerId: effective.providerId, agent, modelId: effective.modelId },
            providerReferencePriceQuote(effective.providerId, effective.modelId, registry, {
              agent,
              at,
              officialOnly: true,
            }),
            overrides,
          ) ?? effective)
      : fallback;
  if (!quote) return undefined;
  return {
    ...quote,
    modelId,
    source: quote.source === 'provider-reference' ? 'subscription-reference' : quote.source,
  };
}
return {
  REFERENCE_MODEL_PRICING_CHANGED_CHANNEL,
  getReferenceModelPricing,
  broadcastReferenceModelPricing,
  getCodexProviderSubscriptionValuePrice,
  getCodexSubscriptionValuePrice,
  getClaudeSubscriptionValuePrice,
  getSubscriptionDirectValuePrice
};
}
