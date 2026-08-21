/**
 * latestMessageText — 取会话 user / assistant 消息的纯文本素材。
 *
 * 与 messages:list 同一套可见性口径:只取 clearedAt 之后、未被 rewind 软删的消息,
 * 否则 /clear 过的会话会读到本该隐藏的旧内容。排序同样对齐 messages:list:
 * createdAt 相同(同毫秒批量落库)时以 rowid 保持写入顺序,避免 transcript 错序。
 *
 * 消费方:sessionTaskSummary(置顶卡片摘要素材,用 latestMessage)、maker-ipc/title
 * (重命名输入框 Magic 按钮按对话内容重起标题,用 regenerateTitleMaterial)。
 * 放在 localDb 层而不是 sessionTaskSummary,是为避免 maker-ipc → sessionTaskSummary
 * → maker-host/index → maker-ipc 的静态模块环。
 */

import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';

import { extractText } from '../sessionTaskSummary.logic.js';

import { getDbClient } from './client/current.js';
import { extractMessagePreview } from './mapper.js';
import { messages, sessions } from './schema.js';
import {
  isTitleTurnBoundaryUser,
  isVisibleTitleUser,
  selectRecentTitleMessages,
  type TitleMessageCandidate,
} from './latestMessageText.logic.js';

export interface LatestMessage {
  text: string;
  /** unix ms;无该角色可见消息时为 null。调用方可据此判断 user/assistant 是否同轮。 */
  createdAt: number | null;
}

/** regenerateTitleMaterial 的单条素材:带角色的纯文本消息。
 *  rowid 用于精确判断某行是否落在最近窗口内(同毫秒批量落库时时间戳无法区分行)。 */
export interface RecentMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: number | null;
  rowid: number;
}

/** 对话开场素材:无开场时 text 为空串、rowid 为 null。 */
export interface OpeningMessage {
  text: string;
  createdAt: number | null;
  rowid: number | null;
}

/** Magic 重命名的素材包:对话开场 + 最近窗口。 */
export interface RegenerateTitleMaterial {
  /** 第一条非空文本的用户消息(对话开场,通常最能定义会话主题)。 */
  opening: OpeningMessage;
  /** 最近 limit 条非空文本的 user/assistant 消息,时间正序(最新一条在末尾)。 */
  recent: RecentMessage[];
}

/** 同毫秒 tie-breaker:与 messages:list 一致,用 SQLite rowid 保持写入顺序。 */
const messageRowid = sql<number>`rowid`;
/** JOIN sessions 时必须限定表名,否则 SQLite 报 no such column: rowid。 */
const joinedMessageRowid = sql<number>`"messages"."rowid"`;

export interface LatestVisiblePreviewRow {
  clientId: string;
  content: string;
  role: string;
}

/**
 * 与 sessions:list 同一口径的最近可见 user/assistant 行。
 * clear 边界与消息放进同一条 JOIN,避免先读旧 clearedAt 再选出清空前的行。
 */
export async function latestVisiblePreviewRow(
  sessionId: string,
): Promise<LatestVisiblePreviewRow | null> {
  const [row] = await getDbClient()
    .drizzle.select({
      clientId: messages.clientId,
      content: messages.content,
      role: messages.role,
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(
      and(
        eq(messages.sessionId, sessionId),
        sql`${messages.role} IN ('user', 'assistant')`,
        isNull(messages.rewindAt),
        sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.autoResume') IS NOT 1)`,
        or(isNull(sessions.clearedAt), gt(messages.createdAt, sessions.clearedAt)),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(joinedMessageRowid))
    .limit(1);
  return row ?? null;
}

/** 最近可见消息的列表预览;无可见行或抽不出正文时为 null,与 sessions:list 一致。 */
export async function latestVisiblePreview(sessionId: string): Promise<string | null> {
  const row = await latestVisiblePreviewRow(sessionId);
  return extractMessagePreview(row?.content, row?.role);
}

/** 开场扫描窗口:会话开头可能连续多条纯附件等抽不出正文的消息,按序多看一批。 */
const OPENING_SCAN_LIMIT = 15;

/** 标题素材分页扫描边界:按 128 行翻页，最多读取 4096 条原始 user/assistant 行。 */
const TITLE_MESSAGE_PAGE_SIZE = 128;
const TITLE_MESSAGE_MAX_RAW_SCAN = 4096;

interface RecentTitleDbRow {
  role: string;
  content: string;
  toolUseId: string | null;
  createdAt: number;
  agentMeta: string | null;
  rowid: number;
}

function toTitleMessageCandidate(row: RecentTitleDbRow): TitleMessageCandidate | null {
  const role = row.role === 'user' ? 'user' : 'assistant';
  const text = extractText(row.content, role);
  if (!text) return null;

  const agentMeta = parseTitleAgentMeta(row.agentMeta);
  return {
    role,
    text,
    createdAt: row.createdAt ?? null,
    rowid: row.rowid,
    toolUseId: row.toolUseId ?? null,
    agentMeta,
  };
}

function parseTitleAgentMeta(raw: string | null): Record<string, unknown> | null {
  let agentMeta: Record<string, unknown> | null = null;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        agentMeta = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed legacy metadata must not make title regeneration fail.
    }
  }
  return agentMeta;
}

function selectionStartsAtCompleteTurn(
  selected: readonly RecentMessage[],
  candidates: readonly TitleMessageCandidate[],
): boolean {
  const first = selected[0];
  if (!first || first.role !== 'user') return false;
  const source = candidates.find((candidate) => candidate.rowid === first.rowid);
  return source ? isTitleTurnBoundaryUser(source.agentMeta) : false;
}

/** 读会话 clearedAt(/clear 可见性边界)。会话不存在 → null。 */
async function sessionClearedAt(sessionId: string): Promise<number | null> {
  const [sess] = await getDbClient()
    .drizzle.select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return sess?.clearedAt ?? null;
}

export async function latestMessage(
  sessionId: string,
  role: 'user' | 'assistant',
): Promise<LatestMessage> {
  const db = getDbClient().drizzle;
  const clearedAt = await sessionClearedAt(sessionId);
  const conds = [
    eq(messages.sessionId, sessionId),
    eq(messages.role, role),
    isNull(messages.rewindAt),
  ];
  if (clearedAt != null) conds.push(gt(messages.createdAt, clearedAt));
  const [row] = await db
    .select({ content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  return { text: extractText(row?.content, role), createdAt: row?.createdAt ?? null };
}

export async function latestMessageText(
  sessionId: string,
  role: 'user' | 'assistant',
): Promise<string> {
  return (await latestMessage(sessionId, role)).text;
}

/**
 * 最近 `limit` 条有效的 user / assistant 素材,时间正序。`limit` 现在按真实
 * conversation turn 收口后的有效消息计数,不是原始 DB 行数；一个 turn 中的
 * assistant 施工播报不会再挤掉用户消息。工具行等抽不出正文的消息会被跳过,
 * DB 侧扫描更大的原始窗口后再做确定性筛选。
 */
async function recentMessagesWithClearedAt(
  sessionId: string,
  limit: number,
  clearedAt: number | null,
  snapshotUpperRowid: number | null,
  latestTurnIsInFlight: boolean,
): Promise<RecentMessage[]> {
  if (limit <= 0 || snapshotUpperRowid == null) return [];
  const db = getDbClient().drizzle;
  const conds = [
    eq(messages.sessionId, sessionId),
    inArray(messages.role, ['user', 'assistant']),
    isNull(messages.rewindAt),
  ];
  if (clearedAt != null) conds.push(gt(messages.createdAt, clearedAt));
  let cursor: { createdAt: number; rowid: number } | null = null;
  let scannedRawRows = 0;
  const candidates: TitleMessageCandidate[] = [];
  const knownToolUseIds = new Set<string>();
  const checkedParentIds = new Set<string>();
  let selected: RecentMessage[] = [];

  while (scannedRawRows < TITLE_MESSAGE_MAX_RAW_SCAN) {
    const pageLimit = Math.min(
      TITLE_MESSAGE_PAGE_SIZE,
      TITLE_MESSAGE_MAX_RAW_SCAN - scannedRawRows,
    );
    const cursorCond = cursor
      ? or(
          lt(messages.createdAt, cursor.createdAt),
          and(eq(messages.createdAt, cursor.createdAt), lt(messageRowid, cursor.rowid)),
        )
      : undefined;
    const rows = (await db
      .select({
        role: messages.role,
        content: messages.content,
        toolUseId: messages.toolUseId,
        createdAt: messages.createdAt,
        agentMeta: messages.agentMeta,
        rowid: messageRowid,
      })
      .from(messages)
      .where(
        and(...conds, lte(messageRowid, snapshotUpperRowid), ...(cursorCond ? [cursorCond] : [])),
      )
      .orderBy(desc(messages.createdAt), desc(messageRowid))
      .limit(pageLimit)) as RecentTitleDbRow[];

    if (rows.length === 0) break;
    scannedRawRows += rows.length;
    cursor = {
      createdAt: rows[rows.length - 1].createdAt,
      rowid: rows[rows.length - 1].rowid,
    };

    const pageCandidates = rows
      .map(toTitleMessageCandidate)
      .filter((candidate): candidate is TitleMessageCandidate => candidate !== null);
    candidates.push(...pageCandidates);
    for (const candidate of pageCandidates) {
      if (candidate.toolUseId) knownToolUseIds.add(candidate.toolUseId);
    }

    const uncheckedParentIds: string[] = [];
    for (const candidate of pageCandidates) {
      const parentUuid = candidate.agentMeta?.parentUuid;
      if (typeof parentUuid !== 'string' || !parentUuid || checkedParentIds.has(parentUuid)) {
        continue;
      }
      checkedParentIds.add(parentUuid);
      uncheckedParentIds.push(parentUuid);
    }
    if (uncheckedParentIds.length > 0) {
      const toolRows = await db
        .select({ toolUseId: messages.toolUseId })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sessionId),
            inArray(messages.role, ['tool_use', 'tool_result']),
            inArray(messages.toolUseId, uncheckedParentIds),
            isNull(messages.rewindAt),
            lte(messageRowid, snapshotUpperRowid),
            ...(clearedAt != null ? [gt(messages.createdAt, clearedAt)] : []),
          ),
        );
      for (const row of toolRows) {
        if (row.toolUseId) knownToolUseIds.add(row.toolUseId);
      }
    }

    selected = selectRecentTitleMessages(candidates, limit, knownToolUseIds, latestTurnIsInFlight);
    // A page can start in the middle of an older turn. Do not stop on an
    // assistant-only or steer-only partial group merely because it fills the
    // effective budget; continue until the oldest selected group has its real
    // user boundary, the snapshot ends, or the raw safety cap is reached.
    if (selected.length >= limit && selectionStartsAtCompleteTurn(selected, candidates)) break;
    if (rows.length < pageLimit) break;
  }

  return selected;
}

/** 第一条非空文本的用户消息;开头连续附件超过扫描窗口时退化为空(调用方按无开场处理)。 */
async function firstUserMessageWithClearedAt(
  sessionId: string,
  clearedAt: number | null,
  snapshotUpperRowid: number | null,
): Promise<OpeningMessage> {
  if (snapshotUpperRowid == null) return { text: '', createdAt: null, rowid: null };
  const db = getDbClient().drizzle;
  const conds = [
    eq(messages.sessionId, sessionId),
    eq(messages.role, 'user'),
    isNull(messages.rewindAt),
    lte(messageRowid, snapshotUpperRowid),
  ];
  if (clearedAt != null) conds.push(gt(messages.createdAt, clearedAt));
  const rows = await db
    .select({
      content: messages.content,
      createdAt: messages.createdAt,
      rowid: messageRowid,
      agentMeta: messages.agentMeta,
    })
    .from(messages)
    .where(and(...conds))
    .orderBy(asc(messages.createdAt), asc(messageRowid))
    .limit(OPENING_SCAN_LIMIT);
  for (const row of rows) {
    if (!isVisibleTitleUser(parseTitleAgentMeta(row.agentMeta))) continue;
    const text = extractText(row.content, 'user');
    if (text) return { text, createdAt: row.createdAt ?? null, rowid: row.rowid };
  }
  return { text: '', createdAt: null, rowid: null };
}

/**
 * Magic 重命名的素材一次取齐:clearedAt 只查一次,开场与最近窗口两个查询并发。
 * (拆成两个独立导出会让调用方并发时重复查 clearedAt,review 反馈已合并。)
 */
export async function regenerateTitleMaterial(
  sessionId: string,
  recentLimit: number,
  latestTurnIsInFlight: boolean | (() => boolean) = false,
): Promise<RegenerateTitleMaterial> {
  const readLatestTurnIsInFlight = (): boolean =>
    typeof latestTurnIsInFlight === 'function'
      ? latestTurnIsInFlight() === true
      : latestTurnIsInFlight;
  // Sample the in-memory turn state and submit the rowid snapshot query before
  // the first await. A turn that starts later receives a larger rowid and cannot
  // enter this material snapshot; a turn already pending is filtered below.
  const inFlightBeforeSnapshot = readLatestTurnIsInFlight();
  const snapshotPromise = getDbClient()
    .drizzle.select({ rowid: sql<number | null>`max(${messageRowid})` })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .get();
  const inFlightAfterSnapshotSubmit = readLatestTurnIsInFlight();
  const [clearedAt, snapshot] = await Promise.all([
    sessionClearedAt(sessionId),
    snapshotPromise,
  ]);
  const snapshotUpperRowid = snapshot?.rowid ?? null;
  const snapshotLatestTurnIsInFlight =
    inFlightBeforeSnapshot || inFlightAfterSnapshotSubmit;
  const [recent, opening] = await Promise.all([
    recentMessagesWithClearedAt(
      sessionId,
      recentLimit,
      clearedAt,
      snapshotUpperRowid,
      snapshotLatestTurnIsInFlight,
    ),
    firstUserMessageWithClearedAt(sessionId, clearedAt, snapshotUpperRowid),
  ]);
  return { recent, opening };
}
