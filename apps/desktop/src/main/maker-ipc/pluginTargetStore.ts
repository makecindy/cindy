import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from '../localDb/client/DbClient.js';
import { pluginTaskRequests } from '../localDb/schema.js';
import type { PluginTargetReceipt, PluginTargetStore, PluginTargetTerminal } from '../cindy-brain/pluginTargetSlot.js';

/** Reuse the receipt table and unique request index; target rows confer no task ownership. */
export function createPluginTargetStore(db: DbClient, assertCurrent: () => void): PluginTargetStore & {
  topicRoute(pluginId: string, botId: string, topicKey: string, create: boolean): Promise<string | null>;
  settle(id: string, taskId: string, terminal: PluginTargetTerminal): Promise<void>;
} {
  const table = pluginTaskRequests;
  const read = async (where: ReturnType<typeof and>) => {
    assertCurrent();
    const [row] = await db.drizzle.select().from(table)
      .where(and(eq(table.operation, 'target'), where)).limit(1);
    assertCurrent();
    return row ? { ...JSON.parse(row.payload), id: row.id, pluginId: row.pluginId,
      requestKey: row.requestKey } as PluginTargetReceipt : undefined;
  };
  const values = (receipt: PluginTargetReceipt) => ({
    id: receipt.id, pluginId: receipt.pluginId, operation: 'target' as const,
    targetId: '', requestKey: receipt.requestKey, fingerprint: receipt.hash ?? '',
    payload: JSON.stringify(receipt), revision: 0, createdAt: Date.now(),
  });
  return {
    // A separate target_id partition shares the existing unique index and source
    // archive lifecycle, without granting ordinary task ownership or history access.
    topicRoute: async (pluginId, botId, topicKey, create) => {
      assertCurrent();
      const targetId = `companion-topic:${botId}`;
      const scope = and(eq(table.pluginId, pluginId), eq(table.operation, 'target'),
        eq(table.targetId, targetId), eq(table.requestKey, topicKey));
      if (create) {
        await db.drizzle.insert(table).values({
          id: `plugin-topic:${randomUUID()}`, pluginId, operation: 'target', targetId,
          requestKey: topicKey, fingerprint: 'companion-topic-v1',
          payload: JSON.stringify({ companionTopic: true }), revision: 0, createdAt: Date.now(),
        }).onConflictDoNothing();
        assertCurrent();
      }
      const [row] = await db.drizzle.select().from(table).where(scope).limit(1);
      assertCurrent();
      if (!row) return null;
      const payload = JSON.parse(row.payload);
      if (row.fingerprint !== 'companion-topic-v1' || payload?.companionTopic !== true ||
          payload.ownershipRevoked === true || !/^plugin-topic:[0-9a-f-]{36}$/.test(row.id))
        throw Object.assign(new Error('TARGET_UNAVAILABLE'), { code: 'TARGET_UNAVAILABLE' });
      // This IM subnamespace is Host-generated; no plugin may select a native IM lane.
      return `im:plugin:${row.id}`;
    },
    settle: async (id, taskId, terminal) => {
      assertCurrent();
      await db.drizzle.update(table).set({
        payload: sql`json_set(${table.payload}, '$.terminal', json(${JSON.stringify(terminal)}))`,
        revision: sql`${table.revision} + 1`,
      }).where(and(eq(table.id, id), eq(table.operation, 'target'),
        sql`json_extract(${table.payload}, '$.taskId') = ${taskId}`,
        sql`json_extract(${table.payload}, '$.terminal') IS NULL`));
      assertCurrent();
    },
    get: (pluginId, key) => read(and(eq(table.pluginId, pluginId), eq(table.targetId, ''), eq(table.requestKey, key))),
    getById: id => read(eq(table.id, id)),
    reserve: async receipt => {
      assertCurrent();
      const inserted = await db.drizzle.insert(table).values(values(receipt))
        .onConflictDoNothing().returning({ id: table.id });
      assertCurrent();
      return inserted.length > 0;
    },
    cancel: async (pluginId, requestKey) => {
      assertCurrent();
      const [row] = await db.drizzle.insert(table).values(values({
        id: `plugin-target:${randomUUID()}`, pluginId, requestKey, hash: null, status: 'cancelled',
      })).onConflictDoUpdate({
        target: [table.pluginId, table.operation, table.targetId, table.requestKey],
        set: { payload: sql`json_set(${table.payload}, '$.status', 'cancelled')`, revision: sql`${table.revision} + 1` },
      }).returning();
      assertCurrent();
      return { ...JSON.parse(row!.payload), id: row!.id, pluginId, requestKey };
    },
    accept: async (id, delivery) => {
      assertCurrent();
      await db.drizzle.update(table).set({
        payload: sql`json_set(${table.payload}, '$.status', 'accepted', '$.delivery', ${delivery})`,
        revision: sql`${table.revision} + 1`,
      }).where(and(eq(table.id, id), eq(table.operation, 'target'), sql`json_extract(${table.payload}, '$.status') != 'cancelled'`));
      assertCurrent();
    },
  };
}
