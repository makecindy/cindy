/**
 * chat-data-localization F5：Messages IPC handlers（C7）。
 *
 * - `list(sessionId, opts)` —— 按 createdAt/rowid desc，limit 默认 50/上限 100；before 为 cursor message id
 * - `create(sessionId, body)` —— `(sessionId, clientId)` 唯一索引保证幂等：已存在则返回已有记录
 * - `updateContent(sessionId, clientId, content)` —— 用于 ask_user 的 answered 状态等
 */

import { ipcMain, BrowserWindow } from 'electron';
import { and, asc, eq, inArray, lt, gt, gte, desc, isNull, or, sql, type SQL } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';

import { getDbClient } from '../client/current';
import { messages, sessions } from '../schema';
import {
  messageToCamel,
  messageCreateToRow,
  safeStringify,
  extractMessagePreview,
} from '../mapper';
import { optionalEnum, throwIpcError, requireObject, requireString } from '../../utils/ipcValidate';
import * as broadcastTap from '../../device-link/broadcast-tap';
import { createLogger } from '../../logger';
import { collectCindyMediaHashes, commitMessageMediaRefs } from '../../cindy-media/chatAttachments';
import {
  removeRefs as removeMediaRefs,
  removeSessionAttachmentRefIfUnreferencedByLiveMessage,
} from '../../cindy-media/ledger';
import { importExternalCodexMessagesForSession } from '../../maker-host/codex-local-sessions';
import { importExternalClaudeCodeMessagesForSession } from '../../maker-host/claude-local-sessions';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { onMessageCreated as onChatMessageCreatedForEmbedding } from '../../embedders/chat-history-embedder';
import { recomputePrRefsForSession, recordPrRefsForMessage } from '../../git-context/prRefsStore';
import {
  isSyntheticTriggerText,
  mergeDismissedIntoErrorContent,
} from '../../../shared/interruptedTurn.js';
import { resolveStaleCodexSubscriptionValueEstimate } from '../../../shared/codexSubscriptionValue.js';
import { normalizeTurnUsageDetails } from '../../../shared/turnUsageDetails.js';
import {
  projectSdkCostMoneyWithBreakdown,
  resolveCustomProviderCostFlag,
  resolveTurnSdkCostPresentation,
} from '../../../shared/customProviderBilling.js';
import {
  addCompatibleRegionalMoney,
  asValueEstimateMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  usdMoney,
  type RegionalMoney,
  type SdkCostPresentation,
} from '../../../shared/regionalMoney.js';
import { capReferenceMessageRows } from './history.js';
import type { Message, MessageRole, AgentMeta } from '../../../renderer/lib/ccAgent.types';

const log = createLogger('localDb/messages');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MESSAGE_DELETION_USER_BOUNDARY_PAGE_SIZE = 32;
// Keep IN (...) bind counts well below SQLite's historical 999 variable limit.
const SQLITE_IN_CHUNK_SIZE = 500;
const messageRowid = sql<number>`rowid`;

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
type MessageRow = typeof messages.$inferSelect;
type MessageRowWithRowid = MessageRow & { rowid: number };
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

// DbClient uses better-sqlite3 `.all()`: never return whole message bodies for
// retention bookkeeping. JSON1 extracts only the distinct paths that startup
// cleanup needs, while LIKE avoids invoking json_each for unrelated history.
const PERSISTED_CHAT_ATTACHMENT_CONTENT_PATTERN = '%chat-attachment-cache%';
const PERSISTED_CHAT_ATTACHMENT_PATHS_SQL = `SELECT DISTINCT
         attachment.atom AS filePath
   FROM messages AS m
   JOIN sessions AS s ON s.id = m.session_id
   JOIN json_tree(
          CASE WHEN json_valid(m.content) THEN m.content ELSE '{}' END,
          '$.files'
        ) AS attachment
  WHERE s.status != 'deleted'
    AND m.rewind_at IS NULL
    AND m.content LIKE ?
    AND attachment.key = 'path'
    AND attachment.type = 'text'`;

export interface EstimatedSessionValueEntry {
  clientId: string;
  money?: RegionalMoney;
  costUsd?: number;
  /**
   * Pre-upgrade custom-provider SDK amounts were persisted as actual cost.  The
   * renderer subtracts this read-only projection from the session ledger before
   * presenting the remaining provider/Gateway spend.
   */
  excludedActualMoney?: RegionalMoney;
  turnCostIsCustomProvider?: boolean;
  turnCostProviderId?: string | null;
  turnUsageDetails?: unknown;
}

/**
 * The already-recorded cost segments for the visible user round immediately
 * before an assistant message. `turnCostUsd` remains deliberately segment
 * scoped; callers use this value only to produce a user-facing round total.
 */
export interface PriorUserRoundCost {
  money: RegionalMoney | null;
  costUsd: number;
  hasEstimatedValue: boolean;
}

const VALID_ROLES: ReadonlySet<MessageRole> = new Set([
  'user',
  'assistant',
  'tool_use',
  'tool_result',
  'ask_user',
  'plan_review',
  'thinking',
] as const);

/** Return all staged attachment paths retained by the current owner's message DB. */
export async function listPersistedChatAttachmentPaths(): Promise<string[]> {
  const rows = await getDbClient().query<{ filePath: unknown }>(
    PERSISTED_CHAT_ATTACHMENT_PATHS_SQL,
    [PERSISTED_CHAT_ATTACHMENT_CONTENT_PATTERN],
  );
  return rows.flatMap((row) => (typeof row.filePath === 'string' ? [row.filePath] : []));
}

export function registerMessageIpc(): void {
  ipcMain.handle('local-db:messages:list', async (_e, sessionId: unknown, opts: unknown) => {
    const sid = requireString(sessionId, 'sessionId');
    const limit = clampLimit((opts as { limit?: number } | undefined)?.limit);
    const before = (opts as { before?: string } | undefined)?.before;
    const beforeTs = (opts as { beforeTs?: number } | undefined)?.beforeTs;
    const after = (opts as { after?: string } | undefined)?.after;
    const db = getDbClient().drizzle;

    // 外部历史导入(Codex rollout / Claude transcript):device-link 隧道调用
    // 只在首页请求跑(分页跳过,#318 性能语义;首页判定 = 无任何分页游标),
    // 覆盖「被控端从未本机打开该会话」的导入缺口。
    await runMessagesListImportSideEffects(
      sid,
      {},
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
    return hydrateLegacyUserTurnCosts(orderedRows.map(messageToCamelWithRowid));
  });

  ipcMain.handle(
    'local-db:messages:around',
    async (_e, sessionId: unknown, messageId: unknown, opts: unknown) => {
      const sid = requireString(sessionId, 'sessionId');
      const mid = requireString(messageId, 'messageId');
      const radius = clampAroundRadius((opts as { radius?: unknown } | undefined)?.radius);
      const db = getDbClient().drizzle;

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
        [...before.reverse(), anchor, ...after].map(messageToCamelWithRowid),
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
      const db = getDbClient().drizzle;

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
        [...before.reverse(), anchor, ...after].map(messageToCamelWithRowid),
      );
      return capReferenceMessageRows(rows, contentCharLimit);
    },
  );

  ipcMain.handle(
    'local-db:messages:estimatedSessionValue',
    async (
      event,
      sessionId: unknown,
      presentationValue?: unknown,
      showSdkEstimateValue?: unknown,
    ) => {
      if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
      const sid = requireString(sessionId, 'sessionId');
      const { presentation, showSdkEstimate } = parseEstimatedSessionValuePresentation(
        presentationValue,
        showSdkEstimateValue,
      );
      const db = getDbClient().drizzle;

      const [sessionRow] = await db
        .select({ clearedAt: sessions.clearedAt })
        .from(sessions)
        .where(eq(sessions.id, sid))
        .limit(1);
      const rows = await db
        .select({
          clientId: messages.clientId,
          agentMeta: messages.agentMeta,
          createdAt: messages.createdAt,
          rewindAt: messages.rewindAt,
        })
        .from(messages)
        .where(and(eq(messages.sessionId, sid), eq(messages.role, 'assistant')));
      const summarized = summarizeEstimatedSessionValueRows(
        rows,
        sessionRow?.clearedAt ?? null,
        presentation,
        showSdkEstimate,
      );
      return {
        projectionVersion: ESTIMATED_SESSION_VALUE_PROJECTION_VERSION,
        totalValueMoney: summarized.totalValueMoney,
        ...(summarized.totalValueUsd != null ? { totalValueUsd: summarized.totalValueUsd } : {}),
        entries: summarized.entries,
      };
    },
  );

  /**
   * Sidebar cost field: one query for many sessions instead of one full-history
   * scan per SessionItem/SessionCard. Returns compact per-session totals only.
   */
  ipcMain.handle(
    'local-db:messages:estimatedSessionValueBatch',
    async (event, body: unknown) => {
      if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
      const payload = requireObject(body, 'payload');
      const sessionIds = parseEstimatedSessionValueBatchIds(payload.sessionIds);
      if (sessionIds.length === 0) return {};
      const { presentation, showSdkEstimate } = parseEstimatedSessionValuePresentation(
        payload.presentation,
        payload.showSdkEstimate,
      );
      const presentationBySession = parseEstimatedSessionValuePresentationMap(
        payload.presentations,
        presentation,
      );
      const db = getDbClient().drizzle;
      const sessionRows = (
        await Promise.all(
          chunkArray(sessionIds, SQLITE_IN_CHUNK_SIZE).map((chunk) =>
            db
              .select({ id: sessions.id, clearedAt: sessions.clearedAt })
              .from(sessions)
              .where(inArray(sessions.id, chunk)),
          ),
        )
      ).flat();
      const messageRows = (
        await Promise.all(
          chunkArray(sessionIds, SQLITE_IN_CHUNK_SIZE).map((chunk) =>
            db
              .select({
                sessionId: messages.sessionId,
                clientId: messages.clientId,
                agentMeta: messages.agentMeta,
                createdAt: messages.createdAt,
                rewindAt: messages.rewindAt,
              })
              .from(messages)
              .where(and(eq(messages.role, 'assistant'), inArray(messages.sessionId, chunk))),
          ),
        )
      ).flat();
      const clearedAtBySession = new Map<string, number | null>(
        sessionRows.map((row) => [row.id, row.clearedAt ?? null]),
      );
      return summarizeEstimatedSessionValuesBySession(
        messageRows,
        clearedAtBySession,
        sessionIds,
        presentationBySession,
        showSdkEstimate,
      );
    },
  );

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

    return createMessage(sid, {
      clientId: cid,
      role: b.role as MessageRole,
      content: b.content,
      toolUseId: typeof b.toolUseId === 'string' ? b.toolUseId : undefined,
      agentMeta: (b.agentMeta as AgentMeta | null | undefined) ?? null,
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
      await updateAgentMeta(sid, cid, agentMeta === null ? null : JSON.stringify(agentMeta));
    },
  );

  ipcMain.handle(
    'local-db:messages:updateContent',
    async (_e, sessionId: unknown, clientId: unknown, content: unknown) => {
      const sid = requireString(sessionId, 'sessionId');
      const cid = requireString(clientId, 'clientId');
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
      const msg = await dismissErrorMessage(sid, cid);
      if (!msg) throwIpcError('NOT_FOUND', 'Error message 不存在');
      return msg;
    },
  );
}

/**
 * messages:list 的「按需导入外部 CLI 会话历史」副作用。
 *
 * 普通 Cindy 任务不需要外部 CLI 历史导入；只有带有明确来源前缀的任务才运行对应 importer。
 * 这样可以避免每次切换普通任务都先为两个 importer 各做一次 sessions 查询。device-link 远程读
 * 仍遵循首页/分页语义，但首页也只对 Codex/Claude 来源任务运行对应 importer。
 *
 * 抽成可注入函数仅为单测(规则 14):默认依赖即生产实现,Electron `ipcMain.handle` 只做 adapter。
 */
export async function runMessagesListImportSideEffects(
  sessionId: string,
  deps: {
    isDeviceLink?: () => boolean;
    importCodex?: (id: string) => Promise<void>;
    importClaude?: (id: string) => Promise<void>;
  } = {},
  opts: { deviceLinkFirstPage?: boolean } = {},
): Promise<void> {
  const isDeviceLink = deps.isDeviceLink ?? isDeviceLinkInvoke;
  // device-link **分页**请求跳过导入(#318 性能语义:每页重跑 importer 会把
  // 导入延迟串接到查询前,拖慢手机端);**首页**请求照跑(review P2):被控端
  // 可能从未本机打开该会话,rollout/transcript 从未导入 —— 崩溃前 CLI 已写的
  // 产出不进 DB,中断行滞留尾部,控制端会看到可「继续」的假中断。首页一次
  // 导入与本机路径的既有成本同水平。
  if (isDeviceLink() && !opts.deviceLinkFirstPage) return;
  const importCodex = deps.importCodex ?? importExternalCodexMessagesForSession;
  const importClaude = deps.importClaude ?? importExternalClaudeCodeMessagesForSession;
  if (sessionId.startsWith('codex-')) {
    await importCodex(sessionId).catch((err) => {
      log.warn('external Codex message import failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    return;
  }
  if (sessionId.startsWith('claude-')) {
    await importClaude(sessionId).catch((err) => {
      log.warn('external Claude Code message import failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
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
  const ownerStamp = ownerStampForBroadcast(ownerScope);
  if (ownerStamp === null) return;
  if (ownerScope !== undefined && ownerScope !== null) {
    broadcastTap.tapWindowBroadcast(
      'local-db:messages:created',
      { sessionId, message: msg },
      ownerStamp,
    );
  } else if (ownerStamp === undefined) {
    broadcastTap.tapWindowBroadcast('local-db:messages:created', { sessionId, message: msg });
  } else {
    broadcastTap.tapWindowBroadcast(
      'local-db:messages:created',
      { sessionId, message: msg },
      ownerStamp,
    );
  }
  const hasCapturedScope = ownerScope !== undefined && ownerScope !== null;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      if (hasCapturedScope) {
        win.webContents.send('local-db:messages:created', { sessionId, message: msg }, ownerStamp);
      } else if (ownerStamp === undefined) {
        win.webContents.send('local-db:messages:created', { sessionId, message: msg });
      } else {
        win.webContents.send('local-db:messages:created', { sessionId, message: msg }, ownerStamp);
      }
    } catch {
      /* swallow per-window broadcast failures */
    }
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
): Promise<{
  sessionId: string;
  deletedClientIds: string[];
  subagentRunIds: string[];
  updatedAt: number;
  preview: string | null;
}> {
  const now = Date.now();
  const db = getDbClient().drizzle;
  const result = await getDbClient().tx('message.delete', {
    sessionId,
    clientIds,
    ...(subagentTurnWindow ? { subagentTurnWindow } : {}),
    contextMarker: {
      id: createId(),
      clientId: `context-rebuild:${createId()}`,
      content: JSON.stringify({ handoff, consumed: false, reason: 'message-deletion' }),
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
  // messages 行数（sessions.ts 的 SESSION_MESSAGE_COUNT_SQL / MESSAGE_COUNT_COL，不过滤
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
    const db = getDbClient().drizzle;
    const [sessionRow] = await db
      .select({ clearedAt: sessions.clearedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const visibleAfterClear =
      sessionRow?.clearedAt == null ? undefined : gt(messages.createdAt, sessionRow.clearedAt);
    const visibleMessageProjection = and(
      eq(messages.sessionId, sessionId),
      sql`${messages.role} IN ('user', 'assistant')`,
      isNull(messages.rewindAt),
      sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.autoResume') IS NOT 1)`,
      visibleAfterClear,
    );
    const [latestRow] = await db
      .select({ content: messages.content, role: messages.role })
      .from(messages)
      .where(visibleMessageProjection)
      .orderBy(desc(messages.createdAt), desc(messageRowid))
      .limit(1);
    preview = extractMessagePreview(latestRow?.content, latestRow?.role);
  } catch (error) {
    // 删除已经原子提交；投影查询失败不能把成功操作伪装成失败。广播保守空值，
    // 后续 sessions:list / reseed 会按 DB 真相收敛。
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

export async function commitContextRebuild(
  sessionId: string,
  handoff: string,
  meta: {
    reason: 'context-overflow' | 'pi-prompt-timeout';
    sourceUserClientId: string | null;
    sourceAgentKind?: 'cc' | 'codex' | 'pi';
    sourceModel?: string | null;
    sourceProviderId?: string | null;
    expectedClearedAt?: number | null;
  },
): Promise<{ updatedAt: number }> {
  const now = Date.now();
  await getDbClient().tx('context.rebuild', {
    sessionId,
    markerId: createId(),
    markerClientId: `context-rebuild:${createId()}`,
    markerContent: JSON.stringify({
      handoff,
      consumed: false,
      reason: meta.reason,
      sourceUserClientId: meta.sourceUserClientId,
      ...(meta.sourceAgentKind ? { sourceAgentKind: meta.sourceAgentKind } : {}),
      ...(meta.sourceModel !== undefined ? { sourceModel: meta.sourceModel } : {}),
      ...(meta.sourceProviderId !== undefined ? { sourceProviderId: meta.sourceProviderId } : {}),
    }),
    markerCreatedAt: now,
    updatedAt: now,
    expectedClearedAt: meta.expectedClearedAt ?? null,
  });
  return { updatedAt: now };
}

export async function findLatestContextRebuildMeta(sessionId: string): Promise<{
  reason?: string;
  sourceUserClientId?: string | null;
  sourceAgentKind?: 'cc' | 'codex' | 'pi';
  sourceModel?: string | null;
  sourceProviderId?: string | null;
} | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'context_rebuild')))
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.content) as {
      reason?: unknown;
      sourceUserClientId?: unknown;
      sourceAgentKind?: unknown;
      sourceModel?: unknown;
      sourceProviderId?: unknown;
    };
    return {
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      sourceUserClientId:
        typeof parsed.sourceUserClientId === 'string' ? parsed.sourceUserClientId : null,
      ...(parsed.sourceAgentKind === 'cc' ||
      parsed.sourceAgentKind === 'codex' ||
      parsed.sourceAgentKind === 'pi'
        ? { sourceAgentKind: parsed.sourceAgentKind }
        : {}),
      ...(typeof parsed.sourceModel === 'string' ? { sourceModel: parsed.sourceModel } : {}),
      ...(typeof parsed.sourceProviderId === 'string'
        ? { sourceProviderId: parsed.sourceProviderId }
        : {}),
    };
  } catch {
    return null;
  }
}

export function broadcastMessageDeleted(
  payload: MessageDeletedPayload,
  ownerScope?: DataOwnerBroadcastScope | null,
): void {
  const ownerStamp = ownerStampForBroadcast(ownerScope);
  if (ownerStamp === null) return;
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

/**
 * Hide a user row that was persisted after the session crossed `/clear`.
 *
 * This is deliberately narrower than `commitMessageDeletion`: a clear-race
 * cleanup must not create a context-rebuild marker, reset the native session,
 * or touch any other turn.  The row stays as a rewind tombstone so the same
 * clientId remains idempotent across a weak-link retry.
 */
export async function rewindPersistedUserMessageAfterClear(
  sessionId: string,
  clientId: string,
): Promise<void> {
  const ownerScope = captureOwnerBroadcastScope();
  if (!isOwnerBroadcastScopeCurrent(ownerScope)) return;
  const dbClient = getDbClient();
  const db = dbClient.drizzle;
  const [row] = await db
    .select({ id: messages.id, clientId: messages.clientId, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.clientId, clientId),
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
      ),
    )
    .limit(1);
  if (!isOwnerBroadcastScopeCurrent(ownerScope)) return;
  if (!row) return;

  const rewoundAt = Date.now();
  const updated = await dbClient.exec(
    `UPDATE messages
        SET rewind_at = ?
      WHERE session_id = ?
        AND client_id = ?
        AND role = 'user'
        AND rewind_at IS NULL`,
    [rewoundAt, sessionId, clientId],
  );
  if (!isOwnerBroadcastScopeCurrent(ownerScope)) return;
  if (updated.changes === 0) return;

  const mediaCleanup = await Promise.allSettled(
    [...new Set([row.id, row.clientId])].map((refId) =>
      removeMediaRefs({ refKind: 'message', refId }),
    ),
  );
  for (const [index, cleanup] of mediaCleanup.entries()) {
    if (cleanup.status === 'fulfilled') continue;
    log.warn('clear-race user media ref cleanup failed', {
      sessionId,
      clientId,
      refId: [row.id, row.clientId][index],
      error: cleanup.reason instanceof Error ? cleanup.reason.message : String(cleanup.reason),
    });
  }
  const mediaHashes = collectCindyMediaHashes(row.content);
  const mediaHashCleanup = await Promise.allSettled(
    mediaHashes.map((hash) =>
      removeSessionAttachmentRefIfUnreferencedByLiveMessage({ sessionId, hash }),
    ),
  );
  for (const [index, cleanup] of mediaHashCleanup.entries()) {
    if (cleanup.status === 'fulfilled') continue;
    log.warn('clear-race session media ref reconcile failed', {
      sessionId,
      clientId,
      hash: mediaHashes[index],
      error: cleanup.reason instanceof Error ? cleanup.reason.message : String(cleanup.reason),
    });
  }
  broadcastMessageDeleted({ sessionId, clientId, clientIds: [clientId] }, ownerScope);
  void recomputePrRefsForSession(sessionId).catch(() => undefined);
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
  const ownerScope = captureOwnerBroadcastScope();
  const db = getDbClient().drizzle;
  const [oldRow] = await db
    .select({
      clientId: messages.clientId,
      createdAt: messages.createdAt,
      rowid: messageRowid,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.clientId, args.supersededUserClientId),
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
      ),
    )
    .limit(1);
  const [retryRow] = await db
    .select({ createdAt: messages.createdAt, rowid: messageRowid })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, args.retryUserClientId)))
    .limit(1);
  if (!oldRow || !retryRow) return [];
  // 窗口两端都用 (created_at, rowid) 双键:error 行的 createdAt 取"本轮最后行 + 1",
  // 但历史数据与时钟边缘仍可能与相邻 user 行同毫秒。口径与 rewind / fork 的边界
  // 比较一致(messageRowid + gt/lt 组合),orderBy 让返回顺序确定,不依赖执行计划。
  const errorRows = await db
    .select({ clientId: messages.clientId })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'error'),
        isNull(messages.rewindAt),
        or(
          gt(messages.createdAt, oldRow.createdAt),
          and(eq(messages.createdAt, oldRow.createdAt), gt(messageRowid, oldRow.rowid)),
        ),
        or(
          lt(messages.createdAt, retryRow.createdAt),
          and(eq(messages.createdAt, retryRow.createdAt), lt(messageRowid, retryRow.rowid)),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messageRowid));
  const clientIds = [oldRow.clientId, ...errorRows.map((r) => r.clientId)];
  if (!isOwnerBroadcastScopeCurrent(ownerScope)) return [];
  await db
    .update(messages)
    .set({ rewindAt: Date.now() })
    .where(
      and(
        eq(messages.sessionId, sessionId),
        inArray(messages.clientId, clientIds),
        isNull(messages.rewindAt),
      ),
    );
  if (isOwnerBroadcastScopeCurrent(ownerScope)) {
    broadcastMessageDeleted({ sessionId, clientId: oldRow.clientId, clientIds }, ownerScope);
  }
  return clientIds;
}

export async function updateMessageContent(
  sessionId: string,
  clientId: string,
  content: unknown,
): Promise<Message | null> {
  const db = getDbClient().drizzle;
  await db
    .update(messages)
    .set({ content: safeStringify(content) })
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId)));
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId)))
    .limit(1);
  if (row) {
    // 挂账钩子同样覆盖"先摘要 create、后全文 update"的 tool_result 顺序
    // (review P2:vendor 事件顺序一变,首现于 update 的 blob URL 若不在这里
    // 挂账就永久零引用);幂等,create 时已挂的 hasRef 跳过。
    void commitMessageMediaRefs({
      sessionId,
      role: row.role,
      content: row.content,
    }).catch((err) => {
      log.warn('message media ref commit failed (update)', {
        sessionId,
        clientId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return row ? messageToCamel(row) : null;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(n), 1), MAX_LIMIT);
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
 * Same-ms message ordering must follow SQLite insertion order, not the random
 * cuid message id. `rowid` is stable for this local table and avoids a schema
 * migration solely for pagination tie-breaking.
 */
function getMessageSelectFields() {
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

function messageToCamelWithRowid(row: MessageRowWithRowid): Message {
  return {
    ...messageToCamel(row),
    rowid: row.rowid,
  };
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
    /**
     * Optional clear-boundary compare-and-set for optimistic user sends.  The
     * insert is accepted only while the session still has this exact
     * `clearedAt` value.  This closes the window where `/clear` wins the DB
     * update while an already-accepted `Session.send()` is still awaiting its
     * durable user row.
     */
    expectedClearBoundaryMs?: number | null;
    /**
     * Owner scope captured before an async main-side write.  A stale scope
     * must not broadcast a row into the next signed-in owner.
     */
    broadcastOwnerScope?: DataOwnerBroadcastScope | null;
  },
): Promise<Message> {
  const dbClient = getDbClient();
  const db = dbClient.drizzle;
  const guarded =
    opts !== undefined && Object.prototype.hasOwnProperty.call(opts, 'expectedClearBoundaryMs');
  const expected = guarded ? opts?.expectedClearBoundaryMs : undefined;
  if (
    guarded &&
    expected !== null &&
    (typeof expected !== 'number' || !Number.isFinite(expected) || expected < 0)
  ) {
    throw new Error('expectedClearBoundaryMs must be null or a non-negative finite number');
  }

  // The unguarded API keeps its historical fast idempotency read. Guarded
  // optimistic sends must skip it: a pre-clear row can otherwise be returned
  // before the compare-and-set boundary is checked.
  if (!guarded) {
    const existing = await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, body.clientId)))
      .limit(1);
    if (existing.length > 0) return messageToCamel(existing[0]);
  }

  const id = createId();
  const now = Date.now();
  const visibleCreatedAt =
    guarded && expected !== null && expected !== undefined
      ? Math.max(body.createdAt ?? now, expected + 1)
      : (body.createdAt ?? now);
  const insertRow = messageCreateToRow(id, sessionId, body, visibleCreatedAt);
  try {
    if (guarded) {
      // Keep the session compare and message insert in one SQLite statement.
      // A separate SELECT would allow /clear to win between the check and the
      // INSERT on the DB worker.
      const inserted = await dbClient.exec(
        `INSERT INTO messages (
           id, client_id, session_id, role, content, tool_use_id,
           agent_meta, agent_kind, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM sessions AS s
          WHERE s.id = ?
            AND COALESCE(s.cleared_at, -1) = COALESCE(?, -1)
         ON CONFLICT(session_id, client_id) DO NOTHING`,
        [
          insertRow.id,
          insertRow.clientId,
          insertRow.sessionId,
          insertRow.role,
          insertRow.content,
          insertRow.toolUseId,
          insertRow.agentMeta,
          insertRow.agentKind,
          insertRow.createdAt,
          sessionId,
          expected,
        ],
      );
      if (inserted.changes === 0) {
        const [existingAfterGuard] = await db
          .select()
          .from(messages)
          .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, body.clientId)))
          .limit(1);
        const [sessionAfterGuard] = await db
          .select({ clearedAt: sessions.clearedAt })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        const actual = sessionAfterGuard?.clearedAt ?? null;
        if (
          existingAfterGuard &&
          actual === expected &&
          existingAfterGuard.rewindAt === null &&
          (expected === null || existingAfterGuard.createdAt > expected)
        ) {
          return messageToCamel(existingAfterGuard);
        }
        if (actual !== expected) {
          throw Object.assign(
            new Error(
              `REMOTE_OPTIMISTIC_INPUT_CLEARED: expectedClearBoundaryMs=${expected ?? 'null'}; currentClearBoundaryMs=${actual ?? 'null'}`,
            ),
            { code: 'REMOTE_OPTIMISTIC_INPUT_CLEARED' },
          );
        }
        throw new Error('Message insert skipped without a clear-boundary change');
      }
    } else {
      await db.insert(messages).values(insertRow);
    }
  } catch (err) {
    const after = await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, body.clientId)))
      .limit(1);
    if (guarded) {
      const [sessionAfterError] = await db
        .select({ clearedAt: sessions.clearedAt })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const actual = sessionAfterError?.clearedAt ?? null;
      const existingAfterError = after[0];
      if (
        existingAfterError &&
        actual === expected &&
        existingAfterError.rewindAt === null &&
        (expected === null || existingAfterError.createdAt > expected)
      ) {
        return messageToCamel(existingAfterError);
      }
      if (actual !== expected) {
        throw Object.assign(
          new Error(
            `REMOTE_OPTIMISTIC_INPUT_CLEARED: expectedClearBoundaryMs=${expected ?? 'null'}; currentClearBoundaryMs=${actual ?? 'null'}`,
          ),
          { code: 'REMOTE_OPTIMISTIC_INPUT_CLEARED' },
        );
      }
    } else if (after.length > 0) {
      return messageToCamel(after[0]);
    }
    throw err;
  }
  const [row] = await db.select().from(messages).where(eq(messages.id, id));
  if (!row) throw new Error('Message 创建后查询失败');
  const msg = messageToCamel(row);
  // 媒体总仓挂账钩子(规则 25):消息落库是"blob 归属本会话"的
  // 确定时点,覆盖所有落库来源(renderer IPC / hook / im / agent echo / 合成
  // tool_result)。生成产物(art/mivo/codex)入仓时零引用,在这里补挂
  // session-attachment 引用;用户附件已在发送链路 commit 过,hasRef 幂等跳过。
  // 传 insertRow.content(已序列化字符串)避免二次 stringify(review P2)。
  const commitMediaRefs = async (): Promise<void> => {
    try {
      await commitMessageMediaRefs({
        sessionId,
        role: body.role,
        content: insertRow.content,
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
  if (shouldAwaitMediaRefs) await commitMediaRefs();
  else void commitMediaRefs();
  // Broadcast 给所有 renderer window — 用于 main 端创建消息 (e.g. feishu /ctr
  // 接管路径下 persistUserMessage / persistAssistantMessage) 时让 renderer
  // 的 makerChatStore push 到 in-memory state, 让消息流实时刷新。
  // Renderer 自己调 createMessage IPC 时也会触发这个 broadcast, 但因为它已经
  // 主动 push 过, 监听端按 (sessionId, clientId) dedupe 就不会重复显示。
  if (opts?.shouldBroadcast?.() !== false) {
    broadcastMessageRow(sessionId, msg, opts?.broadcastOwnerScope);
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
  void recordPrRefsForMessage(msg).catch(() => {
    // recordPrRefsForMessage 内部已 try/catch,此处兜底防御 refactor 漏网异常。
  });
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

export const ESTIMATED_SESSION_VALUE_BATCH_LIMIT = 256;

export interface EstimatedSessionValueRow {
  clientId: string;
  agentMeta: string | null;
  createdAt: number;
  rewindAt: number | null;
}

export interface EstimatedSessionValueSummary {
  estimatedValueMoney: RegionalMoney | null;
  excludedActualMoney: RegionalMoney | null;
  totalValueUsd?: number;
}

export const ESTIMATED_SESSION_VALUE_PROJECTION_VERSION = 1;

function parseEstimatedSessionValuePresentation(
  presentationValue: unknown,
  showSdkEstimateValue: unknown,
): { presentation: SdkCostPresentation; showSdkEstimate: boolean } {
  const presentation: SdkCostPresentation =
    optionalEnum(
      presentationValue,
      ['regular', 'hidden', 'estimate'] as const,
      'custom provider cost presentation',
    ) ?? 'regular';
  if (showSdkEstimateValue !== undefined && typeof showSdkEstimateValue !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'showSdkEstimate must be a boolean');
  }
  const showSdkEstimate =
    typeof showSdkEstimateValue === 'boolean' ? showSdkEstimateValue : presentation === 'estimate';
  return { presentation, showSdkEstimate };
}

function parseEstimatedSessionValueBatchIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'sessionIds must be an array');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = requireString(item, 'sessionId');
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= ESTIMATED_SESSION_VALUE_BATCH_LIMIT) break;
  }
  return ids;
}

function parseEstimatedSessionValuePresentationMap(
  value: unknown,
  fallback: SdkCostPresentation,
): Map<string, SdkCostPresentation> {
  const map = new Map<string, SdkCostPresentation>();
  if (value === undefined) return map;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'presentations must be an object');
  }
  for (const [sessionId, presentationValue] of Object.entries(value as Record<string, unknown>)) {
    map.set(
      sessionId,
      optionalEnum(
        presentationValue,
        ['regular', 'hidden', 'estimate'] as const,
        'custom provider cost presentation',
      ) ?? fallback,
    );
  }
  return map;
}

export function summarizeEstimatedSessionValueRows(
  rows: readonly EstimatedSessionValueRow[],
  clearedAtMs: number | null,
  presentation: SdkCostPresentation = 'regular',
  showSdkEstimate: boolean = presentation === 'estimate',
): {
  totalValueMoney: RegionalMoney | null;
  excludedActualMoney: RegionalMoney | null;
  totalValueUsd?: number;
  entries: EstimatedSessionValueEntry[];
} {
  const visibleRows = rows.filter(
    (row) => row.rewindAt === null && (clearedAtMs === null || row.createdAt > clearedAtMs),
  );
  const visibleEntries = extractEstimatedSessionValueEntries(
    visibleRows,
    presentation,
    showSdkEstimate,
  );
  const lifetimeEntries = extractEstimatedSessionValueEntries(rows, presentation, showSdkEstimate);
  const entries = mergeEstimatedSessionValueEntriesWithLifetimeExclusions(
    visibleEntries,
    lifetimeEntries,
  );
  const estimatedEntries = entries.flatMap((entry) => (entry.money ? [entry.money] : []));
  const excludedEntries = entries.flatMap((entry) =>
    entry.excludedActualMoney ? [entry.excludedActualMoney] : [],
  );
  const totalValueMoney = addCompatibleRegionalMoney(estimatedEntries);
  const excludedActualMoney = addCompatibleRegionalMoney(excludedEntries);
  const hasCompleteUsdProjection = entries.every(
    (entry) => !entry.money || typeof entry.costUsd === 'number',
  );
  return {
    totalValueMoney,
    excludedActualMoney,
    ...(hasCompleteUsdProjection
      ? { totalValueUsd: entries.reduce((sum, item) => sum + (item.costUsd ?? 0), 0) }
      : {}),
    entries,
  };
}

export function summarizeEstimatedSessionValuesBySession(
  rows: ReadonlyArray<EstimatedSessionValueRow & { sessionId: string }>,
  clearedAtBySession: ReadonlyMap<string, number | null>,
  sessionIds: readonly string[],
  presentationBySession: ReadonlyMap<string, SdkCostPresentation>,
  showSdkEstimate: boolean,
): Record<string, EstimatedSessionValueSummary> {
  const grouped = new Map<string, EstimatedSessionValueRow[]>();
  for (const sessionId of sessionIds) grouped.set(sessionId, []);
  for (const row of rows) {
    const list = grouped.get(row.sessionId);
    if (list) list.push(row);
  }
  const result: Record<string, EstimatedSessionValueSummary> = {};
  for (const [sessionId, sessionRows] of grouped) {
    const presentation = presentationBySession.get(sessionId) ?? 'regular';
    const summarized = summarizeEstimatedSessionValueRows(
      sessionRows,
      clearedAtBySession.get(sessionId) ?? null,
      presentation,
      showSdkEstimate,
    );
    result[sessionId] = {
      estimatedValueMoney: summarized.totalValueMoney,
      excludedActualMoney: summarized.excludedActualMoney,
      ...(summarized.totalValueUsd != null ? { totalValueUsd: summarized.totalValueUsd } : {}),
    };
  }
  return result;
}

export function extractEstimatedSessionValueEntries(
  rows: ReadonlyArray<{ clientId: string; agentMeta: string | null }>,
  presentation: SdkCostPresentation = 'regular',
  showSdkEstimate: boolean = presentation === 'estimate',
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
    if (!meta) continue;
    const structured = normalizeRegionalMoney(meta.turnCost);
    const legacyCostUsd =
      typeof meta.turnCostUsd === 'number' &&
      Number.isFinite(meta.turnCostUsd) &&
      meta.turnCostUsd > 0
        ? meta.turnCostUsd
        : null;
    const rawMoney =
      structured && structured.amount > 0
        ? structured
        : legacyCostUsd != null
          ? meta.turnCostIsEstimate === true
            ? usdMoney(legacyCostUsd, 'value-estimate', 'legacy-usd')
            : usdMoney(legacyCostUsd)
          : null;
    if (!rawMoney) continue;

    const turnUsageDetails = normalizeTurnUsageDetails(meta.turnUsageDetails);
    const entryProviderFlag = resolveCustomProviderCostFlag(
      meta.turnCostIsCustomProvider,
      meta.turnCostProviderId,
    );
    const fallbackPresentation =
      meta.turnCostIsCustomProvider === undefined && meta.turnCostProviderId !== undefined
        ? resolveTurnSdkCostPresentation({
            money: rawMoney,
            isCustomProviderCost: entryProviderFlag,
            fallback: presentation,
            showSdkEstimate,
          })
        : presentation;
    const turnPresentation = resolveTurnSdkCostPresentation({
      money: rawMoney,
      isCustomProviderCost: meta.turnCostIsCustomProvider,
      fallback: fallbackPresentation,
      showSdkEstimate,
    });
    const projected = projectSdkCostMoneyWithBreakdown(
      rawMoney,
      turnUsageDetails?.perModelCost?.map((entry) => entry.money),
      turnPresentation,
    );
    const excludedActualMoney =
      rawMoney.kind === 'actual-cost' &&
      meta.turnCostIsEstimate !== true &&
      turnPresentation !== 'regular'
        ? rawMoney
        : null;
    const canExposeProjectedEstimate =
      Boolean(projected && projected.amount > 0) &&
      (projected?.kind === 'value-estimate' || meta.turnCostIsEstimate === true);
    if (!canExposeProjectedEstimate && !excludedActualMoney) continue;

    const estimateMoney = canExposeProjectedEstimate
      ? projected!.kind === 'value-estimate'
        ? projected!
        : asValueEstimateMoney(projected!)
      : null;
    const recomputed =
      estimateMoney?.currency === 'USD' &&
      estimateMoney.estimateReasons?.includes('sdk-estimate') !== true
        ? resolveStaleCodexSubscriptionValueEstimate(
            estimateMoney.amount,
            turnUsageDetails,
            meta.model,
          )
        : null;
    const money = estimateMoney
      ? {
          ...estimateMoney,
          amount: recomputed ?? estimateMoney.amount,
        }
      : null;
    entries.push({
      clientId: row.clientId,
      ...(money ? { money } : {}),
      ...(money?.currency === 'USD' ? { costUsd: money.amount } : {}),
      ...(excludedActualMoney ? { excludedActualMoney } : {}),
      ...(typeof meta.turnCostIsCustomProvider === 'boolean'
        ? { turnCostIsCustomProvider: meta.turnCostIsCustomProvider }
        : {}),
      ...(typeof meta.turnCostProviderId === 'string' || meta.turnCostProviderId === null
        ? { turnCostProviderId: meta.turnCostProviderId }
        : {}),
      ...(turnUsageDetails?.perModelCost?.length ? { turnUsageDetails } : {}),
    });
  }
  return entries;
}

/**
 * Visible value estimates follow the transcript boundary, while exclusions for
 * legacy custom-provider SDK amounts follow the lifetime session ledger.  Merge
 * the latter back without making cleared or rewound estimates visible again.
 */
export function mergeEstimatedSessionValueEntriesWithLifetimeExclusions(
  visibleEntries: readonly EstimatedSessionValueEntry[],
  lifetimeEntries: readonly EstimatedSessionValueEntry[],
): EstimatedSessionValueEntry[] {
  const merged = new Map(
    visibleEntries.map((entry) => [entry.clientId, { ...entry }] as const),
  );
  for (const entry of lifetimeEntries) {
    if (!entry.excludedActualMoney) continue;
    merged.set(entry.clientId, {
      ...(merged.get(entry.clientId) ?? { clientId: entry.clientId }),
      excludedActualMoney: entry.excludedActualMoney,
    });
  }
  return [...merged.values()];
}

/**
 * 对已落库消息的 agent_meta 做 read-merge-write 补丁(不能整列覆盖——会丢 uuid /
 * model 等 rewind / fork 锚点字段)。现有 agent_meta 为 null 或 parse 失败时以 {}
 * 为底。返回 false 表示该行不存在(典型:rewind 已删),调用方据此跳过广播。
 *
 * 用于 turnCostBroadcaster:turn 结束后把 per-turn 费用挂到该轮最后一条 assistant。
 */
export interface MessageAgentMetaPatchResult {
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
}

/** 与 patchMessageAgentMeta 相同，但返回补丁前后的元数据供幂等账本计算。 */
export async function patchMessageAgentMetaWithResult(
  sessionId: string,
  clientId: string,
  patch: Record<string, unknown>,
): Promise<MessageAgentMetaPatchResult | null> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ agentMeta: messages.agentMeta })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId)))
    .limit(1);
  if (rows.length === 0) return null;
  // 损坏的 JSON 以 {} 为底重建(补丁字段仍写入,旧字段无法挽救)。
  const previous = parseAgentMetaRecord(rows[0].agentMeta) ?? {};
  const next = { ...previous, ...patch };
  await updateAgentMeta(sessionId, clientId, JSON.stringify(next));
  return { previous, next };
}

export interface VisibleToolUseMessageLink {
  clientId: string;
  toolUseId: string;
}

/**
 * Recover a durable tool-use row after process-local event linkage was lost.
 * The session clear boundary is part of visibility: a restart must not make a
 * pre-clear row eligible for a late background terminal update again.
 */
export async function findVisibleToolUseMessageByAliases(
  sessionId: string,
  aliases: readonly string[],
): Promise<VisibleToolUseMessageLink | null> {
  const normalizedAliases = [...new Set(aliases.filter((alias) => alias.length > 0))];
  if (!sessionId || normalizedAliases.length === 0) return null;
  const [row] = await getDbClient()
    .drizzle.select({
      clientId: messages.clientId,
      toolUseId: messages.toolUseId,
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'tool_use'),
        inArray(messages.toolUseId, normalizedAliases),
        isNull(messages.rewindAt),
        or(isNull(sessions.clearedAt), gt(messages.createdAt, sessions.clearedAt)),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row?.clientId && row.toolUseId
    ? { clientId: row.clientId, toolUseId: row.toolUseId }
    : null;
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
): Promise<PriorUserRoundCost> {
  const db = getDbClient().drizzle;
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
  const boundary = userRows.find((row) => !isAutoResumeUserMessage(row.agentMeta));
  if (!boundary) return { money: null, costUsd: 0, hasEstimatedValue: false };

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
  };
}

/**
 * Compatibility projection for messages created before userTurnCostUsd existed.
 *
 * This is deliberately read-only: a history page can immediately display the
 * correct user-round total without rewriting legacy data or changing the raw
 * segment values used by every billing aggregate. New messages already carry
 * the persisted field and skip this path.
 */
async function hydrateLegacyUserTurnCosts(history: Message[]): Promise<Message[]> {
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
  if (legacyClientIds.size === 0) return history;

  const sessionId = history[0]?.sessionId;
  if (!sessionId) return history;
  const db = getDbClient().drizzle;
  const [session] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const visibleAfterClear =
    session?.clearedAt == null ? [] : [gt(messages.createdAt, session.clearedAt)];
  const rows = await db
    .select({
      clientId: messages.clientId,
      role: messages.role,
      agentMeta: messages.agentMeta,
    })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), isNull(messages.rewindAt), ...visibleAfterClear))
    .orderBy(asc(messages.createdAt), asc(messageRowid));

  const totalsByClientId = new Map<string, PriorUserRoundCost>();
  let hasRealUserBoundary = false;
  let costUsd = 0;
  let hasEstimatedValue = false;
  for (const row of rows) {
    if (row.role === 'user' && !isAutoResumeUserMessage(row.agentMeta)) {
      hasRealUserBoundary = true;
      costUsd = 0;
      hasEstimatedValue = false;
      continue;
    }
    if (row.role !== 'assistant') continue;
    const meta = parseAgentMetaRecord(row.agentMeta);
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
        ...agentMeta,
        ...(total.money ? { userTurnCost: total.money } : {}),
        userTurnCostUsd: total.costUsd,
        userTurnCostIsEstimate: total.hasEstimatedValue,
      },
    };
  }
  return hydrated ?? history;
}

function isAutoResumeUserMessage(agentMeta: string | null): boolean {
  return parseAgentMetaRecord(agentMeta)?.autoResume === true;
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

function parseAgentMetaRecord(agentMeta: string | null): Record<string, unknown> | null {
  if (!agentMeta) return null;
  try {
    const parsed = JSON.parse(agentMeta);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 查是否有尚未随首条 user 消息发送的内部 handoff。
 * 判定规则(确定性,重启后可从 DB 重建 pending 状态):
 *   - agent_switch:未 rewind 的边界行；
 *   - context_rebuild:消息删除事务写入、刻意用 rewind_at 隐藏的内部行。
 * 两类取晚于 /clear 的最新一条，以 content.consumed 为真源。只有缺 consumed
 * 字段的 v1 agent_switch 老行才回落“边界后是否已有 user 行”的启发式。
 * 同毫秒并列用 rowid 决序(与 messages list 的 tie-break 口径一致)。
 */
export async function findPendingAgentHandoff(sessionId: string): Promise<string | null> {
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessRow?.clearedAt ?? null;
  const afterClear = clearedAt === null ? undefined : gt(messages.createdAt, clearedAt);
  const [boundary] = await db
    .select({
      rowid: messageRowid,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        or(
          and(eq(messages.role, 'agent_switch'), isNull(messages.rewindAt)),
          eq(messages.role, 'context_rebuild'),
        ),
        afterClear,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  if (!boundary) return null;
  let parsed: { handoff?: unknown; consumed?: unknown };
  try {
    parsed = JSON.parse(boundary.content) as typeof parsed;
  } catch {
    return null;
  }
  const handoff =
    typeof parsed.handoff === 'string' && parsed.handoff.length > 0 ? parsed.handoff : null;
  if (!handoff || parsed.consumed === true) return null;
  // v2 边界以持久消费位为真源:失败首发可能已先落 user 行；只要 vendor 尚未
  // accepted,重启后仍必须恢复交接。缺字段的 v1 老行才走 user-row 启发式。
  if (parsed.consumed === false) return handoff;
  if (boundary.role === 'context_rebuild') return handoff;
  const [userAfter] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
        or(
          gt(messages.createdAt, boundary.createdAt),
          and(eq(messages.createdAt, boundary.createdAt), gt(messageRowid, boundary.rowid)),
        ),
      ),
    )
    .limit(1);
  if (userAfter) return null;
  return handoff;
}

/**
 * 查 fork 出的子会话是否还欠一条「来源标记」——返回父会话 id,不欠则 null。
 *
 * 判定"子会话是否已经自己跑过一轮",两个信号取**或**——单用任一个都有整条引擎
 * 线失效。按代码里的判定顺序:
 *  1. 存在未 rewind 的 assistant 行(`createdAt >= session.createdAt`):引擎无关的
 *     主信号,带 rewind_at 过滤,所以回滚掉首个 post-fork turn 后会自动失效;
 *  2. `total_token_usage > 0` **且**存在未 rewind 的 user 行:Codex 补充——Claude
 *     完成路径不累加该列(recordSessionTurnTokens 的唯一调用点在 register.ts 的
 *     `event.source === 'codex'` done 分支),而 token 计数不随 rewind 回退,所以必须
 *     搭配一条仍存活的 user 行才作数。
 *
 * 精度边界(都落在信号一的时间戳比较上,方向不同):
 *  - **漏注入一次**:外部导入的会话里 createdAt 是**合成**的,importer 故意写
 *    `createdAt + sequence`(claude-local-sessions.ts)与 `timestamp + lineNo`
 *    (codex-local-sessions.ts)来强制行序,长 transcript 的末尾行能超出真实墙钟
 *    好几秒;fork 这类会话时,复制来的 assistant 可能被算成子会话自己的回应。
 *    同毫秒边界(复制行与 fork 操作同一毫秒)同理。
 *  - **多注入一次**:一轮跑完但 usage 上报失败、或 turn 中途重启。
 *
 * 为什么不看 user 行:goal 路径的 setGoal 先 persistUserMessage 再 fireTurn→peek
 * (goal-host/controller.ts),dispatch 前就落了 user 行,会把 fork 后首个动作是
 * /goal 的会话误判成已发送。assistant 只在模型确实回应后才出现,没这个问题。
 *
 * 为什么不加持久消费位:写 messages 隐藏边界行会让该会话之后再也不能被 fork
 * (resolveForkNativeSource 见到 context_rebuild 即判 UNSUPPORTED_HISTORY);
 * 加 schema 列则是为一个元信息付一次 migration。两者的代价都高于上述边角。
 */
export async function findPendingForkOrigin(sessionId: string): Promise<string | null> {
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({
      parentSessionId: sessions.parentSessionId,
      createdAt: sessions.createdAt,
      clearedAt: sessions.clearedAt,
      totalTokenUsage: sessions.totalTokenUsage,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!sessRow?.parentSessionId) return null;
  // fork 之后 /clear 过:渲染历史与原生上下文都被显式重置成新对话,再把来源标记
  // 灌进去等于往用户主动清空的上下文里塞旧元信息。
  if (sessRow.clearedAt !== null && sessRow.clearedAt >= sessRow.createdAt) return null;
  // 信号一(引擎无关):子会话自己产生过 assistant 行。带 rewindAt 过滤,所以回滚掉
  // 首个 post-fork turn 之后该信号会自动失效——标记重新 arm,正是期望行为。
  const [assistantAfterFork] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'assistant'),
        isNull(messages.rewindAt),
        gte(messages.createdAt, sessRow.createdAt),
      ),
    )
    .limit(1);
  if (assistantAfterFork) return null;
  // 信号二(Codex 补充):Claude 完成路径不累加 total_token_usage(唯一调用点在
  // register.ts 的 codex done 分支),所以只有 Codex 会走到这里。**必须搭配一条仍
  // 存活的 user 行**才作数:token 计数不随 rewind 回退,单看它会让"回滚掉首个
  // post-fork turn 再重发"的 Codex 会话永远拿不回来源标记。
  if ((sessRow.totalTokenUsage ?? 0) > 0) {
    const [userAfterFork] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.role, 'user'),
          isNull(messages.rewindAt),
          gte(messages.createdAt, sessRow.createdAt),
        ),
      )
      .limit(1);
    if (userAfterFork) return null;
  }
  return sessRow.parentSessionId;
}

/**
 * 只看 fork 血缘,不看首发消费态——给"重建原生上下文"用。
 *
 * 与 findPendingForkOrigin 的区别在语义:后者管的是"首发那一次性的来源标记",
 * 跑过一轮就该消费掉;而 fork 这个**事实**是会话的永久属性。引擎切换与消息删除
 * 会从持久消息重新拼出一份交接、创建新的原生上下文,那份交接是纯粹按 messages
 * 重建的,不含任何 fork 信息——若这里也跟着"已消费"一起沉默,新原生上下文就再也
 * 不知道自己是分叉出来的。
 *
 * /clear 之后同样抑制:那时历史已被用户显式重置,血缘不该再进新上下文。
 */
export async function findForkParentSessionId(sessionId: string): Promise<string | null> {
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({
      parentSessionId: sessions.parentSessionId,
      createdAt: sessions.createdAt,
      clearedAt: sessions.clearedAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!sessRow?.parentSessionId) return null;
  if (sessRow.clearedAt !== null && sessRow.clearedAt >= sessRow.createdAt) return null;
  return sessRow.parentSessionId;
}

/**
 * session-agent-switch:读取交接素材——本会话未被 rewind、晚于 /clear 边界的
 * 最近 limit 行(时间正序返回),只取交接需要的最小投影。
 *
 * `after`(Phase 2 增量交接):只取严格晚于该水位线(createdAt + rowid 决序,
 * 与 findPendingAgentHandoff 同 tie-break 口径)的行——即目标引擎停泊
 * 边界行之后、它"离开期间"的进展。
 */
export async function listMessagesForAgentHandoff(
  sessionId: string,
  limit = 400,
  after?: { createdAt: number; rowid: number },
): Promise<
  Array<{
    clientId: string;
    role: string;
    content: unknown;
    createdAt: number;
    agentMeta: Record<string, unknown> | null;
    toolUseId: string | null;
  }>
> {
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessRow?.clearedAt ?? null;
  const afterClear = clearedAt === null ? undefined : gt(messages.createdAt, clearedAt);
  const afterWatermark =
    after === undefined
      ? undefined
      : or(
          gt(messages.createdAt, after.createdAt),
          and(eq(messages.createdAt, after.createdAt), gt(messageRowid, after.rowid)),
        );
  const rows = await db
    .select({
      rowid: messageRowid,
      clientId: messages.clientId,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      agentMeta: messages.agentMeta,
      toolUseId: messages.toolUseId,
    })
    .from(messages)
    .where(
      and(eq(messages.sessionId, sessionId), isNull(messages.rewindAt), afterClear, afterWatermark),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(limit);
  rows.reverse();
  return rows
    .map((r) => {
      let content: unknown = r.content;
      try {
        content = JSON.parse(r.content);
      } catch {
        // 与 messageToCamel 同口径:非法 JSON 保留原字符串
      }
      let agentMeta: Record<string, unknown> | null = null;
      if (r.agentMeta) {
        try {
          const parsed: unknown = JSON.parse(r.agentMeta);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            agentMeta = parsed as Record<string, unknown>;
          }
        } catch {
          // 非法 JSON 视为无 meta
        }
      }
      if (agentMeta && typeof agentMeta.contextRebuild === 'object' && agentMeta.contextRebuild) {
        return null;
      }
      return {
        clientId: r.clientId,
        role: r.role,
        content,
        createdAt: r.createdAt,
        agentMeta,
        toolUseId: r.toolUseId ?? null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

/** 换窗身份用：不受 handoff 400 行窗口限制，找最近一条非 rewind 的 user。 */
export async function findLatestUserMessageForRebuild(sessionId: string): Promise<{
  clientId: string;
  role: string;
  content: unknown;
  createdAt: number;
  agentMeta: Record<string, unknown> | null;
  toolUseId: string | null;
} | null> {
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessRow?.clearedAt ?? null;
  const afterClear = clearedAt === null ? undefined : gt(messages.createdAt, clearedAt);
  const rows = await db
    .select({
      clientId: messages.clientId,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      agentMeta: messages.agentMeta,
      toolUseId: messages.toolUseId,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
        afterClear,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(30);
  for (const r of rows) {
    let content: unknown = r.content;
    try {
      content = JSON.parse(r.content);
    } catch {
      // 与 messageToCamel 同口径
    }
    let agentMeta: Record<string, unknown> | null = null;
    if (r.agentMeta) {
      try {
        const parsed: unknown = JSON.parse(r.agentMeta);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          agentMeta = parsed as Record<string, unknown>;
        }
      } catch {
        // 非法 JSON 视为无 meta
      }
    }
    const text =
      typeof content === 'string'
        ? content
        : content && typeof content === 'object' && !Array.isArray(content)
          ? typeof (content as { text?: unknown }).text === 'string'
            ? (content as { text: string }).text
            : ''
          : '';
    if (isSyntheticTriggerText(text)) continue;
    return {
      clientId: r.clientId,
      role: r.role,
      content,
      createdAt: r.createdAt,
      agentMeta,
      toolUseId: r.toolUseId ?? null,
    };
  }
  return null;
}

/** Phase 2:目标引擎的停泊原生会话(由最近一次"它离场"的边界行派生)。 */
export interface ParkedEngineSession {
  /** 该引擎离场时的原生 session id(resume 用)。 */
  sdkSessionId: string;
  /** 水位线 = 离场边界行的位置;增量交接只取其后的消息。 */
  watermarkCreatedAt: number;
  watermarkRowid: number;
}

/**
 * session-agent-switch Phase 2:查目标引擎是否有可续接的停泊原生会话。
 *
 * 停泊绑定不新增 schema,从边界行确定性派生:最新一条未被 rewind、晚于 /clear
 * 的 agent_switch 行中,content.fromAgentKind === targetDbKind 的那条——其
 * fromSdkSessionId 即该引擎离场时的原生会话快照,行位置即水位线。
 *
 * 只认"该引擎最近一次离场"那一行:fromSdkSessionId 为空(该引擎上次在场期间
 * 从未真正 spawn)→ 按无绑定处理,不回退更早的行——更早快照对应的原生会话
 * 已被后来的全新会话取代,续接它会让引擎拿到与消息流矛盾的记忆。
 * 消息删除写入的 context_rebuild 行会使它之前的全部停泊绑定失效；否则
 * 用户稍后切回旧引擎时仍会 resume 含被删消息的 transcript，绕过本次上下文重建。
 * content 是 JSON,无法在 SQL 里按字段过滤,取有界条数(边界行数量 = 切换次数,
 * 天然很小)在 JS 里扫。
 */
export async function findParkedEngineSession(
  sessionId: string,
  targetDbKind: 'cc' | 'codex' | 'pi',
): Promise<ParkedEngineSession | null> {
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessRow?.clearedAt ?? null;
  const afterClear = clearedAt === null ? undefined : gt(messages.createdAt, clearedAt);
  const [contextRebuild] = await db
    .select({ rowid: messageRowid, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'context_rebuild'), afterClear))
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  const rows = await db
    .select({
      rowid: messageRowid,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'agent_switch'),
        isNull(messages.rewindAt),
        afterClear,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(50);
  for (const row of rows) {
    let parsed: { fromAgentKind?: unknown; fromSdkSessionId?: unknown };
    try {
      parsed = JSON.parse(row.content) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.fromAgentKind !== targetDbKind) continue;
    if (
      contextRebuild &&
      (contextRebuild.createdAt > row.createdAt ||
        (contextRebuild.createdAt === row.createdAt && contextRebuild.rowid > row.rowid))
    ) {
      return null;
    }
    // 命中"该引擎最近一次离场":快照为空即无绑定,不再往更早找。
    if (typeof parsed.fromSdkSessionId !== 'string' || parsed.fromSdkSessionId.length === 0) {
      return null;
    }
    return {
      sdkSessionId: parsed.fromSdkSessionId,
      watermarkCreatedAt: row.createdAt,
      watermarkRowid: row.rowid,
    };
  }
  return null;
}

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
export async function markLatestAgentHandoffConsumed(sessionId: string): Promise<void> {
  const ownerScope = captureOwnerBroadcastScope();
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessRow?.clearedAt ?? null;
  const afterClear = clearedAt === null ? undefined : gt(messages.createdAt, clearedAt);
  const [boundary] = await db
    .select({ clientId: messages.clientId, role: messages.role, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        or(
          and(eq(messages.role, 'agent_switch'), isNull(messages.rewindAt)),
          eq(messages.role, 'context_rebuild'),
        ),
        afterClear,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  if (!boundary) return;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(boundary.content) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    parsed = value as Record<string, unknown>;
  } catch {
    return;
  }
  if (parsed.consumed === true) return;
  const nextContent = { ...parsed, consumed: true };
  if (boundary.role === 'agent_switch') {
    await updateAgentSwitchBoundaryContent(sessionId, boundary.clientId, nextContent, ownerScope);
    return;
  }
  await getDbClient()
    .drizzle.update(messages)
    .set({ content: safeStringify(nextContent) })
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.clientId, boundary.clientId),
        eq(messages.role, 'context_rebuild'),
      ),
    );
}

/** 原子事务提交后只读并广播边界新行，不做第二次写入。 */
export async function rebroadcastAgentSwitchBoundary(
  sessionId: string,
  boundaryClientId: string,
  ownerScope: DataOwnerBroadcastScope | null = captureOwnerBroadcastScope(),
): Promise<void> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, boundaryClientId)))
    .limit(1);
  if (row && isOwnerBroadcastScopeCurrent(ownerScope)) {
    broadcastMessageRow(sessionId, messageToCamel(row), ownerScope);
  }
}
