
import {
  addRegionalMoney,
  toLedgerCurrency,
  usdToLedgerCurrency,
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type MoneyCurrency,
  type MoneyEstimateReason,
  type PriceVariant,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { buildTurnUsageDetails, type TurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { currentLedgerCurrency } from './ledgerCurrency.js';
import {createTurnCostCalculator} from '@cindy/app-runtime/turnCostCalculator';
export type * from '@cindy/app-runtime/turnCostCalculator';
export const {normalizeTurnUsageSegments,sumTurnUsageSegments,billingRouteForExplicitProvider,normalizeModelIdForPricing,isAnthropicModel,computeGatewayTurnCost,computeGatewaySegmentedTurnCost,computePriceQuoteTurnMoney,resolveTurnCost,resolveClaudeTurnCostSinks,estimateClaudeSubscriptionTurnValue,buildClaudeTurnUsageDetails}=createTurnCostCalculator({
addRegionalMoney: (...args) => addRegionalMoney(...args),
toLedgerCurrency: (...args) => toLedgerCurrency(...args),
usdToLedgerCurrency: (...args) => usdToLedgerCurrency(...args),
buildTurnUsageDetails: (...args) => buildTurnUsageDetails(...args),
currentLedgerCurrency: (...args) => currentLedgerCurrency(...args)
});
