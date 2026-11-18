// The desktop's piUsageReceipts: its core (piUsageReceiptsCore.ts, shared with the Node Host), with the desktop
// functions it imported before bound to its ports (turnUsagePorts.ts), each resolved when called.
// The core calls no port while its module loads (export * evaluates it before the binding below runs);
// each port is resolved when it is called. This module's imports are the ones piUsageReceipts.ts had.
import '../usage/referenceModelPricing.js';
import '../usage/usageHistory.js';
import { getGatewayModelPricing, getGatewayModelPricingForModel } from '../usage/modelPricing.js';
import { rebroadcastTodaySpend } from '../usageBroadcaster.js';
import { broadcastSessionSpend, broadcastSessionTokens } from '../sessionSpendBroadcaster.js';
import { bindTurnUsagePorts } from './turnUsagePorts.js';

bindTurnUsagePorts({
  getGatewayModelPricing: (...args) => getGatewayModelPricing(...args),
  getGatewayModelPricingForModel: (...args) => getGatewayModelPricingForModel(...args),
  rebroadcastTodaySpend: (...args) => rebroadcastTodaySpend(...args),
  broadcastSessionSpend: (...args) => broadcastSessionSpend(...args),
  broadcastSessionTokens: (...args) => broadcastSessionTokens(...args),
});

export * from './piUsageReceiptsCore.js';
