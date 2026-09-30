import type { ByokProvider } from '@cindy/model-providers';
import { gatewayModelPriceQuote, modelPricingKey } from '../../shared/modelPriceQuote.js';
import type { ModelPricingCatalog } from '../../shared/regionalMoney.js';

let pricing: ModelPricingCatalog = {};

/** Enterprise reference prices are separate from Cindy retail prices and discounts. */
export function buildByokPricing(providers: readonly ByokProvider[]): ModelPricingCatalog {
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

export function setByokPricing(value: ModelPricingCatalog): void {
  pricing = value;
}
export function getByokPricing(): ModelPricingCatalog {
  return structuredClone(pricing);
}
