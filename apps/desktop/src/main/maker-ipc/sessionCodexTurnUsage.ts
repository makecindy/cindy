// The desktop's sessionCodexTurnUsage: its core (sessionCodexTurnUsageCore.ts, shared with the Node Host), with the desktop
// functions it imported before bound to its ports (turnUsagePorts.ts), each resolved when called.
// The core calls no port while its module loads (export * evaluates it before the binding below runs);
// each port is resolved when it is called. This module's imports are the ones sessionCodexTurnUsage.ts had.
import './turnUsageContext.js';
import '../usage/referenceModelPricing.js';
import '../usage/usageHistory.js';
import '../maker-host/subscription-account-auth.js';
import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { getCodexProxyAuthInjection } from '../maker-host/codex-proxy-host.desktop.js';
import { recordSessionTurnSpend, recordSessionTurnTokens } from '../sessionSpendBroadcaster.js';
import { codexUsageToTokens, recordSchedulerTurnCost, recordTurnUsageOnMessage } from '../turnCostBroadcaster.js';
import { triggerClaudeAccountUsageRefresh } from '../usage/claudeAccountUsage.js';
import { getGatewayModelPricingForModel, getModelPriceQuote } from '../usage/modelPricing.js';
import { triggerClaudeSubscriptionUsageRefresh, triggerXaiSubscriptionUsageRefresh } from './usage.js';
import { rebroadcastCodexTodayUsage, recordCodexTurnUsage, recordModelTurnUsage, recordTurnSpend } from '../usageBroadcaster.js';
import { broadcastSchedulerChanged } from './schedule.js';
import { bindTurnUsagePorts } from './turnUsagePorts.js';

bindTurnUsagePorts({
  readClaudeApiKey: (...args) => readClaudeApiKey(...args),
  getCodexProxyAuthInjection: (...args) => getCodexProxyAuthInjection(...args),
  recordSessionTurnSpend: (...args) => recordSessionTurnSpend(...args),
  recordSessionTurnTokens: (...args) => recordSessionTurnTokens(...args),
  codexUsageToTokens: (...args) => codexUsageToTokens(...args),
  recordSchedulerTurnCost: (...args) => recordSchedulerTurnCost(...args),
  recordTurnUsageOnMessage: (...args) => recordTurnUsageOnMessage(...args),
  triggerClaudeAccountUsageRefresh: (...args) => triggerClaudeAccountUsageRefresh(...args),
  getGatewayModelPricingForModel: (...args) => getGatewayModelPricingForModel(...args),
  getModelPriceQuote: (...args) => getModelPriceQuote(...args),
  triggerClaudeSubscriptionUsageRefresh: (...args) => triggerClaudeSubscriptionUsageRefresh(...args),
  triggerXaiSubscriptionUsageRefresh: (...args) => triggerXaiSubscriptionUsageRefresh(...args),
  rebroadcastCodexTodayUsage: (...args) => rebroadcastCodexTodayUsage(...args),
  recordCodexTurnUsage: (...args) => recordCodexTurnUsage(...args),
  recordModelTurnUsage: (...args) => recordModelTurnUsage(...args),
  recordTurnSpend: (...args) => recordTurnSpend(...args),
  broadcastSchedulerChanged: (...args) => broadcastSchedulerChanged(...args),
});

export * from './sessionCodexTurnUsageCore.js';
