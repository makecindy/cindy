import { projectHandoffPreview, type HandoffCoverage } from '../../maker-ipc/agentHandoff.js';
import { commitContextRebuildWithPorts } from '../contextRebuildPersistence.js';
import { rebroadcastAgentSwitchBoundaryWith } from '../agentSwitchRows.js';
import { parseAgentMetaRecord, patchMessageAgentMetaWithResultRow, findVisibleToolUseMessageByAliasesRow,
  writeMessageContentRow, rollbackAssistantMessageRow, readVisiblePiUserEntry } from '../messageMutations.js';
import type { MessageAgentMetaPatchResult, VisibleToolUseMessageLink } from '../messageMutations.js';
export type { MessageAgentMetaPatchResult, VisibleToolUseMessageLink } from '../messageMutations.js';
import { writeMessageRow } from '../messageWrite.js';
import { scheduleNativeHistoryBackupCleanup } from '../../remote-agent/controller/nativeHistoryBackup.js';
/**
 * chat-data-localization F5：Messages IPC handlers（C7）。
 *
 * - `list(sessionId, opts)` —— 按 createdAt/rowid desc，limit 默认 50/上限 100；before 为 cursor message id
 * - `create(sessionId, body)` —— `(sessionId, clientId)` 唯一索引保证幂等：已存在则返回已有记录
 * - `updateContent(sessionId, clientId, content)` —— 用于 ask_user 的 answered 状态等
 */

import { ipcMain, BrowserWindow } from 'electron';
import {
  and,
  asc,
  eq,
  lt,
  gt,
  desc,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { historyViewLeaves, isHistoryViewUnavailable } from '@cindy/maker-shared/message-window';
import { projectMcpAppHistory } from '../../mcp-apps/history.js';

import { getDbClient } from '../client/current';
import type { DbClient } from '../client/DbClient';
import type { ContextRebuildArgs } from '../client/tx/types';
import { latestVisiblePreviewRow } from '../latestMessageText';
import { isEmptyAssistantContent } from '../sessionListProjection.sql';
import { messages, sessions } from '../schema';
import { messageRowid, supersedeRetriedUserTurnWithPorts } from '../retriedUserTurnSupersede.js';
import {
  messageToCamel,
  messageCreateToRow,
  extractMessagePreview,
} from '../mapper';
import { throwIpcError, requireString } from '../../utils/ipcValidate';
import * as broadcastTap from '../../device-link/broadcast-tap';
import { createLogger } from '../../logger';
import { collectCindyMediaHashes, commitMessageMediaRefs } from '../../cindy-media/chatAttachments';
import { restoreTaskImageRows } from '../../cindy-media/taskImageDelivery';
import {
  removeRefs as removeMediaRefs,
  removeSessionAttachmentRefIfUnreferencedByLiveMessage,
} from '../../cindy-media/ledger';
import { adoptLegacySessionBeforeOpen } from '../../session-import/legacy';
import { getDeviceLinkInvokeContext, isDeviceLinkInvoke } from '../../device-link/invoke-context';
import { onMessageCreated as onChatMessageCreatedForEmbedding } from '../../embedders/chat-history-embedder';
import { recomputePrRefsForSession } from '../../git-context/prRefsStore';
import { reconcileCorrectedMessagePrRefs, reconcileUpdatedMessagePrRefs, trackMessagePrRefs } from '../messagePrRefs';
import {
  isSyntheticTriggerText,
  mergeDismissedIntoErrorContent,
} from '../../../shared/interruptedTurn.js';
import { resolveStaleCodexSubscriptionValueEstimate } from '../../../shared/codexSubscriptionValue.js';
import { normalizeTurnUsageDetails } from '../../../shared/turnUsageDetails.js';
import { readSessionCostDetails } from '../../usage/sessionCostDetails.js';
import {
  addCompatibleRegionalMoney,
  asValueEstimateMoney,
  normalizeRegionalMoney,
  usdMoney,
  type RegionalMoney,
} from '../../../shared/regionalMoney.js';
import { capReferenceMessageRows } from './history.js';
import type { Message, MessageRole, AgentMeta } from '../../../renderer/lib/ccAgent.types';
import { scheduleBotRemoteResourceChangedForSession } from '../../maker-ipc/botRemoteResourceInvalidation';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { MAX_HISTORY_SCAN_ROWS, type HistoryPageShape } from './historyViewReader';
import {
  createLocalHistoryViewReader,
  createReadMessagesList,
  getMessageSelectFields,
  hydrateLegacyUserTurnCosts,
  isAutoResumeUserMessage,
  messageToCamelWithRowid,
} from './localHistoryViewReader';
import { setHistoryWorkPageReader } from '../../device-link/historyViewPush';
import { encodeHistoryViewDelta } from '../../device-link/historyViewDelta';
import { isScopedPeer, parseHistoryViewDeltaOptions } from '@cindy/device-link';
import { hasTaskChangeListener, publishTaskChange } from '../taskEvents.js';
import { createMessageClearRecovery } from '../messageClearRecovery.js';
import { markLatestAgentHandoffConsumedWithPorts } from '../agentHandoffPendingQueries.js';

export { listMessagesForAgentHandoff } from '../agentHandoffHistory.js';
export { findLatestContextRebuildMeta, findLatestUserMessageForRebuild } from '../contextRebuildQueries.js';
export { findForkParentSessionId, findPendingAgentHandoff, findPendingForkOrigin } from '../agentHandoffPendingQueries.js';

const log = createLogger('localDb/messages');

const MESSAGE_DELETION_USER_BOUNDARY_PAGE_SIZE = 32;

// Normal publication stays non-blocking. Authoritative corrections/retractions
// settle the exact row's create/update hooks before reconciling derived state.
// (The PR reference half lives in ../messagePrRefs.ts, shared with the Node Host.)
const pendingMediaWrites = new WeakMap<DbClient, Map<string, Set<Promise<void>>>>();

function trackMessageMediaWrite(dbClient: DbClient, rowId: string, write: Promise<void>): Promise<void> {
  let rows = pendingMediaWrites.get(dbClient);
  if (!rows) {
    rows = new Map();
    pendingMediaWrites.set(dbClient, rows);
  }
  let writes = rows.get(rowId);
  if (!writes) {
    writes = new Set();
    rows.set(rowId, writes);
  }
  writes.add(write);
  const tracked = writes;
  const trackedRows = rows;
  void write.then(() => {
    tracked.delete(write);
    if (tracked.size === 0 && trackedRows.get(rowId) === tracked) trackedRows.delete(rowId);
  });
  return write;
}

type MessageRow = typeof messages.$inferSelect;
type DataOwnerBroadcastScope = ReturnType<typeof broadcastTap.captureDataOwnerBroadcastScope>;

function captureOwnerBroadcastScope(): DataOwnerBroadcastScope | null {
  try {
    const capture = broadcastTap.captureDataOwnerBroadcastScope;
    return capture ? capture() : null;
  } catch {
    // Narrow unit-test mocks may intentionally expose only the legacy tap API.
    return null;
  }
}

function isOwnerBroadcastScopeCurrent(scope: DataOwnerBroadcastScope | null | undefined): boolean {
  if (scope === null || scope === undefined) return true;
  try {
    const isCurrent = broadcastTap.isDataOwnerBroadcastScopeCurrent;
    return isCurrent ? isCurrent(scope) : true;
  } catch {
    return true;
  }
}

function getSafeOwnerPushStamp(): ReturnType<typeof broadcastTap.getSafeDataOwnerPushStamp> {
  try {
    return broadcastTap.getSafeDataOwnerPushStamp?.();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the stamp for a synchronous broadcast. A captured scope is never
 * relabeled with the current owner after an await; stale scopes are dropped.
 */
function ownerStampForBroadcast(
  scope: DataOwnerBroadcastScope | null | undefined,
): DataOwnerBroadcastScope['ownerStamp'] | null {
  if (!isOwnerBroadcastScopeCurrent(scope)) return null;
  if (scope !== undefined && scope !== null) return scope.ownerStamp;
  return getSafeOwnerPushStamp();
}

function broadcastOwnedPayload(
  channel: string,
  payload: unknown,
  ownerScope?: DataOwnerBroadcastScope | null,
): void {
  const ownerStamp = ownerStampForBroadcast(ownerScope);
  if (ownerStamp === null) return;
  if (ownerScope !== undefined && ownerScope !== null) {
    broadcastTap.tapWindowBroadcast(channel, payload, ownerStamp);
  } else if (ownerStamp === undefined) {
    broadcastTap.tapWindowBroadcast(channel, payload);
  } else {
    broadcastTap.tapWindowBroadcast(channel, payload, ownerStamp);
  }
  const hasCapturedScope = ownerScope !== undefined && ownerScope !== null;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      if (hasCapturedScope) {
        win.webContents.send(channel, payload, ownerStamp);
      } else if (ownerStamp === undefined) {
        win.webContents.send(channel, payload);
      } else {
        win.webContents.send(channel, payload, ownerStamp);
      }
    } catch {
      /* swallow per-window broadcast failures */
    }
  }
}

function isVisibleSessionListPreviewRow(row: MessageRow): boolean {
  if (row.role !== 'user' && row.role !== 'assistant') return false;
  if (row.rewindAt != null) return false;
  if (row.role === 'user' && isAutoResumeUserRow(row.agentMeta)) return false;
  return true;
}

/**
 * 可见 user/assistant 落库后立刻刷新侧栏 preview,不等 turn-done / 全量 reseed。
 * 只广播当前仍是该会话最近可见消息的那一行:改写旧回复不得盖住已经更新的预览。
 * 空正文的 assistant 行不参与预览:改写或写入这种行时广播列表实际会显示的那一条。
 */
async function maybeBroadcastSessionListPreview(
  sessionId: string,
  row: MessageRow,
  ownerScope?: DataOwnerBroadcastScope | null,
  isCurrent?: () => boolean,
): Promise<void> {
  if (isCurrent?.() === false || !isVisibleSessionListPreviewRow(row)) return;
  let latest: Awaited<ReturnType<typeof latestVisiblePreviewRow>>;
  try {
    latest = await latestVisiblePreviewRow(sessionId);
  } catch (err) {
    log.warn('session list preview latest-row check failed (swallowed)', {
      sessionId,
      clientId: row.clientId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const emptyRow = row.role === 'assistant' && isEmptyAssistantContent(row.content);
  if (isCurrent?.() === false || (!emptyRow && latest?.clientId !== row.clientId)) return;
  if (!isOwnerBroadcastScopeCurrent(ownerScope)) return;
  const preview = emptyRow
    ? extractMessagePreview(latest?.content, latest?.role)
    : extractMessagePreview(row.content, row.role);
  // 不在这里落库。insert/update 事务已经把 list_preview 置空；事后 persist 无法
  // 校验同一 clientId 的内容版本，交错改写会把旧正文写回非 NULL 缓存。
  // 侧栏即时刷新靠广播；下次 list/回填从 messages 现算。
  broadcastOwnedPayload('local-db:sessions:patched', { sessionId, patch: { preview } }, ownerScope);
}

function isAutoResumeUserRow(agentMetaJson: string | null): boolean {
  if (!agentMetaJson) return false;
  try {
    const parsed: unknown = JSON.parse(agentMetaJson);
    return Boolean(
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { autoResume?: unknown }).autoResume === true,
    );
  } catch {
    return false;
  }
}

export interface EstimatedSessionValueEntry {
  clientId: string;
  money: RegionalMoney;
  costUsd?: number;
}

export type { PriorUserRoundCost } from './localHistoryViewReader';
export { readPriorUserRoundCost } from './localHistoryViewReader';

const VALID_ROLES: ReadonlySet<MessageRole> = new Set([
  'user',
  'assistant',
  'tool_use',
  'tool_result',
  'ask_user',
  'plan_review',
  'thinking',
] as const);

// The reader's list (localHistoryViewReader.ts), with the desktop's import and task image steps.
// Arrow ports read the live import binding at call time, as the direct calls did.
export const readMessagesList = createReadMessagesList({
  importBeforeList: (sessionId, opts) => runMessagesListImportSideEffects(sessionId, {}, opts),
  restoreTaskImages: (client, rows) => restoreTaskImageRows(client, rows),
});

export function registerMessageIpc(
  readRunning: (sessionId: string) => boolean = () => false,
  readLive: (sessionId: string) => Message[] = () => [],
): void {
  ipcMain.handle('local-db:messages:list', (_e, sessionId: unknown, opts: unknown) =>
    readMessagesList(sessionId, opts));

  const historyView = createLocalHistoryViewReader({
    running: readRunning,
    live: readLive,
    isDeviceLinkCaller: () => isDeviceLinkInvoke(),
    importBeforeList: (sessionId, opts) => runMessagesListImportSideEffects(sessionId, {}, opts),
    restoreTaskImages: (client, rows) => restoreTaskImageRows(client, rows),
  });
  ipcMain.handle('local-db:messages:view', async (event, sessionId: unknown, opts: unknown) => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
    const sid = requireString(sessionId, 'sessionId');
    const before = (opts as { before?: unknown } | null)?.before;
    const context = getDeviceLinkInvokeContext();
    // Work lines and their patches serve same-account remote controllers only; a shared
    // guest keeps the existing projection and authorization path unchanged.
    const workLines = (opts as { workLines?: unknown } | null)?.workLines === true && !!context?.historyView && !context.sharedTask;
    // Same-account remote readers may name the page they already hold (history-view-delta-v1).
    const historyDelta = context && !context.sharedTask && !isScopedPeer(context.controllerDeviceId)
      ? parseHistoryViewDeltaOptions(opts) : null;
    const lazyDetails = (opts as { lazyDetails?: unknown } | null)?.lazyDetails === true;
    let shape: HistoryPageShape | undefined;
    const page = await historyView.page(sid, before == null ? undefined : requireString(before, 'before'),
      lazyDetails,
      workLines || historyDelta ? { workLines, onShape: (value) => { shape = value; } } : {}).catch((error) => {
      if (isHistoryViewUnavailable(error)) context?.historyView?.disable();
      throw error;
    });
    if (before == null) {
      const liveKeys = historyViewLeaves(page.items)
        .filter((item) => item.type === 'work' && item.summary.isStreaming).map((item) => item.key);
      context?.historyView?.update(liveKeys, { workLines, shape });
    }
    return historyDelta && context
      ? encodeHistoryViewDelta(context.controllerDeviceId, sid, `${lazyDetails}:${workLines}`, historyDelta, page, shape) : page;
  });
  setHistoryWorkPageReader((sid, onShape) => historyView.page(sid, undefined, true, { workLines: true, onShape }));
  ipcMain.handle('local-db:messages:view-intent', (event, sessionId: unknown, refs: unknown) => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
    requireString(sessionId, 'sessionId');
    if (!Array.isArray(refs) || refs.length > 100) throwIpcError('INVALID_PARAMS', 'Invalid expanded work groups');
    const keys = refs.map((ref) => requireString(ref?.key, 'key').replace(/^preview-work-/, 'work-'));
    getDeviceLinkInvokeContext()?.historyView?.setExpanded(keys);
  });
  ipcMain.handle('local-db:messages:work-details', async (event, sessionId: unknown, ref: unknown, opts: unknown) => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
    const sid = requireString(sessionId, 'sessionId');
    const value = ref as { key?: unknown; firstMessageId?: unknown; lastMessageId?: unknown; firstStoredMessageId?: unknown; lastStoredMessageId?: unknown; liveMessageIds?: unknown; parentToolUseId?: unknown } | null;
    const after = (opts as { after?: unknown } | null)?.after;
    if (value?.liveMessageIds != null && (!Array.isArray(value.liveMessageIds) || value.liveMessageIds.length > MAX_HISTORY_SCAN_ROWS)) throwIpcError('INVALID_PARAMS', 'Invalid live work range');
    return historyView.details(sid, {
      key: requireString(value?.key, 'key'),
      ...(value?.parentToolUseId == null ? {} : { parentToolUseId: requireString(value.parentToolUseId, 'parentToolUseId') }),
      firstMessageId: requireString(value?.firstMessageId, 'firstMessageId'),
      lastMessageId: requireString(value?.lastMessageId, 'lastMessageId'),
      ...(value?.firstStoredMessageId == null ? {} : { firstStoredMessageId: requireString(value.firstStoredMessageId, 'firstStoredMessageId') }),
      ...(value?.lastStoredMessageId == null ? {} : { lastStoredMessageId: requireString(value.lastStoredMessageId, 'lastStoredMessageId') }),
      ...(Array.isArray(value?.liveMessageIds) ? { liveMessageIds: value.liveMessageIds.map((id) => requireString(id, 'liveMessageId')) } : {}),
    }, after == null ? undefined : requireString(after, 'after'));
  });

  ipcMain.handle(
    'local-db:messages:around',
    async (_e, sessionId: unknown, messageId: unknown, opts: unknown) => {
      const sid = requireString(sessionId, 'sessionId');
      const mid = requireString(messageId, 'messageId');
      const radius = clampAroundRadius((opts as { radius?: unknown } | undefined)?.radius);
      const imageDbClient = getDbClient();
      const db = imageDbClient.drizzle;

      const [sessionRow] = await db
        .select({ clearedAt: sessions.clearedAt })
        .from(sessions)
        .where(eq(sessions.id, sid))
        .limit(1);
      if (!sessionRow) throwIpcError('NOT_FOUND', 'Session 不存在');

      const clearedAtMs = sessionRow.clearedAt ?? null;
      const visibleConds = clearedAtMs === null ? [] : [gt(messages.createdAt, clearedAtMs)];

      const [anchor] = await db
        .select({
          ...getMessageSelectFields(),
          rowid: messageRowid,
        })
        .from(messages)
        .where(
          and(
            eq(messages.id, mid),
            eq(messages.sessionId, sid),
            isNull(messages.rewindAt),
            ...visibleConds,
          ),
        )
        .limit(1);
      if (!anchor) throwIpcError('NOT_FOUND', 'Message 不存在');
      const anchorRowid = anchor.rowid;

      const before = await db
        .select({
          ...getMessageSelectFields(),
          rowid: messageRowid,
        })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sid),
            isNull(messages.rewindAt),
            ...visibleConds,
            or(
              lt(messages.createdAt, anchor.createdAt),
              and(eq(messages.createdAt, anchor.createdAt), lt(messageRowid, anchorRowid)),
            ),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messageRowid))
        .limit(radius);

      const after = await db
        .select({
          ...getMessageSelectFields(),
          rowid: messageRowid,
        })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sid),
            isNull(messages.rewindAt),
            ...visibleConds,
            or(
              gt(messages.createdAt, anchor.createdAt),
              and(eq(messages.createdAt, anchor.createdAt), gt(messageRowid, anchorRowid)),
            ),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messageRowid))
        .limit(radius);

      return hydrateLegacyUserTurnCosts(
        (await restoreTaskImageRows(imageDbClient, [...before.reverse(), anchor, ...after])).map(messageToCamelWithRowid),
      );
    },
  );

  ipcMain.handle(
    'local-db:messages:around-client-id',
    async (_e, sessionId: unknown, clientId: unknown, opts: unknown) => {
      const sid = requireString(sessionId, 'sessionId');
      const cid = requireString(clientId, 'clientId');
      const aroundOpts = opts as { radius?: unknown; contentCharLimit?: unknown } | undefined;
      const radius = clampAroundRadius(aroundOpts?.radius);
      const contentCharLimit = requireReferenceContentCharLimit(aroundOpts?.contentCharLimit);
      const imageDbClient = getDbClient();
      const db = imageDbClient.drizzle;

      const [sessionRow] = await db
        .select({ clearedAt: sessions.clearedAt })
        .from(sessions)
        .where(eq(sessions.id, sid))
        .limit(1);
      if (!sessionRow) throwIpcError('NOT_FOUND', 'Session 不存在');

      const clearedAtMs = sessionRow.clearedAt ?? null;
      const visibleConds = clearedAtMs === null ? [] : [gt(messages.createdAt, clearedAtMs)];

      const [anchor] = await db
        .select({
          ...getMessageSelectFields(),
          rowid: messageRowid,
        })
        .from(messages)
        .where(
          and(
            eq(messages.clientId, cid),
            eq(messages.sessionId, sid),
            isNull(messages.rewindAt),
            ...visibleConds,
          ),
        )
        .limit(1);
      if (!anchor) throwIpcError('NOT_FOUND', 'Message 不存在');
      const anchorRowid = anchor.rowid;

      const before = await db
        .select({
          ...getMessageSelectFields(),
          rowid: messageRowid,
        })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sid),
            isNull(messages.rewindAt),
            ...visibleConds,
            or(
              lt(messages.createdAt, anchor.createdAt),
              and(eq(messages.createdAt, anchor.createdAt), lt(messageRowid, anchorRowid)),
            ),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messageRowid))
        .limit(radius);

      const after = await db
        .select({
          ...getMessageSelectFields(),
          rowid: messageRowid,
        })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sid),
            isNull(messages.rewindAt),
            ...visibleConds,
            or(
              gt(messages.createdAt, anchor.createdAt),
              and(eq(messages.createdAt, anchor.createdAt), gt(messageRowid, anchorRowid)),
            ),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messageRowid))
        .limit(radius);

      const rows = await hydrateLegacyUserTurnCosts(
        (await restoreTaskImageRows(imageDbClient, [...before.reverse(), anchor, ...after])).map(messageToCamelWithRowid),
      );
      return capReferenceMessageRows(rows, contentCharLimit);
    },
  );

  ipcMain.handle('local-db:messages:estimatedSessionValue', async (_e, sessionId: unknown, options?: { includeBreakdown?: boolean; clientId?: unknown }) => {
    const sid = requireString(sessionId, 'sessionId');
    // Message panels request only their own round; avoid the task-wide estimate scan as well.
    if (options?.includeBreakdown === true && options.clientId !== undefined) {
      return {
        costBreakdown: await readSessionCostDetails(getDbClient(), sid, requireString(options.clientId, 'clientId')),
        totalValueMoney: null,
        entries: [],
      };
    }
    const db = getDbClient().drizzle;

    const [sessionRow] = await db
      .select({ clearedAt: sessions.clearedAt })
      .from(sessions)
      .where(eq(sessions.id, sid))
      .limit(1);
    const clearedAtMs = sessionRow?.clearedAt ?? null;

    const visibleConds = clearedAtMs === null ? [] : [gt(messages.createdAt, clearedAtMs)];
    const rows = await db
      .select({
        clientId: messages.clientId,
        agentMeta: messages.agentMeta,
      })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sid),
          eq(messages.role, 'assistant'),
          isNull(messages.rewindAt),
          ...visibleConds,
        ),
      );
    const entries = extractEstimatedSessionValueEntries(rows);
    const totalValueMoney = addCompatibleRegionalMoney(entries.map((entry) => entry.money));
    const hasCompleteUsdProjection = entries.every((entry) => typeof entry.costUsd === 'number');
    return {
      ...(options?.includeBreakdown === true ? { costBreakdown: await readSessionCostDetails(
        getDbClient(), sid, options.clientId === undefined ? undefined : requireString(options.clientId, 'clientId'),
      ) } : {}),
      totalValueMoney,
      ...(hasCompleteUsdProjection
        ? {
            totalValueUsd: entries.reduce((sum, item) => sum + (item.costUsd ?? 0), 0),
          }
        : {}),
      entries,
    };
  });

  ipcMain.handle('local-db:messages:create', async (_e, sessionId: unknown, body: unknown) => {
    const sid = requireString(sessionId, 'sessionId');
    if (!body || typeof body !== 'object') {
      throwIpcError('INVALID_PARAMS', 'body 必须是对象');
    }
    const b = body as {
      clientId?: unknown;
      role?: unknown;
      content?: unknown;
      toolUseId?: unknown;
      agentMeta?: unknown;
      createdAt?: unknown;
    };
    const cid = requireString(b.clientId, 'clientId');
    if (typeof b.role !== 'string' || !VALID_ROLES.has(b.role as MessageRole)) {
      throwIpcError('INVALID_PARAMS', 'role 不合法');
    }
    if (
      b.agentMeta !== undefined &&
      b.agentMeta !== null &&
      (typeof b.agentMeta !== 'object' || Array.isArray(b.agentMeta))
    ) {
      throwIpcError('INVALID_PARAMS', 'agentMeta 必须是对象或 null');
    }
    let createdAt: number | undefined;
    if (b.createdAt !== undefined) {
      const parsed =
        typeof b.createdAt === 'number'
          ? b.createdAt
          : typeof b.createdAt === 'string'
            ? Date.parse(b.createdAt)
            : Number.NaN;
      if (!Number.isFinite(parsed)) {
        throwIpcError('INVALID_PARAMS', 'createdAt 必须是合法时间');
      }
      createdAt = parsed;
    }

    const ipcMeta = b.agentMeta ? { ...(b.agentMeta as Record<string, unknown>) } : null;
    if (ipcMeta) delete ipcMeta.autoReviewUserText;
    return createMessage(sid, {
      clientId: cid,
      role: b.role as MessageRole,
      content: b.content,
      toolUseId: typeof b.toolUseId === 'string' ? b.toolUseId : undefined,
      agentMeta: ipcMeta as AgentMeta | null,
      createdAt,
    });
  });

  // rewind-session：把 SDK echo 出的 user 消息 cc 元信息（uuid / sdkSessionId）
  // 回写到那条已存在的 user 消息。renderer 暂时用不到，注册 IPC 仅为对称完整性。
  ipcMain.handle(
    'local-db:messages:updateAgentMeta',
    async (_e, sessionId: unknown, clientId: unknown, agentMeta: unknown) => {
      const sid = requireString(sessionId, 'sessionId');
      const cid = requireString(clientId, 'clientId');
      if (agentMeta !== null && (typeof agentMeta !== 'object' || Array.isArray(agentMeta))) {
        throwIpcError('INVALID_PARAMS', 'agentMeta 必须是对象或 null');
      }
      const ipcMeta = agentMeta ? { ...(agentMeta as Record<string, unknown>) } : null;
      if (ipcMeta) delete ipcMeta.autoReviewUserText;
      const serialized = ipcMeta ? JSON.stringify(ipcMeta) : null;
      // Preserve Host-authored evidence atomically; the renderer may neither mint nor replace it.
      await getDbClient().drizzle.update(messages).set({ agentMeta: sql`CASE
        WHEN json_valid(${messages.agentMeta}) AND json_type(${messages.agentMeta}, '$.autoReviewUserText') IN ('text', 'object')
        THEN json_set(${serialized ?? '{}'}, '$.autoReviewUserText', json_extract(${messages.agentMeta}, '$.autoReviewUserText'))
        ELSE ${serialized} END` }).where(and(eq(messages.sessionId, sid), eq(messages.clientId, cid)));
    },
  );

  ipcMain.handle(
    'local-db:messages:updateContent',
    async (_e, sessionId: unknown, clientId: unknown, content: unknown) => {
      const sid = requireString(sessionId, 'sessionId');
      const cid = requireString(clientId, 'clientId');
      // User edits invalidate authored text. Card display PATCHes cannot alter the
      // independent Host-accepted answer (older renderers still send those PATCHes).
      await getDbClient().drizzle.update(messages).set({
        agentMeta: sql`CASE WHEN json_valid(${messages.agentMeta})
          THEN json_remove(${messages.agentMeta}, '$.autoReviewUserText') ELSE ${messages.agentMeta} END`,
      }).where(and(eq(messages.sessionId, sid), eq(messages.clientId, cid), eq(messages.role, 'user')));
      const msg = await updateMessageContent(sid, cid, content);
      if (!msg) throwIpcError('NOT_FOUND', 'Message 不存在');
      return msg;
    },
  );

  // error-tail-banner:「关闭 / 忽略」错误行(merge dismissed:true,main 读原
  // content,不丢 sdkError 等字段)。中断行与普通错误行共用。
  ipcMain.handle(
    'local-db:messages:dismiss-error',
    async (_e, sessionId: unknown, clientId: unknown) => {
      const sid = requireString(sessionId, 'sessionId');
      const cid = requireString(clientId, 'clientId');
      // 动态 import:messagePersistBroadcaster 已静态依赖本模块 createMessage,
      // 静态反向 import 会成环。落库前点关闭/重试时先等同一 persistId 写完。
      const { whenTurnErrorPersisted } = await import('../../messagePersistBroadcaster.desktop.js');
      await whenTurnErrorPersisted(sid, cid);
      const msg = await dismissErrorMessage(sid, cid);
      if (!msg) throwIpcError('NOT_FOUND', 'Error message 不存在');
      return msg;
    },
  );
}

/**
 * messages:list 的副作用：旧版导入的任务（codex- / claude- 前缀）第一次打开时接入新导入器。
 *
 * 新导入器在导入时就把完整历史写进 Cindy，打开任务不再读取来源文件（只导入、不同步）。
 * 这里只处理升级前导入、还没接入的旧任务：同步接入正在打开的这一条（与旧版「打开时导入」
 * 同等的等待），其余旧任务在后台一次性接入。普通任务直接返回，不做任何查询。
 *
 * 抽成可注入函数仅为单测(规则 14):默认依赖即生产实现,Electron `ipcMain.handle` 只做 adapter。
 */
export async function runMessagesListImportSideEffects(
  sessionId: string,
  deps: {
    isDeviceLink?: () => boolean;
    adoptLegacy?: (id: string) => Promise<void>;
  } = {},
  opts: { deviceLinkFirstPage?: boolean } = {},
): Promise<void> {
  const isDeviceLink = deps.isDeviceLink ?? isDeviceLinkInvoke;
  // device-link 分页请求跳过（#318 性能语义）；首页照常接入。
  if (isDeviceLink() && !opts.deviceLinkFirstPage) return;
  if (!sessionId.startsWith('codex-') && !sessionId.startsWith('claude-')) return;
  const adopt = deps.adoptLegacy ?? adoptLegacySessionBeforeOpen;
  await adopt(sessionId).catch((err) => {
    log.warn('legacy imported session adoption failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * 内部 API:直接在 main 进程里更新一条 message 的 content（不抛 ipc 错、不 broadcast）。
 * messagePersistBroadcaster 在 tool_result_full 全文覆盖 / tool_result 摘要→全文增长时
 * 用它落库;显示更新搭 maker:event 的 resolvedContent 走,故此处刻意不广播(对齐
 * Option C:单一真相源、避免新增 onUpdated 通道)。
 *
 * 行将不存在(clientId 未落库)→ 返回 null,调用方按需处理(IPC handler 转 NOT_FOUND;
 * broadcaster 忽略)。
 */
/**
 * interrupted-turn-resume / error-tail-banner:把 role='error' 行标记为「已忽略」。
 *
 * main 侧读原 content 后 merge dismissed:true 再写回 —— 不让 renderer 用解析后的
 * 展示字段重建 content(那会丢 sdkError 等未透传字段)。content 非 JSON 对象时包一层
 * { message: 原文 } 保留原始信息。行不存在或 role 不是 'error' 返回 null(调用方转
 * NOT_FOUND);幂等:重复 dismiss 只是重写同值。
 */
/**
 * 消息行广播:本机全部窗口 + device-link tap 通道(控制端镜像)。renderer 的
 * handleMessageCreatedRaw 对已存在 clientId 走 merge/替换语义,因此**更新**行
 * (如 dismiss)复用同一事件即可让 peer 视图刷新,无需新增 onUpdated 通道。
 */
export function broadcastMessageRow(
  sessionId: string,
  msg: Message,
  ownerScope?: DataOwnerBroadcastScope | null,
): void {
  // Main-created rows may bypass the DB mapper. Never broadcast View-only data
  // to top-level renderers or same-account control devices.
  const historyContent = projectMcpAppHistory(msg.content, msg.agentMeta?.mcpApp === true);
  const content = msg.role === 'agent_switch' ? projectHandoffPreview(historyContent) : historyContent;
  const message = content === msg.content ? msg : { ...msg, content };
  broadcastOwnedPayload('local-db:messages:created', { sessionId, message }, ownerScope);
  if (msg.role === 'user' || msg.role === 'assistant') {
    if (hasTaskChangeListener('message')) publishTaskChange({ kind: 'message', sessionId, message }, ownerStampForBroadcast(ownerScope));
    scheduleBotRemoteResourceChangedForSession(sessionId, ownerScope?.ownerScopeKey);
  }
}

export interface MessageDeletedPayload {
  sessionId: string;
  /** 兼容旧控制端：至少移除用户实际点击的目标行。 */
  clientId: string;
  /** 新控制端一次性移除本动作覆盖的整轮记录。 */
  clientIds?: string[];
}

/**
 * assistant 删除覆盖的 Agent 产出角色。agent_switch 是用户主动切换形成的会话
 * 边界，不属于被删除的 AI 输出；autoResume user 行则由下方单独识别并纳入同轮。
 */
const AI_TURN_DELETION_ROLES = new Set([
  'assistant',
  'tool_use',
  'tool_result',
  'ask_user',
  'plan_review',
  'thinking',
  'error',
]);

export interface SubagentTurnDeletionWindow {
  startedAtInclusive: number;
  startedAtExclusive?: number;
}

export interface MessageDeletionTarget {
  id: string;
  role: 'user' | 'assistant';
  deletedClientIds: string[];
  /** Present only when deleting an assistant round. */
  subagentTurnWindow?: SubagentTurnDeletionWindow;
}

/**
 * 消息菜单删除前解析本次动作的完整范围。user 仍只删除自己；assistant 以相邻
 * 真实 user 行为边界，返回整轮 AI 产出，并跳过 autoResume 这类隐藏 user 行。
 * 真正删除由 message.delete 原子事务完成，避免在 renderer / IPC adapter 里拼业务判断。
 */
export async function getMessageDeletionTarget(
  sessionId: string,
  clientId: string,
): Promise<MessageDeletionTarget | null> {
  const db = getDbClient().drizzle;
  const [session] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) return null;
  const afterClear =
    session.clearedAt === null ? undefined : gt(messages.createdAt, session.clearedAt);
  const [row] = await db
    .select({
      id: messages.id,
      role: messages.role,
      createdAt: messages.createdAt,
      rowid: messageRowid,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.clientId, clientId),
        isNull(messages.rewindAt),
        afterClear,
      ),
    )
    .limit(1);
  if (!row || (row.role !== 'user' && row.role !== 'assistant')) return null;
  if (row.role === 'user') {
    return { id: row.id, role: row.role, deletedClientIds: [clientId] };
  }

  const beforeTarget = or(
    lt(messages.createdAt, row.createdAt),
    and(eq(messages.createdAt, row.createdAt), lt(messageRowid, row.rowid)),
  );
  const afterTarget = or(
    gt(messages.createdAt, row.createdAt),
    and(eq(messages.createdAt, row.createdAt), gt(messageRowid, row.rowid)),
  );
  const visibleUser = and(
    eq(messages.sessionId, sessionId),
    eq(messages.role, 'user'),
    isNull(messages.rewindAt),
    afterClear,
  );
  type UserBoundaryRow = {
    createdAt: number;
    rowid: number;
    agentMeta: string | null;
    content: string;
  };
  const scanRealUserBoundary = async (
    direction: 'prior' | 'next',
  ): Promise<UserBoundaryRow | undefined> => {
    let cursor: SQL<unknown> | undefined = direction === 'prior' ? beforeTarget : afterTarget;
    while (cursor) {
      const candidates = await db
        .select({
          createdAt: messages.createdAt,
          rowid: messageRowid,
          agentMeta: messages.agentMeta,
          content: messages.content,
        })
        .from(messages)
        .where(and(visibleUser, cursor))
        .orderBy(
          direction === 'prior' ? desc(messages.createdAt) : asc(messages.createdAt),
          direction === 'prior' ? desc(messageRowid) : asc(messageRowid),
        )
        .limit(MESSAGE_DELETION_USER_BOUNDARY_PAGE_SIZE);
      const boundary = candidates.find(
        (candidate) => !isHiddenContinuationUserMessage(candidate.agentMeta, candidate.content),
      );
      if (boundary) return boundary;
      const last = candidates.at(-1);
      if (!last || candidates.length < MESSAGE_DELETION_USER_BOUNDARY_PAGE_SIZE) return undefined;
      cursor =
        direction === 'prior'
          ? or(
              lt(messages.createdAt, last.createdAt),
              and(eq(messages.createdAt, last.createdAt), lt(messageRowid, last.rowid)),
            )
          : or(
              gt(messages.createdAt, last.createdAt),
              and(eq(messages.createdAt, last.createdAt), gt(messageRowid, last.rowid)),
            );
    }
    return undefined;
  };
  const [priorUser, nextUser] = await Promise.all([
    scanRealUserBoundary('prior'),
    scanRealUserBoundary('next'),
  ]);
  const afterPriorUser = priorUser
    ? or(
        gt(messages.createdAt, priorUser.createdAt),
        and(eq(messages.createdAt, priorUser.createdAt), gt(messageRowid, priorUser.rowid)),
      )
    : undefined;
  const beforeNextUser = nextUser
    ? or(
        lt(messages.createdAt, nextUser.createdAt),
        and(eq(messages.createdAt, nextUser.createdAt), lt(messageRowid, nextUser.rowid)),
      )
    : undefined;
  const roundRows = await db
    .select({
      clientId: messages.clientId,
      role: messages.role,
      agentMeta: messages.agentMeta,
      content: messages.content,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        isNull(messages.rewindAt),
        afterClear,
        afterPriorUser,
        beforeNextUser,
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messageRowid));
  const deletedClientIds = roundRows.flatMap((candidate) => {
    if (AI_TURN_DELETION_ROLES.has(candidate.role)) return [candidate.clientId];
    if (
      candidate.role === 'user' &&
      isHiddenContinuationUserMessage(candidate.agentMeta, candidate.content)
    ) {
      return [candidate.clientId];
    }
    return [];
  });
  if (!deletedClientIds.includes(clientId)) return null;
  return {
    id: row.id,
    role: row.role,
    deletedClientIds,
    subagentTurnWindow: {
      startedAtInclusive: priorUser?.createdAt ?? session.clearedAt ?? 0,
      ...(nextUser ? { startedAtExclusive: nextUser.createdAt } : {}),
    },
  };
}

/**
 * 原子清除一次删除动作覆盖的全部正文/元数据，并让 session 不再 resume 旧原生 transcript。最小
 * tombstone 只保留身份与排序字段，防外部历史重新导入；context_rebuild 行
 * 固定带 rewind_at，普通列表/搜索/导出不可见，只承担重启后的 pending handoff
 * 恢复。媒体引用只通过 cindy-media ledger 释放，不直接碰字节文件。
 */
export async function commitMessageDeletion(
  sessionId: string,
  clientIds: string[],
  handoff: string,
  subagentTurnWindow?: SubagentTurnDeletionWindow,
  handoffCoverage?: HandoffCoverage,
): Promise<{
  sessionId: string;
  deletedClientIds: string[];
  subagentRunIds: string[];
  updatedAt: number;
  preview: string | null;
}> {
  const now = Date.now();
  const result = await getDbClient().tx('message.delete', {
    sessionId,
    clientIds,
    ...(subagentTurnWindow ? { subagentTurnWindow } : {}),
    contextMarker: {
      id: createId(),
      clientId: `context-rebuild:${createId()}`,
      content: JSON.stringify({ handoff, handoffCoverage, consumed: false, reason: 'message-deletion' }),
      createdAt: now,
    },
    updatedAt: now,
  });

  // 当前生产聊天附件主要是 session-attachment 粗粒度引用，不能因删除一轮
  // 误删同 session 其它气泡仍在用的 blob。这里只释放明确以消息 id/clientId
  // 登记的 message refs；零引用 blob 由 recycler 统一回收。
  const mediaRefIds = [
    ...new Set(result.messages.flatMap((message) => [message.messageId, message.clientId])),
  ];
  const mediaCleanup = await Promise.allSettled(
    mediaRefIds.map((refId) => removeMediaRefs({ refKind: 'message', refId })),
  );
  for (const [index, cleanup] of mediaCleanup.entries()) {
    if (cleanup.status === 'fulfilled') continue;
    log.warn('message media ref cleanup failed', {
      sessionId,
      deletedClientIds: clientIds,
      refId: mediaRefIds[index],
      error: cleanup.reason instanceof Error ? cleanup.reason.message : String(cleanup.reason),
    });
  }

  void recomputePrRefsForSession(sessionId).catch(() => undefined);

  // sessions:patched 的消费者只做 shallow merge，不会主动重拉。删除后同步带出 canonical
  // preview，避免其它窗口 / device-link 控制端继续显示已删除的末条消息。preview 口径与
  // sessions:list 的 LATEST_MSG_CONTENT_SQL 一致：可见 user/assistant，过滤 rewind_at /
  // agentMeta.autoResume / cleared_at。
  //
  // 刻意**不**广播 `_count.messages`：列表里 `_count.messages` 的权威口径是该会话的全部
  // messages 行数（sessions.ts 的 SESSION_MESSAGE_COUNT_SQL，不过滤
  // role / rewind_at / cleared_at），而下面这个可见投影只数 user/assistant 行——一个正常
  // 会话里 tool_use / tool_result / thinking / error 行往往是它的几十倍，拿它去 patch 会把
  // 侧栏与手机端卡片的「N 条消息」改成明显偏小的值，且 shallow merge 消费端不会自己纠正，
  // 错值一直留到下次完整 reseed。
  //
  // 那为什么不顺手广播权威口径？因为删除对它的影响只有 0 或 +1，不值得每次删除多跑一次
  // 全表 count：message.delete 事务（worker/opHandlers/tx.ts）先物理删掉该会话所有旧
  // context_rebuild 行，再把目标行原地改成 message_tombstone（保留，不删行），最后插入
  // 一个新的 context_rebuild 行——首次删除（无旧标记）净 +1，之后每次删旧插新、净 0。
  // 差的这一行是用户看不见的隐藏派生行（普通列表 / 搜索 / 导出都按 rewind_at 过滤掉它），
  // 下次完整 reseed 即收敛；而事务外单独查的标量本身也带竞态（并发落消息时它已不等于
  // 「删除后那一刻」的值）。要真的同步就得广播不过滤的 count(*)，见 issue #1282 的讨论。
  // 口径要动得连 maker-shared/sessionList 的 messageCountLabel 一起改。
  let preview: string | null = null;
  try {
    const latest = await latestVisiblePreviewRow(sessionId);
    preview = extractMessagePreview(latest?.content, latest?.role);
    // Keep the transaction's invalidation. Only SQL backfill may populate the
    // raw Markdown cache; persisting this display text would parse code literals
    // a second time on the next list read (and could overwrite a newer edit).
  } catch (error) {
    // 删除已经原子提交；message.delete 事务已把 list_preview / role / count 置 NULL，
    // 投影刷新失败不能把成功操作伪装成失败。广播保守空值，list 回落子查询。
    log.warn('message delete session projection refresh failed', {
      sessionId,
      deletedClientIds: clientIds,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    sessionId,
    deletedClientIds: result.messages.map((message) => message.clientId),
    subagentRunIds: result.subagentRunIds,
    updatedAt: now,
    preview,
  };
}

export function commitContextRebuild(
  sessionId: string,
  handoff: string,
  meta: {
    reason:
      | 'context-overflow'
      | 'model-window-switch'
      | 'pi-prompt-timeout'
      | 'native-session-recovery'
      | 'idle-gap';
    sourceUserClientId: string | null;
    handoffCoverage?: HandoffCoverage;
    sourceAgentKind?: 'cc' | 'codex' | 'pi';
    sourceModel?: string | null;
    sourceProviderId?: string | null;
    expectedClearedAt?: number | null;
    expectedSdkSessionId?: string;
    replacementRoute?: ContextRebuildArgs['replacementRoute'];
  },
): Promise<{ updatedAt: number }> {
  return commitContextRebuildWithPorts({
    now: () => Date.now(),
    createId: () => createId(),
    tx: (...args) => getDbClient().tx(...args),
  }, sessionId, handoff, meta);
}

export function broadcastMessageDeleted(
  payload: MessageDeletedPayload,
  ownerScope?: DataOwnerBroadcastScope | null,
): void {
  scheduleBotRemoteResourceChangedForSession(payload.sessionId, ownerScope?.ownerScopeKey);
  const ownerStamp = ownerStampForBroadcast(ownerScope);
  if (ownerStamp === null) return;
  scheduleNativeHistoryBackupCleanup(payload.sessionId);
  if (ownerScope !== undefined && ownerScope !== null) {
    broadcastTap.tapWindowBroadcast('local-db:messages:deleted', payload, ownerStamp);
  } else if (ownerStamp === undefined) {
    broadcastTap.tapWindowBroadcast('local-db:messages:deleted', payload);
  } else {
    broadcastTap.tapWindowBroadcast('local-db:messages:deleted', payload, ownerStamp);
  }
  const hasCapturedScope = ownerScope !== undefined && ownerScope !== null;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      if (hasCapturedScope) win.webContents.send('local-db:messages:deleted', payload, ownerStamp);
      else if (ownerStamp === undefined) win.webContents.send('local-db:messages:deleted', payload);
      else win.webContents.send('local-db:messages:deleted', payload, ownerStamp);
    } catch {
      /* swallow per-window broadcast failures */
    }
  }
}

/** Shared clear-race tombstone; Desktop retains its existing broadcast scope. */
export const rewindPersistedUserMessageAfterClear = createMessageClearRecovery({
  captureOwnerBroadcastScope: () => captureOwnerBroadcastScope(),
  isOwnerBroadcastScopeCurrent: scope => isOwnerBroadcastScopeCurrent(scope),
  getDbClient: () => getDbClient(),
  removeMediaRefs: params => removeMediaRefs(params),
  collectCindyMediaHashes: content => collectCindyMediaHashes(content),
  removeSessionAttachmentRefIfUnreferencedByLiveMessage: params => removeSessionAttachmentRefIfUnreferencedByLiveMessage(params),
  broadcastMessageDeleted: (payload, scope) => broadcastMessageDeleted(payload, scope),
  recomputePrRefsForSession: id => recomputePrRefsForSession(id),
  log,
});

export async function purgeRewoundSchedulerPrompts(
  limit = 100,
  cursor = 0,
): Promise<{ deleted: number; sessionIds: string[]; cursor: number | null }> {
  const ownerScope = captureOwnerBroadcastScope();
  if (!isOwnerBroadcastScopeCurrent(ownerScope)) return { deleted: 0, sessionIds: [], cursor: null };
  return getDbClient().tx('message.purgeRewoundSchedulerPrompts', { limit, cursor });
}
export async function dismissErrorMessage(
  sessionId: string,
  clientId: string,
): Promise<Message | null> {
  const ownerScope = captureOwnerBroadcastScope();
  const db = getDbClient().drizzle;
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId)))
    .limit(1);
  if (!row || row.role !== 'error') return null;
  const updated = await updateMessageContent(
    sessionId,
    clientId,
    mergeDismissedIntoErrorContent(row.content),
  );
  // 广播更新行(review P2):dismiss 若只写 DB,同会话开在其它窗口/被控端本机
  // 窗口的内存 errorDismissed 仍为 false,stale 尾部 banner 留着还能对已忽略的
  // 错误重复 enqueue 续跑。peer 端 handleMessageCreatedRaw 按 clientId merge,
  // banner 判定即时熄灭;发起端自身的乐观更新早已生效,重复广播幂等。
  if (updated && isOwnerBroadcastScopeCurrent(ownerScope)) {
    broadcastMessageRow(sessionId, updated, ownerScope);
  }
  return updated;
}

/**
 * retry-supersede:零产出失败 turn 被「重试」克隆重发后,软删被取代的旧 user 行
 * 与其后的 role='error' 行(coordinator 在克隆行落库且 vendor 派发成功之后调用,见
 * AgentInputQueuedMessage.supersedesUserClientId)。
 *
 * 语义与守卫:
 *  - 软删 = 置 rewind_at。普通历史读取、fork 复制、外部 transcript 导入、错误
 *    尾行告警全部按 rewind_at IS NULL 过滤,行本体保留可审计——与 context_rebuild
 *    借该列隐藏的既有先例同口径,不是 rewind-session 的回滚语义。
 *  - error 行按 (created_at, rowid) 双键窗口定位:严格晚于旧 user 行、严格早于
 *    克隆行。零产出失败的窗口内只可能有本次失败的 error 行;role 过滤兜底,
 *    绝不触碰任何产出行。
 *  - 旧行必须仍是可见的 user 行、克隆行必须已落库,任一缺失即整体 no-op(防御
 *    误传参与 deferred error 补落竞态);UPDATE 带 rewind_at IS NULL,重复调用幂等。
 *  - 单条 UPDATE 原子置位后经 messages:deleted 广播(本机各窗口 + device-link
 *    转发),desktop / mobile 的移除处理复用消息删除的既有消费端。
 *  - **刻意不广播 sessions:patched**(review 追问过):会话列表 `_count.messages` 的
 *    权威口径是「该会话全部 messages 行数,不过滤 role / rewind_at / cleared_at」
 *    (见 sessions.ts 的 SESSION_MESSAGE_COUNT_SQL),而软删只置 rewind_at 不删行,
 *    总行数不变;preview 口径虽过滤 rewind_at,但克隆行 created_at 更大、始终是最新
 *    可见行,也不变。两个值都没变,广播是多余的;拿「可见 user/assistant 数」去覆盖
 *    _count 更会把侧栏与被控端的计数打成偏小值(消费端只 shallow merge,错到下次
 *    reseed 才收敛)。
 *
 * @returns 实际软删的 clientIds(空数组 = no-op),仅供调用方与测试观察。
 */
export async function supersedeRetriedUserTurn(
  sessionId: string,
  args: { supersededUserClientId: string; retryUserClientId: string },
): Promise<string[]> {
  return supersedeRetriedUserTurnWithPorts(sessionId, args, {
    captureOwnerBroadcastScope, isOwnerBroadcastScopeCurrent, broadcastMessageDeleted,
  });
}

/** Settle media publication off the global message queue, using its captured DB. */
async function reconcileAssistantMediaRefs(row: MessageRow, dbClient: DbClient): Promise<void> {
  await Promise.all([...(pendingMediaWrites.get(dbClient)?.get(row.id) ?? [])]);
  // Cleanup belongs to the committed mutation even if clear/owner changes while
  // publication settles. Use its captured DB and atomic live-message predicate;
  // never republish derived state into the replacement scope.
  for (const hash of collectCindyMediaHashes(row.content)) {
    try {
      // Existing ledger lock + atomic live-message predicate protect shared blobs.
      await removeSessionAttachmentRefIfUnreferencedByLiveMessage(
        { sessionId: row.sessionId, hash }, dbClient.drizzle,
      );
    } catch (error) {
      log.warn('assistant correction media reference reconciliation failed', {
        sessionId: row.sessionId, clientId: row.clientId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Reconcile only the corrected row's derived state against current live history. */
async function reconcileAssistantDerivedState(
  row: MessageRow,
  dbClient: DbClient,
  isCurrent: () => boolean,
  ownerScope: DataOwnerBroadcastScope | null,
  refreshPreview: boolean,
): Promise<void> {
  // Slow media publication must not hold every task's message write queue.
  // Cleanup still waits for this row's hooks and retains the live-reference check.
  void reconcileAssistantMediaRefs(row, dbClient).catch((error) => {
    log.warn('assistant correction media reconciliation failed', {
      sessionId: row.sessionId, clientId: row.clientId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  await reconcileCorrectedMessagePrRefs(row, dbClient, isCurrent);
  if (!refreshPreview || !isCurrent()) return;
  try {
    const latest = await latestVisiblePreviewRow(row.sessionId);
    if (!isCurrent()) return;
    broadcastOwnedPayload('local-db:sessions:patched', {
      sessionId: row.sessionId,
      patch: { preview: extractMessagePreview(latest?.content, latest?.role) },
    }, ownerScope);
  } catch (error) {
    log.warn('assistant retraction preview refresh failed', {
      sessionId: row.sessionId, clientId: row.clientId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Retract an assistant draft rejected by its authoritative empty final.
 * Reuse the exact-row publication rollback so preview/count invalidation is
 * atomic and a concurrent edit or replacement can never be removed.
 */
export async function discardPersistedAssistantMessage(
  sessionId: string,
  clientId: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const ownerScope = captureOwnerBroadcastScope();
  const dbClient = getDbClient();
  if (!isCurrent() || !isOwnerBroadcastScopeCurrent(ownerScope)) return false;
  const row = await rollbackAssistantMessageRow(dbClient, sessionId, clientId,
    () => isCurrent() && isOwnerBroadcastScopeCurrent(ownerScope));
  if (!row) return false;
  await reconcileAssistantDerivedState(row, dbClient,
    () => isCurrent() && isOwnerBroadcastScopeCurrent(ownerScope), ownerScope, true);
  return true;
}

export async function updateMessageContent(
  sessionId: string,
  clientId: string,
  content: unknown,
  autoReviewAnswer?: { text: string; acceptedAt: number },
  finalSnapshot?: { isCurrent: () => boolean },
): Promise<Message | null> {
  const ownerScope = captureOwnerBroadcastScope();
  const dbClient = getDbClient();
  const db = dbClient.drizzle;
  const isCurrent = () => isOwnerBroadcastScopeCurrent(ownerScope) && finalSnapshot?.isCurrent() !== false;
  const [original] = finalSnapshot
    ? await db.select().from(messages).where(and(eq(messages.sessionId, sessionId),
      eq(messages.clientId, clientId), eq(messages.role, 'assistant'), isNull(messages.rewindAt))).limit(1)
    : [];
  if (finalSnapshot && (!original || !isCurrent())) return null;
  const updated = await writeMessageContentRow(dbClient, sessionId, clientId, content, autoReviewAnswer);
  const row: MessageRow | undefined = updated
    ? (await restoreTaskImageRows(dbClient, [updated]))[0] : undefined;
  if (row && (!finalSnapshot || isCurrent())) {
    // 挂账钩子同样覆盖"先摘要 create、后全文 update"的 tool_result 顺序
    // (review P2:vendor 事件顺序一变,首现于 update 的 blob URL 若不在这里
    // 挂账就永久零引用);幂等,create 时已挂的 hasRef 跳过。
    trackMessageMediaWrite(dbClient, row.id, commitMessageMediaRefs({
      sessionId,
      role: row.role,
      content: row.content,
    }).then(() => undefined).catch((err) => {
      log.warn('message media ref commit failed (update)', {
        sessionId,
        clientId,
        error: err instanceof Error ? err.message : String(err),
      });
    }));
    await maybeBroadcastSessionListPreview(sessionId, row, ownerScope, finalSnapshot?.isCurrent);
  }
  // The correction already committed: settle its original publication even if
  // clear/owner changed or another deletion removed the row during readback.
  if (original) await reconcileAssistantDerivedState(original, dbClient, isCurrent, ownerScope, false);
  else if (row && (row.role === 'user' || row.role === 'assistant')) {
    await reconcileUpdatedMessagePrRefs(dbClient, sessionId, row.id, isCurrent);
  }
  return row ? messageToCamel(row) : null;
}

function clampAroundRadius(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 60;
  return Math.min(Math.max(Math.floor(n), 0), 200);
}

function requireReferenceContentCharLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 8_000) {
    throwIpcError(
      'INVALID_PARAMS',
      'contentCharLimit must be an integer between 1 and 8000 or null',
    );
  }
  return raw;
}

/**
 * 内部 API：直接在 main 进程里写一条 message。
 * agentManager 在 SDK echo 时落 user 消息走的就是这个——不再让 renderer 兜
 * 一圈 IPC 落库再回推。
 *
 * 与 IPC handler 行为完全对齐：
 *  - (sessionId, clientId) UNIQUE 幂等：已存在则返回已有 row（不报错）
 *  - 并发命中 UNIQUE 约束时回退读
 *  - 返回 camelCase Message
 *
 * 不抛 ipc 错（无 [CODE] 前缀），调用方按普通 Error 处理。
 */
export async function createMessage(
  sessionId: string,
  body: {
    clientId: string;
    role: MessageRole;
    content: unknown;
    toolUseId?: string;
    agentMeta?: AgentMeta | null;
    /**
     * 产出本行的 agent 引擎('cc' / 'codex')。session-agent-switch 后按行解析
     * agentMeta 需要它;main 侧 SDK 事件落库路径必传,renderer pending echo 等
     * 无 SDK 元信息的行留空(null 回落 session.agentKind)。
     */
    agentKind?: 'cc' | 'codex' | 'pi' | null;
    createdAt?: number;
  },
  opts?: {
    /**
     * Main-side callers that race with /clear can persist an old row whose
     * createdAt is already behind the clear boundary. The row is harmless for
     * history queries, but broadcasting it would resurrect the cleared bubble in
     * every renderer window. Keep this guard next to the broadcast, where the
     * final "is this still current?" check is actually meaningful.
     */
    shouldBroadcast?: () => boolean;
    /** Host-only admission guard, checked before and after the publication transaction.
     * Must be repeatable. A failed final check rolls back this exact row before delivery hooks. */
    beforePublish?: () => Promise<void>;
    /** Host delivery owns its guarded attachment commit and compensation. */
    deferMediaRefs?: boolean;
    /**
     * Optional clear-boundary compare-and-set for optimistic user sends.  The
     * insert is accepted only while the session still has this exact
     * `clearedAt` value.  This closes the window where `/clear` wins the DB
     * update while an already-accepted `Session.send()` is still awaiting its
     * durable user row.
     */
    expectedClearBoundaryMs?: number | null;
    /** Skip a host-written opening if the user has already spoken, checked in the insert transaction. */
    requireNoUserMessage?: boolean;
    /**
     * Owner scope captured before an async main-side write.  A stale scope
     * must not broadcast a row into the next signed-in owner.
     */
    broadcastOwnerScope?: DataOwnerBroadcastScope | null;
  },
): Promise<Message> {
  const dbClient = getDbClient();
  const { row, created } = await writeMessageRow(dbClient, sessionId, body, opts);
  if (!created) return messageToCamel(row);
  const [restoredRow] = await restoreTaskImageRows(dbClient, [row]);
  const msg = messageToCamel(restoredRow);
  // 媒体总仓挂账钩子(规则 25):消息落库是"blob 归属本会话"的
  // 确定时点,覆盖所有落库来源(renderer IPC / hook / im / agent echo / 合成
  // tool_result)。生成产物(art/mivo/codex)入仓时零引用,在这里补挂
  // session-attachment 引用;用户附件已在发送链路 commit 过,hasRef 幂等跳过。
  // 传 row.content(已序列化字符串)避免二次 stringify(review P2)。
  const commitMediaRefs = async (): Promise<void> => {
    try {
      await commitMessageMediaRefs({
        sessionId,
        role: body.role,
        content: row.content,
      });
    } catch (err) {
      log.warn('message media ref commit failed', {
        sessionId,
        clientId: body.clientId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  // Optimistic user rows carry the clear token and are written through the
  // durable FIFO. Await their media commit so a later clear/rewind cannot be
  // overtaken by a fire-and-forget session-attachment ref. Other message roles
  // stay non-blocking on the hot event path.
  const shouldAwaitMediaRefs =
    body.role === 'user' &&
    opts !== undefined &&
    Object.prototype.hasOwnProperty.call(opts, 'expectedClearBoundaryMs');
  if (!opts?.deferMediaRefs) {
    const mediaWrite = trackMessageMediaWrite(dbClient, row.id, commitMediaRefs());
    if (shouldAwaitMediaRefs) await mediaWrite;
  }
  // Broadcast 给所有 renderer window — 用于 main 端创建消息 (e.g. feishu /ctr
  // 接管路径下 persistUserMessage / persistAssistantMessage) 时让 renderer
  // 的 makerChatStore push 到 in-memory state, 让消息流实时刷新。
  // Renderer 自己调 createMessage IPC 时也会触发这个 broadcast, 但因为它已经
  // 主动 push 过, 监听端按 (sessionId, clientId) dedupe 就不会重复显示。
  if (opts?.shouldBroadcast?.() !== false) {
    broadcastMessageRow(sessionId, msg, opts?.broadcastOwnerScope);
    await maybeBroadcastSessionListPreview(sessionId, restoredRow, opts?.broadcastOwnerScope);
  }
  // chat-history-embedder hook (Phase 1.2) —— fire-and-forget, 不 await。
  // 内部已有 enabled / cutoff / role / size 守卫; 关闭状态下零成本直接 return。
  // 失败仅 log warn, 绝不传播错让 createMessage 返回值受影响。
  void onChatMessageCreatedForEmbedding(msg).catch(() => {
    // 双保险: chat-history-embedder.onMessageCreated 内部已 try/catch,
    // 此处 .catch 仅防御该函数将来被 refactor 时漏掉的异常路径。
  });
  // session-git-pr-context hook —— fire-and-forget。内部限定 user/assistant 角色,
  // 每条消息跑一次锚定正则线性扫描(开销可忽略);失败仅 log warn。
  trackMessagePrRefs(dbClient, msg);
  return msg;
}

/**
 * rewind-session 内部 API：把已落库消息的 agent_meta 字段更新为 SDK 给的 cc 元信息
 * （uuid / sdkSessionId / ...）。已是 TEXT JSON 字符串形态，不再做 stringify。
 *
 * 用于 agentManager case 'user'：SDK echo user 消息后补 uuid。失败仅 log warn。
 */
export async function updateAgentMeta(
  sessionId: string,
  clientId: string,
  agentMetaJson: string | null,
): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(messages)
    .set({ agentMeta: agentMetaJson })
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId)));
}

export function extractEstimatedSessionValueEntries(
  rows: Array<{ clientId: string; agentMeta: string | null }>,
): EstimatedSessionValueEntry[] {
  const entries: EstimatedSessionValueEntry[] = [];
  for (const row of rows) {
    if (!row.clientId || !row.agentMeta) continue;
    let meta: AgentMeta | null = null;
    try {
      const parsed = JSON.parse(row.agentMeta);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as AgentMeta;
      }
    } catch {
      continue;
    }
    if (meta?.turnCostIsEstimate !== true) {
      const estimate = addCompatibleRegionalMoney((normalizeTurnUsageDetails(meta?.turnUsageDetails)?.perModelCost ?? [])
        .filter(item => item.money.kind === 'value-estimate').map(item => item.money));
      if (estimate?.amount) entries.push({ clientId: row.clientId, money: estimate,
        ...(estimate.currency === 'USD' ? { costUsd: estimate.amount } : {}) });
      continue;
    }
    const structured = normalizeRegionalMoney(meta.turnCost);
    if (structured && structured.amount > 0) {
      const recomputed =
        structured.currency === 'USD'
          ? resolveStaleCodexSubscriptionValueEstimate(
              structured.amount,
              normalizeTurnUsageDetails(meta.turnUsageDetails),
              meta.model,
            )
          : null;
      const money = asValueEstimateMoney({
        ...structured,
        amount: recomputed ?? structured.amount,
      });
      entries.push({
        clientId: row.clientId,
        money,
        ...(money.currency === 'USD' ? { costUsd: money.amount } : {}),
      });
      continue;
    }
    if (
      typeof meta.turnCostUsd !== 'number' ||
      !Number.isFinite(meta.turnCostUsd) ||
      meta.turnCostUsd <= 0
    ) {
      continue;
    }
    const recomputed = resolveStaleCodexSubscriptionValueEstimate(
      meta.turnCostUsd,
      normalizeTurnUsageDetails(meta.turnUsageDetails),
      meta.model,
    );
    const costUsd = recomputed ?? meta.turnCostUsd;
    entries.push({
      clientId: row.clientId,
      money: usdMoney(costUsd, 'value-estimate', 'legacy-usd'),
      costUsd,
    });
  }
  return entries;
}

/**
 * 对已落库消息的 agent_meta 做 read-merge-write 补丁(不能整列覆盖——会丢 uuid /
 * model 等 rewind / fork 锚点字段)。现有 agent_meta 为 null 或 parse 失败时以 {}
 * 为底。返回 false 表示该行不存在(典型:rewind 已删),调用方据此跳过广播。
 *
 * 用于 turnCostBroadcaster:turn 结束后把 per-turn 费用挂到该轮最后一条 assistant。
 */

/** Stable native identity of a visible user input; do not match retries by text. */
export async function readPiUserEntry(sessionId: string, clientId: string): Promise<string | undefined> {
  return readVisiblePiUserEntry(getDbClient(), sessionId, clientId);
}

/** 与 patchMessageAgentMeta 相同，但返回补丁前后的元数据供幂等账本计算。 */
export async function patchMessageAgentMetaWithResult(sessionId: string, clientId: string, patch: Record<string, unknown>): Promise<MessageAgentMetaPatchResult | null> {
  return patchMessageAgentMetaWithResultRow(getDbClient(), sessionId, clientId, patch);
}


/**
 * Recover a durable tool-use row after process-local event linkage was lost.
 * The session clear boundary is part of visibility: a restart must not make a
 * pre-clear row eligible for a late background terminal update again.
 */
export async function findVisibleToolUseMessageByAliases(sessionId: string, aliases: readonly string[]): Promise<VisibleToolUseMessageLink | null> {
  return findVisibleToolUseMessageByAliasesRow(getDbClient(), sessionId, aliases);
}

export async function patchMessageAgentMeta(
  sessionId: string,
  clientId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  return (await patchMessageAgentMetaWithResult(sessionId, clientId, patch)) !== null;
}

/**
 * agent_meta patch 后把权威完整行复用 messages:created 通道广播。现有 renderer 与
 * device-link reducer 都按 clientId merge，因此不需要新增 IPC channel。
 */
export async function broadcastMessageAgentMetaUpdate(
  sessionId: string,
  clientId: string,
  ownerScope?: DataOwnerBroadcastScope | null,
): Promise<boolean> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.clientId, clientId),
        isNull(messages.rewindAt),
      ),
    )
    .limit(1);
  if (!row) return false;
  if (!isOwnerBroadcastScopeCurrent(ownerScope)) return false;
  broadcastMessageRow(sessionId, messageToCamel(row), ownerScope);
  return true;
}

/** DB content 可为 JSON string、含 text 的对象，或迁移前遗留的裸文本。 */
function readMessageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).text === 'string'
    ) {
      return (parsed as Record<string, unknown>).text as string;
    }
  } catch {
    // 裸文本按原值识别，兼容迁移前记录。
  }
  return content;
}

function isHiddenContinuationUserMessage(agentMeta: string | null, content: string): boolean {
  return isAutoResumeUserMessage(agentMeta) || isSyntheticTriggerText(readMessageText(content));
}


export type { ParkedEngineSession } from '../agentSwitchRows.js';
export { findParkedEngineSession } from '../agentSwitchRows.js';

/**
 * session-agent-switch Phase 2:改写边界行 content 并广播(resume bootstrap 失败
 * 回落全量交接时,边界卡展示的交接全文与 DB pending 重建源必须跟着换成实际注入
 * 的版本)。广播复用 created 通道——renderer 对已存在 clientId 走 merge/替换语义。
 */
export async function updateAgentSwitchBoundaryContent(
  sessionId: string,
  clientId: string,
  content: unknown,
  ownerScope: DataOwnerBroadcastScope | null = captureOwnerBroadcastScope(),
): Promise<boolean> {
  const updated = await updateMessageContent(sessionId, clientId, content);
  if (!updated) return false;
  if (isOwnerBroadcastScopeCurrent(ownerScope)) {
    broadcastMessageRow(sessionId, updated, ownerScope);
  }
  return true;
}

/** vendor accepted 后持久化最新 handoff 消费位；内存 registry 不等待这笔辅助写。 */
export function markLatestAgentHandoffConsumed(sessionId: string): Promise<void> {
  return markLatestAgentHandoffConsumedWithPorts({
    captureOwnerBroadcastScope,
    updateAgentSwitchBoundaryContent,
  }, sessionId);
}

/** 原子事务提交后只读并广播边界新行，不做第二次写入。 */
export async function rebroadcastAgentSwitchBoundary(
  sessionId: string,
  boundaryClientId: string,
  ownerScope: DataOwnerBroadcastScope | null = captureOwnerBroadcastScope(),
): Promise<void> {
  return rebroadcastAgentSwitchBoundaryWith({ isOwnerBroadcastScopeCurrent, broadcastMessageRow }, sessionId, boundaryClientId, ownerScope);
}
