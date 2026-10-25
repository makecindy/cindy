import { createGroupHistoryMcpServer as createShared, type GroupHistoryMcpDeps as SharedDeps } from '@cindy/im-runtime/groupHistoryMcpServer';
import { searchGroupHistory } from '../im/shared/groupHistorySearch';
import { createLogger } from '../logger.js';
export type GroupHistoryMcpDeps = Omit<SharedDeps, 'search'> & { search?: SharedDeps['search'] };
export function createGroupHistoryMcpServer(deps: GroupHistoryMcpDeps) { return createShared({ ...deps, search: deps.search ?? searchGroupHistory }, createLogger('mcp/cindy_group_history')); }
