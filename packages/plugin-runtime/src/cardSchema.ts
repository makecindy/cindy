import {sqliteTable,text,integer,index} from 'drizzle-orm/sqlite-core';

export const ghostCards = sqliteTable(
  'ghost_cards',
  {
    /** 管子配对号(pipeDispatcher 铸造;与 tool_result 的 xdt_card_id 同值)。 */
    callId: text('call_id').primaryKey(),
    ghostId: text('ghost_id').notNull(),
    /** 出生会话(best-effort:codex 路径可取,claude in-process 路径可能为空;仅统计用途)。 */
    sessionId: text('session_id'),
    /** 净化后的卡片正文(静态 HTML+CSS)。 */
    html: text('html').notNull(),
    /** 渲染高度 px(已 clamp)。 */
    height: integer('height').notNull(),
    /** 供片协议版本(海报模式 = 1;未来交互模式扩展位)。 */
    v: integer('v').notNull().default(1),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    /** GC 按最旧淘汰的扫描路径。 */
    byUpdatedAt: index('ghost_cards_updated_at_idx').on(t.updatedAt),
  }),
);
