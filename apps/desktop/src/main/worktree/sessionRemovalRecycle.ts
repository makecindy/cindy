import { createSessionRemovalRecycle } from '@cindy/app-runtime/sessionRemovalRecycle';
import { auditRegisteredWorktrees } from './recycleMaintenance';
import { removeWorktreeForSession } from './WorktreeManager';
import * as store from './worktreeStore';
import { getDbClient } from '../localDb/client/current';
import { createLogger } from '../logger';
export type * from '@cindy/app-runtime/sessionRemovalRecycle';
export const { hasRegisteredWorktreeForSession, recycleWorktreeForRemovedSession, isSessionStillRemovable, reconcileWorktreesForDeletedSessions } = createSessionRemovalRecycle({
 getDbClient: () => getDbClient(), store,
 removeWorktreeForSession: (...args) => removeWorktreeForSession(...args),
 auditRegisteredWorktrees: () => auditRegisteredWorktrees(), logger: createLogger('sessionRemovalRecycle'),
});
