import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

export const pluginTaskRequests = sqliteTable(
  "plugin_task_requests",
  {
    id: text("id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    operation: text("operation", {
      enum: ["create", "send", "target"],
    }).notNull(),
    targetId: text("target_id").notNull(),
    requestKey: text("request_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    payload: text("payload").notNull(),
    revision: integer("revision").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("plugin_task_request_key").on(
      table.pluginId,
      table.operation,
      table.targetId,
      table.requestKey,
    ),
    index("plugin_task_target").on(table.targetId, table.pluginId),
  ],
);
