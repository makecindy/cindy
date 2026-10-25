import { getDbClient, tryGetDbClient } from '../../localDb/client/current';
import * as maintenance from './groupWindowMaintenance';
import { createGroupWindowCore } from '@cindy/im-runtime/groupWindowCore';
import type { GroupWindowDb } from '@cindy/im-runtime/groupWindowSchema';
export * from '@cindy/im-runtime/groupWindowCore';
export { getGroupWindowNamespaceStats, sweepExpiredGroupWindowCursors } from './groupWindowMaintenance';
export const { recordGroupWindowEntry, resetGroupWindowCursors, assembleGroupWindowContext } = createGroupWindowCore({
  getDbClient: () => ({ drizzle: getDbClient().drizzle as unknown as GroupWindowDb }),
  tryGetDbClient: () => { const client = tryGetDbClient(); return client ? { drizzle: client.drizzle as unknown as GroupWindowDb } : null; },
  maintenance,
});
