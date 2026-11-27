/**
 * History reads for cindy-host.
 *
 * The history view and work details are the desktop's reader (createHostHistoryReader below binds
 * its ports). readMessagesList and readMessagesAroundClientId are the Host's own reads for
 * `/api/messages/list`, `/api/sessions/messages` and the around-a-message read.
 */

import { and, asc, desc, eq, gt, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { capReferenceMessageRows, clampAroundRadius, requireReferenceContentCharLimit } from '../../../desktop/src/main/localDb/ipc/history.js';
import { createLocalHistoryViewReader, type LocalHistoryViewReaderPorts } from '../../../desktop/src/main/localDb/ipc/localHistoryViewReader.js';
import { MAX_HISTORY_SCAN_ROWS, type HistoryPageShape } from '../../../desktop/src/main/localDb/ipc/historyViewReader.js';
import { getDeviceLinkInvokeContext, isDeviceLinkInvoke } from '../../../desktop/src/main/device-link/invoke-context.js';
import { encodeHistoryViewDelta } from '../../../desktop/src/main/device-link/historyViewDelta.js';
import { requireString, throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';
import { DeviceLinkError, isScopedPeer, parseHistoryViewDeltaOptions } from '@cindy/device-link';
import { historyViewLeaves, isHistoryViewUnavailable } from '@cindy/maker-shared/message-window';
import { messageToCamel } from '../../../desktop/src/main/localDb/mapper.js';
import { writeMessageContentRow } from '../../../desktop/src/main/localDb/messageMutations.js';
import { mergeDismissedIntoErrorContent } from '../../../desktop/src/shared/interruptedTurn.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../../desktop/src/main/device-link/broadcast-tap.js';
import { messages as messageTable, sessions as sessionTable } from '../../../desktop/src/main/localDb/schema.js';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.js';
import type { Message } from '../../../desktop/src/renderer/lib/ccAgent.types.js';
import { explicitPorts } from './explicit-ports.js';
import { recoverGeneratedImagesForHistory } from '../../../desktop/src/main/cindy-media/generatedImageRecovery.js';

const messageRowid = sql<number>`"messages"."rowid"`;

export interface HistoryListOptions {
  limit?: number;
  before?: string | null;
  after?: string | null;
}

export async function readMessagesList(sessionId: string, opts: HistoryListOptions = {}): Promise<Message[]> {
  const dbClient = getDbClient();
  if (!dbClient) throw new Error('DbClient not ready');
  const db = dbClient.drizzle;

  const limit = Math.max(1, Math.min(opts.limit ?? 200, 2000));
  const before = opts.before?.trim() || null;
  const after = opts.after?.trim() || null;
  // As the desktop's messages list (localHistoryViewReader.ts createReadMessagesList): its first page
  // starts the task's generated-image recovery without waiting (agent/generated-images.ts binds it).
  // The history view reads outlines, which do not.
  if (!before && !after) void recoverGeneratedImagesForHistory(sessionId).catch(() => undefined);

  // Session clearedAt boundary
  const [session] = await db
    .select({ clearedAt: sessionTable.clearedAt })
    .from(sessionTable)
    .where(eq(sessionTable.id, sessionId))
    .limit(1);
  const clearedAt = session?.clearedAt ?? null;

  let beforeCursor: { createdAt: number; rowid: number } | null = null;
  let afterCursor: { createdAt: number; rowid: number } | null = null;

  if (before) {
    const [row] = await db
      .select({ createdAt: messageTable.createdAt, rowid: messageRowid })
      .from(messageTable)
      .where(and(eq(messageTable.id, before), eq(messageTable.sessionId, sessionId)))
      .limit(1);
    if (row) beforeCursor = row;
  } else if (after) {
    const [row] = await db
      .select({ createdAt: messageTable.createdAt, rowid: messageRowid })
      .from(messageTable)
      .where(and(eq(messageTable.id, after), eq(messageTable.sessionId, sessionId)))
      .limit(1);
    if (row) afterCursor = row;
  }

  const conds: Array<SQL | undefined> = [
    eq(messageTable.sessionId, sessionId),
    isNull(messageTable.rewindAt),
  ];
  if (clearedAt !== null) {
    conds.push(gt(messageTable.createdAt, clearedAt));
  }

  if (beforeCursor) {
    conds.push(
      or(
        lt(messageTable.createdAt, beforeCursor.createdAt),
        and(eq(messageTable.createdAt, beforeCursor.createdAt), lt(messageRowid, beforeCursor.rowid)),
      ),
    );
  } else if (afterCursor) {
    conds.push(
      or(
        gt(messageTable.createdAt, afterCursor.createdAt),
        and(eq(messageTable.createdAt, afterCursor.createdAt), gt(messageRowid, afterCursor.rowid)),
      ),
    );
  }

  const rows = await db
    .select({
      id: messageTable.id,
      clientId: messageTable.clientId,
      sessionId: messageTable.sessionId,
      role: messageTable.role,
      content: messageTable.content,
      toolUseId: messageTable.toolUseId,
      agentMeta: messageTable.agentMeta,
      agentKind: messageTable.agentKind,
      createdAt: messageTable.createdAt,
      rewindAt: messageTable.rewindAt,
      rowid: messageRowid,
    })
    .from(messageTable)
    .where(and(...conds))
    .orderBy(
      afterCursor ? asc(messageTable.createdAt) : desc(messageTable.createdAt),
      afterCursor ? asc(messageRowid) : desc(messageRowid),
    )
    .limit(limit);

  const orderedRows = afterCursor ? rows.slice().reverse() : rows;
  return orderedRows.map((row) => ({
    ...messageToCamel(row),
    rowid: row.rowid,
  }));
}

export interface HostHistoryReaderPorts {
  /** The task's turn has not settled yet (the input queue's isTurnRunning, the executor's isRunning). */
  running(sessionId: string): boolean;
  /** Rows of the task's turn not in the database yet (the input queue's liveHistory). */
  live(sessionId: string): Message[];
}

/**
 * The history view and work details (`/api/messages/history-view`, `/api/messages/work-details`):
 * the desktop's reader itself (localHistoryViewReader.ts createLocalHistoryViewReader), with list,
 * outline, hydrate, validate, revision and anchor as the desktop wrote them. The Host binds only the
 * process ports, every one written out below.
 */
export function createHostHistoryReader(ports: HostHistoryReaderPorts) {
  return createLocalHistoryViewReader(explicitPorts<LocalHistoryViewReaderPorts>({
    // The desktop binds isSessionTurnPendingCompletion (registerAll.ts, register.ts): running until the
    // turn's rows have settled. The executor's isRunning is that boundary on the Host (turn-executor.mjs:
    // a turn counts as running until its reply rows settle).
    running: (sessionId) => ports.running(sessionId),
    live: (sessionId) => ports.live(sessionId),
    // Device Link reaches these routes on the Host as well: the shared inbound dispatch runs a peer's
    // invoke inside its device-link context and device-link.ts calls the service in process
    // (HOST_CONTRACT_CHANNELS, local-db:messages:view). The value is the same as the desktop's and only
    // keeps a peer's in-flight page apart from a local one (historyViewReader.ts shareScope).
    isDeviceLinkCaller: () => isDeviceLinkInvoke(),
    // The desktop imports a task's external history (Codex rollout, Claude transcript) before an
    // unpaged read (runMessagesListImportSideEffects). It needs the desktop's agent registries and
    // is not on the Host: the Host's own list (readMessagesList above) does not import either.
    importBeforeList: undefined,
    // Local task images on durable assistant rows (restoreTaskImageRows): taskImageDelivery.ts loads
    // Electron through the desktop media ingest and ref journal, so it cannot load on the Host yet;
    // rows are returned as read (release table section 5, Host history reader ④, 甲类次要).
    restoreTaskImages: undefined,
  }));
}

export type HostHistoryReader = ReturnType<typeof createHostHistoryReader>;

export async function readHostHistoryView(
  reader: HostHistoryReader,
  sessionId: unknown,
  before?: unknown,
  opts?: unknown,
) {
  const sid = requireString(sessionId, 'sessionId');
  const rawOpts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts as Record<string, unknown> : null;
  const beforeArg = before ?? rawOpts?.before;
  const resolvedBefore = beforeArg == null ? undefined : requireString(beforeArg, 'before');
  const context = getDeviceLinkInvokeContext();
  const workLines = rawOpts?.workLines === true && !!context?.historyView && !context.sharedTask;
  const historyDelta = context && !context.sharedTask && !isScopedPeer(context.controllerDeviceId)
    ? parseHistoryViewDeltaOptions(rawOpts) : null;
  const lazyDetails = rawOpts?.lazyDetails !== false;
  let shape: HistoryPageShape | undefined;
  const page = await reader.page(
    sid,
    resolvedBefore,
    lazyDetails,
    workLines || historyDelta ? { workLines, onShape: (value) => { shape = value; } } : {},
  ).catch((error) => {
    if (isHistoryViewUnavailable(error)) context?.historyView?.disable();
    throw error;
  });
  if (resolvedBefore == null) {
    const liveKeys = historyViewLeaves(page.items)
      .filter((item) => item.type === 'work' && item.summary.isStreaming)
      .map((item) => item.key);
    context?.historyView?.update(liveKeys, { workLines, shape });
  }
  return historyDelta && context
    ? encodeHistoryViewDelta(context.controllerDeviceId, sid, `${lazyDetails}:${workLines}`, historyDelta, page, shape)
    : page;
}

export async function readHostWorkDetails(
  reader: HostHistoryReader,
  sessionId: unknown,
  ref: unknown,
  after?: unknown,
) {
  const sid = requireString(sessionId, 'sessionId');
  const value = ref && typeof ref === 'object' && !Array.isArray(ref)
    ? ref as {
      key?: unknown;
      firstMessageId?: unknown;
      lastMessageId?: unknown;
      firstStoredMessageId?: unknown;
      lastStoredMessageId?: unknown;
      liveMessageIds?: unknown;
      parentToolUseId?: unknown;
    }
    : null;
  if (value?.liveMessageIds != null && (!Array.isArray(value.liveMessageIds) || value.liveMessageIds.length > MAX_HISTORY_SCAN_ROWS)) {
    throwIpcError('INVALID_PARAMS', 'Invalid live work range');
  }
  return reader.details(
    sid,
    {
      key: requireString(value?.key, 'key'),
      ...(value?.parentToolUseId == null ? {} : { parentToolUseId: requireString(value.parentToolUseId, 'parentToolUseId') }),
      firstMessageId: requireString(value?.firstMessageId, 'firstMessageId'),
      lastMessageId: requireString(value?.lastMessageId, 'lastMessageId'),
      ...(value?.firstStoredMessageId == null ? {} : { firstStoredMessageId: requireString(value.firstStoredMessageId, 'firstStoredMessageId') }),
      ...(value?.lastStoredMessageId == null ? {} : { lastStoredMessageId: requireString(value.lastStoredMessageId, 'lastStoredMessageId') }),
      ...(Array.isArray(value?.liveMessageIds) ? { liveMessageIds: value.liveMessageIds.map((id) => requireString(id, 'liveMessageId')) } : {}),
    },
    after == null ? undefined : requireString(after, 'after'),
  );
}

export async function readMessagesAroundClientId(
  session: unknown,
  client: unknown,
  opts?: unknown,
): Promise<Message[]> {
  const sessionId = requireString(session, 'sessionId');
  const clientId = requireString(client, 'clientId');
  const options = opts as { radius?: unknown; contentCharLimit?: unknown } | undefined;
  const radius = clampAroundRadius(options?.radius);
  const contentCharLimit = requireReferenceContentCharLimit(options?.contentCharLimit);
  const dbClient = getDbClient();
  if (!dbClient) throw new Error('DbClient not ready');
  const db = dbClient.drizzle;

  const [sessionRow] = await db
    .select({ clearedAt: sessionTable.clearedAt })
    .from(sessionTable)
    .where(eq(sessionTable.id, sessionId))
    .limit(1);
  if (!sessionRow) throwIpcError('NOT_FOUND', 'Session 不存在');
  const clearedAt = sessionRow.clearedAt ?? null;
  const visibleConds = clearedAt === null ? [] : [gt(messageTable.createdAt, clearedAt)];

  const [anchor] = await db
    .select({
      id: messageTable.id,
      clientId: messageTable.clientId,
      sessionId: messageTable.sessionId,
      role: messageTable.role,
      content: messageTable.content,
      toolUseId: messageTable.toolUseId,
      agentMeta: messageTable.agentMeta,
      agentKind: messageTable.agentKind,
      createdAt: messageTable.createdAt,
      rewindAt: messageTable.rewindAt,
      rowid: messageRowid,
    })
    .from(messageTable)
    .where(and(
      eq(messageTable.sessionId, sessionId),
      eq(messageTable.clientId, clientId),
      isNull(messageTable.rewindAt),
      ...visibleConds,
    ))
    .limit(1);

  // Only absence of the message in an existing task is an exact-ID miss.
  if (!anchor) throw new DeviceLinkError('NOT_FOUND', '[NOT_FOUND] Message 不存在');

  const before = await db
    .select({
      id: messageTable.id,
      clientId: messageTable.clientId,
      sessionId: messageTable.sessionId,
      role: messageTable.role,
      content: messageTable.content,
      toolUseId: messageTable.toolUseId,
      agentMeta: messageTable.agentMeta,
      agentKind: messageTable.agentKind,
      createdAt: messageTable.createdAt,
      rewindAt: messageTable.rewindAt,
      rowid: messageRowid,
    })
    .from(messageTable)
    .where(and(
      eq(messageTable.sessionId, sessionId),
      isNull(messageTable.rewindAt),
      ...visibleConds,
      or(
        lt(messageTable.createdAt, anchor.createdAt),
        and(eq(messageTable.createdAt, anchor.createdAt), lt(messageRowid, anchor.rowid)),
      ),
    ))
    .orderBy(desc(messageTable.createdAt), desc(messageRowid))
    .limit(radius);

  const after = await db
    .select({
      id: messageTable.id,
      clientId: messageTable.clientId,
      sessionId: messageTable.sessionId,
      role: messageTable.role,
      content: messageTable.content,
      toolUseId: messageTable.toolUseId,
      agentMeta: messageTable.agentMeta,
      agentKind: messageTable.agentKind,
      createdAt: messageTable.createdAt,
      rewindAt: messageTable.rewindAt,
      rowid: messageRowid,
    })
    .from(messageTable)
    .where(and(
      eq(messageTable.sessionId, sessionId),
      isNull(messageTable.rewindAt),
      ...visibleConds,
      or(
        gt(messageTable.createdAt, anchor.createdAt),
        and(eq(messageTable.createdAt, anchor.createdAt), gt(messageRowid, anchor.rowid)),
      ),
    ))
    .orderBy(asc(messageTable.createdAt), asc(messageRowid))
    .limit(radius);

  const combined = [...before.reverse(), anchor, ...after];
  return capReferenceMessageRows(combined.map((row) => ({
    ...messageToCamel(row),
    rowid: row.rowid,
  })), contentCharLimit);
}

export async function dismissHostErrorMessage(
  sessionId: unknown,
  clientId: unknown,
  publish?: (message: Message) => void,
  waitForErrorPersisted?: (sessionId: string, clientId: string) => Promise<void>,
): Promise<Message> {
  const sid = requireString(sessionId, 'sessionId');
  const cid = requireString(clientId, 'clientId');
  await waitForErrorPersisted?.(sid, cid);
  const ownerScope = captureDataOwnerBroadcastScope();
  const dbClient = getDbClient();
  if (!dbClient) throw new Error('DbClient not ready');
  const [row] = await dbClient.drizzle
    .select()
    .from(messageTable)
    .where(and(eq(messageTable.sessionId, sid), eq(messageTable.clientId, cid)))
    .limit(1);
  if (!row || row.role !== 'error') throwIpcError('NOT_FOUND', 'Error message 不存在');
  const updatedRow = await writeMessageContentRow(dbClient, sid, cid, mergeDismissedIntoErrorContent(row.content));
  if (!updatedRow) throwIpcError('NOT_FOUND', 'Error message 不存在');
  const updated = messageToCamel(updatedRow);
  if (isDataOwnerBroadcastScopeCurrent(ownerScope)) publish?.(updated);
  return updated;
}

export async function readHostSessionActivityMeta(sessionId: string): Promise<{
  title: string | null;
  workingDir: string | null;
  agentKind: string | null;
} | null> {
  const dbClient = getDbClient();
  if (!dbClient) return null;
  const [row] = await dbClient.drizzle
    .select({
      title: sessionTable.title,
      workingDir: sessionTable.workingDir,
      agentKind: sessionTable.agentKind,
    })
    .from(sessionTable)
    .where(and(eq(sessionTable.id, sessionId), ne(sessionTable.status, 'deleted')))
    .limit(1);
  return row ?? null;
}
