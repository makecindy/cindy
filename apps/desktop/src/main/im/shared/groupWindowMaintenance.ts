import { getDbClient } from '../../localDb/client/current';
import { createLogger } from '../../logger';
import { createGroupWindowMaintenance } from '@cindy/im-runtime/groupWindowMaintenance';
import type { GroupWindowDb } from '@cindy/im-runtime/groupWindowSchema';
export { GROUP_CONTEXT_CURSOR_RETENTION_MS, GROUP_WINDOW_ENTRY_TEXT_MAX_BYTES } from '@cindy/im-runtime/groupWindowMaintenance';
export const { prepareGroupWindowText, getGroupWindowNamespaceStats, maybeLogGroupWindowNamespaceStats, sweepExpiredGroupWindowCursors, maybeSweepExpiredGroupWindowCursors } = createGroupWindowMaintenance({
  getDbClient: () => ({ drizzle: getDbClient().drizzle as unknown as GroupWindowDb }),
  log: createLogger('group-window-maintenance'),
});
