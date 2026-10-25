import type { ByokProvider } from '@cindy/model-providers';
import { gatewayModelPriceQuote, modelPricingKey } from '@cindy/model-providers/modelPriceQuote';
import type { ModelPricingCatalog } from '@cindy/maker-shared/regional-money';
export interface createByokPricingHost {}

export function createByokPricing(_host: createByokPricingHost = {}) {



let pricing: ModelPricingCatalog = {};

/** Enterprise reference prices are separate from Cindy retail prices and discounts. */
function buildByokPricing(providers: readonly ByokProvider[]): ModelPricingCatalog {
  const result: ModelPricingCatalog = {};
  for (const provider of providers) {
    const quotes = (result[provider.id] = {} as ModelPricingCatalog[string]);
    for (const model of provider.models) {
      // Missing currency is unknown, not a reason to guess from the client's region.
      if (!model.currency) continue;
      const quote = gatewayModelPriceQuote(
        { ...model, costDiscount: undefined },
        model.currency,
        false,
        {
          allowFreeModel: true,
        },
      );
      if (!quote) continue;
      for (const agent of model.agents ?? []) {
        quotes[modelPricingKey(model.id, agent)] = {
          ...quote,
          providerId: provider.id,
          source: 'provider-reference',
          approximate: true,
        };
      }
    }
  }
  return result;
}

function setByokPricing(value: ModelPricingCatalog): void {
  pricing = value;
}
function getByokPricing(): ModelPricingCatalog {
  return structuredClone(pricing);
}
return {
  buildByokPricing,
  setByokPricing,
  getByokPricing
};
}
