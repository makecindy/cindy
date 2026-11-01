/**
 * Conversation usage adapter (ROADMAP 1.9b-2).
 *
 * Re-exports the pure adapter helpers from `src/shared/conversationUsage.ts` and
 * binds `resolveConversationUsageSummary` to the main-process pricing catalogs
 * (`getGatewayModelPricingForModel()` and `getReferenceModelPricing()`).
 */

import type { SessionUsageSummary } from '@cindy/maker-shared/session-usage';

import {
  adaptStoredTurnToSessionUsageTurn,
  buildConversationUsageFromStoredTurns,
  lookupTurnPriceQuote,
  quoteToUsageRates,
  resolveRecordedTurnMoney,
  type ConversationUsagePricingContext,
  type StoredConversationUsageTurn,
} from '../../shared/conversationUsage.js';
import type { ModelPricingCatalog } from '../../shared/regionalMoney.js';
import { getGatewayModelPricingForModel } from './modelPricing.js';
import { getReferenceModelPricing } from './referenceModelPricing.js';

export {
  adaptStoredTurnToSessionUsageTurn,
  buildConversationUsageFromStoredTurns,
  lookupTurnPriceQuote,
  quoteToUsageRates,
  resolveRecordedTurnMoney,
  type ConversationUsagePricingContext,
  type StoredConversationUsageTurn,
};

export interface ResolveConversationUsageDeps {
  readonly readGatewayPricing?: () => Promise<ModelPricingCatalog | null>;
  readonly readReferencePricing?: () => ModelPricingCatalog | Promise<ModelPricingCatalog>;
}

const DEFAULT_RESOLVE_DEPS: Required<ResolveConversationUsageDeps> = {
  readGatewayPricing: getGatewayModelPricingForModel,
  readReferencePricing: getReferenceModelPricing,
};

/**
 * Asynchronous entry point that loads the desktop pricing catalogs
 * (`getGatewayModelPricingForModel()` and `getReferenceModelPricing()`) when
 * the caller has not already supplied them.
 */
export async function resolveConversationUsageSummary(
  storedTurns: readonly StoredConversationUsageTurn[],
  context: ConversationUsagePricingContext = {},
  deps: ResolveConversationUsageDeps = DEFAULT_RESOLVE_DEPS,
): Promise<SessionUsageSummary> {
  const readGateway = deps.readGatewayPricing ?? DEFAULT_RESOLVE_DEPS.readGatewayPricing;
  const readReference = deps.readReferencePricing ?? DEFAULT_RESOLVE_DEPS.readReferencePricing;
  const [gatewayPricing, referencePricing] = await Promise.all([
    context.gatewayPricing !== undefined
      ? Promise.resolve(context.gatewayPricing)
      : Promise.resolve(readGateway()).catch(() => null),
    context.referencePricing !== undefined
      ? Promise.resolve(context.referencePricing)
      : Promise.resolve(readReference()).catch(() => null),
  ]);
  return buildConversationUsageFromStoredTurns(storedTurns, {
    ...context,
    gatewayPricing,
    referencePricing,
  });
}
