import { captureTurnUsageContext, type TurnUsageContext } from './turnUsageContext.js';
import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.js';

import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { recordSessionTurnSpend } from '../sessionSpendBroadcaster.js';
import { recordSchedulerTurnCost, recordTurnUsageOnMessage } from '../turnCostBroadcaster.js';
import { recordModelMismatchOnMessage } from '../modelMismatchBroadcaster.js';
import { triggerClaudeAccountUsageRefresh } from '../usage/claudeAccountUsage.js';
import {
  getGatewayAccountCurrency,
  getGatewayModelPricingForModel,
} from '../usage/modelPricing.js';
import { getReferenceModelPricing, getCodexProviderSubscriptionValuePrice } from '../usage/referenceModelPricing.js';
import {
  claudeSubscriptionUsageModelKey,
  getSubscriptionValuePriceFor,
} from '../usage/usageHistory.js';
import {
  billingRouteForExplicitProvider,
  buildClaudeTurnUsageDetails,
  computePriceQuoteTurnMoney,
  normalizeTurnUsageSegments,
  normalizeModelIdForPricing,
  resolveClaudeTurnCostSinks,
  sumTurnUsageSegments,
  type BillingRoute,
} from '../usage/turnCostCalculator.js';
import {
  addRegionalMoney,
  usdToLedgerCurrency,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
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
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { readClaudeSessionRoute } from '../maker-host/claude-session-route-registry.js';
import {createSessionClaudeTurnUsage} from '@cindy/app-runtime/sessionClaudeTurnUsage';
export type * from '@cindy/app-runtime/sessionClaudeTurnUsage';
export const {recordSessionClaudeTurnUsage}=createSessionClaudeTurnUsage({
captureTurnUsageContext: (...args) => captureTurnUsageContext(...args),
isOpenAiSubscriptionProviderId: (...args) => isOpenAiSubscriptionProviderId(...args),
readClaudeApiKey: (...args) => readClaudeApiKey(...args),
recordSessionTurnSpend: (...args) => recordSessionTurnSpend(...args),
recordSchedulerTurnCost: (...args) => recordSchedulerTurnCost(...args),
recordTurnUsageOnMessage: (...args) => recordTurnUsageOnMessage(...args),
recordModelMismatchOnMessage: (...args) => recordModelMismatchOnMessage(...args),
triggerClaudeAccountUsageRefresh: (...args) => triggerClaudeAccountUsageRefresh(...args),
getGatewayAccountCurrency: (...args) => getGatewayAccountCurrency(...args),
getGatewayModelPricingForModel: (...args) => getGatewayModelPricingForModel(...args),
getReferenceModelPricing: (...args) => getReferenceModelPricing(...args),
getCodexProviderSubscriptionValuePrice: (...args) => getCodexProviderSubscriptionValuePrice(...args),
claudeSubscriptionUsageModelKey: (...args) => claudeSubscriptionUsageModelKey(...args),
getSubscriptionValuePriceFor: (...args) => getSubscriptionValuePriceFor(...args),
billingRouteForExplicitProvider: (...args) => billingRouteForExplicitProvider(...args),
buildClaudeTurnUsageDetails: (...args) => buildClaudeTurnUsageDetails(...args),
computePriceQuoteTurnMoney: (...args) => computePriceQuoteTurnMoney(...args),
normalizeTurnUsageSegments: (...args) => normalizeTurnUsageSegments(...args),
normalizeModelIdForPricing: (...args) => normalizeModelIdForPricing(...args),
resolveClaudeTurnCostSinks: (...args) => resolveClaudeTurnCostSinks(...args),
sumTurnUsageSegments: (...args) => sumTurnUsageSegments(...args),
addRegionalMoney: (...args) => addRegionalMoney(...args),
usdToLedgerCurrency: (...args) => usdToLedgerCurrency(...args),
currentLedgerCurrency: (...args) => currentLedgerCurrency(...args),
get CURRENT_CINDY_REGION(){return CURRENT_CINDY_REGION;},
triggerClaudeSubscriptionUsageRefresh: (...args) => triggerClaudeSubscriptionUsageRefresh(...args),
triggerCodexAccountUsageRefresh: (...args) => triggerCodexAccountUsageRefresh(...args),
triggerXaiSubscriptionUsageRefresh: (...args) => triggerXaiSubscriptionUsageRefresh(...args),
rebroadcastTodaySpend: (...args) => rebroadcastTodaySpend(...args),
recordModelTurnUsage: (...args) => recordModelTurnUsage(...args),
recordTurnSpend: (...args) => recordTurnSpend(...args),
broadcastSchedulerChanged: (...args) => broadcastSchedulerChanged(...args),
getSessionProvider: (...args) => getSessionProvider(...args),
readClaudeSessionRoute: (...args) => readClaudeSessionRoute(...args)
});
