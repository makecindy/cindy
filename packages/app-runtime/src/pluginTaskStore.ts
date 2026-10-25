import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@cindy/runtime-db';
import { pluginTaskRequests, sessions } from '@cindy/runtime-db/schema';
import { createPluginTaskStore as createStore } from '@cindy/plugin-runtime/pluginTaskStore';

export function createPluginTaskStore(db: DbClient) {
  const table = pluginTaskRequests;
  const adapter = {
    discardUncreated: async (row: import('@cindy/plugin-runtime/pluginTaskService').PluginTaskReceipt) => {
      // The caller proves INSERT never started; retain any changed/revoked
      // receipt or raw Session row, even one hidden by the task view.
      await db.drizzle.delete(table).where(and(
        eq(table.id, row.id), eq(table.pluginId, row.pluginId),
        eq(table.operation, 'create'), eq(table.revision, row.revision),
        sql`NOT EXISTS (SELECT 1 FROM ${sessions} WHERE ${sessions.id} = ${row.id})`,
      ));
    },
  };
  return createStore(db, adapter.discardUncreated);
}
