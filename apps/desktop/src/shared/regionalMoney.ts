import { createRegionalMoney } from '@cindy/maker-shared/regional-money';
import { CURRENT_CINDY_REGION } from './brandRegion.js';
export type * from '@cindy/maker-shared/regional-money';
export const { USD_TO_CNY_FIXED_RATE, gatewayCurrencyForRegion, DEFAULT_USAGE_CURRENCY, gatewayCurrency, zeroUsageMoney, usdMoney, legacyUsdMoney, regionalizeMoney, regionalizeUsd, toLedgerCurrency, usdToLedgerCurrency, gatewayMoney, addRegionalMoney, addCompatibleRegionalMoney, asValueEstimateMoney, normalizeRegionalMoney } = createRegionalMoney(CURRENT_CINDY_REGION);
