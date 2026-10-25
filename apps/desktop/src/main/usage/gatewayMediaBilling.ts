import { getDbClient, getCurrentDbClientUserId } from '../localDb/client/current.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { localDayKey } from '../localDb/dailySpend.js';
import { createLogger } from '../logger.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { broadcastSessionSpend } from '../sessionSpendBroadcaster.js';
import { rebroadcastTodaySpend } from '../usageBroadcaster.js';
import { getGatewayMediaBillingCurrency } from './modelPricing.js';
import { captureMediaUserTurn, refreshMediaUserTurnCost } from './mediaTurnCost.js';
import { enqueueDurableWrite } from '../messagePersistBroadcaster.js';
import { broadcastTurnCostPayload } from '../turnCostBroadcaster.js';
import { broadcastSchedulerChanged } from '../maker-ipc/schedule.js';
import {
  addRegionalMoney,
  legacyUsdMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';

import {createGatewayMediaBilling} from '@cindy/app-runtime/media/gatewayMediaBilling';
export type {GatewayMediaBillingRecorder} from '@cindy/app-runtime/media/gatewayMediaBilling';
export const {prepareGatewayMediaBilling}=createGatewayMediaBilling({getDbClient,getCurrentDbClientUserId,localDayKey,captureDataOwnerBroadcastScope,isDataOwnerBroadcastScopeCurrent,broadcastSessionSpend,rebroadcastTodaySpend,getGatewayMediaBillingCurrency,captureMediaUserTurn,refreshMediaUserTurnCost,enqueueDurableWrite,broadcastTurnCostPayload,broadcastSchedulerChanged,addRegionalMoney,legacyUsdMoney,logger:createLogger('gatewayMediaBilling')});
