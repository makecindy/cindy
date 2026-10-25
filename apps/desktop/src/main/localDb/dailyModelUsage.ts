

import {
  addRegionalMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  zeroUsageMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { localDayKey } from './dailySpend.js';
import { getDbClient } from './client/current.js';
import { createLogger } from '../logger.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import {createDailyModelUsage} from '@cindy/app-runtime/dailyModelUsage';
export type * from '@cindy/app-runtime/dailyModelUsage';
export const {incrementDailyModelUsage,getModelUsageSince}=createDailyModelUsage({
addRegionalMoney: (...args) => addRegionalMoney(...args),
legacyUsdMoney: (...args) => legacyUsdMoney(...args),
normalizeRegionalMoney: (...args) => normalizeRegionalMoney(...args),
zeroUsageMoney: (...args) => zeroUsageMoney(...args),
localDayKey: (...args) => localDayKey(...args),
getDbClient: (...args) => getDbClient(...args),
createLogger: (...args) => createLogger(...args),
currentLedgerCurrency: (...args) => currentLedgerCurrency(...args)
});
