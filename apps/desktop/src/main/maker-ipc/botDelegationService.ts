import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { app } from 'electron';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { ensureProjectGitInitialized } from '../git-snapshot/projectGitBootstrap.js';
import { getDbClient } from '../localDb/client/current.js';
import type { BotsFinishDelegationResult } from '../localDb/client/tx/types.js';
import { visibleMessageTextForConversationSearch } from '../localDb/conversationSearch.pure.js';
import { createBotCanonicalSession } from '../localDb/ipc/bots.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { sessionCreateToRow } from '../localDb/mapper.js';
import {
  botDelegations,
  botProfiles,
  botSessionLinks,
  messages,
  sessions,
} from '../localDb/schema.js';
import { readGitSafetySettings } from '../maker-host/git-safety-settings-store.js';
import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import { UI_ACTION_TRIGGER_PREFIX } from '../../shared/interruptedTurn.js';
import { createLogger } from '../logger.js';
import { resolveBusinessSessionId } from '../sessionIds.js';
import { registerBotDelegationParentCancellation } from './botDelegationLifecycle.js';
import { classifyBotDelegationDispatchFailure } from './botDelegationDispatchOutcome.js';
import { resolveBotCanonicalSession } from './botCanonicalSessionRegistry.js';
import type {
  BotDelegationArtifact,
  BotDelegationChangedPayload,
  BotDelegationPendingInteraction,
  BotDelegationPlanSnapshot,
  BotDelegationStatus,
  BotDelegationView,
} from '../../shared/botDelegation.js';
import { parseBotDelegationPlanSnapshot } from '../../shared/botDelegation.js';
import type {
  BotCollaborationMeta,
  BotCollaborationRole,
  BotDelegationInterjectResult,
} from '../../shared/botCollaboration.js';
import { BOT_DELEGATION_CLIENT_ID } from '../../shared/botCollaboration.js';
import { ensureBotWorkspaceDir } from './botProfileFolder.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const ACTIVE_DELEGATION_STATUSES = ['queued', 'running', 'waiting'] as const;
/** 一条补充消息的正文上限：够写清「先别做 X，改做 Y」，又不至于变成另一项任务。 */
const MAX_INTERJECTION_CHARS = 4_000;
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_ACTIVE_CHILDREN = 10;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_OBJECTIVE_CHARS = 12_000;
const MAX_RESULT_CHARS = 12_000;
const MAX_RETRY_DELAY_MS = 60_000;
/** 对方停在要人拍板的地方时,超时不计时;每隔这么久再看一眼有没有答完。 */
const WAITING_TIMEOUT_GRACE_MS = 5 * 60_000;
const MAX_ARTIFACTS = 64;
const messageRowid = sql<number>`"messages"."rowid"`;
const log = createLogger('bot-delegation');

type DelegationStatus = BotDelegationStatus;
type DelegationRow = typeof botDelegations.$inferSelect;

type DispatchResult =
  | {
      ok: true;
      targetSessionId: string;
      wakeKind: 'resumed' | 'already-active' | 'created' | 'queued';
    }
  | { ok: false; errorCode: string; message: string };

export interface BotDelegationServiceDeps {
  dispatch: (params: {
    targetSessionId: string;
    message: string;
    persistedContent?: string;
    clientId?: string;
    onAccepted?: () => void | Promise<void>;
  }) => Promise<DispatchResult>;
  abortSession: (sessionId: string) => Promise<void>;
  closeSession?: (sessionId: string) => Promise<void>;
  broadcastSessionCreated?: (sessionId: string) => void;
  persistTimelineMessage?: (params: {
    sessionId: string;
    clientId: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt?: number;
    /**
     * 只增不改的呈现标记（写进 `messages.agent_meta`）。renderer 据此把镜像消息
     * 升级成任务卡 / 客座气泡；不带标记的老行继续按普通文本渲染。
     */
    agentMeta?: Record<string, unknown>;
  }) => Promise<void>;
  onChanged?: (payload: BotDelegationChangedPayload) => void;
  /**
   * 替用户回答子任务里挂起的交互(权限 / 提问 / 计划)。返回 false 表示这条交互
   * 已经不在了(用户先答了、超时了、子任务关了)。
   */
  resolveInteraction?: (requestId: string, decision: InteractionDecision) => boolean;
  /** 子任务这一路改过的文件;缺省不采集交付物。 */
  collectArtifacts?: (sessionId: string) => Promise<BotDelegationArtifact[]>;
  /** Pending follow-up input must run before this Session task can become terminal. */
  hasPendingInput?: (sessionId: string) => boolean;
  now?: () => number;
  createId?: () => string;
  maxActiveChildren?: number;
}

/** Start one tracked Cindy Session task from a persistent Bot task. */
export interface SessionTaskInput {
  callerSessionId: string;
  objective: string;
  contextRefs?: string[];
  /** 任务标题,缺省取 objective 首行。 */
  title?: string;
  /**
   * 工作目录,必须是已存在的绝对路径;缺省用发起伙伴的 Home workspace。
   */
  workingDir?: string;
  timeoutMs?: number;
}

/**
 * 发起方对一条 Session 任务的消息。任务停在 waiting 时,approve / deny / answer 直接替
 * 用户拍板;message 在进行中时追加要求,在终态时把同一任务重新拉起来接着做。
 */
export type SessionTaskMessage =
  | { kind: 'approve' }
  | { kind: 'deny'; reason?: string }
  | { kind: 'answer'; answers: Record<string, string> }
  | { kind: 'message'; text: string; idempotencyKey?: string };

export type BotDelegationResult<T extends object = object> =
  ({ ok: true } & T)
  | { ok: false; errorCode: string; message: string };

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseArtifacts(value: string | null | undefined): BotDelegationArtifact[] {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const artifact = item as Partial<BotDelegationArtifact>;
      if (
        typeof artifact.path !== 'string'
        || typeof artifact.absolutePath !== 'string'
        || !['added', 'modified', 'deleted', 'renamed'].includes(artifact.status ?? '')
      ) return [];
      return [artifact as BotDelegationArtifact];
    });
  } catch {
    return [];
  }
}

function sessionTaskViewStatus(
  row: Pick<DelegationRow, 'status' | 'lastError'>,
): BotDelegationStatus {
  if (row.status === 'failed' && /^TIMEOUT(?:_|:)/i.test(row.lastError ?? '')) {
    return 'timed-out';
  }
  return row.status as BotDelegationStatus;
}

function boundedStringList(value: string[] | undefined, max = 32): string[] {
  if (!value) return [];
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
    .slice(0, max)
    .map((item) => item.slice(0, 4_000));
}

function readDeadline(permissionSnapshotJson: string): number | null {
  const plan = parseBotDelegationPlanSnapshot(permissionSnapshotJson);
  const deadlineAt = plan?.limits.deadlineAt ?? parseRecord(permissionSnapshotJson).deadlineAt;
  return typeof deadlineAt === 'number' && Number.isFinite(deadlineAt) ? deadlineAt : null;
}

function extendDeadlineSnapshot(permissionSnapshotJson: string, pausedMs: number): string | null {
  const plan = parseBotDelegationPlanSnapshot(permissionSnapshotJson);
  if (!plan || pausedMs <= 0) return null;
  return JSON.stringify({
    ...plan,
    limits: {
      ...plan.limits,
      deadlineAt: plan.limits.deadlineAt + pausedMs,
    },
  });
}

function parsePendingInteraction(
  value: string | null | undefined,
): BotDelegationPendingInteraction | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<BotDelegationPendingInteraction>;
    if (
      typeof parsed.requestId !== 'string'
      || (parsed.kind !== 'permission'
        && parsed.kind !== 'ask_user_question'
        && parsed.kind !== 'plan_review')
      || typeof parsed.summary !== 'string'
      || typeof parsed.raisedAt !== 'number'
    ) return null;
    return {
      requestId: parsed.requestId,
      kind: parsed.kind,
      summary: parsed.summary,
      raisedAt: parsed.raisedAt,
    };
  } catch {
    return null;
  }
}

/**
 * 上下文引用是纯文本指针（文件名、链接、一句背景）,随目标事项进入子任务提示词。
 * 项目绑定退出 v1 后它不再承载路径授权语义:子任务的实际可读写面由它自己的
 * 工作目录与权限门决定,这里只挡注入类噪音。
 */
function normalizeDelegationReferences(
  refs: string[] | undefined,
): BotDelegationResult<{ refs: string[] }> {
  const bounded = boundedStringList(refs);
  for (const ref of bounded) {
    if (ref.includes('\0') || ref.includes('\n') || ref.includes('\r') || ref.length > 512) {
      return {
        ok: false,
        errorCode: 'INVALID_REFERENCE',
        message: 'context_refs 只接受不含换行的短文本引用',
      };
    }
  }
  return { ok: true, refs: [...new Set(bounded)] };
}

export function createBotDelegationService(deps: BotDelegationServiceDeps) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const completionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Serializes a terminal receipt with a user continuing the same task card. */
  const completionInFlight = new Map<string, Promise<void>>();
  const interactionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const cleanupRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Live resolver handles remain process-local; the user-visible waiting
   * summary and paused status are persisted on the delegation row. */
  const pendingInteractions = new Map<string, BotDelegationPendingInteraction & {
    request: InteractionRequest;
  }>();
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? randomUUID;
  const maxActiveChildren = Math.max(1, deps.maxActiveChildren ?? DEFAULT_MAX_ACTIVE_CHILDREN);
  const persistTimelineMessage = deps.persistTimelineMessage ?? (async (params) => {
    await createMessage(params.sessionId, {
      clientId: params.clientId,
      role: params.role,
      content: params.content,
      agentKind: null,
      createdAt: params.createdAt,
      ...(params.agentMeta
        ? { agentMeta: params.agentMeta as Parameters<typeof createMessage>[1]['agentMeta'] }
        : {}),
    });
  });

  const clearTimer = (delegationId: string): void => {
    const timer = timers.get(delegationId);
    if (timer) clearTimeout(timer);
    timers.delete(delegationId);
  };

  const clearRetryTimer = (delegationId: string): void => {
    const timer = retryTimers.get(delegationId);
    if (timer) clearTimeout(timer);
    retryTimers.delete(delegationId);
  };

  const clearCompletionRetryTimer = (delegationId: string): void => {
    const timer = completionRetryTimers.get(delegationId);
    if (timer) clearTimeout(timer);
    completionRetryTimers.delete(delegationId);
  };

  const clearInteractionRetryTimer = (delegationId: string): void => {
    const timer = interactionRetryTimers.get(delegationId);
    if (timer) clearTimeout(timer);
    interactionRetryTimers.delete(delegationId);
  };

  const clearCleanupRetryTimer = (delegationId: string): void => {
    const timer = cleanupRetryTimers.get(delegationId);
    if (timer) clearTimeout(timer);
    cleanupRetryTimers.delete(delegationId);
  };

  const cleanupChildSession = async (
    delegationId: string,
    childSessionId: string,
    abortChild: boolean,
    attempt = 0,
  ): Promise<void> => {
    try {
      if (abortChild) await deps.abortSession(childSessionId);
      await deps.closeSession?.(childSessionId);
      clearCleanupRetryTimer(delegationId);
    } catch (error) {
      log.warn('Session task cleanup failed; scheduling retry', {
        delegationId,
        childSessionId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      clearCleanupRetryTimer(delegationId);
      const delay = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(attempt, 6));
      const timer = setTimeout(() => {
        cleanupRetryTimers.delete(delegationId);
        void cleanupChildSession(delegationId, childSessionId, abortChild, attempt + 1);
      }, delay);
      timer.unref?.();
      cleanupRetryTimers.set(delegationId, timer);
    }
  };

  const emitChanged = (payload: BotDelegationChangedPayload): void => {
    deps.onChanged?.(payload);
  };

  const isActiveDelegation = (status: DelegationStatus): boolean =>
    ACTIVE_DELEGATION_STATUSES.includes(
      status as (typeof ACTIVE_DELEGATION_STATUSES)[number],
    );

  const buildDelegationGraph = (rows: DelegationRow[]) => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const byChildSessionId = new Map(
      rows.flatMap((row) => (row.childSessionId ? [[row.childSessionId, row] as const] : []),
    ),
    );
    const childrenByParentSessionId = new Map<string, DelegationRow[]>();
    for (const row of rows) {
      if (!row.parentSessionId) continue;
      const children = childrenByParentSessionId.get(row.parentSessionId) ?? [];
      children.push(row);
      childrenByParentSessionId.set(row.parentSessionId, children);
    }
    return { byId, byChildSessionId, childrenByParentSessionId };
  };

  const descendantRows = (
    root: DelegationRow,
    graph: ReturnType<typeof buildDelegationGraph>,
  ): DelegationRow[] => {
    const result: DelegationRow[] = [];
    const pending = root.childSessionId
      ? [...(graph.childrenByParentSessionId.get(root.childSessionId) ?? [])]
      : [];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const next = pending.shift()!;
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      result.push(next);
      if (next.childSessionId) {
        pending.push(...(graph.childrenByParentSessionId.get(next.childSessionId) ?? []));
      }
    }
    return result;
  };

  const ensureTargetCanonicalSession = async (target: {
    id: string;
    currentVersion: number;
  }): Promise<BotDelegationResult<{ sessionId: string }>> => {
    const db = getDbClient().drizzle;
    const registered = await resolveBotCanonicalSession(target.id);
    let expectedCanonicalSessionId = registered.status === 'resolved'
      ? registered.sessionId
      : null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (expectedCanonicalSessionId) {
        const [current] = await db
          .select({
            status: sessions.status,
            source: sessions.source,
            botId: botSessionLinks.botId,
            role: botSessionLinks.role,
          })
          .from(sessions)
          .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
          .where(eq(sessions.id, expectedCanonicalSessionId))
          .limit(1);
        if (
          current?.status === 'active'
          && current.source === 'bot'
          && current.botId === target.id
          && current.role === 'canonical'
        ) {
          return { ok: true, sessionId: expectedCanonicalSessionId };
        }
        const replacement = await createBotCanonicalSession({
          botId: target.id,
          expectedCanonicalSessionId,
          expectedProfileVersion: target.currentVersion,
          recoverMissingOnly: current === undefined,
        });
        if (replacement.created) deps.broadcastSessionCreated?.(replacement.canonicalSessionId);
        expectedCanonicalSessionId = replacement.canonicalSessionId;
        continue;
      }
      const created = await createBotCanonicalSession({
        botId: target.id,
        expectedCanonicalSessionId: null,
        expectedProfileVersion: target.currentVersion,
      });
      if (created.created) deps.broadcastSessionCreated?.(created.canonicalSessionId);
      expectedCanonicalSessionId = created.canonicalSessionId;
    }
    return {
      ok: false,
      errorCode: 'TARGET_CANONICAL_UNAVAILABLE',
      message: '目标伙伴的主任务正在变化，请稍后重试发送',
    };
  };

  const requesterDisplayName = async (botId: string): Promise<string> => {
    const db = getDbClient().drizzle;
    const [profile] = await db
      .select({ displayName: botProfiles.displayName })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    return profile?.displayName || botId;
  };

  /**
   * 冻结这次协作双方的展示身份。名字后来改了不回填历史消息——消息流讲的是
   * 「当时谁把活交给了谁」，不是「他们现在叫什么」。
   */
  const collaborationMeta = async (
    row: Pick<DelegationRow,
      'id' | 'requestingBotId' | 'targetBotId' | 'objective' | 'parentSessionId' | 'childSessionId'
    >,
    role: BotCollaborationRole,
  ): Promise<BotCollaborationMeta> => {
    const db = getDbClient().drizzle;
    const ids = [...new Set([row.requestingBotId, ...(row.targetBotId ? [row.targetBotId] : [])])];
    const profiles = await db
      .select({ id: botProfiles.id, displayName: botProfiles.displayName })
      .from(botProfiles)
      .where(inArray(botProfiles.id, ids));
    const nameOf = (botId: string): string =>
      profiles.find((profile) => profile.id === botId)?.displayName || botId;
    return {
      v: 1,
      role,
      delegationId: row.id,
      fromBotId: row.requestingBotId,
      fromBotName: nameOf(row.requestingBotId),
      toBotId: row.targetBotId,
      // 空目标 = 普通 Cindy 任务;卡片上的对方就叫 Cindy。
      toBotName: row.targetBotId ? nameOf(row.targetBotId) : 'Cindy',
      parentSessionId: row.parentSessionId,
      childSessionId: row.childSessionId,
      objective: row.objective.slice(0, 400),
    };
  };

  /**
   * 父任务里的任务卡锚点：空正文 + `botCollaboration` v1 兼容标记，只为在发起方的消息流
   * **原位**留下一个可追踪任务。卡片的实时状态、秒数与终态结果
   * 都由 delegation 行推送驱动，锚点本身不需要更新。
   *
   * 锚点写不进去时必须在 dispatch 前失败，不能让任务在没有入口的情况下隐身启动。
   */
  const projectParentRequest = async (row: Pick<DelegationRow,
    | 'id'
    | 'requestingBotId'
    | 'targetBotId'
    | 'objective'
    | 'parentSessionId'
    | 'childSessionId'
    | 'createdAt'
  >): Promise<void> => {
    if (!row.parentSessionId) return;
    await persistTimelineMessage({
      sessionId: row.parentSessionId,
      clientId: BOT_DELEGATION_CLIENT_ID.parentRequest(row.id),
      role: 'assistant',
      content: '',
      createdAt: row.createdAt,
      agentMeta: {
        botCollaboration: await collaborationMeta(row, 'delegation-request'),
      },
    });
  };

  /**
   * 完成信号:对模型是一条内部指令,对用户不可见。
   *
   * 用户可见的终态由发起方消息流里的任务卡承载(delegation 行推送驱动),不再
   * 往时间线里落一条机读文本。指令行带 UI_ACTION_TRIGGER_PREFIX,与既有的
   * 合成 UI 指令共用同一条「渲染隐藏 / 预览排除 / 搜索排除」判定链。
   *
   * 投递目标：优先冻结的父任务；父任务已被恢复流程替换时，改投发起 Bot 当前的
   * 主任务。完成信号属于 Bot 本人，不属于损坏的旧任务。两者都不在（Bot 已
   * 暂停/归档)才放弃投递,此时卡片终态仍然可见,不算静默丢失。
   */
  const deliverCompletion = async (params: {
    id: string;
    runSequence: number;
    requestingBotId: string;
    targetBotId: string | null;
    parentSessionId: string | null;
    childSessionId: string | null;
    objective: string;
    status: Extract<DelegationStatus, 'completed' | 'failed' | 'cancelled' | 'timed-out'>;
    resultSummary?: string | null;
    artifacts?: BotDelegationArtifact[];
    lastError?: string | null;
  }, attempt = 0): Promise<boolean> => {
    const previousDelivery = completionInFlight.get(params.id);
    if (previousDelivery) await previousDelivery.catch(() => undefined);
    let releaseDelivery!: () => void;
    const thisDelivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    completionInFlight.set(params.id, thisDelivery);
    try {
    const completionStillPending = async (): Promise<boolean> => {
      const [current] = await getDbClient().drizzle
        .select({
          status: botDelegations.status,
          childSessionId: botDelegations.childSessionId,
          runSequence: botDelegations.runSequence,
          completionDeliveredAt: botDelegations.completionDeliveredAt,
        })
        .from(botDelegations)
        .where(eq(botDelegations.id, params.id))
        .limit(1);
      return !!current
        && current.status === params.status
        && current.childSessionId === params.childSessionId
        && current.runSequence === params.runSequence
        && current.completionDeliveredAt === null;
    };
    // A retry from an earlier run may fire while the same task card is being
    // continued. Never let that stale receipt wake or mark the new run.
    if (!(await completionStillPending())) {
      clearCompletionRetryTimer(params.id);
      return false;
    }
    const targetSessionId = await requesterLiveSessionId(params.requestingBotId, params.parentSessionId);
    if (!targetSessionId) {
      log.warn('skip Bot delegation completion: requester has no live task', {
        delegationId: params.id,
        requestingBotId: params.requestingBotId,
        parentSessionId: params.parentSessionId,
      });
      scheduleCompletionRetry(params, attempt);
      return false;
    }
    const taskSubject = '后台任务';
    const statusLine =
      params.status === 'completed'
        ? '已完成'
        : params.status === 'cancelled'
          ? '已取消'
          : params.status === 'timed-out' || params.lastError?.startsWith('TIMEOUT')
            ? '已超时'
            : '失败了';
    const artifacts = params.artifacts ?? [];
    const completionMessage = [
      `${UI_ACTION_TRIGGER_PREFIX}[任务回执] ${taskSubject}${statusLine}。task_id: ${params.id}`,
      `目标事项: ${params.objective.slice(0, 400)}`,
      params.resultSummary ? `结果:\n${params.resultSummary}` : '',
      artifacts.length
        ? `交出的文件(${artifacts.length}):\n${artifacts.slice(0, 20).map((item) => `- ${item.absolutePath}`).join('\n')}`
        : '',
      params.lastError ? `失败原因: ${params.lastError}` : '',
      '当前时间线里的任务卡已更新到终态,交付文件清单也在卡片里。直接依据结果接手继续当前工作;结果不够或还想让执行者接着做,用 `message_session_task`(带 task_id)继续说,不必重新发起。回复用户时不要复述本条回执,也不要提及任何内部编号。',
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      if (!(await completionStillPending())) {
        clearCompletionRetryTimer(params.id);
        return false;
      }
      const dispatched = await deps.dispatch({
        targetSessionId,
        message: completionMessage,
        persistedContent: completionMessage,
        clientId: BOT_DELEGATION_CLIENT_ID.completionRun(params.id, params.runSequence),
      });
      if (!dispatched.ok) {
        log.warn('Bot Session task completion was not accepted', {
          delegationId: params.id,
          errorCode: dispatched.errorCode,
        });
        scheduleCompletionRetry(params, attempt);
        return false;
      }
      const [marked] = await getDbClient().drizzle
        .update(botDelegations)
        .set({ completionDeliveredAt: now(), updatedAt: now() })
        .where(and(
          eq(botDelegations.id, params.id),
          eq(botDelegations.runSequence, params.runSequence),
          eq(botDelegations.status, params.status),
          params.childSessionId === null
            ? isNull(botDelegations.childSessionId)
            : eq(botDelegations.childSessionId, params.childSessionId),
          isNull(botDelegations.completionDeliveredAt),
        ))
        .returning({ id: botDelegations.id });
      clearCompletionRetryTimer(params.id);
      return !!marked;
    } catch (error) {
      log.warn('Bot Session task completion delivery failed', {
        delegationId: params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleCompletionRetry(params, attempt);
      return false;
    }
    } finally {
      releaseDelivery();
      if (completionInFlight.get(params.id) === thisDelivery) {
        completionInFlight.delete(params.id);
      }
    }
  };

  function scheduleCompletionRetry(
    params: Parameters<typeof deliverCompletion>[0],
    attempt: number,
  ): void {
    clearCompletionRetryTimer(params.id);
    const delay = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(attempt, 6));
    const timer = setTimeout(() => {
      completionRetryTimers.delete(params.id);
      void deliverCompletion(params, attempt + 1);
    }, delay);
    timer.unref?.();
    completionRetryTimers.set(params.id, timer);
  }

  /**
   * 发起伙伴此刻活着的那条任务：优先冻结的父任务；若它已被恢复流程替换，改投
   * 当前主任务。回执与交互事件属于伙伴本人，不属于损坏的旧任务。
   */
  const requesterLiveSessionId = async (
    requestingBotId: string,
    parentSessionId: string | null,
  ): Promise<string | null> => {
    const db = getDbClient().drizzle;
    const liveRequesterTask = async (sessionId: string): Promise<boolean> => {
      const [parent] = await db
        .select({
          status: sessions.status,
          role: botSessionLinks.role,
          botId: botSessionLinks.botId,
          profileStatus: botProfiles.status,
        })
        .from(sessions)
        .innerJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
        .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return (
        parent?.status === 'active'
        && parent.profileStatus === 'active'
        && parent.botId === requestingBotId
        && (parent.role === 'canonical' || parent.role === 'delegation')
      );
    };
    if (parentSessionId && (await liveRequesterTask(parentSessionId))) return parentSessionId;
    const current = await resolveBotCanonicalSession(requestingBotId).catch(() => null);
    if (current?.status === 'resolved' && (await liveRequesterTask(current.sessionId))) {
      return current.sessionId;
    }
    return null;
  };

  const repairDelegationParent = async (row: DelegationRow): Promise<DelegationRow> => {
    const liveParentSessionId = await requesterLiveSessionId(
      row.requestingBotId,
      row.parentSessionId,
    );
    if (!liveParentSessionId || liveParentSessionId === row.parentSessionId) return row;
    const at = now();
    const db = getDbClient().drizzle;
    const [repaired] = await db
      .update(botDelegations)
      .set({ parentSessionId: liveParentSessionId, updatedAt: at })
      .where(and(
        eq(botDelegations.id, row.id),
        row.parentSessionId === null
          ? isNull(botDelegations.parentSessionId)
          : eq(botDelegations.parentSessionId, row.parentSessionId),
      ))
      .returning({ id: botDelegations.id });
    if (!repaired) return row;
    if (row.childSessionId) {
      await db
        .update(sessions)
        .set({ parentSessionId: liveParentSessionId, updatedAt: at })
        .where(and(eq(sessions.id, row.childSessionId), eq(sessions.status, 'active')));
    }
    return { ...row, parentSessionId: liveParentSessionId, updatedAt: at };
  };

  const updateTerminal = async (params: {
    delegationId: string;
    status: Extract<DelegationStatus, 'completed' | 'failed' | 'cancelled'>;
    resultSummary?: string | null;
    outputArtifactsJson?: string;
    lastError?: string | null;
    tokensUsed?: number;
    abortChild?: boolean;
  }): Promise<{
    id: string;
    parentSessionId: string | null;
    childSessionId: string | null;
    status: DelegationStatus;
  } | null> => {
    const at = now();
    const updated = await getDbClient().tx<BotsFinishDelegationResult | null>(
      'bots.finishDelegation',
      {
        delegationId: params.delegationId,
        status: params.status,
        resultSummary: params.resultSummary?.slice(0, MAX_RESULT_CHARS) ?? null,
        outputArtifactsJson: params.outputArtifactsJson ?? '[]',
        lastError: params.lastError?.slice(0, 4_000) ?? null,
        ...(typeof params.tokensUsed === 'number' ? { tokensUsed: params.tokensUsed } : {}),
        completedAt: at,
      },
    );
    if (updated) {
      clearTimer(params.delegationId);
      clearRetryTimer(params.delegationId);
      clearInteractionRetryTimer(params.delegationId);
      pendingInteractions.delete(params.delegationId);
      emitChanged({
        delegationId: updated.id,
        parentSessionId: updated.parentSessionId,
        childSessionId: updated.childSessionId,
        status: updated.status as DelegationStatus,
        pendingInteraction: null,
      });
      if (updated.childSessionId) {
        // 子任务归档由 bots.finishDelegation 在同一事务内完成(见该 tx op 的注释),
        // 不再另走通用 sessions.setStatus —— 那条通道对 source='bot' 的行会拒单,
        // 归档失败也不会被吞掉:任何失败都会让整个终态事务回滚并往上抛。
        await cleanupChildSession(
          params.delegationId,
          updated.childSessionId,
          params.abortChild === true,
        );
      }
    }
    return updated;
  };

  const readLatestAssistantText = async (sessionId: string): Promise<string | null> => {
    const db = getDbClient().drizzle;
    const [latest] = await db
      .select({ content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.role, 'assistant'),
          isNull(messages.rewindAt),
          // 任务卡锚点(空正文)与插话留痕也是 assistant 行,但它们是这个任务**自己
          // 派活**留下的注解,不是它交出的答复。嵌套委派下不排除会直接选错:上一层
          // 拿到的"结果"会变成一句催促,或干脆是空的。
          sql`(
            ${messages.agentMeta} IS NULL
            OR json_extract(${messages.agentMeta}, '$.botCollaboration.role') IS NULL
            OR json_extract(${messages.agentMeta}, '$.botCollaboration.role')
               NOT IN ('delegation-request', 'interjection')
          )`,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messageRowid))
      .limit(1);
    const text = visibleMessageTextForConversationSearch('assistant', latest?.content ?? '').trim();
    return text || null;
  };

  const timeoutDelegation = async (delegationId: string): Promise<void> => {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(eq(botDelegations.id, delegationId))
      .limit(1);
    if (!row) return;
    // 对方停在等人拍板的地方不算超时:等人不是干活慢。答完再按原截止时间续算。
    if (row.status === 'waiting' || pendingInteractions.has(delegationId)) {
      scheduleTimeout(delegationId, now() + WAITING_TIMEOUT_GRACE_MS);
      return;
    }
    const lastError = 'TIMEOUT: 到了约定时间后台任务还没有交回结果';
    const changed = await updateTerminal({
      delegationId,
      status: 'failed',
      lastError,
      abortChild: true,
    });
    if (changed) {
      await deliverCompletion({
        ...row,
        status: 'failed',
        resultSummary: row.resultSummary,
        lastError,
      });
    }
  };

  const scheduleTimeout = (delegationId: string, deadlineAt: number): void => {
    clearTimer(delegationId);
    const delay = deadlineAt - now();
    if (delay <= 0) {
      void timeoutDelegation(delegationId);
      return;
    }
    const timer = setTimeout(() => void timeoutDelegation(delegationId), delay);
    timer.unref?.();
    timers.set(delegationId, timer);
  };

  const resolveCaller = async (callerSessionId: string) => {
    const db = getDbClient().drizzle;
    const [link] = await db
      .select({
        botId: botSessionLinks.botId,
        role: botSessionLinks.role,
        profileVersion: botSessionLinks.profileVersion,
        sessionStatus: sessions.status,
        permissionMode: sessions.permissionMode,
        workingDir: sessions.workingDir,
        remoteHostId: sessions.remoteHostId,
      })
      .from(botSessionLinks)
      .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
      .where(eq(botSessionLinks.sessionId, callerSessionId))
      .limit(1);
    if (
      !link
      || link.sessionStatus !== 'active'
      || (link.role !== 'canonical' && link.role !== 'delegation')
    ) return null;
    return link;
  };

  const interactionSummary = (request: InteractionRequest): string => {
    if (request.kind === 'permission') {
      return (
        request.title?.trim()
        || request.displayName?.trim()
        || request.description?.trim()
        || `需要授权使用 ${request.toolName}`
      );
    }
    if (request.kind === 'ask_user_question') {
      return (
        request.questions
        .slice(0, 5)
        .map((question, index) => {
          const options = question.options?.map((option) => option.label).filter(Boolean) ?? [];
          return `${index + 1}. ${question.question}${options.length ? `（${options.join(' / ')}）` : ''}`;
        })
        .join('\n')
        .slice(0, 4_000) || '子任务需要补充信息'
      );
    }
    return request.plan.trim().slice(0, 4_000) || '子任务需要确认执行计划';
  };

  const pendingInteractionView = (
    pending: BotDelegationPendingInteraction & { request: InteractionRequest },
  ): BotDelegationPendingInteraction => ({
    requestId: pending.requestId,
    kind: pending.kind,
    summary: pending.summary,
    raisedAt: pending.raisedAt,
  });

  const notifyRequesterOfInteraction = async (
    row: DelegationRow,
    pending: BotDelegationPendingInteraction & { request: InteractionRequest },
    attempt = 0,
  ): Promise<void> => {
    if (pendingInteractions.get(row.id)?.requestId !== pending.requestId) return;
    const requesterSessionId = await requesterLiveSessionId(
      row.requestingBotId,
      row.parentSessionId,
    );
    const message = [
      `${UI_ACTION_TRIGGER_PREFIX}[任务需要你处理] task_id: ${row.id}`,
      `类型: ${pending.request.kind}`,
      pending.summary,
      '你是用户的代理。能按用户已表达的意图安全决定，就用 `message_session_task` 直接回答；拿不准才用一句人话问用户。不要让用户去子任务窗口处理，也不要复述内部编号。',
    ].join('\n\n');
    const dispatched = requesterSessionId
      ? await deps.dispatch({
          targetSessionId: requesterSessionId,
          message,
          persistedContent: message,
          clientId: `bot-delegation-interaction:${row.id}:${pending.requestId}`,
        }).catch(() => null)
      : null;
    if (dispatched?.ok) {
      clearInteractionRetryTimer(row.id);
      return;
    }
    clearInteractionRetryTimer(row.id);
    const delay = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(attempt, 6));
    const timer = setTimeout(() => {
      interactionRetryTimers.delete(row.id);
      void notifyRequesterOfInteraction(row, pending, attempt + 1);
    }, delay);
    timer.unref?.();
    interactionRetryTimers.set(row.id, timer);
  };

  const handleInteractionStart = async (
    childSessionId: string,
    request: InteractionRequest,
  ): Promise<void> => {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(
        and(
          eq(botDelegations.childSessionId, childSessionId),
          inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES]),
        ),
      )
      .orderBy(desc(botDelegations.createdAt))
      .limit(1);
    if (!row) return;
    const pending: BotDelegationPendingInteraction & { request: InteractionRequest } = {
      requestId: request.requestId,
      kind: request.kind,
      summary: interactionSummary(request),
      raisedAt: now(),
      request,
    };
    const pendingInteractionJson = JSON.stringify(pendingInteractionView(pending));
    const [waiting] = await db
      .update(botDelegations)
      .set({ status: 'waiting', pendingInteractionJson, updatedAt: pending.raisedAt })
      .where(
        and(
          eq(botDelegations.id, row.id),
          inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES]),
        ),
      )
      .returning({
        id: botDelegations.id,
        parentSessionId: botDelegations.parentSessionId,
        childSessionId: botDelegations.childSessionId,
      });
    if (!waiting) {
      return;
    }
    pendingInteractions.set(row.id, pending);
    clearTimer(row.id);
    emitChanged({
      delegationId: row.id,
      parentSessionId: row.parentSessionId,
      childSessionId,
      status: 'waiting',
      pendingInteraction: pendingInteractionView(pending),
    });
    await notifyRequesterOfInteraction(row, pending);
  };

  const handleInteractionEnd = async (
    childSessionId: string,
    request: InteractionRequest,
  ): Promise<void> => {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(eq(botDelegations.childSessionId, childSessionId))
      .orderBy(desc(botDelegations.createdAt))
      .limit(1);
    if (!row) return;
    const pending = pendingInteractions.get(row.id);
    if (!pending || pending.requestId !== request.requestId) return;
    const resumedAt = now();
    const extendedSnapshot = extendDeadlineSnapshot(
      row.permissionSnapshotJson,
      Math.max(0, resumedAt - pending.raisedAt),
    );
    const [running] = await db
      .update(botDelegations)
      .set({
        status: 'running',
        pendingInteractionJson: null,
        ...(extendedSnapshot ? { permissionSnapshotJson: extendedSnapshot } : {}),
        updatedAt: resumedAt,
      })
      .where(and(eq(botDelegations.id, row.id), eq(botDelegations.status, 'waiting')))
      .returning({ id: botDelegations.id });
    if (!running) return;
    pendingInteractions.delete(row.id);
    clearInteractionRetryTimer(row.id);
    emitChanged({
      delegationId: row.id,
      parentSessionId: row.parentSessionId,
      childSessionId,
      status: 'running',
      pendingInteraction: null,
    });
    const deadlineAt = readDeadline(extendedSnapshot ?? row.permissionSnapshotJson);
    if (deadlineAt !== null) scheduleTimeout(row.id, deadlineAt);
  };

  const buildDelegationPrompt = (row: {
    id: string;
    objective: string;
    contextRefsJson: string;
  }): string => [
    'You are running an independent Cindy Session task started from the user\'s Bot task.',
    `Task ID: ${row.id}`,
    `Objective:\n${row.objective}`,
    parseStringArray(row.contextRefsJson).length
      ? `Context references:\n${parseStringArray(row.contextRefsJson).join('\n')}`
      : '',
    'Work independently in this task\'s own workspace.',
    'The parent Bot is acting for the user: permission prompts, questions and plan reviews you raise are answered there (or by the user directly). Ask through the normal tools when you genuinely need a decision; otherwise keep going.',
    'Use descriptive filenames instead of generic names such as index, final, or output. If HTML is only a preview or SVG is only a source file, also export a directly viewable PNG or PDF. In the final response, list only user-ready files under a Deliverables heading; list source, preview, and intermediate files separately, and say how the result was verified.',
    'Return a concise conclusion when done. Files you create or change in this workspace are handed back automatically; do not write into the parent task\'s directory and do not ask anyone to copy a local path.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const validateDispatchPlan = async (
    row: DelegationRow,
  ): Promise<BotDelegationResult> => {
    const plan = parseBotDelegationPlanSnapshot(row.permissionSnapshotJson);
    if (!plan || plan.targetBotId !== row.targetBotId) {
      return {
        ok: false,
        errorCode: 'PLAN_SNAPSHOT_INVALID',
        message: '后台任务缺少有效的冻结执行计划',
      };
    }
    if (!row.childSessionId) {
      return { ok: false, errorCode: 'CHILD_SESSION_MISSING', message: '后台任务不存在' };
    }
    const db = getDbClient().drizzle;
    const liveRequesterSessionId = await requesterLiveSessionId(
      row.requestingBotId,
      row.parentSessionId,
    );
    if (!liveRequesterSessionId) {
      return { ok: false, errorCode: 'PARENT_SESSION_INACTIVE', message: '发起任务已归档或删除' };
    }
    if (row.targetBotId !== null) {
      return {
        ok: false,
        errorCode: 'LEGACY_NAMED_BOT_TASK',
        message: '旧版伙伴任务已停用，请向伙伴发送消息或新建后台任务',
      };
    }
    const [child] = await db
        .select({
          status: sessions.status,
          source: sessions.source })
        .from(sessions)
        .where(eq(sessions.id, row.childSessionId))
        .limit(1);
    if (child?.status !== 'active'
      || child.source !== 'desktop') {
      return { ok: false, errorCode: 'CHILD_SESSION_INVALID', message: '后台任务已归档或删除' };
    }
    return { ok: true };
  };

  function scheduleDispatchRetry(delegationId: string, attempt: number): void {
    clearRetryTimer(delegationId);
    const delay = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(attempt, 6));
    const timer = setTimeout(() => {
      retryTimers.delete(delegationId);
      void attemptDispatch(delegationId, attempt + 1);
    }, delay);
    timer.unref?.();
    retryTimers.set(delegationId, timer);
  }

  /**
   * 去程投递失败到无法自愈时的收口：委派立刻变成 `failed`，并把人话原因送回发起方。
   *
   * 单独抽出来是因为这条路径有三件事必须一起发生，缺一件就退化成「静默挂起」：
   * 收口 delegation 行（任务卡据此翻终态）、中止并归档子任务、把失败当作一次结果
   * 回传（发起方的对话里必须出现这句话，而不是只在日志里）。
   */
  async function failDelegationDispatch(
    row: DelegationRow,
    lastError: string,
  ): Promise<void> {
    clearRetryTimer(row.id);
    const changed = await updateTerminal({
      delegationId: row.id,
      status: 'failed',
      lastError,
      abortChild: true,
    });
    if (changed) {
      await deliverCompletion({ ...row, status: 'failed', lastError });
    }
  }

  async function attemptDispatch(
    delegationId: string,
    attempt = 0,
  ): Promise<{
    ok: boolean;
    status: 'queued' | 'running' | 'failed';
    error?: DispatchResult;
  }> {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(eq(botDelegations.id, delegationId))
      .limit(1);
    if (!row || !row.childSessionId || row.status !== 'queued') {
      return { ok: true, status: row?.status === 'running' ? 'running' : 'queued' };
    }
    const deadlineAt = readDeadline(row.permissionSnapshotJson);
    if (deadlineAt !== null && deadlineAt <= now()) {
      await timeoutDelegation(delegationId);
      return { ok: false, status: 'failed' };
    }
    const validation = await validateDispatchPlan(row);
    if (!validation.ok) {
      await failDelegationDispatch(row, `${validation.errorCode}: ${validation.message}`);
      return { ok: false, status: 'failed' };
    }
    const dispatched = await deps.dispatch({
      targetSessionId: row.childSessionId,
      message: buildDelegationPrompt(row),
      persistedContent: row.objective,
      clientId: `bot-delegation-start:${row.id}`,
      onAccepted: async () => {
        const acceptedAt = now();
        const [accepted] = await db
          .update(botDelegations)
          .set({ status: 'running', acceptedAt, lastError: null, updatedAt: acceptedAt })
          .where(and(eq(botDelegations.id, row.id), eq(botDelegations.status, 'queued')))
          .returning({
            id: botDelegations.id,
            parentSessionId: botDelegations.parentSessionId,
            childSessionId: botDelegations.childSessionId,
            status: botDelegations.status,
          });
        if (accepted) {
          clearRetryTimer(accepted.id);
          emitChanged({
            delegationId: accepted.id,
            parentSessionId: accepted.parentSessionId,
            childSessionId: accepted.childSessionId,
            status: accepted.status as DelegationStatus,
          });
        }
      },
    });
    if (dispatched.ok) {
      const [current] = await db
        .select({ status: botDelegations.status })
        .from(botDelegations)
        .where(eq(botDelegations.id, row.id))
        .limit(1);
      return { ok: true, status: current?.status === 'running' ? 'running' : 'queued' };
    }
    // 去程没送出去。**不能**一律留在 queued 然后永远重试下去：没登录、子任务已归档
    // 这类原因不会自愈，无限退避只会让任务卡永远转圈、发起方永远等不到任何交代。
    const verdict = classifyBotDelegationDispatchFailure({
      errorCode: dispatched.errorCode,
      message: dispatched.message,
      attempt,
    });
    if (verdict.kind === 'fatal') {
      log.warn('Bot delegation dispatch gave up', {
        delegationId: row.id,
        targetBotId: row.targetBotId,
        attempt,
        errorCode: verdict.errorCode,
        dispatchErrorCode: dispatched.errorCode,
      });
      await failDelegationDispatch(row, `${verdict.errorCode}: ${verdict.message}`);
      return { ok: false, status: 'failed', error: dispatched };
    }
    const failedAt = now();
    const [retrying] = await db
      .update(botDelegations)
      .set({
        lastError: `${dispatched.errorCode}: ${dispatched.message}`.slice(0, 4_000),
        updatedAt: failedAt,
      })
      .where(and(eq(botDelegations.id, row.id), eq(botDelegations.status, 'queued')))
      .returning({
        id: botDelegations.id,
        parentSessionId: botDelegations.parentSessionId,
        childSessionId: botDelegations.childSessionId,
      });
    if (retrying) {
      emitChanged({
        delegationId: retrying.id,
        parentSessionId: retrying.parentSessionId,
        childSessionId: retrying.childSessionId,
        status: 'queued',
      });
      scheduleDispatchRetry(retrying.id, attempt);
    }
    return { ok: false, status: 'queued', error: dispatched };
  }

  async function resumeRunningDelegation(delegationId: string, attempt = 0): Promise<void> {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(eq(botDelegations.id, delegationId))
      .limit(1);
    // 重启前停在 waiting 的：保留持久等待摘要与暂停状态，先恢复子任务；只有新的
    // turn 真正被接受后才切回 running。旧 resolver 随进程消失，子任务会从历史继续
    // 并在仍需决定时重新发出一条新的 interaction request。
    if (!row || (row.status !== 'running' && row.status !== 'waiting')) return;
    let effectiveSnapshot = row.permissionSnapshotJson;
    if (row.status === 'waiting') {
      effectiveSnapshot = extendDeadlineSnapshot(
        row.permissionSnapshotJson,
        Math.max(0, now() - row.updatedAt),
      ) ?? row.permissionSnapshotJson;
      emitChanged({
        delegationId: row.id,
        parentSessionId: row.parentSessionId,
        childSessionId: row.childSessionId,
        status: 'waiting',
        pendingInteraction: parsePendingInteraction(row.pendingInteractionJson),
      });
    }
    const deadlineAt = readDeadline(effectiveSnapshot);
    if (deadlineAt !== null && deadlineAt <= now()) {
      await timeoutDelegation(row.id);
      return;
    }
    if (deadlineAt !== null && row.status !== 'waiting') scheduleTimeout(row.id, deadlineAt);
    if (!row.childSessionId) {
      const lastError = '应用重启后找不到这项后台任务的执行会话。';
      const changed = await updateTerminal({
        delegationId: row.id,
        status: 'failed',
        lastError,
      });
      if (changed) await deliverCompletion({ ...row, status: 'failed', lastError });
      return;
    }
    const [child] = await db
      .select({
        status: sessions.status,
        activeTurnStartedAt: sessions.activeTurnStartedAt,
        lastTurnEndedAt: sessions.lastTurnEndedAt,
      })
      .from(sessions)
      .where(eq(sessions.id, row.childSessionId))
      .limit(1);
    if (!child || child.status !== 'active') {
      const lastError = child
        ? '应用重启后这项后台任务的执行会话已结束。'
        : '应用重启后找不到这项后台任务的执行会话。';
      const changed = await updateTerminal({
        delegationId: row.id,
        status: 'failed',
        lastError,
      });
      if (changed) await deliverCompletion({ ...row, status: 'failed', lastError });
      return;
    }

    if (
      child.activeTurnStartedAt !== null
      && child.lastTurnEndedAt !== null
      && child.lastTurnEndedAt >= child.activeTurnStartedAt
    ) {
      const resultText = await readLatestAssistantText(row.childSessionId);
      if (resultText) {
        await settleSession({
          childSessionId: row.childSessionId,
          outcome: 'done',
          resultText,
        });
      } else {
        const lastError = '后台任务在应用重启前已结束，但没有可恢复的结果。';
        const changed = await updateTerminal({
          delegationId: row.id,
          status: 'failed',
          lastError,
        });
        if (changed) await deliverCompletion({ ...row, status: 'failed', lastError });
      }
      return;
    }

    const validation = await validateDispatchPlan(row);
    if (!validation.ok) {
      const lastError = `${validation.errorCode}: ${validation.message}`;
      const changed = await updateTerminal({
        delegationId: row.id,
        status: 'failed',
        lastError,
        abortChild: true,
      });
      if (changed) await deliverCompletion({ ...row, status: 'failed', lastError });
      return;
    }

    const resumeEpoch = child.activeTurnStartedAt ?? row.acceptedAt ?? row.createdAt;
    const clientId = `bot-delegation-resume:${row.id}:${resumeEpoch}`;
    const message = [
      'The previous Session task turn was interrupted by a Cindy host restart.',
      'Inspect the existing task history, continue the original objective, and return the final result.',
      `Task ID: ${row.id}`,
      `Objective:\n${row.objective}`,
    ].join('\n\n');
    const dispatched = await deps.dispatch({
      targetSessionId: row.childSessionId,
      message,
      persistedContent: row.objective,
      clientId,
    });
    if (dispatched.ok) {
      clearRetryTimer(row.id);
      const resumedAt = now();
      await db
        .update(botDelegations)
        .set({
          status: 'running',
          permissionSnapshotJson: effectiveSnapshot,
          pendingInteractionJson: null,
          lastError: null,
          updatedAt: resumedAt,
        })
        .where(and(
          eq(botDelegations.id, row.id),
          inArray(botDelegations.status, ['running', 'waiting']),
        ));
      if (row.status === 'waiting') {
        emitChanged({
          delegationId: row.id,
          parentSessionId: row.parentSessionId,
          childSessionId: row.childSessionId,
          status: 'running',
          pendingInteraction: null,
        });
        if (deadlineAt !== null) scheduleTimeout(row.id, deadlineAt);
      }
      return;
    }
    await db
      .update(botDelegations)
      .set({
        lastError: `${dispatched.errorCode}: ${dispatched.message}`.slice(0, 4_000),
        ...(row.status === 'waiting'
          ? { permissionSnapshotJson: effectiveSnapshot }
          : {}),
        updatedAt: now(),
      })
      .where(and(
        eq(botDelegations.id, row.id),
        inArray(botDelegations.status, ['running', 'waiting']),
      ));
    clearRetryTimer(row.id);
    // 重启续跑与首次投递同一条纪律：不会自愈的原因要立刻说出来，别把「running」
    // 挂到超时（默认 30 分钟）才收口——那半小时里用户看到的只有一个转圈的卡片。
    const verdict = classifyBotDelegationDispatchFailure({
      errorCode: dispatched.errorCode,
      message: dispatched.message,
      attempt,
    });
    if (verdict.kind === 'fatal') {
      log.warn('Bot delegation resume gave up', {
        delegationId: row.id,
        targetBotId: row.targetBotId,
        attempt,
        errorCode: verdict.errorCode,
        dispatchErrorCode: dispatched.errorCode,
      });
      await failDelegationDispatch(row, `${verdict.errorCode}: ${verdict.message}`);
      return;
    }
    const delay = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(attempt, 6));
    const timer = setTimeout(() => {
      retryTimers.delete(row.id);
      void resumeRunningDelegation(row.id, attempt + 1);
    }, delay);
    timer.unref?.();
    retryTimers.set(row.id, timer);
  }

  /**
   * 后台任务前置检查：调用方身份、超时时间与并发额度。
   */
  const resolveDelegationPreflight = async (input: {
    callerSessionId: string;
    timeoutMs?: number;
  }): Promise<BotDelegationResult<{
    caller: NonNullable<Awaited<ReturnType<typeof resolveCaller>>>;
      timeoutMs: number;
    }>> => {
    const db = getDbClient().drizzle;
    const caller = await resolveCaller(input.callerSessionId);
    if (!caller) {
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于任何伙伴' };
    }
    const requestedTimeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1_000, Math.floor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    );
    const active = await db
      .select({ id: botDelegations.id })
      .from(botDelegations)
      .where(
        and(
          eq(botDelegations.requestingBotId, caller.botId),
          inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES]),
        ),
      );
    if (active.length >= maxActiveChildren) {
      return {
        ok: false,
        errorCode: 'CONCURRENCY_LIMIT',
        message: `当前伙伴已有 ${active.length} 个进行中的后台任务，最多 ${maxActiveChildren} 个`,
      };
    }
    return {
      ok: true,
      caller,
      timeoutMs: requestedTimeoutMs,
    };
  };

  /** 创建 Session 任务行 + 子任务，并完成卡片锚点、超时排程与首次投递。 */
  const startDelegation = async (input: {
    caller: NonNullable<Awaited<ReturnType<typeof resolveCaller>>>;
    callerSessionId: string;
    objective: string;
    contextRefs: string[];
    plan: BotDelegationPlanSnapshot;
    session: {
      workingDir: string;
      model: string;
      effort?: string;
      fastMode?: boolean;
      providerId?: string | null;
      agentKind: 'cc' | 'codex' | 'pi';
      permissionMode: string;
      title: string;
      source: 'desktop';
    };
  }): Promise<BotDelegationResult<{
    delegationId: string;
    childSessionId: string;
    status: 'queued' | 'running' | 'failed';
    deadlineAt: number;
  }>> => {
    const { plan } = input;
    const delegationId = createId();
    const childSessionId = resolveBusinessSessionId(undefined);
    const createdAt = plan.createdAt;
    const permissionSnapshotJson = JSON.stringify(plan);
    const childRow = {
      ...sessionCreateToRow(
        childSessionId,
        {
          workspaceKind: 'dialogue',
          workingDir: input.session.workingDir,
          model: input.session.model,
          // 后台任务沿用发起伙伴当前任务的模型、来源和执行档位。
          ...(input.session.effort !== undefined ? { effort: input.session.effort } : {}),
          ...(input.session.fastMode !== undefined ? { fastMode: input.session.fastMode } : {}),
          ...(input.session.providerId !== undefined
            ? { providerId: input.session.providerId }
            : {}),
          agentKind: input.session.agentKind,
          permissionMode: input.session.permissionMode,
          parentSessionId: input.callerSessionId,
        },
        createdAt,
      ),
      title: input.session.title,
      source: input.session.source,
    };
    try {
      await ensureProjectGitInitialized({
        workingDir: input.session.workingDir,
        workspaceKind: 'dialogue',
        remoteHostId: null,
        sessionId: childSessionId,
        autoSnapshotEnabled: readGitSafetySettings().autoSnapshotEnabled,
        source: 'bot-delegation',
      });
      await getDbClient().tx('bots.createDelegation', {
        maxActiveChildren,
        session: {
          id: childRow.id,
          title: childRow.title,
          workingDir: childRow.workingDir ?? null,
          workspaceKind: childRow.workspaceKind,
          model: childRow.model,
          effort: childRow.effort,
          fastMode: childRow.fastMode,
          permissionMode: childRow.permissionMode,
          agentKind: childRow.agentKind,
          remoteHostId: null,
          providerId: childRow.providerId ?? null,
          parentSessionId: input.callerSessionId,
          extraDirs: childRow.extraDirs,
          source: childRow.source,
          createdAt: childRow.createdAt,
          updatedAt: childRow.updatedAt,
        },
        delegation: {
          id: delegationId,
          requestingBotId: input.caller.botId,
          targetBotId: null,
          parentSessionId: input.callerSessionId,
          childSessionId,
          objective: input.objective,
          contextRefsJson: JSON.stringify(input.contextRefs),
          permissionSnapshotJson,
          lineageJson: JSON.stringify([input.caller.botId]),
          targetProfileVersion: null,
          depth: 1,
          createdAt,
        },
      });
      emitChanged({
        delegationId,
        parentSessionId: input.callerSessionId,
        childSessionId,
        status: 'queued',
      });
    } catch (error) {
      // The Profile workspace is durable and shared across the Bot's Sessions.
      // A failed child creation never owns it and must not compensate by deleting it.
      if (error instanceof Error && error.message === 'BOT_DELEGATION_CONCURRENCY_LIMIT') {
        return {
          ok: false,
          errorCode: 'CONCURRENCY_LIMIT',
          message: `当前伙伴的进行中后台任务已达到 ${maxActiveChildren} 个`,
        };
      }
      throw error;
    }

    deps.broadcastSessionCreated?.(childSessionId);
    const mirrorRow = {
      id: delegationId,
      requestingBotId: input.caller.botId,
      targetBotId: null,
      objective: input.objective,
      parentSessionId: input.callerSessionId,
      childSessionId,
      permissionSnapshotJson,
      createdAt,
    };
    // The requesting timeline is the user's only guaranteed place to find and
    // control this task. Persist its card before starting the child Session;
    // a background task without this anchor must never start invisibly.
    try {
      await projectParentRequest(mirrorRow);
    } catch (error) {
      const lastError = `PARENT_TIMELINE_PERSIST_FAILED: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await updateTerminal({
        delegationId,
        status: 'failed',
        lastError,
        abortChild: true,
      });
      return {
        ok: false,
        errorCode: 'PARENT_TIMELINE_PERSIST_FAILED',
        message: '任务未启动：无法在当前时间线中保留任务卡',
      };
    }
    scheduleTimeout(delegationId, plan.limits.deadlineAt);
    const dispatchResult = await attemptDispatch(delegationId);
    return {
      ok: true,
      delegationId,
      childSessionId,
      status: dispatchResult.status,
      deadlineAt: plan.limits.deadlineAt,
    };
  };

  /**
   * 创建一条普通 desktop Session，在发起伙伴的工作目录与执行配置下独立运行。
   */
  const startSessionTask = async (
    input: SessionTaskInput,
  ): Promise<BotDelegationResult<{
    delegationId: string;
    childSessionId: string;
    /**
     * `failed` 也是一个合法的即时结果：启动遇到不会自愈的原因（最典型是没登录）时，
     * 任务在返回前就已经收口。发起方据此当场知道「任务没启动」，而不是拿到一个
     * 「排队中」的假承诺再永远等下去。
     */
    status: 'queued' | 'running' | 'failed';
    deadlineAt: number;
  }>> => {
    const objective = input.objective.trim();
    if (!objective || objective.length > MAX_OBJECTIVE_CHARS) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message: `objective 必须为 1-${MAX_OBJECTIVE_CHARS} 个字符`,
      };
    }
    const db = getDbClient().drizzle;
    const preflight = await resolveDelegationPreflight(input);
    if (!preflight.ok) return preflight;
    const { caller, timeoutMs } = preflight;
    const contextRefs = normalizeDelegationReferences(input.contextRefs);
    if (!contextRefs.ok) return contextRefs;
    const createdAt = now();
    const deadlineAt = createdAt + timeoutMs;

    // 子任务沿用发起方会话当前的模型与 harness,但权限从 ask 开始。需要授权时
    // 统一回到发起伙伴代答,不能因为伙伴本身是 trusted 就让完整任务静默越权。
    const [callerSession] = await db
      .select({
        model: sessions.model,
        agentKind: sessions.agentKind,
        providerId: sessions.providerId,
        effort: sessions.effort,
        fastMode: sessions.fastMode,
      })
      .from(sessions)
      .where(eq(sessions.id, input.callerSessionId))
      .limit(1);
    if (!callerSession) {
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于任何伙伴' };
    }
    let workingDir = input.workingDir?.trim() || '';
    if (workingDir) {
      const isDirectory = (() => {
        try {
          return statSync(workingDir).isDirectory();
        } catch {
          return false;
        }
      })();
      if (!path.isAbsolute(workingDir) || !existsSync(workingDir) || !isDirectory) {
        return {
          ok: false,
          errorCode: 'INVALID_WORKING_DIR',
          message: 'working_dir 必须是已存在的绝对路径',
        };
      }
    } else {
      workingDir = await ensureBotWorkspaceDir(
        ownerScopedUserDataPath(),
        caller.botId,
        app.getPath('userData'),
      );
    }
    const permissionMode = 'ask';
    const plan: BotDelegationPlanSnapshot = {
      version: 1,
      createdAt,
      targetBotId: null,
      access: { contextRefs: contextRefs.refs },
      completionTarget: { parentSessionId: input.callerSessionId },
      limits: { maxDepth: DEFAULT_MAX_DEPTH, timeoutMs, deadlineAt },
      permission: {
        mode: permissionMode,
        requesterMode: caller.permissionMode ?? null,
        targetConfigured: 'ask',
      },
    };
    const started = await startDelegation({
      caller,
      callerSessionId: input.callerSessionId,
      objective,
      contextRefs: contextRefs.refs,
      plan,
      session: {
        workingDir,
        model: callerSession.model,
        ...(callerSession.effort ? { effort: callerSession.effort } : {}),
        ...(callerSession.fastMode !== null && callerSession.fastMode !== undefined
          ? { fastMode: callerSession.fastMode }
          : {}),
        ...(callerSession.providerId ? { providerId: callerSession.providerId } : {}),
        agentKind: callerSession.agentKind as 'cc' | 'codex' | 'pi',
        permissionMode,
        title: input.title?.trim() || objective.split('\n')[0]!.slice(0, 60),
        source: 'desktop',
      },
    });
    if (!started.ok) return started;
    return {
      ok: true,
      delegationId: started.delegationId,
      childSessionId: started.childSessionId,
      status: started.status,
      deadlineAt: started.deadlineAt,
    };
  };

  const listDelegations = async (
    callerSessionId: string,
  ): Promise<BotDelegationResult<{ delegations: BotDelegationView[] }>> => {
    const caller = await resolveCaller(callerSessionId);
    if (!caller) {
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于任何伙伴' };
    }
    const db = getDbClient().drizzle;
    const rows = await db
      .select()
      .from(botDelegations)
      .where(
        eq(botDelegations.requestingBotId, caller.botId),
      )
      .orderBy(desc(botDelegations.createdAt));
    const profiles = await db
      .select({ id: botProfiles.id, displayName: botProfiles.displayName })
      .from(botProfiles);
    const profileNames = new Map(profiles.map((profile) => [profile.id, profile.displayName]));
    const childSessionIds = rows.flatMap((row) => row.childSessionId ? [row.childSessionId] : []);
    const childSessions = childSessionIds.length > 0
      ? await db
        .select({ id: sessions.id, title: sessions.title })
        .from(sessions)
        .where(inArray(sessions.id, childSessionIds))
      : [];
    const childTitles = new Map(childSessions.map((session) => [session.id, session.title]));
    return {
      ok: true,
      delegations: rows.map((row) => ({
        ...row,
        title: row.childSessionId
          ? (childTitles.get(row.childSessionId) ?? row.objective.trim().split('\n')[0] ?? '')
          : (row.objective.trim().split('\n')[0] ?? ''),
        status: sessionTaskViewStatus(row),
        targetBotName: row.targetBotId
          ? (profileNames.get(row.targetBotId) ?? row.targetBotId)
          : 'Cindy',
        contextRefs: parseStringArray(row.contextRefsJson),
        lineage: parseStringArray(row.lineageJson),
        permissionSnapshot: parseRecord(row.permissionSnapshotJson),
        pendingInteraction: pendingInteractions.has(row.id)
          ? pendingInteractionView(pendingInteractions.get(row.id)!)
          : parsePendingInteraction(row.pendingInteractionJson),
        artifacts: parseArtifacts(row.outputArtifactsJson),
      })) as BotDelegationView[],
    };
  };

  const cancelDelegationTree = async (
    root: DelegationRow,
    reason: string,
    deliverRoot: boolean,
    rootAlreadyAborted = false,
  ): Promise<boolean> => {
    const db = getDbClient().drizzle;
    const graph = buildDelegationGraph(await db.select().from(botDelegations));
    const currentRoot = graph.byId.get(root.id) ?? root;
    const affected = [currentRoot, ...descendantRows(currentRoot, graph)]
      .filter((row) => isActiveDelegation(row.status))
      .sort((a, b) => b.depth - a.depth);
    let rootChanged = false;
    for (const row of affected) {
      const changed = await updateTerminal({
        delegationId: row.id,
        status: 'cancelled',
        lastError: reason,
        abortChild: !(rootAlreadyAborted && row.id === currentRoot.id),
      });
      if (changed && !deliverRoot) {
        // Lifecycle shutdown already owns the user-visible explanation. Mark
        // its cancellation handled so restore cannot wake a paused/archived Bot.
        await db
          .update(botDelegations)
          .set({ completionDeliveredAt: now(), updatedAt: now() })
          .where(and(
            eq(botDelegations.id, row.id),
            eq(botDelegations.status, 'cancelled'),
            isNull(botDelegations.completionDeliveredAt),
          ));
      }
      rootChanged ||= row.id === currentRoot.id && changed !== null;
    }
    if (deliverRoot && rootChanged) {
      await deliverCompletion({
        ...currentRoot,
        status: 'cancelled',
        resultSummary: currentRoot.resultSummary,
        lastError: reason,
      });
    }
    return rootChanged;
  };

  const cancelDelegationsForParentSession = async (
    parentSessionId: string,
    reason = 'Parent Bot task was archived or deleted.',
  ): Promise<number> => {
    const db = getDbClient().drizzle;
    const roots = await db
      .select()
      .from(botDelegations)
      .where(
        and(
          eq(botDelegations.parentSessionId, parentSessionId),
          inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES]),
        ),
      );
    let cancelled = 0;
    for (const root of roots) {
      if (await cancelDelegationTree(root, reason, false)) cancelled += 1;
    }
    return cancelled;
  };

  const cancelDelegationsForBot = async (
    botId: string,
    reason = 'The owning Bot was paused, archived, or deleted.',
  ): Promise<number> => {
    const db = getDbClient().drizzle;
    const rows = await db
      .select()
      .from(botDelegations)
      .where(
        and(
          inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES]),
          or(
            eq(botDelegations.requestingBotId, botId),
            eq(botDelegations.targetBotId, botId),
          ),
        ),
      )
      .orderBy(desc(botDelegations.depth), desc(botDelegations.createdAt));
    let cancelled = 0;
    for (const row of rows) {
      if (await cancelDelegationTree(row, reason, false)) cancelled += 1;
    }
    return cancelled;
  };

  const cancelDelegation = async (
    callerSessionId: string,
    delegationId: string,
  ): Promise<BotDelegationResult<{ delegationId: string; childSessionId: string | null }>> => {
    const caller = await resolveCaller(callerSessionId);
    if (!caller) {
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于任何伙伴' };
    }
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(
        and(
          eq(botDelegations.id, delegationId),
          eq(botDelegations.requestingBotId, caller.botId),
        ),
      )
      .limit(1);
    if (!row) return { ok: false, errorCode: 'NOT_FOUND', message: '后台任务不存在' };
    if (!ACTIVE_DELEGATION_STATUSES.includes(row.status as (typeof ACTIVE_DELEGATION_STATUSES)[number])) {
      return {
        ok: false,
        errorCode: 'ALREADY_TERMINAL',
        message: `后台任务已结束（${row.status}）`,
      };
    }
    if (row.childSessionId) {
      try {
        // A successful stop response means the active process has actually
        // accepted cancellation, not merely that the card changed color.
        await deps.abortSession(row.childSessionId);
      } catch (error) {
        log.warn('Session task stop was not accepted by the child runtime', {
          delegationId,
          childSessionId: row.childSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          errorCode: 'STOP_FAILED',
          message: '后台任务暂时未能停止，请稍后重试',
        };
      }
    }
    const changed = await cancelDelegationTree(
      row,
      'Cancelled by the requesting Bot.',
      true,
      true,
    );
    if (!changed) {
      return { ok: false, errorCode: 'ALREADY_TERMINAL', message: '后台任务已由另一操作结束' };
    }
    return { ok: true, delegationId, childSessionId: row.childSessionId };
  };

  /**
   * 向一个**仍在进行**的后台任务补一句话：补充条件或修正方向。
   *
   * 为什么需要单独的通道：子任务本身早就支持排队输入，缺的是「从发起方那一侧」
   * 合法地投进去的入口——直接按 sessionId 发消息会绕开归属校验，把任意会话变成
   * 任意 Bot 子任务的输入源。这里把三件事一次做完：
   *  - **归属**：任务必须属于调用会话代表的同一个 Bot。canonical 异常恢复会换
   *    Session id，所以不能把冻结的 parentSessionId 当作永久身份。
   *  - **状态**：只接受 queued / running / waiting。终态明确报错，绝不复活已收口的
   *    任务，也不会向已归档的子 Session 投递。
   *  - **幂等**：clientId 决定去重。同一 token 重发落到同一条消息上（dispatch 侧按
   *    clientId 查已落库行），重试不会发送两遍。
   *
   * 权限边界不放宽：投递复用启动任务时冻结的子 Session，不新建会话、不改权限档。
   * 子任务正忙时按会话既有语义入队，当前回合结束后被读到。
   */
  const interjectDelegation = async (
    callerSessionId: string,
    delegationId: string,
    text: string,
    idempotencyToken?: string,
  ): Promise<BotDelegationInterjectResult> => {
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, errorCode: 'INVALID_ARGS', message: '消息内容不能为空' };
    }
    if (trimmed.length > MAX_INTERJECTION_CHARS) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message: `消息内容超过 ${MAX_INTERJECTION_CHARS} 字，请新建后台任务`,
      };
    }
    const caller = await resolveCaller(callerSessionId);
    if (!caller) {
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于任何伙伴' };
    }
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(
        and(
          eq(botDelegations.id, delegationId),
          eq(botDelegations.requestingBotId, caller.botId),
        ),
      )
      .limit(1);
    if (!row) return { ok: false, errorCode: 'NOT_FOUND', message: '后台任务不存在' };
    if (!isActiveDelegation(row.status as DelegationStatus)) {
      return {
        ok: false,
        errorCode: 'ALREADY_TERMINAL',
        message: `后台任务已结束（${row.status}），将用这条消息继续任务`,
      };
    }
    if (row.status === 'queued') {
      return {
        ok: false,
        errorCode: 'SESSION_TASK_NOT_READY',
        message: '后台任务还在启动，请稍后再补充',
      };
    }
    if (!row.childSessionId) {
      return {
        ok: false,
        errorCode: 'CHILD_SESSION_MISSING',
        message: '后台任务尚未就绪',
      };
    }
    // token 只做幂等键，不进正文；限死字符集免得脏值污染 clientId 空间。
    const token = (idempotencyToken ?? createId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
      || createId();
    const requesterName = await requesterDisplayName(caller.botId);
    const dispatched = await deps.dispatch({
      targetSessionId: row.childSessionId,
      message: [`[来自 ${requesterName} 的补充]`, trimmed].join('\n\n'),
      persistedContent: [`[来自 ${requesterName} 的补充]`, trimmed].join('\n\n'),
      clientId: BOT_DELEGATION_CLIENT_ID.interjection(delegationId, token),
    });
    if (!dispatched?.ok) {
      return {
        ok: false,
        errorCode: dispatched?.errorCode ?? 'DISPATCH_FAILED',
        message: dispatched?.message ?? '消息未能送达后台任务',
      };
    }
    // 发起方视角的留痕：补过什么，重开会话仍在。写不进去不回滚投递
    // ——话已经送到了，回滚只会让两边记账不一致。
    await persistTimelineMessage({
      sessionId: callerSessionId,
      clientId: BOT_DELEGATION_CLIENT_ID.interjectionMirror(delegationId, token),
      role: 'assistant',
      content: trimmed,
      createdAt: now(),
      agentMeta: {
        botCollaboration: await collaborationMeta(row, 'interjection'),
      },
    }).catch((error) => {
      log.warn('failed to mirror a Session task message into the requesting task', {
        delegationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    emitChanged({
      delegationId: row.id,
      parentSessionId: row.parentSessionId,
      childSessionId: row.childSessionId,
      status: row.status as DelegationStatus,
    });
    return {
      ok: true,
      delegationId,
      childSessionId: row.childSessionId,
      queued: dispatched.wakeKind === 'queued',
    };
  };

  /**
   * 已结束任务收到继续消息时会另起一条执行 Session，但复用原任务 id。旧 Session
   * 已归档，新 Session 重新进入 queued；卡片、停止、状态查询与后续结果仍指向同一任务。
   */
  const reopenTerminalDelegation = async (
    callerSessionId: string,
    callerBotId: string,
    row: DelegationRow,
    text: string,
  ): Promise<BotDelegationResult<{
    delegationId: string;
    childSessionId: string;
    resumed: true;
    queued: boolean;
  }>> => {
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, errorCode: 'INVALID_ARGS', message: '继续说明不能为空' };
    }
    if (trimmed.length > MAX_INTERJECTION_CHARS) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message: `继续说明超过 ${MAX_INTERJECTION_CHARS} 字，请新建后台任务`,
      };
    }
    const oldPlan = parseBotDelegationPlanSnapshot(row.permissionSnapshotJson);
    if (!oldPlan || !row.childSessionId) {
      return {
        ok: false,
        errorCode: 'SESSION_TASK_HISTORY_INCOMPLETE',
        message: '这项后台任务的冻结执行信息不完整，无法继续',
      };
    }
    const db = getDbClient().drizzle;
    const [oldChild] = await db
      .select({
        title: sessions.title,
        workingDir: sessions.workingDir,
        workspaceKind: sessions.workspaceKind,
        model: sessions.model,
        effort: sessions.effort,
        permissionMode: sessions.permissionMode,
        fastMode: sessions.fastMode,
        agentKind: sessions.agentKind,
        remoteHostId: sessions.remoteHostId,
        providerId: sessions.providerId,
        extraDirs: sessions.extraDirs,
        source: sessions.source,
      })
      .from(sessions)
      .where(eq(sessions.id, row.childSessionId))
      .limit(1);
    if (
      !oldChild
      || !oldChild.workingDir
      || (oldChild.source !== 'bot' && oldChild.source !== 'desktop')
    ) {
      return {
        ok: false,
        errorCode: 'SESSION_TASK_HISTORY_INCOMPLETE',
        message: '上一次执行任务已经不可用，无法继续',
      };
    }

    const reopenedAt = now();
    const deadlineAt = reopenedAt + Math.min(MAX_TIMEOUT_MS, oldPlan.limits.timeoutMs);
    const nextPlan: BotDelegationPlanSnapshot = {
      ...oldPlan,
      createdAt: reopenedAt,
      completionTarget: { parentSessionId: callerSessionId },
      limits: { ...oldPlan.limits, deadlineAt },
    };
    const continuationObjective = [
      'Continue the same Session task with the requester’s follow-up.',
      `Previous objective:\n${row.objective.slice(0, 5_000)}`,
      row.resultSummary ? `Previous result:\n${row.resultSummary.slice(0, 4_000)}` : '',
      `Requester follow-up:\n${trimmed}`,
    ].filter(Boolean).join('\n\n').slice(0, MAX_OBJECTIVE_CHARS);
    const childSessionId = resolveBusinessSessionId(undefined);
    try {
      clearCompletionRetryTimer(row.id);
      await completionInFlight.get(row.id)?.catch(() => undefined);
      await ensureProjectGitInitialized({
        workingDir: oldChild.workingDir,
        workspaceKind: 'dialogue',
        remoteHostId: null,
        sessionId: childSessionId,
        autoSnapshotEnabled: readGitSafetySettings().autoSnapshotEnabled,
        source: 'bot-delegation',
      });
      const reopened = await getDbClient().tx('bots.reopenDelegation', {
        maxActiveChildren,
        delegationId: row.id,
        requestingBotId: callerBotId,
        expectedStatus: row.status as 'completed' | 'failed' | 'cancelled' | 'timed-out',
        parentSessionId: callerSessionId,
        childSessionId,
        objective: continuationObjective,
        permissionSnapshotJson: JSON.stringify(nextPlan),
        targetBotId: null,
        targetProfileVersion: null,
        session: {
          id: childSessionId,
          title: oldChild.title,
          workingDir: oldChild.workingDir,
          workspaceKind: oldChild.workspaceKind,
          model: oldChild.model,
          effort: oldChild.effort,
          permissionMode: oldChild.permissionMode,
          agentKind: oldChild.agentKind,
          remoteHostId: oldChild.remoteHostId,
          providerId: oldChild.providerId,
          parentSessionId: callerSessionId,
          extraDirs: oldChild.extraDirs,
          fastMode: oldChild.fastMode,
          source: oldChild.source,
          createdAt: reopenedAt,
          updatedAt: reopenedAt,
        },
        reopenedAt,
      });
      if (!reopened.reopened) {
        await deliverCompletion({
          ...row,
          status: row.status as Extract<
            DelegationStatus,
            'completed' | 'failed' | 'cancelled' | 'timed-out'
          >,
          artifacts: parseArtifacts(row.outputArtifactsJson),
        });
        return {
          ok: false,
          errorCode: 'SESSION_TASK_STATE_CHANGED',
          message: '后台任务状态刚刚发生变化，请重新查看后再继续',
        };
      }
      deps.broadcastSessionCreated?.(childSessionId);
      emitChanged({
        delegationId: row.id,
        parentSessionId: callerSessionId,
        childSessionId,
        status: 'queued',
        pendingInteraction: null,
      });
      const reopenedRow = {
        ...row,
        parentSessionId: callerSessionId,
        childSessionId,
        objective: continuationObjective,
        permissionSnapshotJson: JSON.stringify(nextPlan),
        createdAt: reopenedAt,
      };
      if (reopened.previousParentSessionId !== callerSessionId) {
        await projectParentRequest(reopenedRow).catch((error) => {
          log.warn('failed to anchor reopened Session task in the current task', {
            delegationId: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      scheduleTimeout(row.id, deadlineAt);
      const dispatched = await attemptDispatch(row.id);
      return {
        ok: true,
        delegationId: row.id,
        childSessionId,
        resumed: true,
        queued: dispatched.status === 'queued',
      };
    } catch (error) {
      await deliverCompletion({
        ...row,
        status: row.status as Extract<
          DelegationStatus,
          'completed' | 'failed' | 'cancelled' | 'timed-out'
        >,
        artifacts: parseArtifacts(row.outputArtifactsJson),
      });
      if (error instanceof Error && error.message === 'BOT_DELEGATION_CONCURRENCY_LIMIT') {
        return {
          ok: false,
          errorCode: 'CONCURRENCY_LIMIT',
          message: `当前伙伴已有 ${maxActiveChildren} 个进行中的后台任务`,
        };
      }
      throw error;
    }
  };

  const reply = async (
    callerSessionId: string,
    delegationId: string,
    input: SessionTaskMessage,
  ): Promise<BotDelegationResult<{
    delegationId: string;
    childSessionId: string | null;
    resumed: boolean;
    queued?: boolean;
  }>> => {
    const caller = await resolveCaller(callerSessionId);
    if (!caller) {
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于任何伙伴' };
    }
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(
        and(
          eq(botDelegations.id, delegationId),
          eq(botDelegations.requestingBotId, caller.botId),
        ),
      )
      .limit(1);
    if (!row) return { ok: false, errorCode: 'NOT_FOUND', message: '后台任务不存在' };

    const pending = pendingInteractions.get(delegationId);
    if (pending) {
      let decision: InteractionDecision | null = null;
      if (pending.request.kind === 'permission') {
        if (input.kind === 'approve') {
          decision = { kind: 'permission', behavior: 'allow' };
        } else if (input.kind === 'deny') {
          decision = { kind: 'permission', behavior: 'deny', reason: input.reason };
        }
      } else if (pending.request.kind === 'ask_user_question' && input.kind === 'answer') {
        decision = { kind: 'ask_user_question', answers: input.answers };
      } else if (pending.request.kind === 'plan_review') {
        if (input.kind === 'approve') {
          decision = { kind: 'plan_review', behavior: 'allow' };
        } else if (input.kind === 'deny') {
          decision = { kind: 'plan_review', behavior: 'deny', reason: input.reason };
        }
      }
      if (!decision) {
        return {
          ok: false,
          errorCode: 'WRONG_REPLY_KIND',
          message: `当前后台任务在等待 ${pending.request.kind}，回复类型 ${input.kind} 不匹配`,
        };
      }
      if (!deps.resolveInteraction?.(pending.requestId, decision)) {
        await handleInteractionEnd(row.childSessionId ?? '', pending.request);
        return {
          ok: false,
          errorCode: 'INTERACTION_STALE',
          message: '这条确认已由用户或后台任务处理，请重新查看任务状态',
        };
      }
      return {
        ok: true,
        delegationId,
        childSessionId: row.childSessionId,
        resumed: false,
      };
    }

    const persistedPending = parsePendingInteraction(row.pendingInteractionJson);
    if (row.status === 'waiting' && persistedPending && input.kind !== 'message') {
      return {
        ok: false,
        errorCode: 'INTERACTION_REHYDRATING',
        message: '后台任务正在恢复这条确认，请稍后重试；补充说明仍可使用 message',
      };
    }

    if (input.kind !== 'message') {
      return {
        ok: false,
        errorCode: 'NO_PENDING_INTERACTION',
        message: '当前后台任务没有等待确认；补充说明请使用 message',
      };
    }
    if (!isActiveDelegation(row.status as DelegationStatus)) {
      return reopenTerminalDelegation(callerSessionId, caller.botId, row, input.text);
    }
    const result = await interjectDelegation(
      callerSessionId,
      delegationId,
      input.text,
      input.idempotencyKey,
    );
    if (!result.ok) return result;
    return {
      ok: true,
      delegationId,
      childSessionId: result.childSessionId,
      resumed: false,
      queued: result.queued,
    };
  };

  const findOwnedSessionTask = async (callerSessionId: string, taskId: string) => {
    const caller = await resolveCaller(callerSessionId);
    if (!caller) {
      return {
        ok: false as const,
        errorCode: 'NOT_A_BOT_SESSION',
        message: '当前任务不属于任何伙伴',
      };
    }
    const [row] = await getDbClient()
      .drizzle.select()
      .from(botDelegations)
      .where(
        and(
          eq(botDelegations.id, taskId),
          eq(botDelegations.requestingBotId, caller.botId),
          isNull(botDelegations.targetBotId),
        ),
      )
      .limit(1);
    return row
      ? { ok: true as const, row }
      : { ok: false as const, errorCode: 'NOT_FOUND', message: '后台任务不存在' };
  };

  const getSessionTask = async (callerSessionId: string, taskId: string) => {
    const found = await findOwnedSessionTask(callerSessionId, taskId);
    if (!found.ok) return found;
    const row = found.row;
    const [child] = row.childSessionId
      ? await getDbClient().drizzle
        .select({ title: sessions.title })
        .from(sessions)
        .where(eq(sessions.id, row.childSessionId))
        .limit(1)
      : [];
    return {
      ok: true as const,
      task: {
        task_id: row.id,
        session_id: row.childSessionId,
        status: sessionTaskViewStatus(row),
        title: child?.title || row.objective.trim().split('\n')[0]?.slice(0, 120) || 'Background task',
        objective: row.objective,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        completed_at: row.completedAt,
        deadline_at: readDeadline(row.permissionSnapshotJson),
        result: row.resultSummary,
        error: row.lastError?.replace(/^[A-Z_]+:\s*/, '') ?? null,
        pendingInteraction: pendingInteractions.has(row.id)
          ? pendingInteractionView(pendingInteractions.get(row.id)!)
          : parsePendingInteraction(row.pendingInteractionJson),
        artifacts: parseArtifacts(row.outputArtifactsJson),
      },
    };
  };

  const messageSessionTask = async (
    callerSessionId: string,
    taskId: string,
    input: SessionTaskMessage,
  ) => {
    const found = await findOwnedSessionTask(callerSessionId, taskId);
    if (!found.ok) return found;
    return reply(callerSessionId, taskId, input);
  };

  const stopSessionTask = async (callerSessionId: string, taskId: string) => {
    const found = await findOwnedSessionTask(callerSessionId, taskId);
    if (!found.ok) return found;
    return cancelDelegation(callerSessionId, taskId);
  };

  const settleSession = async (params: {
    childSessionId: string;
    outcome: 'done' | 'error';
    resultText?: string;
    error?: string;
    /** Captured synchronously at the terminal boundary, before queue drain can start the next turn. */
    hadPendingInputAtTerminal?: boolean;
  }): Promise<void> => {
    // A message sent while the child is busy is queued for its next turn. The
    // current turn's done event is only a boundary, not the task's final result.
    if (params.hadPendingInputAtTerminal || deps.hasPendingInput?.(params.childSessionId)) return;
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(eq(botDelegations.childSessionId, params.childSessionId))
      .orderBy(desc(botDelegations.createdAt))
      .limit(1);
    if (!row || !ACTIVE_DELEGATION_STATUSES.includes(row.status as (typeof ACTIVE_DELEGATION_STATUSES)[number])) return;
    const [child] = await db
      .select({ tokensUsed: sessions.totalTokenUsage })
      .from(sessions)
      .where(eq(sessions.id, params.childSessionId))
      .limit(1);
    const tokensUsed = child?.tokensUsed ?? 0;
    const status: Extract<DelegationStatus, 'completed' | 'failed'> =
      params.outcome === 'done' ? 'completed' : 'failed';
    const lastError = params.error ?? null;
    // done.result 不是字符串时(部分 Pi / 订阅档位只把终答写进消息行)不能把空结果
    // 当成「对方什么都没说」——发起方会被叫醒,但手里是一段没 Result 的废话墙。
    const recoveredText = params.resultText?.trim()
      || (params.outcome === 'done'
        ? ((await readLatestAssistantText(params.childSessionId))?.trim() ?? '')
        : '');
    const resultSummary = recoveredText.slice(0, MAX_RESULT_CHARS) || null;
    const artifacts = params.outcome === 'done' && deps.collectArtifacts
      ? (await deps.collectArtifacts(params.childSessionId).catch((error) => {
          log.warn('failed to collect Session task artifacts', {
            delegationId: row.id,
            childSessionId: params.childSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        })).filter((artifact) => artifact.status !== 'deleted').slice(0, MAX_ARTIFACTS)
      : [];
    const changed = await updateTerminal({
      delegationId: row.id,
      status,
      resultSummary,
      outputArtifactsJson: JSON.stringify(artifacts),
      lastError,
      tokensUsed,
    });
    if (!changed) return;
    await deliverCompletion({
      ...row,
      status,
      resultSummary,
      artifacts,
      lastError,
    });
  };

  const restore = async (): Promise<void> => {
    const db = getDbClient().drizzle;
    const rows = await db
      .select()
      .from(botDelegations)
      .where(or(
        inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES]),
        and(
          inArray(botDelegations.status, ['completed', 'failed', 'cancelled', 'timed-out']),
          isNull(botDelegations.completionDeliveredAt),
        ),
      ));
    for (const persistedRow of rows) {
      const row = await repairDelegationParent(persistedRow);
      if (!isActiveDelegation(row.status as DelegationStatus)) {
        // Recreate the task-card anchor as well as the hidden wake after an
        // abnormal canonical replacement. The result must remain visible.
        await projectParentRequest(row);
        await deliverCompletion({
          ...row,
          status: row.status as Extract<DelegationStatus, 'completed' | 'failed' | 'cancelled' | 'timed-out'>,
          artifacts: parseArtifacts(row.outputArtifactsJson),
        });
        continue;
      }
      // Idempotent repair for the crash window between durable task creation/reparenting
      // and its timeline projection. A running task must never become unfindable.
      await projectParentRequest(row);
      if (row.status === 'queued') {
        const deadlineAt = readDeadline(row.permissionSnapshotJson);
        if (deadlineAt !== null) scheduleTimeout(row.id, deadlineAt);
        if (row.childSessionId) await attemptDispatch(row.id);
        continue;
      }
      if (row.status === 'running' || row.status === 'waiting') {
        await resumeRunningDelegation(row.id);
      }
    }
  };

  const unregisterParentCancellation = registerBotDelegationParentCancellation(
    cancelDelegationsForParentSession,
  );

  const dispose = (): void => {
    unregisterParentCancellation();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    for (const timer of completionRetryTimers.values()) clearTimeout(timer);
    completionRetryTimers.clear();
    for (const timer of interactionRetryTimers.values()) clearTimeout(timer);
    interactionRetryTimers.clear();
    for (const timer of cleanupRetryTimers.values()) clearTimeout(timer);
    cleanupRetryTimers.clear();
  };

  return {
    startSessionTask,
    ensureCanonicalSession: async (botId: string) => {
      const [profile] = await getDbClient().drizzle
        .select({ id: botProfiles.id, currentVersion: botProfiles.currentVersion, status: botProfiles.status })
        .from(botProfiles)
        .where(eq(botProfiles.id, botId))
        .limit(1);
      if (!profile || profile.status !== 'active') {
        return { ok: false as const, errorCode: 'TARGET_BOT_INACTIVE', message: '目标伙伴已暂停或归档' };
      }
      return ensureTargetCanonicalSession({ id: profile.id, currentVersion: profile.currentVersion });
    },
    listDelegations,
    getSessionTask,
    messageSessionTask,
    stopSessionTask,
    cancelDelegation,
    cancelDelegationsForParentSession,
    cancelDelegationsForBot,
    settleSession,
    handleInteractionStart,
    handleInteractionEnd,
    restore,
    dispose,
  };
}

export type BotDelegationService = ReturnType<typeof createBotDelegationService>;
