

import { getDbClient } from '../localDb/client/current';
import { createLogger } from '../logger';
import { legacyUsdMoney, normalizeRegionalMoney } from '../../shared/regionalMoney.js';
import {createScheduleRunCostLedger} from '@cindy/app-runtime/runCostLedger';
export type * from '@cindy/app-runtime/runCostLedger';
export const {computeScheduleRunCostDeltas,applyScheduleRunCostMetaChange,recordScheduleRunCostDirect}=createScheduleRunCostLedger({
getDbClient: (...args) => getDbClient(...args),
createLogger: (...args) => createLogger(...args),
legacyUsdMoney: (...args) => legacyUsdMoney(...args),
normalizeRegionalMoney: (...args) => normalizeRegionalMoney(...args)
});
