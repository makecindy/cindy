import type {ModelPricingCatalog as ModelPricingMap,ModelPriceQuote} from '@cindy/maker-shared/regional-money';import type {ModelPriceOverridesSnapshot} from './modelPriceOverrideStore.js';import type {createReferenceModelPricing} from './referenceModelPricing.js';
export function createSubscriptionValuePrice(host:Pick<ReturnType<typeof createReferenceModelPricing>,'getSubscriptionDirectValuePrice'|'getCodexSubscriptionValuePrice'|'getCodexProviderSubscriptionValuePrice'|'getClaudeSubscriptionValuePrice'>){
const {getSubscriptionDirectValuePrice,getCodexSubscriptionValuePrice,getCodexProviderSubscriptionValuePrice,getClaudeSubscriptionValuePrice}=host;
function getSubscriptionValuePriceFor(
  agentKind: 'claude-code' | 'codex' | 'pi' | 'media',
  model: string,
  pricing: ModelPricingMap | null,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  if (agentKind === 'media') return undefined;
  if (agentKind === 'codex') {
    return (
      getSubscriptionDirectValuePrice(model, 'codex', pricing, at, overrides) ??
      getCodexSubscriptionValuePrice(model, pricing, at, overrides) ??
      getCodexProviderSubscriptionValuePrice('anthropic', model, pricing, at, overrides)
    );
  }
  if (agentKind === 'pi') {
    return (
      getSubscriptionDirectValuePrice(model, 'pi', pricing, at, overrides) ??
      getCodexSubscriptionValuePrice(model, pricing, at, overrides) ??
      getClaudeSubscriptionValuePrice(model, pricing, at, overrides)
    );
  }
  return (
    getSubscriptionDirectValuePrice(model, 'claude-code', pricing, at, overrides) ??
    getClaudeSubscriptionValuePrice(model, pricing, at, overrides)
  );
}

return {getSubscriptionValuePriceFor};
}
