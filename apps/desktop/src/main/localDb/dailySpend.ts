

import {
  addCompatibleRegionalMoney,
  addRegionalMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  zeroUsageMoney,
  type MoneyCurrency,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { getDbClient } from './client/current.js';
import { createLogger } from '../logger.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import {createDailySpend} from '@cindy/app-runtime/dailySpend';
export type * from '@cindy/app-runtime/dailySpend';
export const {localDayKey,collapseDayMonies,incrementDailySpend,getTodaySpend,getAllSpendDays}=createDailySpend({
addCompatibleRegionalMoney: (...args) => addCompatibleRegionalMoney(...args),
addRegionalMoney: (...args) => addRegionalMoney(...args),
legacyUsdMoney: (...args) => legacyUsdMoney(...args),
normalizeRegionalMoney: (...args) => normalizeRegionalMoney(...args),
zeroUsageMoney: (...args) => zeroUsageMoney(...args),
getDbClient: (...args) => getDbClient(...args),
createLogger: (...args) => createLogger(...args),
currentLedgerCurrency: (...args) => currentLedgerCurrency(...args)
});
