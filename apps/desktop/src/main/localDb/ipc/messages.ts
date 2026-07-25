/**
 * chat-data-localization F5：Messages IPC handlers（C7）。
 *
 * - `list(sessionId, opts)` —— 按 createdAt/rowid desc，limit 默认 50/上限 100；before 为 cursor message id
 * - `create(sessionId, body)` —— `(sessionId, clientId)` 唯一索引保证幂等：已存在则返回已有记录
 * - `updateContent(sessionId, clientId, content)` —— 用于 ask_user 的 answered 状态等
 */

import { ipcMain, BrowserWindow } from 'electron';
import { and, asc, count, eq, lt, gt, desc, isNull, or, sql, type SQL } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';

import { getDbClient } from '../client/current';
import { messages, sessions } from '../schema';
import {
  messageToCamel,
  messageCreateToRow,
  safeStringify,
  extractMessagePreview,
} from '../mapper';
import { throwIpcError, requireString } from '../../utils/ipcValidate';
import { tapWindowBroadcast } from '../../device-link/broadcast-tap';
import { createLogger } from '../../logger';
import { commitMessageMediaRefs } from '../../cindy-media/chatAttachments';
import { removeRefs as removeMediaRefs } from '../../cindy-media/ledger';
import { importExternalCodexMessagesForSession } from '../../maker-host/codex-local-sessions';
import { importExternalClaudeCodeMessagesForSession } from '../../maker-host/claude-local-sessions';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context';
import { onMessageCreated as onChatMessageCreatedForEmbedding } from '../../embedders/chat-history-embedder';
import { recomputePrRefsForSession, recordPrRefsForMessage } from '../../git-context/prRefsStore';
import {
  isSyntheticTriggerText,
  mergeDismissedIntoErrorContent,
} from '../../../shared/interruptedTurn.js';
import { resolveStaleCodexSubscriptionValueEstimate } from '../../../shared/codexSubscriptionValue.js';
import { normalizeTurnUsageDetails } from '../../../shared/turnUsageDetails.js';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion.js';
import {
  addCompatibleRegionalMoney,
  asValueEstimateMoney,
  normalizeRegionalMoney,
  regionalCurrencyForRegion,
  regionalizeLegacyUsd,
  regionalizeUsd,
  type RegionalMoney,
} from '../../../shared/regionalMoney.js';
import { capReferenceMessageRows } from './history.js';
import type { Message, MessageRole, AgentMeta } from '../../../renderer/lib/ccAgent.types';

const log = createLogger('localDb/messages');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MESSAGE_DELETION_USER_BOUNDARY_PAGE_SIZE = 32;
const messageRowid = sql<number>`rowid`;
type MessageRow = typeof messages.$inferSelect;
type MessageRowWithRowid = MessageRow & { rowid: number };

export interface EstimatedSessionValueEntry {
  clientId: string;
  money: RegionalMoney;
  costUsd?: number;
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

export function registerMessageIpc(): void {
  ipcMain.handle('local-db:messages:list', async (_e, sessionId: unknown, opts: unknown) => {
    const sid = requireString(sessionId, 'sessionId');
    const limit = clampLimit((opts as { limit?: number } | undefined)?.limit);
    const before = (opts as { before?: string } | undefined)?.before;
    const beforeTs = (opts as { beforeTs?: number } | undefined)?.beforeTs;
    const db = getDbClient().drizzle;

    // 外部历史导入(Codex rollout / Claude transcript):device-link 隧道调用
    // 只在首页请求跑(分页跳过,#318 性能语义;首页判定 = 无任何分页游标),
    // 覆盖「被控端从未本机打开该会话」的导入缺口。
    await runMessagesListImportSideEffects(
      sid,
      {},
      {
        deviceLinkFirstPage: !before && beforeTs == null,
      },
    );

    let beforeCursor: { createdAt: number; rowid: number } | null = null;
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
      .orderBy(desc(messages.createdAt), desc(messageRowid))
      .limit(limit);
    return hydrateLegacyUserTurnCosts(rows.map(messageToCamelWithRowid));
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

  ipcMain.handle('local-db:messages:estimatedSessionValue', async (_e, sessionId: unknown) => {
    const sid = requireString(sessionId, 'sessionId');
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
    const totalValueMoney =
      addCompatibleRegionalMoney(
        entries.map((entry) => entry.money),
        regionalCurrencyForRegion(CURRENT_CINDY_REGION),
      );
    const hasCompleteUsdProjection = entries.every((entry) => typeof entry.costUsd === 'number');
    return {
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
 * codex / cc importer 各自在会话非对应 agent / 非 import 会话时 early-return，但仍各跑一次
 * `SELECT FROM sessions`，且二者串行 await 在真正的消息查询之前。device-link 远程读是被控端
 * 已导入状态的镜像:在每次(含分页)远程 open 上重跑这些「读外部 rollout/JSONL → 写本机 DB」的
 * 本地副作用,只会把导入延迟串接到消息查询前(见 GitHub issue #318 A3)。故 device-link 路径
 * 整体跳过这些副作用;非 device-link 路径保持原有的串行顺序、错误吞并与告警语义不变。
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
  await importCodex(sessionId).catch((err) => {
    log.warn('external Codex message import failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
  await importClaude(sessionId).catch((err) => {
    log.warn('external Claude Code message import failed', {
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
function broadcastMessageRow(sessionId: string, msg: Message): void {
  tapWindowBroadcast('local-db:messages:created', { sessionId, message: msg });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('local-db:messages:created', { sessionId, message: msg });
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

/**
 * 消息菜单删除前解析本次动作的完整范围。user 仍只删除自己；assistant 以相邻
 * 真实 user 行为边界，返回整轮 AI 产出，并跳过 autoResume 这类隐藏 user 行。
 * 真正删除由 message.delete 原子事务完成，避免在 renderer / IPC adapter 里拼业务判断。
 */
export async function getMessageDeletionTarget(
  sessionId: string,
  clientId: string,
): Promise<{
  id: string;
  role: 'user' | 'assistant';
  deletedClientIds: string[];
} | null> {
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
  return { id: row.id, role: row.role, deletedClientIds };
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
): Promise<{
  sessionId: string;
  deletedClientIds: string[];
  updatedAt: number;
  preview: string | null;
  messageCount: number;
}> {
  const now = Date.now();
  const result = await getDbClient().tx('message.delete', {
    sessionId,
    clientIds,
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

  // sessions:patched 的消费者只做 shallow merge，不会主动重拉。删除后同步带出
  // canonical session-list projection，避免其它窗口 / device-link 控制端继续显示
  // 已删除的末条消息预览或旧 _count。count 口径与 sessions:list / preview 的可见消息保持一致。
  let preview: string | null = null;
  let messageCount = 0;
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
    const [[countRow], [latestRow]] = await Promise.all([
      db
        .select({ messageCount: count(messages.id) })
        .from(messages)
        .where(visibleMessageProjection),
      db
        .select({ content: messages.content, role: messages.role })
        .from(messages)
        .where(visibleMessageProjection)
        .orderBy(desc(messages.createdAt), desc(messageRowid))
        .limit(1),
    ]);
    preview = extractMessagePreview(latestRow?.content, latestRow?.role);
    messageCount = countRow?.messageCount ?? 0;
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
    updatedAt: now,
    preview,
    messageCount,
  };
}

export function broadcastMessageDeleted(payload: MessageDeletedPayload): void {
  tapWindowBroadcast('local-db:messages:deleted', payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('local-db:messages:deleted', payload);
    } catch {
      /* swallow per-window broadcast failures */
    }
  }
}

export async function dismissErrorMessage(
  sessionId: string,
  clientId: string,
): Promise<Message | null> {
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
  if (updated) broadcastMessageRow(sessionId, updated);
  return updated;
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
    agentKind?: 'cc' | 'codex' | null;
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
  },
): Promise<Message> {
  const db = getDbClient().drizzle;
  const existing = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, body.clientId)))
    .limit(1);
  if (existing.length > 0) {
    return messageToCamel(existing[0]);
  }

  const id = createId();
  const now = Date.now();
  const insertRow = messageCreateToRow(id, sessionId, body, now);
  try {
    await db.insert(messages).values(insertRow);
  } catch (err) {
    const after = await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, body.clientId)))
      .limit(1);
    if (after.length > 0) return messageToCamel(after[0]);
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
  // fire-and-forget:挂账失败只警告,绝不影响消息落库本身。
  void commitMessageMediaRefs({
    sessionId,
    role: body.role,
    content: insertRow.content,
  }).catch((err) => {
    log.warn('message media ref commit failed', {
      sessionId,
      clientId: body.clientId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  // Broadcast 给所有 renderer window — 用于 main 端创建消息 (e.g. feishu /ctr
  // 接管路径下 persistUserMessage / persistAssistantMessage) 时让 renderer
  // 的 makerChatStore push 到 in-memory state, 让消息流实时刷新。
  // Renderer 自己调 createMessage IPC 时也会触发这个 broadcast, 但因为它已经
  // 主动 push 过, 监听端按 (sessionId, clientId) dedupe 就不会重复显示。
  if (opts?.shouldBroadcast?.() !== false) {
    broadcastMessageRow(sessionId, msg);
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
    if (meta?.turnCostIsEstimate !== true) continue;
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
      money: regionalizeUsd(costUsd, CURRENT_CINDY_REGION, 'legacy-usd', 'value-estimate'),
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
  broadcastMessageRow(sessionId, messageToCamel(row));
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
        ? regionalizeLegacyUsd(meta.turnCostUsd, CURRENT_CINDY_REGION)
        : undefined;
    const rawSegment = structured ?? legacy;
    const isEstimate = rawSegment?.kind === 'value-estimate' || meta?.turnCostIsEstimate === true;
    const segment = rawSegment && isEstimate ? asValueEstimateMoney(rawSegment) : rawSegment;
    if (!segment || segment.amount <= 0) continue;
    values.push(segment);
    if (isEstimate) estimatedCurrencies.add(segment.currency);
  }
  const money = addCompatibleRegionalMoney(
    values,
    regionalCurrencyForRegion(CURRENT_CINDY_REGION),
  );
  const hasEstimatedValue =
    money !== null && estimatedCurrencies.has(money.currency);
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
        money: regionalizeLegacyUsd(costUsd, CURRENT_CINDY_REGION),
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
): Promise<Array<{ clientId: string; role: string; content: unknown; createdAt: number }>> {
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
    })
    .from(messages)
    .where(
      and(eq(messages.sessionId, sessionId), isNull(messages.rewindAt), afterClear, afterWatermark),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(limit);
  rows.reverse();
  return rows.map((r) => {
    let content: unknown = r.content;
    try {
      content = JSON.parse(r.content);
    } catch {
      // 与 messageToCamel 同口径:非法 JSON 保留原字符串
    }
    return { clientId: r.clientId, role: r.role, content, createdAt: r.createdAt };
  });
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
  targetDbKind: 'cc' | 'codex',
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
): Promise<boolean> {
  const updated = await updateMessageContent(sessionId, clientId, content);
  if (!updated) return false;
  broadcastMessageRow(sessionId, updated);
  return true;
}

/** vendor accepted 后持久化最新 handoff 消费位；内存 registry 不等待这笔辅助写。 */
export async function markLatestAgentHandoffConsumed(sessionId: string): Promise<void> {
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
    await updateAgentSwitchBoundaryContent(sessionId, boundary.clientId, nextContent);
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
): Promise<void> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, boundaryClientId)))
    .limit(1);
  if (row) broadcastMessageRow(sessionId, messageToCamel(row));
}
