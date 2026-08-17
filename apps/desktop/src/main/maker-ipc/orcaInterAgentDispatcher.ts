import {
  formatAgentMessage,
  formatOrcaCommunicationMessage,
} from '@cindy/orca-workflow';
import type { AgentKind, SessionSendOptions, SessionSendResult, UserMessage } from '@cindy/maker-core';

import type {
  AgentInputCreateOpts,
  AgentInputQueuedMessage,
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
} from './agent-input-coordinator.js';
import { runAcceptedCallback, runAcceptedRollback } from './acceptedCallbackRunner.js';

const defaultLog = createLogger('maker-ipc');

type OrcaInterAgentDispatchMode = 'dispatched' | 'queued';

function stripIpcErrorPrefix(message: string): string {
  const match = message.match(/^\[[^\]]+\]\s*(.*)$/);
  return match?.[1] ?? message;
}

function isInactiveOrcaTeamSendFailure(result: AgentInputSendResult): boolean {
  if (result.kind === 'host-send') {
    return stripIpcErrorPrefix(result.message).startsWith('ORCA_TEAM_INACTIVE:');
  }
  return (
    !result.dispatched &&
    result.reason === 'cancelled-before-dispatch' &&
    result.context.startsWith('ORCA_TEAM_INACTIVE/')
  );
}

function thrownMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPendingOrcaTeamTransitionError(err: unknown): boolean {
  return stripIpcErrorPrefix(thrownMessage(err)).startsWith('ORCA_TEAM_TERMINATING:');
}

function isUnconfirmedCollabDispatchOutcome(
  outcome: CollabDispatchFailureOutcome,
): boolean {
  return outcome.kind === 'host-send' && outcome.dispatchUnconfirmed === true;
}

/** Orca lead/worker 派发结果，保留底层 dispatch outcome 供 MCP/IPC 区分排队、直发和失败根因。 */
export type DispatchOrcaInterAgentMessageResult =
  | {
      ok: true;
      mode: OrcaInterAgentDispatchMode;
      clientId: string;
      dispatchOutcome: CollabDispatchSuccessOutcome | CollabDispatchQueuedOutcome;
      targetTitle?: string | null;
      targetLastUserSendAt?: string | null;
    }
  | {
      ok: false;
      dispatchOutcome: CollabDispatchFailureOutcome;
    };

type DispatchOrcaInterAgentMessageAttemptResult = DispatchOrcaInterAgentMessageResult & {
  retryAfterTerminalTransition?: true;
};

/** Orca 消息的发送方类型，决定持久化协议和 agent 可见提示头。 */
export type OrcaInterAgentMessageSource = 'lead' | 'worker';

/** 一次 lead/worker 间消息派发请求，accepted 回调用于把业务副作用绑定到真正派发边界。 */
export interface DispatchOrcaInterAgentMessageParams {
  targetSessionId: string;
  /** Durable workflow scope; every automatic Orca message belongs to one team. */
  teamId: string;
  rawContent: string;
  source: OrcaInterAgentMessageSource;
  senderLabel: string;
  workerId?: string;
  onAccepted?: () => void | Promise<void>;
  onAcceptedRollback?: () => void | Promise<void>;
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
      /** Provider acceptance may have happened; accepted side effects must be preserved. */
      dispatchUnconfirmed?: true;
    };

/** 通过既有 sendToSessionInternal 重建或排队目标 session 时传入的最小参数。 */
export interface OrcaInterAgentSendToSessionInternalParams {
  targetSessionId: string;
  message: string;
  persistedContent: string;
  clientId: string;
  onAccepted?: () => void | Promise<void>;
  onAcceptedRollback?: () => void | Promise<void>;
  origin?: AgentInputQueuedMessage['origin'];
}

/** Orca dispatcher 内部日志接口，保持测试和宿主 logger 可替换。 */
export interface OrcaInterAgentDispatcherLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

/** Orca dispatcher 的 I/O 边界，register.ts 只负责注入 DB、Maker、queue 和 role 解析能力。 */
export interface OrcaInterAgentDispatcherDeps<TSessionMeta> {
  createId: () => string;
  getSessionMeta: (sessionId: string) => Promise<TSessionMeta | null>;
  getSessionRowSnapshot: (sessionId: string) => Promise<OrcaInterAgentSessionRowSnapshot | null>;
  getLiveSession: (sessionId: string) => PersistedUserMessageSession | null | undefined;
  shouldQueueNewTurn: (sessionId: string) => boolean;
  hasSendToSessionLock: (sessionId: string) => boolean;
  buildCreateOptsForQueuedSession: (
    sessionId: string,
    meta: TSessionMeta,
  ) => Promise<AgentInputCreateOpts>;
  enqueueQueuedMessage: (
    sessionId: string,
    item: AgentInputQueuedMessage,
  ) => void | Promise<void>;
  sendToSessionInternal: (
    params: OrcaInterAgentSendToSessionInternalParams,
  ) => Promise<OrcaInterAgentSendToSessionInternalResult>;
  createDbMessage: (
    sessionId: string,
    message: { clientId: string; role: 'user'; content: string },
  ) => Promise<unknown>;
  rewindPersistedUserMessage: (sessionId: string, clientId: string) => Promise<void>;
  retainPersistedUserMessageCleanup: (
    sessionId: string,
    item: AgentInputQueuedMessage,
    error: unknown,
  ) => void | Promise<void>;
  trackPersistedUserMessageBeforeVendorDispatch: (
    sessionId: string,
    item: AgentInputQueuedMessage,
  ) => void;
  untrackPersistedUserMessageBeforeVendorDispatch: (clientId: string) => void;
  beginDirectTurnChangeSet: (sessionId: string, clientId: string) => Promise<void>;
  abortDirectTurnChangeSet: (sessionId: string) => void;
  resolveWorkerSenderLabel: (workerId: string, fallback: string) => Promise<string>;
  isOrcaTeamActive: (teamId: string) => Promise<boolean>;
  /** Retain the terminal fence entry until this pre-vendor attempt settles. */
  reserveOrcaTeamPreVendorDispatch: (teamId: string) => () => void;
  /** Wait until an in-flight terminal transition either commits or rolls back. */
  waitForOrcaTeamTerminalTransition: (teamId: string) => Promise<'open' | 'terminal'>;
  /** Cross-process lease held from the durable active check through provider acceptance. */
  acquireVendorDispatchLease: (
    teamId: string,
  ) => Promise<() => void | Promise<void>>;
  /** Process-local last-moment fence for the DB-check-to-vendor race. */
  assertOrcaTeamActiveBeforeVendorDispatch?: (teamId: string) => void;
  isSessionRunningError: (err: unknown) => boolean;
  log?: OrcaInterAgentDispatcherLogger;
}

/** queued 消息的 accepted 副作用状态，用于派发失败时只回滚已经执行过的副作用。 */
interface QueuedOrcaInterAgentAcceptedCallback {
  accepted: () => void | Promise<void>;
  rollback?: () => void | Promise<void>;
  didRun: boolean;
}

/** Orca lead/worker 派发协调器，集中管理直发、排队、accepted 副作用和回滚生命周期。 */
export interface OrcaInterAgentDispatcher {
  dispatchOrEnqueueOrcaInterAgentMessage: (
    params: DispatchOrcaInterAgentMessageParams,
  ) => Promise<DispatchOrcaInterAgentMessageResult>;
  registerQueuedOrcaInterAgentAcceptedCallback: (
    clientId: string,
    accepted: () => void | Promise<void>,
    rollback?: () => void | Promise<void>,
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
  reserveTeamDispatchSettlement: (teamId: string) => () => void;
  waitForTeamDispatchSettlements: (teamId: string) => Promise<void>;
}

export function createOrcaInterAgentDispatcher<TSessionMeta>(
  deps: OrcaInterAgentDispatcherDeps<TSessionMeta>,
): OrcaInterAgentDispatcher {
  const log = deps.log ?? defaultLog;
  const queuedOrcaInterAgentAcceptedCallbacks = new Map<string, QueuedOrcaInterAgentAcceptedCallback>();
  const teamDispatchSettlements = new Map<string, Set<Promise<void>>>();

  const registerQueuedOrcaInterAgentAcceptedCallback = (
    clientId: string,
    accepted: () => void | Promise<void>,
    rollback?: () => void | Promise<void>,
  ): void => {
    queuedOrcaInterAgentAcceptedCallbacks.set(clientId, {
      accepted,
      rollback,
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
      return;
    }
    if (isInactiveOrcaTeamSendFailure(result)) {
      queuedOrcaInterAgentAcceptedCallbacks.delete(clientId);
      if (callback.didRun) {
        await runAcceptedRollback(callback.rollback, sessionId, clientId, log);
      }
      return;
    }
    if (callback.didRun) {
      queuedOrcaInterAgentAcceptedCallbacks.delete(clientId);
      await runAcceptedRollback(callback.rollback, sessionId, clientId, log);
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

  const trackTeamDispatchSettlement = (teamId: string, settlement: Promise<void>): void => {
    const teamSettlements = teamDispatchSettlements.get(teamId) ?? new Set();
    teamSettlements.add(settlement);
    teamDispatchSettlements.set(teamId, teamSettlements);
    void settlement.then(() => {
      teamSettlements.delete(settlement);
      if (teamSettlements.size === 0 && teamDispatchSettlements.get(teamId) === teamSettlements) {
        teamDispatchSettlements.delete(teamId);
      }
    });
  };

  const reserveTeamDispatchSettlement = (teamId: string): (() => void) => {
    const releaseReservation = deps.reserveOrcaTeamPreVendorDispatch(teamId);
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    trackTeamDispatchSettlement(teamId, settlement);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseReservation();
      resolveSettlement();
    };
  };

  const dispatchOrEnqueueOrcaInterAgentMessage = async (
    params: DispatchOrcaInterAgentMessageParams,
  ): Promise<DispatchOrcaInterAgentMessageAttemptResult> => {
    try {
      if (!(await deps.isOrcaTeamActive(params.teamId))) {
        return {
          ok: false,
          dispatchOutcome: {
            ...createHostSendFailure(
              'SEND_FAILED',
              `ORCA_TEAM_INACTIVE: team ${params.teamId} has already ended`,
            ),
            source: params.meta.source,
            context: params.meta.context,
          },
        };
      }
    } catch (err) {
      return {
        ok: false,
        dispatchOutcome: {
          ...createHostSendFailure('SEND_FAILED', err instanceof Error ? err.message : String(err)),
          source: params.meta.source,
          context: params.meta.context,
        },
      };
    }
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
    const agentMessageText = formatAgentMessage(params.source, params.rawContent, params.workerId);
    const persistedContent = formatOrcaCommunicationMessage(params.source, params.rawContent);
    let acceptedDidRun = false;
    const runAccepted = async (): Promise<void> => {
      acceptedDidRun = true;
      await params.onAccepted?.();
    };
    const failureResult = async (
      dispatchOutcome: CollabDispatchFailureOutcome,
      retryAfterTerminalTransition = false,
    ): Promise<DispatchOrcaInterAgentMessageAttemptResult> => {
      if (acceptedDidRun && !isUnconfirmedCollabDispatchOutcome(dispatchOutcome)) {
        await runAcceptedRollback(params.onAcceptedRollback, params.targetSessionId, clientId, log);
      }
      return {
        ok: false,
        dispatchOutcome,
        ...(retryAfterTerminalTransition ? { retryAfterTerminalTransition: true as const } : {}),
      };
    };
    const failureFromThrown = (err: unknown): CollabDispatchFailureOutcome => ({
      ...createHostSendFailure(
        deps.isSessionRunningError(err) ? 'SESSION_RUNNING' : 'SEND_FAILED',
        err instanceof Error ? err.message : String(err),
      ),
      source: params.meta.source,
      context: params.meta.context,
    });
    const dispatchReceipt = {
      targetTitle: dbRow.title,
      targetLastUserSendAt: dbRow.userSendAt !== null
        ? new Date(dbRow.userSendAt).toISOString()
        : null,
    };
    // senderLabel 口径 = worker 的 role。包侧路径只有 workerId 可传, host 这里反查 role 覆盖。
    const resolveSenderLabel = async (): Promise<string> => {
      if (params.source !== 'worker' || !params.workerId) return params.senderLabel;
      try {
        return await deps.resolveWorkerSenderLabel(params.workerId, params.senderLabel);
      } catch {
        return params.senderLabel;
      }
    };
    let queuedMessagePromise: Promise<AgentInputQueuedMessage> | null = null;
    const buildQueuedMessage = (): Promise<AgentInputQueuedMessage> => {
      queuedMessagePromise ??= Promise.all([
        deps.buildCreateOptsForQueuedSession(params.targetSessionId, meta),
        resolveSenderLabel(),
      ]).then(([createOpts, senderLabel]) => buildQueuedOrcaInterAgentMessage({
        clientId,
        agentMessageText,
        persistedContent,
        rawContent: params.rawContent,
        teamId: params.teamId,
        senderLabel,
        createOpts,
      }));
      return queuedMessagePromise;
    };
    const enqueueQueuedMessage = async (
      logEvent: string,
    ): Promise<DispatchOrcaInterAgentMessageAttemptResult> => {
      const queued = await buildQueuedMessage();
      try {
        deps.assertOrcaTeamActiveBeforeVendorDispatch?.(params.teamId);
      } catch (err) {
        return failureResult(failureFromThrown(err), isPendingOrcaTeamTransitionError(err));
      }
      if (params.onAccepted) {
        registerQueuedOrcaInterAgentAcceptedCallback(clientId, params.onAccepted, params.onAcceptedRollback);
      }
      try {
        await deps.enqueueQueuedMessage(params.targetSessionId, queued);
      } catch (err) {
        discardQueuedOrcaInterAgentAcceptedCallback(clientId);
        return failureResult(failureFromThrown(err), isPendingOrcaTeamTransitionError(err));
      }
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
        ...dispatchReceipt,
      };
    };

    const shouldQueue = deps.shouldQueueNewTurn(params.targetSessionId)
      || deps.hasSendToSessionLock(params.targetSessionId)
      || deps.getLiveSession(params.targetSessionId)?.isTurnRunning?.() === true;
    if (shouldQueue) {
      return enqueueQueuedMessage('orca inter-agent message queued');
    }

    try {
      const live = deps.getLiveSession(params.targetSessionId);
      if (live) {
        // Prebuild the durable cleanup representation before the direct path
        // can persist a user row. If session configuration cannot be captured,
        // fail before creating a row that would have no crash recovery shape.
        const cleanupItem = await buildQueuedMessage();
        const result = await sendPersistedUserMessageToSession(deps, {
          session: live,
          dbContent: persistedContent,
          agentMessage: { type: 'user', content: agentMessageText },
          clientId,
          source: params.meta.source,
          context: params.meta.context,
          onAccepted: runAccepted,
          onPersisted: () =>
            deps.trackPersistedUserMessageBeforeVendorDispatch(
              params.targetSessionId,
              cleanupItem,
            ),
          acquireVendorDispatchLease: () =>
            deps.acquireVendorDispatchLease(params.teamId),
          beforeVendorDispatch: () => {
            deps.assertOrcaTeamActiveBeforeVendorDispatch?.(params.teamId);
            deps.untrackPersistedUserMessageBeforeVendorDispatch(clientId);
          },
          onConfirmedUndispatched: () =>
            deps.untrackPersistedUserMessageBeforeVendorDispatch(clientId),
          onRewindFailed: (error) =>
            deps.retainPersistedUserMessageCleanup(
              params.targetSessionId,
              cleanupItem,
              error,
            ),
        });
        if (result.dispatched) {
          return { ok: true, mode: 'dispatched', clientId, dispatchOutcome: result.dispatchOutcome, ...dispatchReceipt };
        }
        if (result.dispatchOutcome.kind === 'host-send' && result.dispatchOutcome.code === 'SESSION_RUNNING') {
          return enqueueQueuedMessage('orca inter-agent message queued after SESSION_RUNNING race');
        }
        return failureResult(result.dispatchOutcome, result.terminalTransitionPending === true);
      }

      const result = await deps.sendToSessionInternal({
        targetSessionId: params.targetSessionId,
        message: agentMessageText,
        persistedContent,
        clientId,
        onAccepted: runAccepted,
        onAcceptedRollback: params.onAcceptedRollback,
        origin: {
          kind: 'orca',
          teamId: params.teamId,
          senderLabel: await resolveSenderLabel(),
          displayText: params.rawContent,
        },
      });
      if (result.ok) {
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
          targetTitle: result.targetTitle,
          targetLastUserSendAt: result.targetLastUserSendAt,
        };
      }
      return failureResult(
        {
          ...createHostSendFailure(result.errorCode === 'BUSY' ? 'SESSION_RUNNING' : 'SEND_FAILED', result.message),
          source: params.meta.source,
          context: params.meta.context,
          ...(result.dispatchUnconfirmed ? { dispatchUnconfirmed: true as const } : {}),
        },
        isPendingOrcaTeamTransitionError(result.message),
      );
    } catch (err) {
      return failureResult(failureFromThrown(err), isPendingOrcaTeamTransitionError(err));
    }
  };

  const dispatchOrEnqueueOrcaInterAgentMessageWithSettlement = (
    params: DispatchOrcaInterAgentMessageParams,
  ): Promise<DispatchOrcaInterAgentMessageResult> => {
    const terminalTransitionFailure = (message: string): DispatchOrcaInterAgentMessageResult => ({
      ok: false,
      dispatchOutcome: {
        ...createHostSendFailure('SEND_FAILED', message),
        source: params.meta.source,
        context: params.meta.context,
      },
    });
    const run = (async () => {
      while (true) {
        let releaseReservation: (() => void) | null = null;
        while (!releaseReservation) {
          try {
            releaseReservation = reserveTeamDispatchSettlement(params.teamId);
          } catch (err) {
            if (!isPendingOrcaTeamTransitionError(err)) {
              return terminalTransitionFailure(thrownMessage(err));
            }
            try {
              const state = await deps.waitForOrcaTeamTerminalTransition(params.teamId);
              if (state === 'terminal') {
                return terminalTransitionFailure(
                  `ORCA_TEAM_INACTIVE: team ${params.teamId} has already ended`,
                );
              }
            } catch (waitErr) {
              return terminalTransitionFailure(thrownMessage(waitErr));
            }
          }
        }
        let result: DispatchOrcaInterAgentMessageAttemptResult;
        try {
          result = await dispatchOrEnqueueOrcaInterAgentMessage(params);
        } finally {
          releaseReservation();
        }
        if (!result.retryAfterTerminalTransition) return result;
        try {
          const state = await deps.waitForOrcaTeamTerminalTransition(params.teamId);
          if (state === 'terminal') {
            return terminalTransitionFailure(
              `ORCA_TEAM_INACTIVE: team ${params.teamId} has already ended`,
            );
          }
        } catch (waitErr) {
          return terminalTransitionFailure(thrownMessage(waitErr));
        }
      }
    })();
    return run;
  };

  const waitForTeamDispatchSettlements = async (teamId: string): Promise<void> => {
    const settlements = teamDispatchSettlements.get(teamId);
    if (!settlements || settlements.size === 0) return;
    await Promise.all([...settlements]);
  };

  return {
    dispatchOrEnqueueOrcaInterAgentMessage: dispatchOrEnqueueOrcaInterAgentMessageWithSettlement,
    registerQueuedOrcaInterAgentAcceptedCallback,
    runQueuedOrcaInterAgentAcceptedCallback,
    rollbackQueuedOrcaInterAgentAcceptedCallback,
    settleQueuedOrcaInterAgentAcceptedCallback,
    discardQueuedOrcaInterAgentAcceptedCallback,
    reserveTeamDispatchSettlement,
    waitForTeamDispatchSettlements,
  };
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
    onAccepted?: () => void | Promise<void>;
    onPersisted?: () => void | Promise<void>;
    acquireVendorDispatchLease?: SessionSendOptions['acquireVendorDispatchLease'];
    beforeVendorDispatch?: () => void;
    onConfirmedUndispatched?: () => void;
    onRewindFailed?: (error: unknown) => void | Promise<void>;
  },
): Promise<CollabDirectDispatchResult & { terminalTransitionPending?: true }> {
  const { session, dbContent, agentMessage, clientId = deps.createId(), source, context, onAccepted } = params;
  let userMessagePersisted = false;
  let turnChangeSetStarted = false;
  let terminalTransitionPending = false;
  const originalAcquireVendorDispatchLease = params.acquireVendorDispatchLease;
  const acquireVendorDispatchLease: SessionSendOptions['acquireVendorDispatchLease'] =
    originalAcquireVendorDispatchLease
      ? () => {
        try {
          const acquisition = originalAcquireVendorDispatchLease();
          if (acquisition instanceof Promise) {
            return acquisition.catch((err) => {
              terminalTransitionPending = isPendingOrcaTeamTransitionError(err);
              throw err;
            });
          }
          return acquisition;
        } catch (err) {
          terminalTransitionPending = isPendingOrcaTeamTransitionError(err);
          throw err;
        }
      }
      : undefined;
  const result = await resolveCollabDispatchResult(
    () => session.send(agentMessage, {
      planMode: false,
      throwOnStartFailure: true,
      onAccepted: async () => {
        // maker-core 会在 vendor handle.send 前 await 此 hook；必须先落库，再运行 accepted 副作用。
        await deps.createDbMessage(session.id, {
          clientId,
          role: 'user',
          content: dbContent,
        });
        userMessagePersisted = true;
        await params.onPersisted?.();
        await deps.beginDirectTurnChangeSet(session.id, clientId);
        turnChangeSetStarted = true;
        await runAcceptedCallback(onAccepted, session.id, clientId, deps.log ?? defaultLog);
      },
      acquireVendorDispatchLease,
      onDispatching: () => {
        try {
          params.beforeVendorDispatch?.();
        } catch (err) {
          terminalTransitionPending = isPendingOrcaTeamTransitionError(err);
          throw err;
        }
      },
    }),
    { source, context },
  );
  const confirmedUndispatched =
    !result.dispatched && !isUnconfirmedCollabDispatchOutcome(result.dispatchOutcome);
  if (turnChangeSetStarted && confirmedUndispatched) {
    deps.abortDirectTurnChangeSet(session.id);
  }
  if (userMessagePersisted && confirmedUndispatched) {
    try {
      await deps.rewindPersistedUserMessage(session.id, clientId);
    } catch (err) {
      (deps.log ?? defaultLog).warn('direct Orca user row rewind failed', {
        sessionId: session.id,
        clientId,
        error: err instanceof Error ? err.message : String(err),
      });
      await params.onRewindFailed?.(err);
      throw err;
    } finally {
      params.onConfirmedUndispatched?.();
    }
  }
  return {
    ...result,
    ...(terminalTransitionPending ? { terminalTransitionPending: true as const } : {}),
  };
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
  rawContent: string;
  teamId: string;
  senderLabel: string;
  createOpts: AgentInputCreateOpts;
}): AgentInputQueuedMessage {
  const createdAt = new Date().toISOString();
  return {
    clientId: params.clientId,
    text: params.agentMessageText,
    persistedContent: params.persistedContent,
    model: params.createOpts.model,
    effort: params.createOpts.effort ?? '',
    permissionMode: params.createOpts.permissionMode ?? 'bypassPermissions',
    workingDir: params.createOpts.workingDir,
    vendorOptions: params.createOpts.vendorOptions,
    chatMessage: {
      clientId: params.clientId,
      role: 'user',
      content: params.persistedContent,
      createdAt,
    },
    createOpts: params.createOpts,
    origin: {
      kind: 'orca',
      teamId: params.teamId,
      senderLabel: params.senderLabel,
      displayText: params.rawContent,
    },
  };
}
