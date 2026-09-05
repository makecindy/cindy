/**
 * chatHistorySearch.ts —— 跨 session 聊天记录混合检索引擎(FTS5 + 向量 RRF 融合)。
 *
 * 给 cindy_helper 的 search_chat_history MCP 工具用(经 mcp-providers.ts 注入)。
 * 工具层只做 schema 校验 + payload 整形, 真正的检索逻辑在这里, 因为它要同时碰
 * SQLite(messages_fts / 向量表 / 上下文窗口)和 EmbeddingService(query embedding),
 * 这两者只在 desktop main 进程存在。
 *
 * 两路召回 + 融合:
 *   1. FTS arm —— messages_fts(0017 迁移, 全量历史、无 cutoff; 0066 起仅索引
 *      user / assistant / ask_user / plan_review 四类 role, tool_result 等
 *      工具输出不进索引——与 UI 会话搜索、语义嵌入的白名单对齐)。把自然语言
 *      query 拆成 token 做 OR 召回, bm25 排序。永远可用, 是检索地基。
 *   2. vector arm —— chat_messages_vec_v1(0034 迁移, voyage-4/1024d)。增益项:
 *      sqlite-vec 未加载 / 聊天语义索引运行时未启用 / 向量表空 / embedding host
 *      未起 / query 嵌入失败 / KNN 失败 —— 任一条件命中即**静默跳过**(记 skipReason,
 *      绝不冒泡), 整体退化为纯 FTS。这是产品硬约束: 没开 embedding 也要能搜。
 *   3. RRF 融合 —— Reciprocal Rank Fusion, 无需归一化两路异构分数, 鲁棒。
 *
 * 每条命中带同 session 内前后 ±contextRadius 条邻居(含命中本身), 给出连贯对话片段。
 *
 * 复用:
 *   - 向量 join SQL 形态参照 scripts/dev-embed-search.mjs(已验证): vec rowid ⇄
 *     embedding_jobs.rowid ⇄ messages.id。query 嵌入用 EmbeddingService.embedSync。
 *   - 模型/表/维度常量来自 embedders/chat-history-embedder.ts(写入侧单一事实源)。
 *   - 上下文窗口 / content 解析复用 mapper.ts 的 messageToCamel(走 drizzle 驼峰行)。
 */

import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';

import type {
  SearchChatHistoryArgs,
  SearchChatHistoryResult,
  SearchChatHistoryHit,
  SearchChatHistoryContextMessage,
  SearchChatHistorySessionMeta,
  HistoryRole,
} from '@cindy/mcps';

import { getDbClient } from './client/current';
import { messages as messagesTable, sessions as sessionsTable } from './schema';
import { messageToCamel } from './mapper';
import { fuseRRF, buildMessagesFtsMatch, extractMessagesFtsTokens } from './chatHistorySearch.pure';
import { buildSnippetFromContent, SNIPPET_SOURCE_MAX_CHARS } from './cjkSeg';
import { resolveStoredWorkingDirCandidates } from './workingDirHistoryFilter';
import { createLogger } from '../logger';
import { getEmbeddingService } from '../embedding-host';
import {
  CHAT_EMBED_MODEL_ID,
  CHAT_VEC_TABLE,
  isChatEmbeddingEnabled,
} from '../embedders/chat-history-embedder';
import type { SessionSource } from '../../shared/sessionSource.js';

const log = createLogger('chat-history-search');

type MessageRow = typeof messagesTable.$inferSelect;
type QueryEmbeddingCache = Map<string, number[]>;

/** 每路 arm 召回候选数(融合前)。 */
const ARM_POOL = 50;
/** 向量 arm over-fetch 倍数: KNN 先多取, 结构化过滤后再截, 避免过滤后不足量。 */
const VEC_OVERFETCH = 5;
/** 融合候选池硬上限 —— offset 游标只在池内翻页; 超出则 poolCapped=true 提示用户缩范围。 */
const FUSE_POOL_CAP = 100;
const MAX_INTERNAL_POOL = 500;

interface ArmRow {
  messageId: string;
  sessionId: string;
  role: string;
  createdAt: number;
  snippet: string | null;
  distance: number | null;
}

/** 单路命中在 metaById 里的聚合形态。 */
interface HitMeta {
  sessionId: string;
  role: string;
  createdAt: number;
  snippet: string | null;
  distance: number | null;
}

type SearchSessionStatus = 'active' | 'archived' | 'deleted';

interface SearchChatHistoryEngineArgs extends SearchChatHistoryArgs {
  /**
   * Optional host-side filters for product entry points that should only expose
   * desktop-visible conversations. MCP callers omit these and keep the original
   * broad history-search behavior.
   */
  sessionSources?: readonly SessionSource[] | null;
  sessionStatuses?: readonly SearchSessionStatus[] | null;
  excludeCleared?: boolean;
  sessionActivityFromMs?: number | null;
  skipVector?: boolean;
  /** Internal over-fetch knobs for conversation-level search. */
  ftsPoolLimit?: number;
  vectorPoolLimit?: number;
  fusePoolLimit?: number;
  queryEmbeddingCache?: QueryEmbeddingCache;
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

/**
 * 混合检索主流程。DbClient 未就绪时 getDbClient 抛 'DbClient not ready',
 * 由 mcp-providers 适配层 catch 后映射成 HOST_NOT_READY errorCode。
 */
export async function searchChatHistoryHybrid(
  args: SearchChatHistoryEngineArgs,
): Promise<SearchChatHistoryResult> {
  // 1) 两路召回(FTS 同步; vector 异步, 失败静默跳过)
  // workdir 候选按 DB 实际拼写解析一次, 两路 arm 复用(见 workingDirHistoryFilter)
  const workdirCandidates =
    args.workdir != null ? await resolveStoredWorkingDirCandidates(args.workdir) : null;
  // 空候选 ⟺ 库里不存在该目录的任何拼写(typo / 已删),必然零命中——在两路
  // arm 之前短路,避免向量 arm 白算一次 query embedding(Codex review)。
  if (workdirCandidates !== null && workdirCandidates.length === 0) {
    return {
      hits: [],
      sessions: {},
      vectorUsed: false,
      vectorSkipReason: 'workdir 过滤在历史库中无匹配目录, 已短路跳过检索。',
      nextOffset: null,
      hasMore: false,
      poolSize: 0,
      poolCapped: false,
    };
  }
  const ftsRows = await runFtsArm(args, workdirCandidates);
  const vec = await runVectorArm(args, workdirCandidates);

  // 2) 按 messageId 聚合元信息(FTS 提供 snippet, vector 提供 distance)
  const metaById = new Map<string, HitMeta>();
  for (const r of vec.rows) {
    metaById.set(r.messageId, {
      sessionId: r.sessionId,
      role: r.role,
      createdAt: r.createdAt,
      snippet: null,
      distance: r.distance,
    });
  }
  for (const r of ftsRows) {
    const e = metaById.get(r.messageId);
    if (e) {
      e.snippet = r.snippet; // 两路都命中 → 补 FTS 高亮, 保留向量 distance
    } else {
      metaById.set(r.messageId, {
        sessionId: r.sessionId,
        role: r.role,
        createdAt: r.createdAt,
        snippet: r.snippet,
        distance: null,
      });
    }
  }

  // 3) RRF 融合排序
  const fused = fuseRRF(
    ftsRows.map((r) => r.messageId),
    vec.rows.map((r) => r.messageId),
  );

  // 4) 物化候选池(offset 游标作用域)+ 切页
  const fusePoolLimit = clampInternalPoolLimit(args.fusePoolLimit, FUSE_POOL_CAP);
  const poolCapped = fused.length > fusePoolLimit;
  const pool = poolCapped ? fused.slice(0, fusePoolLimit) : fused;
  if (poolCapped) {
    log.info(
      JSON.stringify({ event: 'chatHistorySearch.poolCapped', total: fused.length, cap: fusePoolLimit }),
    );
  }
  const start = Math.max(0, Math.min(args.offset, pool.length));
  const pageEntries = pool.slice(start, start + args.limit);
  const nextOffset = start + args.limit < pool.length ? start + args.limit : null;

  // radius=0 is the conversation-search hot path. Hydrate the whole page in
  // one worker RPC; callers that need neighbours keep the original window query.
  const anchorContexts =
    args.contextRadius <= 0
      ? await fetchAnchorContexts(pageEntries.map((entry) => entry.messageId))
      : null;

  // 5) 按命中顺序组装上下文窗口
  const hits: SearchChatHistoryHit[] = [];
  for (const fe of pageEntries) {
    const meta = metaById.get(fe.messageId);
    if (!meta) continue; // 理论不会发生(fused 的 id 必来自两路 arm)
    const context =
      anchorContexts?.get(fe.messageId) ??
      (anchorContexts
        ? []
        : await fetchContextWindow(
            fe.messageId,
            meta.sessionId,
            meta.createdAt,
            args.roles,
            args.contextRadius,
          ));
    hits.push({
      messageId: fe.messageId,
      sessionId: meta.sessionId,
      role: meta.role,
      createdAt: meta.createdAt,
      snippet: meta.snippet,
      score: fe.score,
      ftsRank: fe.ftsRank,
      vectorRank: fe.vectorRank,
      vectorDistance: meta.distance,
      context,
    });
  }

  // 6) session 元数据(顶层 map, 避免逐条命中重复)
  const sessions = await fetchSessionsMeta(hits.map((h) => h.sessionId));

  return {
    hits,
    sessions,
    vectorUsed: vec.skipReason === null,
    vectorSkipReason: vec.skipReason,
    nextOffset,
    hasMore: nextOffset !== null,
    poolSize: pool.length,
    poolCapped,
  };
}

// ── FTS arm ──────────────────────────────────────────────────────────────────

async function fetchAnchorContexts(
  anchorIds: readonly string[],
): Promise<Map<string, SearchChatHistoryContextMessage[]>> {
  const uniqueIds = [...new Set(anchorIds)];
  if (uniqueIds.length === 0) return new Map();

  const rows = await getDbClient()
    .drizzle.select()
    .from(messagesTable)
    .where(inArray(messagesTable.id, uniqueIds));

  return new Map(rows.map((row) => [row.id, [rowToContext(row, true)]]));
}

async function runFtsArm(
  args: SearchChatHistoryEngineArgs,
  workdirCandidates: string[] | null,
): Promise<ArmRow[]> {
  const queryTokens = extractMessagesFtsTokens(args.query);
  const match = buildMessagesFtsMatch(args.query, 'OR');
  if (!match) return [];
  const { clause, params } = buildFilterClause(args, workdirCandidates);
  // snippet 从原文 m.content 重建，不用索引侧文本：
  // messages_fts.content 是 cjk_seg 插过空格的形态，直接展示会篡改原文空格
  // （「foo登录bar」多出假空格、「登录 报错」的真空格被吃）。FTS5 无 offsets()，
  // 命中位置由 buildSnippetFromContent 用同一份查询 token 在原文对齐的索引串里重算。
  const sql = `
    SELECT m.id          AS messageId,
           m.session_id  AS sessionId,
           m.role        AS role,
           m.created_at  AS createdAt,
           substr(m.content, 1, ?) AS content
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.message_id
      JOIN sessions s ON s.id = m.session_id
     WHERE messages_fts MATCH ?
       AND ${clause}
     ORDER BY bm25(messages_fts)
     LIMIT ?`;
  const limit = clampInternalPoolLimit(args.ftsPoolLimit, ARM_POOL);
  try {
    const rows = await getDbClient().query<{
      messageId: string;
      sessionId: string;
      role: string;
      createdAt: number;
      content: string;
    }>(sql, [SNIPPET_SOURCE_MAX_CHARS, match, ...params, limit]);
    return rows.map((r) => ({
      messageId: r.messageId,
      sessionId: r.sessionId,
      role: r.role,
      createdAt: r.createdAt,
      snippet: buildSnippetFromContent(r.content, queryTokens),
      distance: null,
    }));
  } catch (e) {
    // token 已中和操作符, 理论不该到这; 兜底记 warn 返空, 让向量 arm 兜。
    log.warn(JSON.stringify({ event: 'chatHistorySearch.fts.error', error: String(e) }));
    return [];
  }
}

// ── vector arm(增益, 任一步失败即静默跳过) ──────────────────────────────────

async function runVectorArm(
  args: SearchChatHistoryEngineArgs,
  workdirCandidates: string[] | null,
): Promise<{ rows: ArmRow[]; skipReason: string | null }> {
  if (args.skipVector === true) {
    return { rows: [], skipReason: '本次请求已禁用语义检索, 仅用 FTS。' };
  }
  // gate 1: 聊天语义索引运行时可用且已启用?
  if (!isChatEmbeddingEnabled()) {
    return { rows: [], skipReason: '聊天记录语义索引未启用, 本次仅用 FTS 全文检索。' };
  }
  // gate 2: sqlite-vec 扩展加载?
  if (!isDbClientVecAvailable()) {
    return { rows: [], skipReason: 'sqlite-vec 扩展未加载, 本次仅用 FTS 全文检索。' };
  }
  // gate 3: 向量表里有无数据? 无 → 用户没开"聊天记录语义索引"或尚未嵌完,
  // 提前短路, 不浪费一次 query embedding 的 API 调用。
  try {
    const probe = await getDbClient().queryOne<{ rowid: number }>(
      `SELECT rowid FROM "${CHAT_VEC_TABLE}" LIMIT 1`,
    );
    if (!probe) {
      return {
        rows: [],
        skipReason: '尚无已嵌入的聊天向量(未开启"聊天记录语义索引"或嵌入未完成), 本次仅用 FTS。',
      };
    }
  } catch (e) {
    return { rows: [], skipReason: `向量表不可用(${errMsg(e)}), 本次仅用 FTS。` };
  }
  // query embedding(必须与写入侧同款模型/维度)
  const cacheKey = queryEmbeddingCacheKey(args.query);
  let queryVec = args.queryEmbeddingCache?.get(cacheKey);
  if (!queryVec) {
    // gate 4: embedding host 起了吗?
    let service: ReturnType<typeof getEmbeddingService>;
    try {
      service = getEmbeddingService();
    } catch {
      return { rows: [], skipReason: 'embedding host 未启动, 本次仅用 FTS。' };
    }
    try {
      const resp = await service.embedSync([args.query], { modelId: CHAT_EMBED_MODEL_ID });
      if (!resp.embeddings || resp.embeddings.length === 0 || resp.embeddings[0].length === 0) {
        return { rows: [], skipReason: 'query 嵌入返回空, 本次仅用 FTS。' };
      }
      queryVec = resp.embeddings[0];
      args.queryEmbeddingCache?.set(cacheKey, queryVec);
    } catch (e) {
      log.warn(JSON.stringify({ event: 'chatHistorySearch.embed.error', error: errMsg(e) }));
      return { rows: [], skipReason: `query 嵌入失败(${errMsg(e)}), 本次仅用 FTS。` };
    }
  }

  // KNN + 结构化过滤:
  // sqlite-vec 硬性要求 LIMIT/'k=?' 直接挂在**纯 vec0 查询**上 —— 一旦把 MATCH 跟
  // JOIN/额外 WHERE 写进同一层, planner 不会把 LIMIT 下推到 KNN cursor, vec0 会抛
  // "A LIMIT or 'k = ?' constraint is required on vec0 knn queries."。
  // 故把纯 KNN 放进 CTE(LIMIT 在此层 = over-fetch, 因为外层过滤会筛掉孤儿/软删/越界
  // rowid), 外层再 JOIN + 套过滤 + 截到 ARM_POOL。CTE 带 LIMIT 也能防 SQLite 把它
  // flatten 回外层重新触发该错误。
  // float32 必须以 Buffer(little-endian)绑定为 BLOB(better-sqlite3 不接受裸 Float32Array)。
  const f32 = Buffer.from(Float32Array.from(queryVec).buffer);
  const { clause, params } = buildFilterClause(args, workdirCandidates);
  const vectorPoolLimit = clampInternalPoolLimit(args.vectorPoolLimit, ARM_POOL);
  const sql = `
    WITH knn AS (
      SELECT rowid, distance
        FROM "${CHAT_VEC_TABLE}"
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?
    )
    SELECT m.id          AS messageId,
           m.session_id  AS sessionId,
           m.role        AS role,
           m.created_at  AS createdAt,
           knn.distance  AS distance
      FROM knn
      JOIN embedding_jobs j ON j.rowid     = knn.rowid
      JOIN messages       m ON m.id        = j.source_id
      JOIN sessions       s ON s.id        = m.session_id
     WHERE ${clause}
     ORDER BY knn.distance
     LIMIT ?`;
  try {
    const rows = await getDbClient().query<{
      messageId: string;
      sessionId: string;
      role: string;
      createdAt: number;
      distance: number;
    }>(sql, [f32, vectorPoolLimit * VEC_OVERFETCH, ...params, vectorPoolLimit]);
    return {
      rows: rows.map((r) => ({
        messageId: r.messageId,
        sessionId: r.sessionId,
        role: r.role,
        createdAt: r.createdAt,
        snippet: null,
        distance: r.distance,
      })),
      skipReason: null, // 跑通即视为 vectorUsed=true(哪怕 0 命中)
    };
  } catch (e) {
    log.warn(JSON.stringify({ event: 'chatHistorySearch.knn.error', error: errMsg(e) }));
    return { rows: [], skipReason: `向量检索失败(${errMsg(e)}), 本次仅用 FTS。` };
  }
}

// ── 结构化过滤(两路 arm 共用; 作用于别名 m=messages, s=sessions) ─────────────

function buildFilterClause(
  args: SearchChatHistoryEngineArgs,
  workdirCandidates: string[] | null,
): { clause: string; params: unknown[] } {
  const conds: string[] = ['m.rewind_at IS NULL'];
  const params: unknown[] = [];
  if (args.sessionIds && args.sessionIds.length > 0) {
    conds.push(`m.session_id IN (${args.sessionIds.map(() => '?').join(',')})`);
    params.push(...args.sessionIds);
  }
  if (args.workdir) {
    // 候选由入口按 DB 实际拼写解析(resolveStoredWorkingDirCandidates); 空集 ⟺
    // 库里不存在该目录的任何拼写, 直接短路为空结果。
    if (!workdirCandidates || workdirCandidates.length === 0) {
      conds.push('1 = 0');
    } else {
      conds.push(`s.working_dir IN (${workdirCandidates.map(() => '?').join(',')})`);
      params.push(...workdirCandidates);
    }
  }
  if (args.fromMs !== null) {
    conds.push('m.created_at >= ?');
    params.push(args.fromMs);
  }
  if (args.toMs !== null) {
    conds.push('m.created_at < ?');
    params.push(args.toMs);
  }
  if (args.agentKind) {
    conds.push('s.agent_kind = ?');
    params.push(args.agentKind);
  }
  if (args.sessionSources && args.sessionSources.length > 0) {
    conds.push(`s.source IN (${args.sessionSources.map(() => '?').join(',')})`);
    params.push(...args.sessionSources);
  }
  if (args.sessionStatuses && args.sessionStatuses.length > 0) {
    conds.push(`s.status IN (${args.sessionStatuses.map(() => '?').join(',')})`);
    params.push(...args.sessionStatuses);
  }
  if (args.sessionActivityFromMs !== undefined && args.sessionActivityFromMs !== null) {
    // 兼容存量 DB 行（旧版 touchUserSendInDb 只写 user_send_at 不 bump updated_at）：
    // 与 conversationSearch.ts 保持一致，用 OR 回退避免漏掉这些行。
    conds.push('(s.updated_at >= ? OR (s.user_send_at IS NOT NULL AND s.user_send_at >= ?))');
    params.push(args.sessionActivityFromMs, args.sessionActivityFromMs);
  }
  if (args.excludeCleared === true) {
    conds.push('(s.cleared_at IS NULL OR m.created_at > s.cleared_at)');
  }
  if (args.roles && args.roles.length > 0) {
    conds.push(`m.role IN (${args.roles.map(() => '?').join(',')})`);
    params.push(...args.roles);
  }
  return { clause: conds.join(' AND '), params };
}

// ── 上下文窗口(走 drizzle, 复用 messageToCamel 的 content/agentMeta 解析) ─────

/**
 * 取命中消息前后各 radius 条同 session、同 role 集合、未软删的邻居(含命中本身),
 * 按 createdAt 升序返回。(createdAt, id) 复合 keyset 处理同毫秒多消息。
 * radius=0 → 只返命中本身。
 */
async function fetchContextWindow(
  anchorId: string,
  sessionId: string,
  anchorCreatedAt: number,
  roles: HistoryRole[] | null,
  radius: number,
): Promise<SearchChatHistoryContextMessage[]> {
  const db = getDbClient().drizzle;

  const anchorRows = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, anchorId))
    .limit(1);
  if (anchorRows.length === 0) return [];
  const anchorRow = anchorRows[0];
  if (radius <= 0) return [rowToContext(anchorRow, true)];

  const roleCond =
    roles && roles.length > 0 ? [inArray(messagesTable.role, roles)] : [];

  // 命中之前(更早): created_at < anchor 或 (= anchor 且 id < anchorId), 倒序取 radius
  const before = await db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.sessionId, sessionId),
        isNull(messagesTable.rewindAt),
        ...roleCond,
        or(
          lt(messagesTable.createdAt, anchorCreatedAt),
          and(eq(messagesTable.createdAt, anchorCreatedAt), lt(messagesTable.id, anchorId)),
        ),
      ),
    )
    .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
    .limit(radius);

  // 命中之后(更晚): created_at > anchor 或 (= anchor 且 id > anchorId), 正序取 radius
  const after = await db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.sessionId, sessionId),
        isNull(messagesTable.rewindAt),
        ...roleCond,
        or(
          gt(messagesTable.createdAt, anchorCreatedAt),
          and(eq(messagesTable.createdAt, anchorCreatedAt), gt(messagesTable.id, anchorId)),
        ),
      ),
    )
    .orderBy(asc(messagesTable.createdAt), asc(messagesTable.id))
    .limit(radius);

  const ordered = [...before.reverse(), anchorRow, ...after];
  return ordered.map((r) => rowToContext(r, r.id === anchorId));
}

/**
 * drizzle message 行 → 上下文消息。content/agentMeta 复用 messageToCamel 的解析,
 * 时间戳保留 unix ms(由 tool 层统一转 ISO), 额外带 rewindAt + isHit。
 */
function rowToContext(row: MessageRow, isHit: boolean): SearchChatHistoryContextMessage {
  const camel = messageToCamel(row);
  return {
    id: camel.id,
    sessionId: camel.sessionId,
    role: camel.role,
    content: camel.content,
    toolUseId: camel.toolUseId,
    agentMeta: camel.agentMeta,
    createdAt: row.createdAt,
    rewindAt: row.rewindAt,
    isHit,
  };
}

// ── session 元数据 ───────────────────────────────────────────────────────────

async function fetchSessionsMeta(
  sessionIds: string[],
): Promise<Record<string, SearchChatHistorySessionMeta>> {
  const uniq = [...new Set(sessionIds)];
  if (uniq.length === 0) return {};
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      id: sessionsTable.id,
      workingDir: sessionsTable.workingDir,
      agentKind: sessionsTable.agentKind,
      title: sessionsTable.title,
    })
    .from(sessionsTable)
    .where(inArray(sessionsTable.id, uniq));
  const out: Record<string, SearchChatHistorySessionMeta> = {};
  for (const r of rows) {
    out[r.id] = { workingDir: r.workingDir, agentKind: r.agentKind, title: r.title };
  }
  return out;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isDbClientVecAvailable(): boolean {
  try {
    return getDbClient().vecAvailable;
  } catch {
    return false;
  }
}

function clampInternalPoolLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), MAX_INTERNAL_POOL));
}

function queryEmbeddingCacheKey(query: string): string {
  return `${CHAT_EMBED_MODEL_ID}\0${query}`;
}
