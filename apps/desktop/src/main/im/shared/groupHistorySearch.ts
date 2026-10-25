import { createGroupHistorySearch } from '@cindy/im-runtime/groupHistorySearch';
import { getDbClient } from '../../localDb/client/current';
import { createLogger } from '../../logger';
export type { GroupHistorySearchHit, GroupHistorySearchLane } from '@cindy/im-runtime/groupHistorySearch';
export const searchGroupHistory = createGroupHistorySearch({ query: (sql, params) => getDbClient().query(sql, params), log: createLogger('group-history-search') });
