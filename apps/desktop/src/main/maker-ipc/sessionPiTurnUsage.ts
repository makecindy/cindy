// The desktop's sessionPiTurnUsage: its core (sessionPiTurnUsageCore.ts, shared with the Node Host), with the desktop
// functions it imported before bound to its ports (turnUsagePorts.ts), each resolved when called.
// The core calls no port while its module loads (export * evaluates it before the binding below runs);
// each port is resolved when it is called. This module's imports are the ones sessionPiTurnUsage.ts had.
import './turnUsageContext.js';
import '../maker-host/subscription-account-auth.js';
import './piUsageReceipts.js';
import '../usage/referenceModelPricing.js';
import '../usage/usageHistory.js';
import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.desktop.js';
import { recordSessionTurnSpend, recordSessionTurnTokens } from '../sessionSpendBroadcaster.js';
import { piUsageToTokens, recordSchedulerTurnCost, recordTurnUsageOnMessage } from '../turnCostBroadcaster.js';
import { triggerClaudeAccountUsageRefresh } from '../usage/claudeAccountUsage.js';
import { getGatewayModelPricingForModel } from '../usage/modelPricing.js';
import { triggerClaudeSubscriptionUsageRefresh, triggerCodexAccountUsageRefresh, triggerXaiSubscriptionUsageRefresh } from './usage.js';
import { rebroadcastTodaySpend, recordModelTurnUsage, recordTurnSpend } from '../usageBroadcaster.js';
import { broadcastSchedulerChanged } from './schedule.js';
import { bindTurnUsagePorts } from './turnUsagePorts.js';

bindTurnUsagePorts({
  isOpenAiSubscriptionProviderId: (...args) => isOpenAiSubscriptionProviderId(...args),
  recordSessionTurnSpend: (...args) => recordSessionTurnSpend(...args),
  recordSessionTurnTokens: (...args) => recordSessionTurnTokens(...args),
  piUsageToTokens: (...args) => piUsageToTokens(...args),
  recordSchedulerTurnCost: (...args) => recordSchedulerTurnCost(...args),
  recordTurnUsageOnMessage: (...args) => recordTurnUsageOnMessage(...args),
  triggerClaudeAccountUsageRefresh: (...args) => triggerClaudeAccountUsageRefresh(...args),
  getGatewayModelPricingForModel: (...args) => getGatewayModelPricingForModel(...args),
  triggerClaudeSubscriptionUsageRefresh: (...args) => triggerClaudeSubscriptionUsageRefresh(...args),
  triggerCodexAccountUsageRefresh: (...args) => triggerCodexAccountUsageRefresh(...args),
  triggerXaiSubscriptionUsageRefresh: (...args) => triggerXaiSubscriptionUsageRefresh(...args),
  rebroadcastTodaySpend: (...args) => rebroadcastTodaySpend(...args),
  recordModelTurnUsage: (...args) => recordModelTurnUsage(...args),
  recordTurnSpend: (...args) => recordTurnSpend(...args),
  broadcastSchedulerChanged: (...args) => broadcastSchedulerChanged(...args),
});

export * from './sessionPiTurnUsageCore.js';
