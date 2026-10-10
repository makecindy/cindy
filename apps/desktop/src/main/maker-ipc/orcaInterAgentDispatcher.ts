import {
  formatAgentMessage,
  formatOrcaCommunicationMessage,
} from '@cindy/orca-workflow';
import { AUTO_REVIEW_DELEGATED_CONTINUATION, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT } from '@cindy/maker-core';
import { restoreAutoReviewUserIntent, type AutoReviewHistoryMessage } from './autoReviewUserIntent.js';
import type { AgentKind, SessionSendOptions, SessionSendResult, UserMessage } from '@cindy/maker-core';

import type {
  AgentInputCreateOpts,
  AgentInputQueuedMessage,
  AgentInputSerializedFile,
} from '../../shared/agentInputQueue.js';
import { createLogger } from '../logger.js';
import { createHostSendFailure } from '../maker-host/send-outcome.js';
import type {
  CollabDispatchFailureOutcome,
  CollabDispatchQueuedOutcome,
  CollabDispatchSuccessOutcome,
  CollabDirectDispatchResult,
} from './collabSendOutcome.js';
import { resolveCollabDispatchResult } from './collabSendOutcome.js';
import type {
  AgentInputSendOpts,
  AgentInputSendResult,
  ControlSteerOutcome,
} from './agent-input-coordinator.js';
import { runAcceptedCallback, runAcceptedRollback } from './acceptedCallbackRunner.js';

const defaultLog = createLogger('maker-ipc');

type OrcaInterAgentDispatchMode = 'dispatched' | 'queued' | 'steered';

/** 请求插话但消息进了队列的原因；目标空闲直发时没有原因。 */
export type OrcaSteerFallbackReason = 'STEER_UNSUPPORTED' | 'INPUT_BOUNDARY_BUSY' | 'STEER_UNCERTAIN';

/** Orca lead/worker 派发结果，保留底层 dispatch outcome 供 MCP/IPC 区分排队、直发和失败根因。 */
export type DispatchOrcaInterAgentMessageResult =
  | {
      ok: true;
      mode: OrcaInterAgentDispatchMode;
      clientId: string;
      dispatchOutcome: CollabDispatchSuccessOutcome | CollabDispatchQueuedOutcome;
      targetTitle?: string | null;
      targetLastUserSendAt?: string | null;
      steerFallbackReason?: OrcaSteerFallbackReason;
    }
  | {
      ok: false;
      dispatchOutcome: CollabDispatchFailureOutcome;
    };

/** Orca 消息的发送方类型，决定持久化协议和 agent 可见提示头。 */
export type OrcaInterAgentMessageSource = 'lead' | 'worker';

/** 一次 lead/worker 间消息派发请求，accepted 回调用于把业务副作用绑定到真正派发边界。 */
export interface DispatchOrcaInterAgentMessageParams {
  targetSessionId: string;
  rawContent: string;
  source: OrcaInterAgentMessageSource;
  senderLabel: string;
  workerId?: string;
  /** 发送方显式选择；缺省排队。steer 只在目标正在运行时插进当前 turn。 */
  delivery?: 'queue' | 'steer';
  /** 可选, 随消息发给目标的本机图片绝对路径; 仅本机 session 支持, SSH 远端目标拒绝。 */
  imagePaths?: string[];
  /** Synchronous reserve boundary hook; must return before drain is scheduled. */
  onReserved?: () => void;
  beforeReserve?: () => Promise<void>;
  onAccepted?: () => void | Promise<void>;
  onAcceptedRollback?: () => void | Promise<void>;
  onAcceptedCommit?: () => void | Promise<void>;
  meta: {
    source: string;
    context: string;
  };
}

/** Orca dispatcher 只依赖 maker-core session 的最小发送接口，避免绑定完整 Maker 实例。 */
interface PersistedUserMessageSession {
  id: string;
  agentKind?: AgentKind;
  isTurnRunning?: () => boolean;
  getTurnGeneration?: () => number;
  capabilities?: { sameTurnSteer: { supported: boolean } };
  remoteHostId?: string | null;
  send: (
    message: UserMessage,
    opts?: SessionSendOptions,
  ) => Promise<SessionSendResult>;
}

/** 判断目标 session 是否可投递所需的最小 DB 快照。 */
export interface OrcaInterAgentSessionRowSnapshot {
  title: string | null;
  status: string | null;
  userSendAt: string | number | Date | null;
  /** 图片附件仅支持本机 session; SSH 远端目标必须拒绝。 */
  remoteHostId?: string | null;
}

/** register.ts 现有 sendToSessionInternal 的窄结果形状，Orca dispatcher 只消费派发语义。 */
export type OrcaInterAgentSendToSessionInternalResult =
  | {
      ok: true;
      targetSessionId: string;
      agentKind: AgentKind;
      wakeKind: 'resumed' | 'already-active' | 'created' | 'queued';
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
      /** create + useWorktree 专用回传;dispatcher 恒走 jump(必传 targetSessionId),不消费。 */
      worktreePath?: string | null;
    }
  | {
      ok: false;
      errorCode:
        | 'INVALID_ARGS'
        | 'NOT_FOUND'
        | 'ARCHIVED'
        | 'DELETED'
        | 'BUSY'
        | 'AGENT_NOT_READY'
        | 'UNSUPPORTED_CAPABILITY'
        // create 显式执行配置专用;dispatcher 恒走 jump,仅镜像共用函数的联合形状。
        | 'BUDGET_MODEL_REQUIRES_API_MODE'
        | 'PROVIDER_ROUTE_UNAVAILABLE'
        | 'LEAD_NOT_SUPPORTED'
        // create + useWorktree 专用;dispatcher 恒走 jump,不会收到,仅为镜像 register.ts 联合形状。
        | 'WORKTREE_UNAVAILABLE'
        | 'INTERNAL';
      message: string;
    };

/** 通过既有 sendToSessionInternal 重建或排队目标 session 时传入的最小参数。 */
export interface OrcaInterAgentSendToSessionInternalParams {
  autoReviewUserText: { kind: 'delegated-continuation' };
  targetSessionId: string;
  message: string;
  persistedContent: string;
  clientId: string;
  onAccepted?: () => void | Promise<void>;
  onAcceptedRollback?: () => void | Promise<void>;
  onAcceptedCommit?: () => void | Promise<void>;
  origin?: AgentInputQueuedMessage['origin'];
}

/** 校验后的图片附件; host 注入的 validateImageAttachments 产出, dispatcher 只消费。 */
export interface OrcaInterAgentImageAttachment {
  path: string;
  name: string;
  ext: string;
  size: number;
  mimeType: string;
}

/** Orca dispatcher 内部日志接口，保持测试和宿主 logger 可替换。 */
export interface OrcaInterAgentDispatcherLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

/** Orca dispatcher 的 I/O 边界，register.ts 只负责注入 DB、Maker、queue 和 role 解析能力。 */
export interface OrcaInterAgentDispatcherDeps<TSessionMeta> {
  readAutoReviewHistory?: (sessionId: string) => Promise<AutoReviewHistoryMessage[]>;
  createId: () => string;
  getSessionMeta: (sessionId: string) => Promise<TSessionMeta | null>;
  getSessionRowSnapshot: (sessionId: string) => Promise<OrcaInterAgentSessionRowSnapshot | null>;
  getLiveSession: (sessionId: string) => PersistedUserMessageSession | null | undefined;
  /** Uses the input coordinator's steer guards and preserves uncertain-delivery ownership. */
  steerControlInput?: (
    sessionId: string,
    item: AgentInputQueuedMessage,
    expectedTurn: { session: object; turnGeneration: number },
  ) => Promise<ControlSteerOutcome>;
  shouldQueueNewTurn: (sessionId: string) => boolean;
  hasSendToSessionLock: (sessionId: string) => boolean;
  /**
   * 把 prepare → 重新取 live → send 整段串行化到与 sendToSessionInternal 同一把
   * per-session 锁。占用中时 dispatcher 先排队，不自己再拿一层以免死锁。
   */
  withSendToSessionLock?: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
  /** 直发前与 sendToSessionInternal 共用同一套满窗 / compact 失败换窗预检。 */
  prepareUnhealthySession?: (sessionId: string) => Promise<boolean | void>;
  /**
   * 校验 imagePaths(存在性 + 图片扩展名), 返回逐张附件元数据或错误消息。
   * fs 属 host 边界, dispatcher 不直接碰文件系统。
   */
  validateImageAttachments?: (
    paths: string[],
  ) => Promise<{ ok: true; images: OrcaInterAgentImageAttachment[] } | { ok: false; message: string }>;
  buildCreateOptsForQueuedSession: (
    sessionId: string,
    meta: TSessionMeta,
  ) => Promise<AgentInputCreateOpts>;
  enqueueQueuedMessage: (sessionId: string, item: AgentInputQueuedMessage) => void;
  /** Restore first, then synchronously reserve the item at the live queue head. */
  reserveNextQueuedMessage: (
    sessionId: string,
    item: AgentInputQueuedMessage,
    onReserved?: () => void,
    beforeReserve?: () => Promise<void>,
  ) => Promise<boolean>;
  sendToSessionInternal: (
    params: OrcaInterAgentSendToSessionInternalParams,
  ) => Promise<OrcaInterAgentSendToSessionInternalResult>;
  createDbMessage: (
    sessionId: string,
    message: {
      clientId: string;
      role: 'user';
      content: string;
      agentMeta?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  beginDirectTurnChangeSet: (sessionId: string, clientId: string) => Promise<void>;
  abortDirectTurnChangeSet: (sessionId: string) => void;
  /**
   * 反查 worker 的 role，查不到返回 fallback。dispatcher 以空串作 fallback 区分「未知」，
   * role 同时用于来源标签与发给 lead 的 `[From Orca Worker <role> (worker_id: …)]` 前缀。
   */
  resolveWorkerSenderLabel: (workerId: string, fallback: string) => Promise<string>;
  /**
   * 反查 worker 所在的 Lead / Worker 会话，给消息来源标签定位发送方会话。
   * 缺省或查不到时消息仍照常投递，只是来源不可点击跳转。
   */
  resolveWorkerSessionLink?: (
    workerId: string,
  ) => Promise<{ leadSessionId: string; workerSessionId: string } | null>;
  isSessionRunningError: (err: unknown) => boolean;
  log?: OrcaInterAgentDispatcherLogger;
}

/** queued 消息的 accepted 副作用状态，用于派发失败时只回滚已经执行过的副作用。 */
interface QueuedOrcaInterAgentAcceptedCallback {
  accepted: () => void | Promise<void>;
  rollback?: (reason?: 'cancelled-before-dispatch') => void | Promise<void>;
  commit?: () => void | Promise<void>;
  didRun: boolean;
}

/** Orca lead/worker 派发协调器，集中管理直发、排队、accepted 副作用和回滚生命周期。 */
export interface OrcaInterAgentDispatcher {
  dispatchOrEnqueueOrcaInterAgentMessage: (
    params: DispatchOrcaInterAgentMessageParams,
  ) => Promise<DispatchOrcaInterAgentMessageResult>;
  /** Reserve one Orca message as the target's next input without steering the active turn. */
  reserveNextOrcaInterAgentMessage: (
    params: DispatchOrcaInterAgentMessageParams,
  ) => Promise<DispatchOrcaInterAgentMessageResult>;
  registerQueuedOrcaInterAgentAcceptedCallback: (
    clientId: string,
    accepted: () => void | Promise<void>,
    rollback?: (reason?: 'cancelled-before-dispatch') => void | Promise<void>,
    commit?: () => void | Promise<void>,
  ) => void;
  runQueuedOrcaInterAgentAcceptedCallback: (
    sessionId: string,
    item: AgentInputQueuedMessage,
  ) => Promise<void> | undefined;
  rollbackQueuedOrcaInterAgentAcceptedCallback: (
    sessionId: string,
    clientId: string | undefined,
  ) => Promise<void>;
  settleQueuedOrcaInterAgentAcceptedCallback: (
    sessionId: string,
    sendOpts: AgentInputSendOpts,
    result: AgentInputSendResult,
  ) => Promise<void>;
  discardQueuedOrcaInterAgentAcceptedCallback: (clientId: string) => void;
}

export function createOrcaInterAgentDispatcher<TSessionMeta>(
  deps: OrcaInterAgentDispatcherDeps<TSessionMeta>,
): OrcaInterAgentDispatcher {
  const log = deps.log ?? defaultLog;
  const queuedOrcaInterAgentAcceptedCallbacks = new Map<string, QueuedOrcaInterAgentAcceptedCallback>();

  const registerQueuedOrcaInterAgentAcceptedCallback = (
    clientId: string,
    accepted: () => void | Promise<void>,
    rollback?: (reason?: 'cancelled-before-dispatch') => void | Promise<void>,
    commit?: () => void | Promise<void>,
  ): void => {
    queuedOrcaInterAgentAcceptedCallbacks.set(clientId, {
      accepted,
      rollback,
      commit,
      didRun: false,
    });
  };

  const rollbackQueuedOrcaInterAgentAcceptedCallback = async (
    sessionId: string,
    clientId: string | undefined,
  ): Promise<void> => {
    if (!clientId) return;
    const callback = queuedOrcaInterAgentAcceptedCallbacks.get(clientId);
    if (!callback?.didRun) return;
    queuedOrcaInterAgentAcceptedCallbacks.delete(clientId);
    await runAcceptedRollback(callback.rollback, sessionId, clientId, log);
  };

  const settleQueuedOrcaInterAgentAcceptedCallback = async (
    sessionId: string,
    sendOpts: AgentInputSendOpts,
    result: AgentInputSendResult,
  ): Promise<void> => {
    const clientId = sendOpts.persistUserMessage?.clientId;
    if (!clientId) return;
    const callback = queuedOrcaInterAgentAcceptedCallbacks.get(clientId);
    if (!callback) return;
    if (result.kind === 'session-dispatch' && result.dispatched) {
      queuedOrcaInterAgentAcceptedCallbacks.delete(clientId);
      if (callback.didRun) {
        await runAcceptedCallback(callback.commit, sessionId, clientId, log);
      }
      return;
    }
    if (callback.didRun) {
      queuedOrcaInterAgentAcceptedCallbacks.delete(clientId);
      const reason =
        result.kind === 'session-dispatch' && result.reason === 'cancelled-before-dispatch'
          ? result.reason
          : undefined;
      await runAcceptedRollback(
        () => callback.rollback?.(reason),
        sessionId,
        clientId,
        log,
      );
    }
  };

  const runQueuedOrcaInterAgentAcceptedCallback = (
    sessionId: string,
    item: AgentInputQueuedMessage,
  ): Promise<void> | undefined => {
    const callback = queuedOrcaInterAgentAcceptedCallbacks.get(item.clientId);
    if (!callback) return undefined;
    callback.didRun = true;
    return runAcceptedCallback(callback.accepted, sessionId, item.clientId, log);
  };

  const discardQueuedOrcaInterAgentAcceptedCallback = (clientId: string): void => {
    queuedOrcaInterAgentAcceptedCallbacks.delete(clientId);
  };

  const dispatchOrEnqueueOrcaInterAgentMessage = async (
    params: DispatchOrcaInterAgentMessageParams,
  ): Promise<DispatchOrcaInterAgentMessageResult> => {
    const [meta, dbRow] = await Promise.all([
      deps.getSessionMeta(params.targetSessionId).catch(() => null),
      deps.getSessionRowSnapshot(params.targetSessionId),
    ]);
    if (!meta || !dbRow) {
      return {
        ok: false,
        dispatchOutcome: {
          ...createHostSendFailure('SEND_FAILED', `session ${params.targetSessionId} not found`),
          source: params.meta.source,
          context: params.meta.context,
        },
      };
    }
    if (dbRow.status === 'archived' || dbRow.status === 'deleted') {
      return {
        ok: false,
        dispatchOutcome: {
          ...createHostSendFailure('SEND_FAILED', `session ${params.targetSessionId} is ${dbRow.status}`),
          source: params.meta.source,
          context: params.meta.context,
        },
      };
    }

    const clientId = deps.createId();
    // worker 回报的前缀要带发件 worker 的 role,需要反查;只查一次,文本与来源标签共用。
    let workerRolePromise: Promise<string | undefined> | undefined;
    const resolveRole = (): Promise<string | undefined> =>
      (workerRolePromise ??= resolveOrcaWorkerRole(deps, params));
    const buildAgentMessageText = async (): Promise<string> =>
      formatAgentMessage(params.source, params.rawContent, params.workerId, await resolveRole());
    const persistedContent = formatOrcaCommunicationMessage(params.source, params.rawContent);
    // 图片附件: 入口处一次校验(存在性 + 图片扩展名 + 本机限定);三条投递路径共用。
    let imageFiles: AgentInputSerializedFile[] = [];
    if (params.imagePaths?.length) {
      if (dbRow.remoteHostId) {
        return {
          ok: false,
          dispatchOutcome: {
            ...createHostSendFailure(
              'SEND_FAILED',
              'image attachments are only supported for local sessions; SSH remote targets are not supported',
            ),
            source: params.meta.source,
            context: params.meta.context,
          },
        };
      }
      if (!deps.validateImageAttachments) {
        return {
          ok: false,
          dispatchOutcome: {
            ...createHostSendFailure('SEND_FAILED', 'image attachments are not supported by this host'),
            source: params.meta.source,
            context: params.meta.context,
          },
        };
      }
      const validated = await deps.validateImageAttachments(params.imagePaths);
      if (!validated.ok) {
        return {
          ok: false,
          dispatchOutcome: {
            ...createHostSendFailure('SEND_FAILED', validated.message),
            source: params.meta.source,
            context: params.meta.context,
          },
        };
      }
      imageFiles = validated.images.map((image) => ({
        id: deps.createId(),
        name: image.name,
        path: image.path,
        ext: image.ext,
        size: image.size,
        category: 'image',
        mimeType: image.mimeType,
        // 图片只可能来自本机(SSH 远端在入口已拒):标记 desktop-host,
        // 视觉桥才会桥接无视觉模型的 worker,否则原始 block 进 Pi 会抛
        // PiImageInputUnsupportedError 整条任务失败。
        pathOrigin: 'desktop-host',
      }));
    }
    // 直发时 image block 跟在格式化文本后;排队/插话时文件挂在 entry.files,
    // drain 由 buildMakerUserMessage 还原成同样的 block 序列。
    const agentMessageTextWithImages = async (): Promise<UserMessage> => {
      const text = await buildAgentMessageText();
      if (imageFiles.length === 0) return { type: 'user', content: text };
      return {
        type: 'user',
        content: [
          { type: 'text', text },
          ...imageFiles.map((file) => ({
            type: 'image' as const,
            path: file.path,
            mimeType: file.mimeType,
            pathOrigin: 'desktop-host' as const,
          })),
        ],
      };
    };
    let acceptedDidRun = false;
    const runAccepted = async (): Promise<void> => {
      acceptedDidRun = true;
      await params.onAccepted?.();
    };
    const rollbackAcceptedForRequeue = async (): Promise<void> => {
      if (!acceptedDidRun) return;
      await runAcceptedRollback(
        params.onAcceptedRollback,
        params.targetSessionId,
        clientId,
        log,
      );
      acceptedDidRun = false;
    };
    const failureResult = async (dispatchOutcome: CollabDispatchFailureOutcome): Promise<DispatchOrcaInterAgentMessageResult> => {
      if (acceptedDidRun) {
        await runAcceptedRollback(params.onAcceptedRollback, params.targetSessionId, clientId, log);
      }
      return { ok: false, dispatchOutcome };
    };
    const dispatchReceipt = {
      targetTitle: dbRow.title,
      targetLastUserSendAt: dbRow.userSendAt !== null
        ? new Date(dbRow.userSendAt).toISOString()
        : null,
    };
    // senderLabel 口径 = worker 的 role。包侧路径只有 workerId 可传, host 这里反查 role 覆盖。
    const resolveSenderLabel = async (): Promise<string> =>
      (await resolveRole()) ?? params.senderLabel;
    const resolveOrigin = async (): Promise<NonNullable<AgentInputQueuedMessage['origin']>> => {
      const [senderLabel, senderSessionId] = await Promise.all([
        resolveSenderLabel(),
        resolveOrcaSenderSessionId(deps, params),
      ]);
      return {
        kind: 'orca',
        senderLabel,
        displayText: params.rawContent,
        ...(senderSessionId ? { senderSessionId } : {}),
      };
    };
    let steerFallbackReason: OrcaSteerFallbackReason | undefined;
    // 请求了插话却落进队列时，回执必须说明原因；没请求插话时不带。
    const queuedSteerFallback = (): { steerFallbackReason?: OrcaSteerFallbackReason } =>
      params.delivery === 'steer'
        ? { steerFallbackReason: steerFallbackReason ?? 'INPUT_BOUNDARY_BUSY' }
        : {};
    const enqueueQueuedMessage = async (logEvent: string): Promise<DispatchOrcaInterAgentMessageResult> => {
      const createOpts = await deps.buildCreateOptsForQueuedSession(params.targetSessionId, meta);
      const queued = buildQueuedOrcaInterAgentMessage({
        clientId,
        agentMessageText: await buildAgentMessageText(),
        persistedContent,
        origin: await resolveOrigin(),
        createOpts,
        ...(imageFiles.length ? { files: imageFiles } : {}),
      });
      if (params.onAccepted) {
        registerQueuedOrcaInterAgentAcceptedCallback(
          clientId,
          params.onAccepted,
          params.onAcceptedRollback,
          params.onAcceptedCommit,
        );
      }
      deps.enqueueQueuedMessage(params.targetSessionId, queued);
      log.info(logEvent, {
        targetSessionId: params.targetSessionId,
        clientId,
        source: params.source,
        senderLabel: params.senderLabel,
        context: params.meta.context,
      });
      return {
        ok: true,
        mode: 'queued',
        clientId,
        dispatchOutcome: makeQueuedDispatchOutcome(params.meta.source),
        ...queuedSteerFallback(),
        ...dispatchReceipt,
      };
    };

    // 插话只由发送方显式选择（delivery=steer），且只对正在运行的目标尝试；空闲目标照常直发。
    const liveTurn = deps.getLiveSession(params.targetSessionId);
    if (params.delivery === 'steer' && liveTurn?.isTurnRunning?.() === true) {
      if (
        !deps.steerControlInput || !liveTurn.capabilities?.sameTurnSteer.supported ||
        !liveTurn.getTurnGeneration || liveTurn.remoteHostId
      ) {
        steerFallbackReason = 'STEER_UNSUPPORTED';
      } else if (!deps.hasSendToSessionLock(params.targetSessionId)) {
        const expectedTurn = { session: liveTurn, turnGeneration: liveTurn.getTurnGeneration() };
        const trySteer = async (): Promise<DispatchOrcaInterAgentMessageResult | null> => {
          // Async item preparation and lock acquisition can cross a turn replacement.
          const createOpts = await deps.buildCreateOptsForQueuedSession(params.targetSessionId, meta);
          const item = buildQueuedOrcaInterAgentMessage({
            clientId,
            agentMessageText: await buildAgentMessageText(),
            persistedContent,
            origin: await resolveOrigin(),
            createOpts,
            ...(imageFiles.length ? { files: imageFiles } : {}),
          });
          if (
            deps.getLiveSession(params.targetSessionId) !== liveTurn ||
            !liveTurn.isTurnRunning?.() ||
            liveTurn.getTurnGeneration?.() !== expectedTurn.turnGeneration
          ) return null;
          const outcome = await deps.steerControlInput!(params.targetSessionId, item, expectedTurn);
          if (outcome === 'steered') {
            // The message joined the running turn. Accepted/commit callbacks claim a new
            // turn's running/auto-bridge identity, so they deliberately never run here.
            return { ok: true, mode: 'steered', clientId,
              dispatchOutcome: { kind: 'session-dispatch', source: params.meta.source, dispatched: true },
              ...dispatchReceipt };
          }
          if (outcome === 'rejected') {
            // Input screening discarded it. Re-queueing would retry refused content.
            return failureResult({
              ...createHostSendFailure('SEND_FAILED', 'Orca message was blocked by input screening'),
              source: params.meta.source, context: params.meta.context,
            });
          }
          if (outcome === 'queued') {
            // The coordinator already owns this exact clientId in a paused queue. Enqueuing
            // again would duplicate it; its later drain starts a turn, so register there.
            if (params.onAccepted) registerQueuedOrcaInterAgentAcceptedCallback(
              clientId, params.onAccepted, params.onAcceptedRollback, params.onAcceptedCommit,
            );
            return { ok: true, mode: 'queued', clientId,
              dispatchOutcome: makeQueuedDispatchOutcome(params.meta.source),
              steerFallbackReason: 'STEER_UNCERTAIN', ...dispatchReceipt };
          }
          // Not delivered and nothing retained: the ordinary send/queue path is still safe.
          return null;
        };
        try {
          const steered = deps.withSendToSessionLock
            ? await deps.withSendToSessionLock(params.targetSessionId, trySteer)
            : await trySteer();
          if (steered) return steered;
        } catch (err) {
          return failureResult({
            ...createHostSendFailure('SEND_FAILED', err instanceof Error ? err.message : String(err)),
            source: params.meta.source, context: params.meta.context,
          });
        }
      }
    }

    const shouldQueue = deps.shouldQueueNewTurn(params.targetSessionId)
      || deps.hasSendToSessionLock(params.targetSessionId)
      || deps.getLiveSession(params.targetSessionId)?.isTurnRunning?.() === true;
    if (shouldQueue) {
      return enqueueQueuedMessage('orca inter-agent message queued');
    }

    try {
      const sendToInternal = async (): Promise<DispatchOrcaInterAgentMessageResult> => {
        const result = await deps.sendToSessionInternal({
          autoReviewUserText: { kind: 'delegated-continuation' },
          targetSessionId: params.targetSessionId,
          message: await buildAgentMessageText(),
          persistedContent,
          clientId,
          onAccepted: runAccepted,
          onAcceptedRollback: params.onAcceptedRollback,
          onAcceptedCommit: params.onAcceptedCommit,
          origin: await resolveOrigin(),
        });
        if (result.ok) {
          if (result.wakeKind === 'queued') {
            // A live/resume send can cross accepted and still lose a SESSION_RUNNING race. Undo
            // that provisional lifecycle before the same message waits for a fresh acceptance.
            await rollbackAcceptedForRequeue();
          }
          if (result.wakeKind !== 'queued' && acceptedDidRun) {
            await runAcceptedCallback(
              params.onAcceptedCommit,
              params.targetSessionId,
              clientId,
              log,
            );
          }
          return {
            ok: true,
            mode: result.wakeKind === 'queued' ? 'queued' : 'dispatched',
            clientId,
            dispatchOutcome: result.wakeKind === 'queued'
              ? makeQueuedDispatchOutcome(params.meta.source)
              : {
                  kind: 'session-dispatch',
                  source: params.meta.source,
                  dispatched: true,
                },
            ...(result.wakeKind === 'queued' ? queuedSteerFallback() : {}),
            targetTitle: result.targetTitle,
            targetLastUserSendAt: result.targetLastUserSendAt,
          };
        }
        return failureResult({
          ...createHostSendFailure(result.errorCode === 'BUSY' ? 'SESSION_RUNNING' : 'SEND_FAILED', result.message),
          source: params.meta.source,
          context: params.meta.context,
        });
      };
      const dispatchLive = async (): Promise<DispatchOrcaInterAgentMessageResult | null> => {
        await deps.prepareUnhealthySession?.(params.targetSessionId);
        const live = deps.getLiveSession(params.targetSessionId);
        if (!live) return null;
        const origin = await resolveOrigin();
        const result = await sendPersistedUserMessageToSession(deps, {
          session: live,
          dbContent: persistedContent,
          agentMessage: await agentMessageTextWithImages(),
          clientId,
          source: params.meta.source,
          context: params.meta.context,
          origin,
          onAccepted: runAccepted,
        });
        if (result.dispatched) {
          if (acceptedDidRun) {
            await runAcceptedCallback(
              params.onAcceptedCommit,
              params.targetSessionId,
              clientId,
              log,
            );
          }
          return { ok: true, mode: 'dispatched', clientId, dispatchOutcome: result.dispatchOutcome, ...dispatchReceipt };
        }
        if (result.dispatchOutcome.kind === 'host-send' && result.dispatchOutcome.code === 'SESSION_RUNNING') {
          await rollbackAcceptedForRequeue();
          return enqueueQueuedMessage('orca inter-agent message queued after SESSION_RUNNING race');
        }
        return failureResult(result.dispatchOutcome);
      };
      const liveResult = deps.withSendToSessionLock
        ? await deps.withSendToSessionLock(params.targetSessionId, dispatchLive)
        : await dispatchLive();
      if (liveResult) return liveResult;
      // 带图 no-live(换窗/重建中)与纯文本排队语义对齐:携 files 入队,
      // drain 经 sendToAgent 用 createOpts 重建 session 后送达,不静默丢图。
      if (imageFiles.length > 0) {
        return enqueueQueuedMessage('orca inter-agent message queued for no-live target with images');
      }
      return await sendToInternal();
    } catch (err) {
      return failureResult({
        ...createHostSendFailure(deps.isSessionRunningError(err) ? 'SESSION_RUNNING' : 'SEND_FAILED', err instanceof Error ? err.message : String(err)),
        source: params.meta.source,
        context: params.meta.context,
      });
    }
  };

  const reserveNextOrcaInterAgentMessage = async (
    params: DispatchOrcaInterAgentMessageParams,
  ): Promise<DispatchOrcaInterAgentMessageResult> => {
    const [meta, dbRow] = await Promise.all([
      deps.getSessionMeta(params.targetSessionId).catch(() => null),
      deps.getSessionRowSnapshot(params.targetSessionId),
    ]);
    if (!meta || !dbRow) {
      return {
        ok: false,
        dispatchOutcome: {
          ...createHostSendFailure('SEND_FAILED', `session ${params.targetSessionId} not found`),
          source: params.meta.source,
          context: params.meta.context,
        },
      };
    }
    if (dbRow.status === 'archived' || dbRow.status === 'deleted') {
      return {
        ok: false,
        dispatchOutcome: {
          ...createHostSendFailure(
            'SEND_FAILED',
            `session ${params.targetSessionId} is ${dbRow.status}`,
          ),
          source: params.meta.source,
          context: params.meta.context,
        },
      };
    }

    const clientId = deps.createId();
    const createOpts = await deps.buildCreateOptsForQueuedSession(params.targetSessionId, meta);
    const workerRole = await resolveOrcaWorkerRole(deps, params);
    const senderLabel = workerRole ?? params.senderLabel;
    const senderSessionId = await resolveOrcaSenderSessionId(deps, params);
    const queued = buildQueuedOrcaInterAgentMessage({
      clientId,
      agentMessageText: formatAgentMessage(params.source, params.rawContent, params.workerId, workerRole),
      persistedContent: formatOrcaCommunicationMessage(params.source, params.rawContent),
      origin: {
        kind: 'orca',
        senderLabel,
        displayText: params.rawContent,
        ...(senderSessionId ? { senderSessionId } : {}),
      },
      createOpts,
    });
    const callbackAlreadyRegistered = queuedOrcaInterAgentAcceptedCallbacks.has(clientId);
    if (params.onAccepted && !callbackAlreadyRegistered) {
      registerQueuedOrcaInterAgentAcceptedCallback(
        clientId,
        params.onAccepted,
        params.onAcceptedRollback,
        params.onAcceptedCommit,
      );
    }
    let reserved: boolean;
    try {
      reserved = await deps.reserveNextQueuedMessage(
        params.targetSessionId,
        queued,
        params.onReserved,
        params.beforeReserve,
      );
    } catch (err) {
      if (!callbackAlreadyRegistered) {
        discardQueuedOrcaInterAgentAcceptedCallback(clientId);
      }
      return {
        ok: false,
        dispatchOutcome: {
          ...createHostSendFailure('SEND_FAILED', err instanceof Error ? err.message : String(err)),
          source: params.meta.source,
          context: params.meta.context,
        },
      };
    }
    if (!reserved) {
      if (!callbackAlreadyRegistered) {
        discardQueuedOrcaInterAgentAcceptedCallback(clientId);
      }
      return {
        ok: false,
        dispatchOutcome: {
          ...createHostSendFailure('SEND_FAILED', `queued message ${clientId} was not reserved`),
          source: params.meta.source,
          context: params.meta.context,
        },
      };
    }
    log.info('orca inter-agent message reserved as next input', {
      targetSessionId: params.targetSessionId,
      clientId,
      source: params.source,
      senderLabel,
      context: params.meta.context,
    });
    return {
      ok: true,
      mode: 'queued',
      clientId,
      dispatchOutcome: makeQueuedDispatchOutcome(params.meta.source),
      targetTitle: dbRow.title,
      targetLastUserSendAt:
        dbRow.userSendAt !== null ? new Date(dbRow.userSendAt).toISOString() : null,
    };
  };

  return {
    dispatchOrEnqueueOrcaInterAgentMessage,
    reserveNextOrcaInterAgentMessage,
    registerQueuedOrcaInterAgentAcceptedCallback,
    runQueuedOrcaInterAgentAcceptedCallback,
    rollbackQueuedOrcaInterAgentAcceptedCallback,
    settleQueuedOrcaInterAgentAcceptedCallback,
    discardQueuedOrcaInterAgentAcceptedCallback,
  };
}

/**
 * worker 发出的消息反查其 role（lead 发出的消息不需要）。查不到或出错返回 undefined，
 * 消息照常投递：前缀退回只带 worker_id，来源标签退回调用方给的 senderLabel。
 */
async function resolveOrcaWorkerRole<TSessionMeta>(
  deps: OrcaInterAgentDispatcherDeps<TSessionMeta>,
  params: Pick<DispatchOrcaInterAgentMessageParams, 'source' | 'workerId'>,
): Promise<string | undefined> {
  if (params.source !== 'worker' || !params.workerId) return undefined;
  try {
    const role = (await deps.resolveWorkerSenderLabel(params.workerId, '')).trim();
    return role || undefined;
  } catch {
    return undefined;
  }
}

/** Lead 发出的消息来源是 Lead 会话，Worker 发出的是 Worker 会话；都以 workerId 反查。 */
async function resolveOrcaSenderSessionId<TSessionMeta>(
  deps: OrcaInterAgentDispatcherDeps<TSessionMeta>,
  params: Pick<DispatchOrcaInterAgentMessageParams, 'source' | 'workerId'>,
): Promise<string | undefined> {
  if (!params.workerId || !deps.resolveWorkerSessionLink) return undefined;
  try {
    const link = await deps.resolveWorkerSessionLink(params.workerId);
    if (!link) return undefined;
    return params.source === 'lead' ? link.leadSessionId : link.workerSessionId;
  } catch {
    return undefined;
  }
}

async function sendPersistedUserMessageToSession<TSessionMeta>(
  deps: OrcaInterAgentDispatcherDeps<TSessionMeta>,
  params: {
    session: PersistedUserMessageSession;
    dbContent: string;
    agentMessage: UserMessage;
    clientId?: string;
    source: string;
    context: string;
    origin?: AgentInputQueuedMessage['origin'];
    onAccepted?: () => void | Promise<void>;
  },
): Promise<CollabDirectDispatchResult> {
  const { session, dbContent, agentMessage, clientId = deps.createId(), source, context, origin, onAccepted } = params;
  let turnChangeSetStarted = false;
  const humanIntent = restoreAutoReviewUserIntent(await deps.readAutoReviewHistory?.(session.id) ?? []);
  const result = await resolveCollabDispatchResult(
    () => session.send(agentMessage, {
      planMode: false,
      throwOnStartFailure: true,
      [AUTO_REVIEW_SOURCE_CONTENT]: '',
      [AUTO_REVIEW_USER_INTENT]: humanIntent,
      [AUTO_REVIEW_DELEGATED_CONTINUATION]: true,
      onAccepted: async () => {
        // maker-core 会在 vendor handle.send 前 await 此 hook；必须先落库，再运行 accepted 副作用。
        await deps.createDbMessage(session.id, {
          clientId,
          role: 'user',
          content: dbContent,
          agentMeta: { ...(origin ? { origin } : {}), autoReviewUserText: { kind: 'delegated-continuation' }, delivery: 'turn' },
        });
        await deps.beginDirectTurnChangeSet(session.id, clientId);
        turnChangeSetStarted = true;
        await runAcceptedCallback(onAccepted, session.id, clientId, deps.log ?? defaultLog);
      },
    }),
    { source, context },
  );
  if (turnChangeSetStarted && !result.dispatched) {
    deps.abortDirectTurnChangeSet(session.id);
  }
  return result;
}

function makeQueuedDispatchOutcome(source: string): CollabDispatchQueuedOutcome {
  return {
    kind: 'session-dispatch',
    source,
    dispatched: true,
    wakeKind: 'queued',
  };
}

/**
 * 按 lead→worker 排队消息的原始派发格式重建正文,供「修改排队消息」能力使用。
 * text / persistedContent / chatMessage.content / origin.displayText 四处的格式
 * 耦合与 buildQueuedOrcaInterAgentMessage 同源(formatAgentMessage /
 * formatOrcaCommunicationMessage);身份与调度字段(clientId / createOpts /
 * chatMessage.createdAt / origin.senderLabel)全部锚定原条目不变。
 */
export function rebuildQueuedOrcaLeadMessage(
  entry: AgentInputQueuedMessage,
  rawContent: string,
  workerId?: string,
): AgentInputQueuedMessage {
  const agentMessageText = formatAgentMessage('lead', rawContent, workerId);
  const persistedContent = formatOrcaCommunicationMessage('lead', rawContent);
  return {
    ...entry,
    text: agentMessageText,
    persistedContent,
    chatMessage: {
      ...entry.chatMessage,
      content: persistedContent,
    },
    ...(entry.origin?.kind === 'orca'
      ? { origin: { ...entry.origin, displayText: rawContent } }
      : {}),
  };
}

function buildQueuedOrcaInterAgentMessage(params: {
  clientId: string;
  agentMessageText: string;
  persistedContent: string;
  origin: NonNullable<AgentInputQueuedMessage['origin']>;
  createOpts: AgentInputCreateOpts;
  files?: AgentInputSerializedFile[];
}): AgentInputQueuedMessage {
  const createdAt = new Date().toISOString();
  return {
    clientId: params.clientId,
    text: params.agentMessageText,
    autoReviewUserText: { kind: 'delegated-continuation' },
    persistedContent: params.persistedContent,
    model: params.createOpts.model,
    effort: params.createOpts.effort ?? '',
    permissionMode: params.createOpts.permissionMode ?? 'bypassPermissions',
    workingDir: params.createOpts.workingDir,
    vendorOptions: params.createOpts.vendorOptions,
    ...(params.files?.length ? { files: params.files } : {}),
    chatMessage: {
      clientId: params.clientId,
      role: 'user',
      content: params.persistedContent,
      createdAt,
    },
    createOpts: params.createOpts,
    origin: params.origin,
  };
}
