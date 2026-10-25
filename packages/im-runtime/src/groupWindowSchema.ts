import { sqliteTable, integer, text, uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
export const hookGroupMessages = sqliteTable(
  'hook_group_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider').notNull(),
    chatId: text('chat_id').notNull(),
    /** forum topic / thread id;空串 = 主群流。 */
    threadId: text('thread_id').notNull().default(''),
    messageId: text('message_id').notNull(),
    chatName: text('chat_name'),
    author: text('author').notNull(),
    isBot: integer('is_bot').notNull().default(0),
    text: text('text').notNull(),
    /** JSON string[];无附件为空。 */
    fileNames: text('file_names'),
    /** IM 平台侧发送时刻(unix ms)。 */
    sentAt: integer('sent_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    /** 同一条消息(重放/重连)幂等去重的键(冲突即忽略, 不更新)。 */
    byMessage: uniqueIndex('hook_group_messages_msg_idx').on(
      t.provider,
      t.chatId,
      t.threadId,
      t.messageId,
    ),
    /** 窗口查询与 GC 的扫描路径。 */
    byWindow: index('hook_group_messages_window_idx').on(t.provider, t.chatId, t.threadId, t.id),
  }),
);

/** hook_group_messages 的派生容量计数；由本地 SQLite 触发器增量维护。 */
export const hookGroupMessageStats = sqliteTable('hook_group_message_stats', {
  provider: text('provider').primaryKey(),
  rowCount: integer('row_count').notNull(),
  textBytes: integer('text_bytes').notNull(),
});

/**
 * 群消息窗口的已提交游标。游标与消息池同属本地 DB，但按 provider 命名空间
 * 隔离，登出/换绑时只清理对应 bot 的行。
 */
export const hookGroupContextCursors = sqliteTable(
  'hook_group_context_cursors',
  {
    provider: text('provider').notNull(),
    cursorKey: text('cursor_key').notNull(),
    cursorId: integer('cursor_id').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.cursorKey] }),
    /** 消息命名空间已清空后，惰性 sweep 按最后活跃时间回收孤儿游标。 */
    byUpdatedAt: index('hook_group_context_cursors_updated_at_idx').on(t.updatedAt),
  }),
);


export type GroupWindowDb = Pick<BetterSQLite3Database, 'select' | 'insert' | 'update' | 'delete'>;
