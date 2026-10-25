import { sqliteTable, text, integer, index, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export const mediaBlobs = sqliteTable('media_blobs', {
  /** SHA-256 十六进制指纹(64 字符,主机侧对字节计算;外部自称指纹一律无效)。 */
  hash: text('hash').primaryKey(),
  /** 落盘扩展名(含点,如 '.png');由主机按真实 mime 定,决定渲染方式。 */
  ext: text('ext').notNull(),
  mimeType: text('mime_type').notNull(),
  bytes: integer('bytes').notNull(),
  /**
   * 性质=缓存(可再生:飞书/Jira 等下载副本)。cache blob 即使仍有 ref 也可被
   * 容量上限清理(重下同内容 = 同指纹自动复位);非 cache(附件/作品)只走引用计数。
   */
  isCache: integer('is_cache', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  /** 最近被读取时间(cache LRU 依据;惰性更新,不保证每次读都刷)。 */
  lastAccessAt: integer('last_access_at').notNull(),
});

/**
 * 引用行:谁在用这个 blob(+ 这次引用的出生信息)。
 *
 * refKind/refId 是多态引用(消息 id / 会话 id / 意识 id),不设 FK——
 * 删除会话/卸载意识时由对应业务代码删自己名下的 ref(回收器对账兜底)。
 * origin* 记出生:意识面板供图的归属校验即查「该指纹是否有 origin 为本意识
 * 的行,或 ghost-gallery / ghost-grant / ghost-tool-grant / ghost-deposit ref」
 * (ghostCanRead,见 main/cindy-media/ledger.ts)。
 *
 * refKind 是无约束的 text 列:新增引用类型只改 ledger.ts 的联合类型,
 * 不需要 migration。
 */
export const mediaRefs = sqliteTable(
  'media_refs',
  {
    id: text('id').primaryKey(),
    hash: text('hash')
      .notNull()
      .references((): AnySQLiteColumn => mediaBlobs.hash, { onDelete: 'cascade' }),
    /** 'message' | 'session-attachment' | 'ghost-gallery' | 'ghost-tool-grant' | 'ghost-deposit' | 'import'…(联合类型见 ledger.ts)。 */
    refKind: text('ref_kind').notNull(),
    /** 引用方 id:消息 clientId / 会话 id / 意识 id。 */
    refId: text('ref_id').notNull(),
    /** 出生会话(生成/导入它的会话;画廊 ref 等无会话语境时为空)。 */
    originSessionId: text('origin_session_id'),
    /** 出生来源类型:'ghost' | 'tool' | 'user' | 'integration'。 */
    originKind: text('origin_kind'),
    /** 出生来源 id:意识 id / 工具名 / 集成名。 */
    originId: text('origin_id'),
    /** 人类可读备注(画廊 caption = 生成时的描述文本等);可空。 */
    label: text('label'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    /** 归属校验与回收器"谁还引用它"主路径。 */
    byHash: index('media_refs_hash_idx').on(t.hash),
    /** 业务删除自己名下 ref 的主路径(删会话/卸载意识)。 */
    byRef: index('media_refs_ref_idx').on(t.refKind, t.refId),
  }),
);

