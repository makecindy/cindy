// The desktop's sessionClaudeTurnUsage: its core (sessionClaudeTurnUsageCore.ts, shared with the Node Host), with the desktop
// functions it imported before bound to its ports (turnUsagePorts.ts), each resolved when called.
// The core calls no port while its module loads (export * evaluates it before the binding below runs);
// each port is resolved when it is called. This module's imports are the ones sessionClaudeTurnUsage.ts had.
import './turnUsageContext.js';
import '../usage/referenceModelPricing.js';
import '../usage/usageHistory.js';
import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.desktop.js';
import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { recordSessionTurnSpend } from '../sessionSpendBroadcaster.js';
import { recordSchedulerTurnCost, recordTurnUsageOnMessage } from '../turnCostBroadcaster.js';
import { recordModelMismatchOnMessage } from '../modelMismatchBroadcaster.js';
import { triggerClaudeAccountUsageRefresh } from '../usage/claudeAccountUsage.js';
import { getGatewayAccountCurrency, getGatewayModelPricingForModel } from '../usage/modelPricing.js';
import { triggerClaudeSubscriptionUsageRefresh, triggerCodexAccountUsageRefresh, triggerXaiSubscriptionUsageRefresh } from './usage.js';
import { rebroadcastTodaySpend, recordModelTurnUsage, recordTurnSpend } from '../usageBroadcaster.js';
import { broadcastSchedulerChanged } from './schedule.js';
import { bindTurnUsagePorts } from './turnUsagePorts.js';

bindTurnUsagePorts({
  isOpenAiSubscriptionProviderId: (...args) => isOpenAiSubscriptionProviderId(...args),
  readClaudeApiKey: (...args) => readClaudeApiKey(...args),
  recordSessionTurnSpend: (...args) => recordSessionTurnSpend(...args),
  recordSchedulerTurnCost: (...args) => recordSchedulerTurnCost(...args),
  recordTurnUsageOnMessage: (...args) => recordTurnUsageOnMessage(...args),
  recordModelMismatchOnMessage: (...args) => recordModelMismatchOnMessage(...args),
  triggerClaudeAccountUsageRefresh: (...args) => triggerClaudeAccountUsageRefresh(...args),
  getGatewayAccountCurrency: (...args) => getGatewayAccountCurrency(...args),
  getGatewayModelPricingForModel: (...args) => getGatewayModelPricingForModel(...args),
  triggerClaudeSubscriptionUsageRefresh: (...args) => triggerClaudeSubscriptionUsageRefresh(...args),
  triggerCodexAccountUsageRefresh: (...args) => triggerCodexAccountUsageRefresh(...args),
  triggerXaiSubscriptionUsageRefresh: (...args) => triggerXaiSubscriptionUsageRefresh(...args),
  rebroadcastTodaySpend: (...args) => rebroadcastTodaySpend(...args),
  recordModelTurnUsage: (...args) => recordModelTurnUsage(...args),
  recordTurnSpend: (...args) => recordTurnSpend(...args),
  broadcastSchedulerChanged: (...args) => broadcastSchedulerChanged(...args),
});

export * from './sessionClaudeTurnUsageCore.js';
