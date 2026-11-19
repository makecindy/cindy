/**
 * The local history view reader (moved from localDb/ipc/messages.ts, 2026-11-17): the page reader
 * `createHistoryViewReader` is given over the owner database, with list, outline, hydrate, validate,
 * revision and anchor as the desktop wrote them. Without Electron, so the Node Host binds the same
 * reader. What differs by process comes in as ports: whether a turn is still settling (`running`),
 * the in-flight rows (`live`), whether the caller is a device-link peer (`isDeviceLinkCaller`), the
 * external history import before a page (`importBeforeList`) and the task image restoration
 * (`restoreTaskImages`). The last two pull Electron in on the desktop; absent, nothing is imported
 * and rows are returned as read.
 *
 * `readPriorUserRoundCost` (moved from messages.ts unchanged, 2026-11-18) lives here too: the cost
 * already recorded in the visible user round, which turn cost recording adds to the final message.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { supplementalConversationEstimates } from '@cindy/maker-shared/usage-cost-details';
import { historyOutlineContent, historyOutlineContentStamp, withHistoryArtifacts } from './historyViewOutline';
import { getDbClient, getCurrentDbClientSnapshot } from '../client/current';
import type { DbClient } from '../client/DbClient';
import { messages, sessions } from '../schema';
import { messageRowid } from '../retriedUserTurnSupersede.js';
import { messageToCamel } from '../mapper';
import { parseAgentMetaRecord } from '../messageMutations.js';
import { throwIpcError, requireString } from '../../utils/ipcValidate';
import { recoverGeneratedImagesForHistory } from '../../cindy-media/generatedImageRecovery';
import type { restoreTaskImageRows } from '../../cindy-media/taskImageDelivery';
import { buildTurnUsageDetails, normalizeTurnUsageDetails } from '../../../shared/turnUsageDetails.js';
import {
  addCompatibleRegionalMoney,
  asValueEstimateMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  type RegionalMoney,
} from '../../../shared/regionalMoney.js';
import type { Message } from '../../../renderer/lib/ccAgent.types';
import { createHistoryViewReader } from './historyViewReader';

type MessageRow = typeof messages.$inferSelect;
type MessageRowWithRowid = MessageRow & { rowid: number };

export interface LocalHistoryReadPorts {
  /** Before an unpaged read: the desktop's external history import (runMessagesListImportSideEffects). */
  importBeforeList?(sessionId: string, opts: { deviceLinkFirstPage: boolean }): Promise<void>;
  /** Local task images on durable assistant rows (the desktop's restoreTaskImageRows). */
  restoreTaskImages?: typeof restoreTaskImageRows;
}

export interface LocalHistoryViewReaderPorts extends LocalHistoryReadPorts {
  /** The turn has not settled yet (the desktop: isSessionTurnPendingCompletion). Read on every call. */
  running(sessionId: string): boolean;
  /** Rows of the turn not yet in the database (the desktop: getSessionThinkingSnapshots). Read on every call. */
  live(sessionId: string): Message[];
  /** The call comes from a device-link peer (the desktop: isDeviceLinkInvoke). */
  isDeviceLinkCaller?(): boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Skip silent-stop autoResume user rows without letting one bad historical
 * agent_meta blob fail the whole page query. SQLite may evaluate
 * json_extract even when a sibling OR json_valid(...) = 0 is already true.
 */
function notAutoResumeAgentMetaSql() {
  return sql`(${messages.agentMeta} IS NULL OR CASE WHEN json_valid(${messages.agentMeta}) THEN json_extract(${messages.agentMeta}, '$.autoResume') END IS NOT 1)`;
}

/**
 * The already-recorded cost segments for the visible user round immediately
 * before an assistant message. `turnCostUsd` remains deliberately segment
 * scoped; callers use this value only to produce a user-facing round total.
 */
export interface PriorUserRoundCost {
  additionalCosts?: RegionalMoney[];
  money: RegionalMoney | null;
  costUsd: number;
  hasEstimatedValue: boolean;
  /** 本轮是该任务（或 /clear 之后）第一条真实用户请求。 */
  isFirstUserRound?: boolean;
}

/** `readMessagesList` of the desktop, with its two process-specific steps as ports. */
export function createReadMessagesList(ports: LocalHistoryReadPorts) {
  return async function readMessagesList(sessionId: unknown, opts: unknown, skipImport = false, outline = false) {
    const sid = requireString(sessionId, 'sessionId');
    const limit = outline ? 1000 : clampLimit((opts as { limit?: number } | undefined)?.limit);
    const before = (opts as { before?: string } | undefined)?.before;
    const beforeTs = (opts as { beforeTs?: number } | undefined)?.beforeTs;
    const after = (opts as { after?: string } | undefined)?.after;
    const imageDbClient = getDbClient();
    const db = imageDbClient.drizzle;
    if (!before && beforeTs == null && !after && !outline) {
      void recoverGeneratedImagesForHistory(sid).catch(() => undefined);
    }

    // 外部历史导入(Codex rollout / Claude transcript):device-link 隧道调用
    // 只在首页请求跑(分页跳过,#318 性能语义;首页判定 = 无任何分页游标),
    // 覆盖「被控端从未本机打开该会话」的导入缺口。
    if (!skipImport) await ports.importBeforeList?.(
      sid,
      {
        deviceLinkFirstPage: !before && beforeTs == null && !after,
      },
    );

    let beforeCursor: { createdAt: number; rowid: number } | null = null;
    let afterCursor: { createdAt: number; rowid: number } | null = null;
    let beforeMs: number | null = null;
    if (typeof before === 'string' && before) {
      const beforeRow = await db
        .select({ createdAt: messages.createdAt, rowid: messageRowid })
        .from(messages)
        .where(eq(messages.id, before))
        .limit(1);
      if (beforeRow.length > 0) {
        beforeCursor = beforeRow[0];
      }
    } else if (typeof beforeTs === 'number' && Number.isFinite(beforeTs)) {
      beforeMs = beforeTs;
    }
    if (!beforeCursor && beforeMs === null && typeof after === 'string' && after) {
      const afterRow = await db
        .select({ createdAt: messages.createdAt, rowid: messageRowid })
        .from(messages)
        .where(and(eq(messages.id, after), eq(messages.sessionId, sid)))
        .limit(1);
      if (afterRow.length > 0) afterCursor = afterRow[0];
    }

    // /clear：过滤 createdAt > session.clearedAt，本地 DB 旧消息也遵守 clearedAt 边界
    const sessionRow = await db
      .select({ clearedAt: sessions.clearedAt })
      .from(sessions)
      .where(eq(sessions.id, sid))
      .limit(1);
    const clearedAtMs = sessionRow[0]?.clearedAt ?? null;

    // rewind-session：list 永远过滤 rewind_at IS NULL —— 被 rewind 软删的消息在 UI 上不可见
    const conds: (SQL<unknown> | undefined)[] = [
      eq(messages.sessionId, sid),
      isNull(messages.rewindAt),
    ];
    if (beforeCursor) {
      conds.push(
        or(
          lt(messages.createdAt, beforeCursor.createdAt),
          and(eq(messages.createdAt, beforeCursor.createdAt), lt(messageRowid, beforeCursor.rowid)),
        ),
      );
    } else if (beforeMs !== null) {
      conds.push(lt(messages.createdAt, beforeMs));
    } else if (afterCursor) {
      conds.push(
        or(
          gt(messages.createdAt, afterCursor.createdAt),
          and(eq(messages.createdAt, afterCursor.createdAt), gt(messageRowid, afterCursor.rowid)),
        ),
      );
    }
    if (clearedAtMs !== null) conds.push(gt(messages.createdAt, clearedAtMs));
    const whereExpr = and(...conds);

    const rows = await db
      .select({
        ...getMessageSelectFields(),
        ...(outline ? { content: historyOutlineContent(), historyContentStamp: historyOutlineContentStamp() } : {}),
        rowid: messageRowid,
      })
      .from(messages)
      .where(whereExpr)
      .orderBy(
        afterCursor ? asc(messages.createdAt) : desc(messages.createdAt),
        afterCursor ? asc(messageRowid) : desc(messageRowid),
      )
      .limit(limit);
    const orderedRows = afterCursor ? rows.slice().reverse() : rows;
    const restored = ports.restoreTaskImages ? await ports.restoreTaskImages(imageDbClient, orderedRows) : orderedRows;
    const listed = await hydrateLegacyUserTurnCosts(restored.map(messageToCamelWithRowid));
    if (!outline) return listed;
    const stamps = new Map(orderedRows.map((row) => [row.id, (row as { historyContentStamp?: string }).historyContentStamp]));
    return listed.map((row) => withHistoryArtifacts({ ...row, historyContentStamp: stamps.get(row.id) ?? undefined }));
  };
}

export function createLocalHistoryViewReader(ports: LocalHistoryViewReaderPorts) {
  const readMessagesList = createReadMessagesList(ports);
  const readRunning = (sessionId: string) => ports.running(sessionId);
  const readLive = (sessionId: string) => ports.live(sessionId);
  return createHistoryViewReader({
    list: readMessagesList,
    // readMessagesList skips paged imports only for device-link callers (#318).
    shareScope: () => (ports.isDeviceLinkCaller?.() ? 'device-link' : 'local'),
    revision: async () => {
      const current = getCurrentDbClientSnapshot();
      if (!current) throw new Error('DbClient not ready');
      // Own writes increment total_changes; writes through other connections
      // increment data_version. Both run on the existing database worker.
      const [version] = await current.client.query<{ changes: number; version: number }>(
        'SELECT total_changes() AS changes, data_version AS version FROM pragma_data_version');
      return `${current.clientEpoch}:${version.version}:${version.changes}`;
    },
    outline: (sid, opts, skipImport) => readMessagesList(sid, opts, skipImport, true),
    hydrate: async (sid, ids) => {
      const imageDbClient = getDbClient();
      const db = imageDbClient.drizzle;
      const [session] = await db.select({ clearedAt: sessions.clearedAt }).from(sessions)
        .where(eq(sessions.id, sid)).limit(1);
      if (!session) throwIpcError('NOT_FOUND', 'History is unavailable');
      const result: Message[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        const rows = await db.select({ ...getMessageSelectFields(), rowid: messageRowid }).from(messages)
          .where(and(eq(messages.sessionId, sid), inArray(messages.id, batch), isNull(messages.rewindAt),
            session.clearedAt !== null ? gt(messages.createdAt, session.clearedAt) : undefined));
        if (rows.length !== batch.length) throwIpcError('NOT_FOUND', 'History range changed');
        result.push(...(ports.restoreTaskImages ? await ports.restoreTaskImages(imageDbClient, rows) : rows).map(messageToCamelWithRowid));
      }
      return hydrateLegacyUserTurnCosts(result);
    },
    validate: async (sid, ids) => {
      const db = getDbClient().drizzle;
      const [session] = await db.select({ clearedAt: sessions.clearedAt }).from(sessions)
        .where(eq(sessions.id, sid)).limit(1);
      if (!session) throwIpcError('NOT_FOUND', 'History is unavailable');
      const valid = new Set(readLive(sid).filter((row) => session.clearedAt === null || Date.parse(row.createdAt) > session.clearedAt)
        .map((row) => row.id));
      const pending = ids.filter((id) => !valid.has(id));
      for (let offset = 0; offset < pending.length; offset += 100) {
        const batch = pending.slice(offset, offset + 100);
        const storedIds = batch.filter((id) => !id.startsWith('history-live:'));
        const clientIds = batch.filter((id) => id.startsWith('history-live:')).map((id) => id.slice('history-live:'.length));
        const rows = await db.select({ id: messages.id, clientId: messages.clientId }).from(messages)
          .where(and(eq(messages.sessionId, sid), isNull(messages.rewindAt),
            or(inArray(messages.id, storedIds), inArray(messages.clientId, clientIds)),
            session.clearedAt !== null ? gt(messages.createdAt, session.clearedAt) : undefined));
        for (const row of rows) { valid.add(row.id); valid.add(`history-live:${row.clientId}`); }
      }
      if (ids.some((id) => !valid.has(id))) throwIpcError('NOT_FOUND', 'History range changed');
    },
    running: readRunning,
    live: readLive,
    anchor: async (sessionId, id, outline) => {
      const imageDbClient = getDbClient();
      const db = imageDbClient.drizzle;
      const [session] = await db.select({ clearedAt: sessions.clearedAt }).from(sessions)
        .where(eq(sessions.id, sessionId)).limit(1);
      if (!session) throwIpcError('NOT_FOUND', 'History is unavailable');
      if (id.startsWith('history-live:')) {
        const live = readLive(sessionId).find((row) => row.id === id);
        if (live && (session.clearedAt === null || Date.parse(live.createdAt) > session.clearedAt)) return live;
      }
      const [row] = await db.select({ ...getMessageSelectFields(), ...(outline ? { content: historyOutlineContent() } : {}), rowid: messageRowid }).from(messages)
        .where(and(eq(messages.sessionId, sessionId),
          id.startsWith('history-live:') ? eq(messages.clientId, id.slice('history-live:'.length)) : eq(messages.id, id),
          isNull(messages.rewindAt),
          session.clearedAt !== null ? gt(messages.createdAt, session.clearedAt) : undefined)).limit(1);
      if (!row) throwIpcError('NOT_FOUND', 'History range changed');
      const [restored] = ports.restoreTaskImages ? await ports.restoreTaskImages(imageDbClient, [row]) : [row];
      const message = messageToCamelWithRowid(restored);
      return outline ? withHistoryArtifacts(message) : message;
    },
  });
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(n), 1), MAX_LIMIT);
}

/**
 * Same-ms message ordering must follow SQLite insertion order, not the random
 * cuid message id. `rowid` is stable for this local table and avoids a schema
 * migration solely for pagination tie-breaking.
 */
export function getMessageSelectFields() {
  return {
    id: messages.id,
    clientId: messages.clientId,
    sessionId: messages.sessionId,
    role: messages.role,
    content: messages.content,
    toolUseId: messages.toolUseId,
    agentMeta: messages.agentMeta,
    agentKind: messages.agentKind,
    createdAt: messages.createdAt,
    rewindAt: messages.rewindAt,
  };
}

export function messageToCamelWithRowid(row: MessageRowWithRowid): Message {
  return {
    ...messageToCamel(row),
    rowid: row.rowid,
  };
}

/**
 * Compatibility projection for messages created before userTurnCostUsd existed.
 *
 * This is deliberately read-only: a history page can immediately display the
 * correct user-round total without rewriting legacy data or changing the raw
 * segment values used by every billing aggregate. Media charges are committed
 * on the user row before the assistant follow-up. Rebuild their display snapshot
 * from that ledger: missing metadata and existing totals/snapshots cannot prove
 * that the latest fee was projected.
 *
 * Scan only from the oldest row on this page back to the previous real user
 * boundary. A full-session walk here used to re-read tens of thousands of
 * agent_meta blobs on every history page.
 */
export async function hydrateLegacyUserTurnCosts(history: Message[]): Promise<Message[]> {
  const pageAssistantClientIds = new Set(history.filter(message => message.role === 'assistant')
    .map(message => message.clientId));
  if (pageAssistantClientIds.size === 0) return history;
  const legacyClientIds = new Set(
    history.flatMap((message) => {
      const agentMeta = message.agentMeta;
      return message.role === 'assistant' &&
        agentMeta &&
        typeof agentMeta === 'object' &&
        !Array.isArray(agentMeta) &&
        typeof agentMeta.turnCostUsd === 'number' &&
        Number.isFinite(agentMeta.turnCostUsd) &&
        agentMeta.turnCostUsd > 0 &&
        !(typeof agentMeta.userTurnCostUsd === 'number' && agentMeta.userTurnCostUsd > 0)
        ? [message.clientId]
        : [];
    }),
  );
  const sessionId = history[0]?.sessionId;
  if (!sessionId) return history;
  const oldestOnPage = oldestHistoryMessage(history);
  const oldestCreatedAtMs = Date.parse(oldestOnPage.createdAt);
  if (!Number.isFinite(oldestCreatedAtMs)) return history;
  const db = getDbClient().drizzle;
  const [session] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const visibleAfterClear =
    session?.clearedAt == null ? [] : [gt(messages.createdAt, session.clearedAt)];
  const olderThanOldestOnPage =
    oldestOnPage.rowid != null
      ? or(
          lt(messages.createdAt, oldestCreatedAtMs),
          and(eq(messages.createdAt, oldestCreatedAtMs), lt(messageRowid, oldestOnPage.rowid)),
        )
      : lt(messages.createdAt, oldestCreatedAtMs);
  // A visible real user row already establishes this page's cost boundary.
  // Looking behind it adds a round trip and reads an irrelevant earlier round.
  // Continuations and pages starting midway through a round still query back.
  const priorUser = oldestOnPage.role === 'user' && oldestOnPage.agentMeta?.autoResume !== true
    && oldestOnPage.rowid != null
    ? [{ createdAt: oldestCreatedAtMs, rowid: oldestOnPage.rowid }]
    : await db
    .select({
      createdAt: messages.createdAt,
      rowid: messageRowid,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
        ...visibleAfterClear,
        olderThanOldestOnPage,
        notAutoResumeAgentMetaSql(),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  const newestOnPage = newestHistoryMessage(history);
  const newestCreatedAtMs = Date.parse(newestOnPage.createdAt);
  const fromPriorUser = priorUser[0]
    ? or(
        gt(messages.createdAt, priorUser[0].createdAt),
        and(eq(messages.createdAt, priorUser[0].createdAt), gte(messageRowid, priorUser[0].rowid)),
      )
    : undefined;
  const throughNewestOnPage = Number.isFinite(newestCreatedAtMs)
    ? newestOnPage.rowid != null
      ? or(
          lt(messages.createdAt, newestCreatedAtMs),
          and(eq(messages.createdAt, newestCreatedAtMs), lte(messageRowid, newestOnPage.rowid)),
        )
      : lte(messages.createdAt, newestCreatedAtMs)
    : undefined;
  const rows = await db
    .select({
      clientId: messages.clientId,
      role: messages.role,
      agentMeta: messages.agentMeta,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        isNull(messages.rewindAt),
        ...visibleAfterClear,
        ...(fromPriorUser ? [fromPriorUser] : []),
        ...(throughNewestOnPage ? [throughNewestOnPage] : []),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messageRowid));

  const totalsByClientId = new Map<string, PriorUserRoundCost>();
  const additionalByClientId = new Map<string, RegionalMoney[]>();
  const roundMoneyByClientId = new Map<string, { money: RegionalMoney; isEstimate: boolean }>();
  let roundValues: RegionalMoney[] = [];
  let additionalCosts: RegionalMoney[] = [];
  let hasRealUserBoundary = false;
  let costUsd = 0;
  let hasEstimatedValue = false;
  for (const row of rows) {
    if (row.role === 'user' && !isAutoResumeUserMessage(row.agentMeta)) {
      hasRealUserBoundary = true;
      const recorded = parseAgentMetaRecord(row.agentMeta)?.mediaCosts;
      additionalCosts = Array.isArray(recorded) ? recorded.map(normalizeRegionalMoney)
        .filter((value): value is RegionalMoney => !!value && value.amount > 0) : [];
      roundValues = [...additionalCosts];
      costUsd = additionalCosts.filter(value => value.currency === 'USD').reduce((sum, value) => sum + value.amount, 0);
      hasEstimatedValue = false;
      continue;
    }
    if (row.role !== 'assistant') continue;
    if (additionalCosts.length) additionalByClientId.set(row.clientId, additionalCosts);
    const meta = parseAgentMetaRecord(row.agentMeta);
    const rawMoney = normalizeRegionalMoney(meta?.turnCost) ??
      (typeof meta?.turnCostUsd === 'number' && Number.isFinite(meta.turnCostUsd) && meta.turnCostUsd > 0
        ? legacyUsdMoney(meta.turnCostUsd) : null);
    const segmentMoney = rawMoney && meta?.turnCostIsEstimate === true ? asValueEstimateMoney(rawMoney) : rawMoney;
    if (segmentMoney) roundValues.push(segmentMoney);
    roundValues.push(...supplementalConversationEstimates(meta));
    // Only calculate recovery totals for messages on this history page, not every older segment.
    const roundMoney = additionalCosts.length && pageAssistantClientIds.has(row.clientId)
      ? addCompatibleRegionalMoney(roundValues, segmentMoney?.currency) : null;
    if (hasRealUserBoundary && roundMoney) roundMoneyByClientId.set(row.clientId, {
      money: roundMoney,
      isEstimate: roundValues.some(value => value.currency === roundMoney.currency && value.kind === 'value-estimate'),
    });
    const segmentCost = meta?.turnCostUsd;
    if (
      !hasRealUserBoundary ||
      typeof segmentCost !== 'number' ||
      !Number.isFinite(segmentCost) ||
      segmentCost <= 0
    ) {
      continue;
    }
    costUsd += segmentCost;
    hasEstimatedValue ||= meta?.turnCostIsEstimate === true;
    if (legacyClientIds.has(row.clientId)) {
      totalsByClientId.set(row.clientId, {
        money: legacyUsdMoney(costUsd),
        costUsd,
        hasEstimatedValue,
      });
    }
  }

  let hydrated: Message[] | null = null;
  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    const agentMeta = message.agentMeta;
    const additional = additionalByClientId.get(message.clientId);
    if (additional) {
      const round = roundMoneyByClientId.get(message.clientId);
      hydrated ??= history.slice();
      hydrated[index] = { ...message, agentMeta: { ...agentMeta,
        ...(round ? {
          userTurnCost: round.money,
          userTurnCostUsd: round.money.currency === 'USD' ? round.money.amount : undefined,
          userTurnCostIsEstimate: round.isEstimate,
        } : {}),
        turnUsageDetails: buildTurnUsageDetails({ ...normalizeTurnUsageDetails(agentMeta?.turnUsageDetails), additionalCosts: additional }) ?? undefined,
      } };
      // The ledger projection already includes legacy USD segments and estimates.
      // Do not overwrite it with the older USD-only compatibility subtotal.
      continue;
    }
    if (
      message.role !== 'assistant' ||
      !agentMeta ||
      typeof agentMeta !== 'object' ||
      Array.isArray(agentMeta) ||
      typeof agentMeta.turnCostUsd !== 'number' ||
      !Number.isFinite(agentMeta.turnCostUsd) ||
      agentMeta.turnCostUsd <= 0 ||
      (typeof agentMeta.userTurnCostUsd === 'number' && agentMeta.userTurnCostUsd > 0)
    ) {
      continue;
    }
    const total = totalsByClientId.get(message.clientId);
    if (!total) continue;
    hydrated ??= history.slice();
    hydrated[index] = {
      ...message,
      agentMeta: {
        ...(hydrated[index].agentMeta ?? agentMeta),
        ...(total.money ? { userTurnCost: total.money } : {}),
        userTurnCostUsd: total.costUsd,
        userTurnCostIsEstimate: total.hasEstimatedValue,
      },
    };
  }
  return hydrated ?? history;
}

export function isAutoResumeUserMessage(agentMeta: string | null): boolean {
  return parseAgentMetaRecord(agentMeta)?.autoResume === true;
}

/**
 * Sums prior assistant cost segments back to the latest real user message.
 *
 * An agent can emit several SDK `done` segments while completing one visible
 * user request (for example, background audit progress followed by a final
 * summary). Those segments must stay separate for billing and analytics, but
 * the final message needs their user-round total. This reads only the current
 * round, honours /clear + rewind visibility, and deliberately skips synthetic
 * `autoResume` user rows so an automatic "continue" cannot split a round.
 */
export async function readPriorUserRoundCost(
  sessionId: string,
  assistantClientId: string,
  client: DbClient = getDbClient(),
): Promise<PriorUserRoundCost> {
  const db = client.drizzle;
  const [target] = await db
    .select({ createdAt: messages.createdAt, rowid: messageRowid })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.clientId, assistantClientId),
        eq(messages.role, 'assistant'),
        isNull(messages.rewindAt),
      ),
    )
    .limit(1);
  if (!target) return { money: null, costUsd: 0, hasEstimatedValue: false };

  const [session] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const visibleAfterClear =
    session?.clearedAt == null ? [] : [gt(messages.createdAt, session.clearedAt)];
  const beforeTarget = or(
    lt(messages.createdAt, target.createdAt),
    and(eq(messages.createdAt, target.createdAt), lt(messageRowid, target.rowid)),
  );

  const userRows = await db
    .select({ createdAt: messages.createdAt, rowid: messageRowid, agentMeta: messages.agentMeta })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
        beforeTarget,
        ...visibleAfterClear,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid));
  const realUserRows = userRows.filter((row) => !isAutoResumeUserMessage(row.agentMeta));
  const boundary = realUserRows[0];
  if (!boundary) return { money: null, costUsd: 0, hasEstimatedValue: false };
  // 运行中插话（delivery: 'steer'）与界面一样归在同一轮，不算新的用户请求。
  const isFirstUserRound =
    realUserRows.filter((row) => parseAgentMetaRecord(row.agentMeta)?.delivery !== 'steer')
      .length === 1;

  const afterBoundary = or(
    gt(messages.createdAt, boundary.createdAt),
    and(eq(messages.createdAt, boundary.createdAt), gt(messageRowid, boundary.rowid)),
  );
  const assistantRows = await db
    .select({ agentMeta: messages.agentMeta })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'assistant'),
        isNull(messages.rewindAt),
        afterBoundary,
        beforeTarget,
        ...visibleAfterClear,
      ),
    );

  const values: RegionalMoney[] = [];
  const additionalCosts: RegionalMoney[] = [];
  const mediaCosts = parseAgentMetaRecord(boundary.agentMeta)?.mediaCosts;
  if (Array.isArray(mediaCosts)) {
    for (const value of mediaCosts) {
      const cost = normalizeRegionalMoney(value);
      if (cost?.kind === 'actual-cost' && cost.amount > 0) {
        values.push(cost);
        additionalCosts.push(cost);
      }
    }
  }
  const estimatedCurrencies = new Set<RegionalMoney['currency']>();
  for (const row of assistantRows) {
    const meta = parseAgentMetaRecord(row.agentMeta);
    const structured = normalizeRegionalMoney(meta?.turnCost);
    const legacy =
      typeof meta?.turnCostUsd === 'number' &&
      Number.isFinite(meta.turnCostUsd) &&
      meta.turnCostUsd > 0
        ? legacyUsdMoney(meta.turnCostUsd)
        : undefined;
    const rawSegment = structured ?? legacy;
    const isEstimate = rawSegment?.kind === 'value-estimate' || meta?.turnCostIsEstimate === true;
    const segment = rawSegment && isEstimate ? asValueEstimateMoney(rawSegment) : rawSegment;
    for (const estimate of supplementalConversationEstimates(meta)) {
      values.push(estimate);
      estimatedCurrencies.add(estimate.currency);
    }
    if (!segment || segment.amount <= 0) continue;
    values.push(segment);
    if (isEstimate) estimatedCurrencies.add(segment.currency);
  }
  const money = addCompatibleRegionalMoney(values);
  const hasEstimatedValue = money !== null && estimatedCurrencies.has(money.currency);
  return {
    money,
    costUsd: money?.currency === 'USD' ? money.amount : 0,
    hasEstimatedValue,
    ...(additionalCosts.length ? { additionalCosts } : {}),
    ...(isFirstUserRound ? { isFirstUserRound } : {}),
  };
}

function oldestHistoryMessage(history: Message[]): Message {
  return history.reduce((oldest, message) =>
    compareHistoryTimeline(message, oldest) < 0 ? message : oldest,
  );
}

function newestHistoryMessage(history: Message[]): Message {
  return history.reduce((newest, message) =>
    compareHistoryTimeline(message, newest) > 0 ? message : newest,
  );
}

function compareHistoryTimeline(a: Message, b: Message): number {
  const timeDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
  const aRowid = typeof a.rowid === 'number' ? a.rowid : Number.NaN;
  const bRowid = typeof b.rowid === 'number' ? b.rowid : Number.NaN;
  if (Number.isFinite(aRowid) && Number.isFinite(bRowid) && aRowid !== bRowid) {
    return aRowid - bRowid;
  }
  return 0;
}
