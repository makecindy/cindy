import { captureTurnUsageContext, type TurnUsageContext } from './turnUsageContext.js';
import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.js';
import { isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId } from '../maker-host/subscription-account-auth.js';

import { buildTurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { recordSessionTurnSpend, recordSessionTurnTokens } from '../sessionSpendBroadcaster.js';
import {
  piUsageToTokens,
  recordSchedulerTurnCost,
  recordTurnUsageOnMessage,
} from '../turnCostBroadcaster.js';
import { triggerClaudeAccountUsageRefresh } from '../usage/claudeAccountUsage.js';
import { getGatewayModelPricingForModel } from '../usage/modelPricing.js';
import { getReferenceModelPricing, getCodexProviderSubscriptionValuePrice } from '../usage/referenceModelPricing.js';
import {
  getSubscriptionValuePriceFor,
  piSubscriptionUsageModelKey,
} from '../usage/usageHistory.js';
import {
  computePriceQuoteTurnMoney,
  normalizeTurnUsageSegments,
  normalizeModelIdForPricing,
  resolveTurnCost,
  sumTurnUsageSegments,
  type BillingRoute,
} from '../usage/turnCostCalculator.js';
import { addRegionalMoney, type RegionalMoney } from '../../shared/regionalMoney.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import {
  triggerClaudeSubscriptionUsageRefresh,
  triggerCodexAccountUsageRefresh,
  triggerXaiSubscriptionUsageRefresh,
} from './usage.js';
import {
  rebroadcastTodaySpend,
  recordModelTurnUsage,
  recordTurnSpend,
} from '../usageBroadcaster.js';
import { broadcastSchedulerChanged } from './schedule.js';
import {createSessionPiTurnUsage} from '@cindy/app-runtime/sessionPiTurnUsage';
export type * from '@cindy/app-runtime/sessionPiTurnUsage';
export const {recordSessionPiTurnUsage}=createSessionPiTurnUsage({
captureTurnUsageContext: (...args) => captureTurnUsageContext(...args),
isOpenAiSubscriptionProviderId: (...args) => isOpenAiSubscriptionProviderId(...args),
isClaudeSubscriptionProviderId: (...args) => isClaudeSubscriptionProviderId(...args),
isXaiSubscriptionProviderId: (...args) => isXaiSubscriptionProviderId(...args),
buildTurnUsageDetails: (...args) => buildTurnUsageDetails(...args),
recordSessionTurnSpend: (...args) => recordSessionTurnSpend(...args),
recordSessionTurnTokens: (...args) => recordSessionTurnTokens(...args),
piUsageToTokens: (...args) => piUsageToTokens(...args),
recordSchedulerTurnCost: (...args) => recordSchedulerTurnCost(...args),
recordTurnUsageOnMessage: (...args) => recordTurnUsageOnMessage(...args),
triggerClaudeAccountUsageRefresh: (...args) => triggerClaudeAccountUsageRefresh(...args),
getGatewayModelPricingForModel: (...args) => getGatewayModelPricingForModel(...args),
getReferenceModelPricing: (...args) => getReferenceModelPricing(...args),
getCodexProviderSubscriptionValuePrice: (...args) => getCodexProviderSubscriptionValuePrice(...args),
getSubscriptionValuePriceFor: (...args) => getSubscriptionValuePriceFor(...args),
piSubscriptionUsageModelKey: (...args) => piSubscriptionUsageModelKey(...args),
computePriceQuoteTurnMoney: (...args) => computePriceQuoteTurnMoney(...args),
normalizeTurnUsageSegments: (...args) => normalizeTurnUsageSegments(...args),
normalizeModelIdForPricing: (...args) => normalizeModelIdForPricing(...args),
resolveTurnCost: (...args) => resolveTurnCost(...args),
sumTurnUsageSegments: (...args) => sumTurnUsageSegments(...args),
addRegionalMoney: (...args) => addRegionalMoney(...args),
currentLedgerCurrency: (...args) => currentLedgerCurrency(...args),
get CURRENT_CINDY_REGION(){return CURRENT_CINDY_REGION;},
triggerClaudeSubscriptionUsageRefresh: (...args) => triggerClaudeSubscriptionUsageRefresh(...args),
triggerCodexAccountUsageRefresh: (...args) => triggerCodexAccountUsageRefresh(...args),
triggerXaiSubscriptionUsageRefresh: (...args) => triggerXaiSubscriptionUsageRefresh(...args),
rebroadcastTodaySpend: (...args) => rebroadcastTodaySpend(...args),
recordModelTurnUsage: (...args) => recordModelTurnUsage(...args),
recordTurnSpend: (...args) => recordTurnSpend(...args),
broadcastSchedulerChanged: (...args) => broadcastSchedulerChanged(...args)
});
