
import { localDayKey } from './dailySpend.js';
import { getDbClient } from './client/current.js';
import {createDailySessionUsage} from '@cindy/app-runtime/dailySessionUsage';
export type * from '@cindy/app-runtime/dailySessionUsage';
export const {incrementDailySessionUsage,getUsageTaskMeta,getSessionUsageSince}=createDailySessionUsage({
localDayKey: (...args) => localDayKey(...args),
getDbClient: (...args) => getDbClient(...args)
});
