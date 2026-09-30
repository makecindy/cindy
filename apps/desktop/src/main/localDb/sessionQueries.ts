import { normalizeTaskTags } from '@cindy/maker-shared';
/** Shared database reads for local IPC, remote IPC and internal callers. */
import { desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { DbClient } from './client/DbClient';
import { sessions } from './schema';
import { LIST_PREVIEW_EXTRACT_SQL, LATEST_VISIBLE_PREVIEW_FILTER_SQL } from './sessionListProjection';
import { sessionToCamel, type SessionRowWithCount } from './mapper';
import { projectSessionContextWindow, type ContextWindowSession } from '../../shared/sessionContextWindow';

// Drizzle strips table names from Column chunks in single-table SELECT projections,
// including nested SQL. An unqualified "id" inside the messages subquery resolves
// to messages.id, not the outer session: wrong results and a full messages scan.
// Identifier fragments retain the outer scope in both single-table and joined reads.
const OUTER_SESSION_ID_SQL = sql`${sql.identifier('sessions')}.${sql.identifier('id')}`;
const OUTER_SESSION_CLEARED_AT_SQL = sql`${sql.identifier('sessions')}.${sql.identifier('cleared_at')}`;

/**
 * list / get / update 共用的 messageCount：标量子查询。口径是该会话的全部 messages 行数，
 * 不过滤 role / rewind_at / cleared_at（口径要动就得连手机端卡片上的「N 条消息」一起想，
 * 见 maker-shared/sessionList 的 messageCountLabel）。
 *
 * 标量子查询没有 LEFT JOIN 补的那一行空行，无匹配时聚合返回 0，所以这里用 `count(*)` 是
 * 安全的。仍然只扫 idx_messages_session_created（session_id 是首列），不回表。
 *
 * 旧的一段式 LEFT JOIN + GROUP BY 不能图快改用 `count(*)`：LEFT JOIN 会给空会话补一行，
 * 数出 1 而非 0，打歪 sidebar 的「单空 New Maker 草稿」判定。list 已改成两段式；get/update
 * 也走同一条标量子查询，避免切任务时把几万行 join 进单行快照。
 *
 * 由 sessionListMessageCount 回归测试守护。
 *
 * list_message_count 已回填时走缓存列，跳过 messages 扫描。未回填时 count(*) 精确总数
 * （侧栏文案仍用 messageCountLabel 把 ≥1001 显示成 1000+；wire `_count.messages` 保持精确）。
 * 非 NULL 即信任：绕过 createMessage 的 messages 增删必须同步投影。
 * import / treeRehydrate 置空三列；turn/review 租约、context.rebuild、createMessage 只置空计数。
 */
const SESSION_MESSAGE_COUNT_SQL = sql<number>`(
  CASE
    WHEN ${sessions.listMessageCount} IS NOT NULL THEN ${sessions.listMessageCount}
    ELSE (
      SELECT count(*) FROM messages m WHERE m.session_id = ${OUTER_SESSION_ID_SQL}
    )
  END
)`.as('message_count');

/**
 * sidebar-card-mode：最近一条可见 user/assistant 的预览抽出 / role。
 * list_preview 已回填时 CASE 短路，不碰 messages。否则 SQL 侧 json_extract 纯文本，
 * 不把整段 content 跨 worker RPC。autoResume 只检查 user 行的 agent_meta。
 */
const LATEST_MSG_EXTRACT_SQL = sql<string | null>`(
  CASE
    WHEN ${sessions.listPreview} IS NOT NULL THEN NULL
    ELSE (
      SELECT ${sql.raw(LIST_PREVIEW_EXTRACT_SQL)} FROM messages m
      WHERE m.session_id = ${OUTER_SESSION_ID_SQL}
        AND ${sql.raw(LATEST_VISIBLE_PREVIEW_FILTER_SQL)}
        AND (${OUTER_SESSION_CLEARED_AT_SQL} IS NULL OR m.created_at > ${OUTER_SESSION_CLEARED_AT_SQL})
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
    )
  END
)`.as('latest_message_extract');
const LATEST_MSG_ROLE_SQL = sql<string | null>`(
  CASE
    WHEN ${sessions.listPreviewRole} IS NOT NULL THEN ${sessions.listPreviewRole}
    ELSE (
      SELECT m.role FROM messages m
      WHERE m.session_id = ${OUTER_SESSION_ID_SQL}
        AND ${sql.raw(LATEST_VISIBLE_PREVIEW_FILTER_SQL)}
        AND (${OUTER_SESSION_CLEARED_AT_SQL} IS NULL OR m.created_at > ${OUTER_SESSION_CLEARED_AT_SQL})
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
    )
  END
)`.as('latest_message_role');

/** {@link selectSessionListRows} 的行形状——与 sessionToCamel 的入参对齐。 */
export interface SessionListRow {
  session: typeof sessions.$inferSelect;
  messageCount: number;
  latestMessageExtract: string | null;
  latestMessageRole: string | null;
  tagsJson?: string;
}

function sessionReadSelection() {
  return {
    session: sessions,
    tagsJson:
      sql<string>`(SELECT coalesce(json_group_array(json_object('id',t.id,'name',t.name,'nameCustomized',json(CASE WHEN t.name_customized THEN 'true' ELSE 'false' END),'color',t.color,'favoriteOrder',t.favorite_order,'sortOrder',t.sort_order,'revision',t.revision)), '[]') FROM task_tags t JOIN session_task_tags st ON st.tag_id=t.id WHERE st.session_id=${OUTER_SESSION_ID_SQL})`.as(
        'tags_json',
      ),
    messageCount: SESSION_MESSAGE_COUNT_SQL,
    latestMessageExtract: LATEST_MSG_EXTRACT_SQL,
    latestMessageRole: LATEST_MSG_ROLE_SQL,
  };
}

export function flattenSessionReadRow(row: SessionListRow): SessionRowWithCount {
  return { ...row.session,
    tags: normalizeTaskTags(JSON.parse(row.tagsJson ?? '[]')), messageCount: row.messageCount,
    latestMessageExtract: row.latestMessageExtract, latestMessageRole: row.latestMessageRole };
}

export function projectSessionReadResult(
  row: SessionRowWithCount,
  resolve?: (session: ContextWindowSession) => number | null,
) {
  return sessionToCamel(projectSessionContextWindow(row, resolve));
}

/** No settled cache: every read observes the database and uses the same projection. */
export async function selectSessionsByIds(db: DbClient['drizzle'], ids: readonly string[]): Promise<SessionRowWithCount[]> {
  const unique = [...new Set(ids)];
  const result = new Map<string, SessionRowWithCount>();
  for (let offset = 0; offset < unique.length; offset += 256) {
    const rows = await db.select(sessionReadSelection()).from(sessions)
      .where(inArray(sessions.id, unique.slice(offset, offset + 256)));
    for (const row of rows) result.set(row.session.id, flattenSessionReadRow(row));
  }
  return unique.flatMap((id) => { const row = result.get(id); return row ? [row] : []; });
}

export async function selectSessionWithCount(db: DbClient['drizzle'], id: string): Promise<SessionRowWithCount | undefined> {
  return (await selectSessionsByIds(db, [id]))[0];
}

/**
 * sessions:list 的行查询——**两段式**：CTE 先按排序取够 `cap` 个 id，主查询只对这批行算
 * messageCount 与 preview。
 *
 * 为什么不能沿用一段式的 `LEFT JOIN messages + GROUP BY`：那个形状下 `LIMIT` 在 GROUP BY
 * **之后**才生效，于是每个候选会话的全部消息都要参与聚合，成本与"最终只要 1000 行"无关。
 * 4.7GB / 111 万条消息的真实库上，把聚合面从 1743 个会话收窄到 1000 个，热缓存 104ms →
 * 54ms。会话越多、limit 占比越小，收益越大。
 *
 * 用单条 CTE 而不是"先查 id 再 IN (...)"两次往返，有两个理由：
 *   1. 一致性——两次查询之间会话可能被删/改状态，第二段就会比第一段少行，列表凭空少一条。
 *      CTE 是单条语句、单一致性快照。
 *   2. 参数——`IN (...)` 要绑 cap 个参数（当前 MAX_LIMIT=1000），CTE 只绑一个 limit。
 *
 * messageCount 在这里是**标量子查询**里的 `count(*)`：无匹配行时聚合返回 0，不存在 LEFT JOIN
 * 那个"空会话数出 1"的坑。它同样只扫 idx_messages_session_created，不回表。
 *
 * @param where 行过滤条件，同时作用于 CTE 与主查询（CTE 决定取哪些、主查询决定算哪些）。
 * @param cap   取前 N 行；`null` = 不限（置顶补齐分支用，pinned 行数天然很少）。
 */
export function selectSessionListRows(
  db: DbClient['drizzle'],
  where: SQL | undefined,
  cap: number | null,
): Promise<SessionListRow[]> {
  const pickedBase = db.select({ id: sessions.id }).from(sessions).where(where);
  const picked = db
    .$with('picked')
    .as(
      cap === null
        ? pickedBase.orderBy(desc(sessions.updatedAt))
        : pickedBase.orderBy(desc(sessions.updatedAt)).limit(cap),
    );
  return db
    .with(picked)
    .select(sessionReadSelection())
    .from(sessions)
    .innerJoin(picked, eq(picked.id, sessions.id))
    .where(where)
    .orderBy(desc(sessions.updatedAt));
}
