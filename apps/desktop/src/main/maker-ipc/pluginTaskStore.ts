import { and, asc, eq, gt } from 'drizzle-orm';
import type { DbClient } from '../localDb/client/DbClient.js';
import { pluginTaskRequests } from '../localDb/schema.js';
import type { PluginTaskStore } from './pluginTaskService.js';

/** Captures the DB handle once, so a delayed operation never switches accounts. */
export function createPluginTaskStore(db: DbClient): PluginTaskStore {
  const table = pluginTaskRequests;
  return {
    get: async (id) => (await db.drizzle.select().from(table).where(eq(table.id, id)).limit(1))[0],
    find: async (pluginId, operation, targetId, requestKey) =>
      (
        await db.drizzle
          .select()
          .from(table)
          .where(
            and(
              eq(table.pluginId, pluginId),
              eq(table.operation, operation as 'create' | 'send'),
              eq(table.targetId, targetId),
              eq(table.requestKey, requestKey),
            ),
          )
          .limit(1)
      )[0],
    list: (pluginId, operation, targetId, after, limit) =>
      db.drizzle
        .select()
        .from(table)
        .where(
          and(
            eq(table.pluginId, pluginId),
            eq(table.operation, operation as 'create' | 'send'),
            targetId === null ? undefined : eq(table.targetId, targetId),
            gt(table.id, after),
          ),
        )
        .orderBy(asc(table.id))
        .limit(limit),
    forSession: (taskId) =>
      db.drizzle
        .select()
        .from(table)
        .where(and(eq(table.operation, 'send'), eq(table.targetId, taskId))),
    insert: async (row) => {
      await db.drizzle.insert(table).values(row);
    },
    save: async (row) => {
      const result = await db.drizzle
        .update(table)
        .set({ payload: row.payload, revision: row.revision + 1 })
        .where(and(eq(table.id, row.id), eq(table.revision, row.revision)))
        .returning({ id: table.id });
      if (!result.length) throw new Error('Plugin task receipt revision conflict');
    },
  };
}
