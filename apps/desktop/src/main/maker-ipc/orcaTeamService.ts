import type { AgentKind } from '@cindy/maker-core';

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { createHostSendFailure } from '../maker-host/send-outcome.js';
import type {
  CollabDispatchFailureOutcome,
  CollabDispatchQueuedOutcome,
  CollabDispatchSuccessOutcome,
} from './collabSendOutcome.js';
import { rebuildQueuedOrcaLeadMessage } from './orcaInterAgentDispatcher.js';

/**
 * OrcaTeamService 只接管已存在 worker 的派活、释放、归档与 auto-bridge。
 * 普通 worker 创建由 OrcaWorkerCreationService 处理；开启协同的 team 生命周期编排由 OrcaLifecycleService 处理。
 * 契约锚点：accepted/rollback 与 terminal auto-bridge 不变量见 docs/dev-rules/orca-team-architecture.md「协同运行时行为契约」。
 */
export type OrcaWorkerStatus = 'idle' | 'running' | 'done' | 'error';
export type OrcaWorkerEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

/** 从 store 读出的 worker 快照；service 不持有 Drizzle row，方便测试和 provider 复用。 */
export interface OrcaWorkerRecordSnapshot {
  id: string;
  teamId: string;
  leadSessionId: string;
  sessionId: string;
  status: OrcaWorkerStatus;
  label: string | null;
  role: string;
  focused: boolean;
  idleSince: string | null;
  session: {
    title: string;
    agentKind: AgentKind;
    model: string;
    effort: string | null;
    permissionMode: string;
    fastMode: boolean;
  };
}

/** worker 与 lead 的最小链接信息，足够完成 resume、broadcast 和 auto-bridge。 */
export interface OrcaWorkerLinkSnapshot {
  workerId: string;
  teamId: string;
  workerSessionId: string;
  leadSessionId: string;
}

/** send_to_worker 对外允许暴露的错误码，内部 host-send code 必须在 service 边界归一。 */
export type SendToWorkerFailureCode =
  | 'NOT_FOUND'
  | 'ARCHIVED'
  | 'DELETED'
  | 'BUSY'
  | 'AGENT_NOT_READY'
  | 'INVALID_ARGS'
  | 'INTERNAL';

/** provider / IPC 共享的 send_to_worker 结果；worker 派活不允许创建新 session。 */
export type SendToWorkerResult =
  | {
      ok: true;
      agentKind: AgentKind;
      wakeKind: 'resumed' | 'already-active' | 'queued';
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
      /** wakeKind='queued' 时回传:排队消息的可寻址句柄,供 lead 后续查看/修改/撤回。 */
      queuedMessageId?: string;
    }
  | {
      ok: false;
      errorCode: SendToWorkerFailureCode;
      message: string;
    };

/** 底层派发只暴露 dispatch/queue 结果；service 根据派发前 live 状态映射 wakeKind。 */
export type DispatchWorkerMessageResult =
  | {
      ok: true;
      mode: 'dispatched' | 'queued';
      /** 底层 dispatcher 为该消息生成的 clientId;queued 模式下即队列内寻址句柄。 */
      clientId: string;
      dispatchOutcome: CollabDispatchSuccessOutcome | CollabDispatchQueuedOutcome;
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
    }
  | {
      ok: false;
      dispatchOutcome: CollabDispatchFailureOutcome;
    };

/** service 内部 worker 派活请求，dispatchMeta 用于保留 MCP/IPC 调用来源和诊断上下文。 */
export interface DispatchWorkerTaskParams {
  targetSessionId: string;
  message: string;
  dispatchMeta: {
    source: string;
    context: string;
  };
}

/** worker 派活的 domain 结果，保留 queued 与 dispatchOutcome 供不同 adapter 自行翻译。 */
export type DispatchWorkerTaskResult =
  | {
      dispatched: true;
      queued?: false;
      dispatchOutcome: CollabDispatchSuccessOutcome;
      agentKind: AgentKind;
      wakeKind: 'resumed' | 'already-active';
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
    }
  | {
      dispatched: false;
      queued: true;
      dispatchOutcome: CollabDispatchQueuedOutcome;
      agentKind: AgentKind;
      wakeKind: 'queued';
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
      /** 排队消息的可寻址句柄(coordinator 队列内的 clientId)。 */
      queuedMessageId: string;
    }
  | {
      dispatched: false;
      queued?: false;
      dispatchOutcome: CollabDispatchFailureOutcome;
    };

/** 简单生命周期操作的 domain result，供 IPC 与 MCP adapter 各自翻译。 */
export type OrcaOkResult = { ok: true; workerId?: string } | { ok: false; errorCode: string; message: string };

/** worker 排队消息控制(list/update/cancel)对外暴露的失败码。 */
export type WorkerQueuedMessageFailureCode =
  | 'WORKER_NOT_FOUND'
  | 'QUEUED_MESSAGE_NOT_FOUND'
  | 'NOT_LEAD_MESSAGE'
  | 'MESSAGE_CONSUMING'
  | 'INVALID_ARGS'
  | 'INTERNAL';

/**
 * worker 队列里单条排队消息的 lead 可见投影。口径是「看得全、只能动自己的」
 * (2026-07-21 产品决策):三种来源的条目都回传正文(lead 条目取
 * origin.displayText 原始正文,用户手打 / scheduler 条目取排队正文),让 lead
 * 能基于完整队列内容做编排决策;但修改 / 撤回仍只对 lead 自己的 orca 条目开放。
 */
export interface WorkerQueuedMessageSnapshot {
  queuedMessageId: string;
  position: number;
  source: 'lead' | 'user' | 'scheduler';
  content: string;
  /** true = 该条正在 steering 投递中,不可修改 / 撤回。 */
  consuming: boolean;
}

/** 排队消息控制的 domain result。 */
export type WorkerQueuedMessageControlResult =
  | { ok: true; workerId: string; queuedMessageId: string }
  | { ok: false; errorCode: WorkerQueuedMessageFailureCode; message: string };

export type ListWorkerQueuedMessagesResult =
  | { ok: true; workerId: string; workerSessionId: string; messages: WorkerQueuedMessageSnapshot[] }
  | { ok: false; errorCode: 'WORKER_NOT_FOUND' | 'INTERNAL'; message: string };

/** worker turn 终止后由 register.ts 的事件 adapter 回调 service。 */
export interface WorkerTerminalTurnParams {
  sessionId: string;
  status: 'done' | 'error';
  finalText: string;
}

/** INPUT_STOP / ABORT_SESSION 记录的手动中断快照，用来让 terminal handler 静默收尾。 */
export interface OrcaManualInterruptSnapshot {
  reason: string;
}

/** service 的 I/O 边界。register.ts 只负责把 DB、Maker、IPC broadcast 作为依赖组合进来。 */
export interface OrcaTeamServiceDeps {
  getWorkerLinkBySessionId(workerSessionId: string): Promise<OrcaWorkerLinkSnapshot | null>;
  getWorkerLinkByWorkerId(workerId: string): Promise<OrcaWorkerLinkSnapshot | null>;
  listWorkersByLead(leadSessionId: string): Promise<OrcaWorkerRecordSnapshot[]>;
  getLiveSession(sessionId: string): { isTurnRunning(): boolean } | null;
  resumeWorkerSession(worker: OrcaWorkerRecordSnapshot, link: OrcaWorkerLinkSnapshot): Promise<void>;
  updateWorkerStatus(workerId: string, status: OrcaWorkerStatus): Promise<void>;
  markWorkerIdle(workerId: string): Promise<void>;
  markWorkerIdleIfStatus(workerId: string, expectedStatus: 'done'): Promise<boolean>;
  restoreWorkerDoneIfIdle(workerId: string): Promise<boolean>;
  /** Stop Host-owned work (for example iOS builds) before archiving this worker task. */
  cancelWorkerSessionOperations(sessionId: string): Promise<void>;
  closeWorkerSession(sessionId: string): Promise<void>;
  /** 与 Session.send reservation 原子互斥；false 表示 direct send/turn 已先取得会话。 */
  closeWorkerSessionIfIdle(sessionId: string): Promise<boolean>;
  /** pending / dispatch-boundary / recovery 输入任一存在时返回 true。 */
  hasPendingWorkerInput(sessionId: string): Promise<boolean>;
  /** send_to_session 的恢复/直发锁覆盖 bootstrap 到 Session.send reservation 的窗口。 */
  hasSendToSessionLock(sessionId: string): boolean;
  archiveWorkerSession(sessionId: string): Promise<void>;
  getManualInterrupt(sessionId: string): OrcaManualInterruptSnapshot | null;
  clearManualInterrupt(sessionId: string): void;
  /** 归档后清理手动中断跟踪，避免 stale mark 影响后续同 id 恢复。 */
  forgetWorkerSession?(sessionId: string): void;
  broadcastOrcaWorkerChanged(leadSessionId: string): void;
  dispatchWorkerMessage(params: {
    targetSessionId: string;
    message: string;
    workerId: string;
    dispatchMeta: {
      source: string;
      context: string;
    };
    onAccepted?: () => void | Promise<void>;
    onAcceptedRollback?: () => void | Promise<void>;
  }): Promise<DispatchWorkerMessageResult>;
  sendAutoBridgeToLead(leadSessionId: string, message: string, workerId: string): Promise<{ accepted: boolean }>;
  /**
   * 读取目标 session 输入队列的当前快照(pendingQueue + steering 中的 clientId)。
   * 实现方(register.ts)须先 ensureQueueRestored 再读,保证崩溃恢复条目可见。
   */
  getSessionQueueSnapshot(sessionId: string): Promise<{
    pendingQueue: AgentInputQueuedMessage[];
    steeringClientIds: string[];
  }>;
  /** 从队列移除一条排队消息;实现方必须走 coordinator.remove(带 discard settle)。返回是否真的移除。 */
  removeQueuedMessage(sessionId: string, clientId: string): boolean;
  /** 整条替换一条排队消息(同 clientId 原位替换);steering / 已派发返回 false。 */
  replaceQueuedMessage(sessionId: string, clientId: string, next: AgentInputQueuedMessage): boolean;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/** Orca worker 生命周期服务。错误以结构化 result 返回，IPC adapter 再转 throwIpcError。 */
export interface OrcaTeamService {
  /** 可信内部路径：只供 lifecycle / host 对已解析 worker 派活，不做外部 caller 校验。 */
  dispatchWorkerTask(params: DispatchWorkerTaskParams): Promise<DispatchWorkerTaskResult>;
  /** 外部调用边界：按 caller lead 校验 worker 可见性。内部可信派活请用 dispatchWorkerTask。 */
  sendToWorker(params: { callerLeadSessionId: string; targetSessionId: string; message: string }): Promise<SendToWorkerResult>;
  /** 外部调用边界：按 caller lead 校验 worker 可见性。 */
  idleWorker(params: { callerLeadSessionId: string; workerId: string; expectedStatus?: 'done' }): Promise<OrcaOkResult>;
  /** 外部调用边界：按 caller lead 校验 worker 可见性。 */
  archiveWorker(params: { callerLeadSessionId: string; workerId: string }): Promise<OrcaOkResult>;
  /** 外部调用边界：列出目标 worker 输入队列中的排队消息(lead 自己的条目含正文)。 */
  listWorkerQueuedMessages(params: {
    callerLeadSessionId: string;
    workerRef: string;
  }): Promise<ListWorkerQueuedMessagesResult>;
  /** 外部调用边界：修改一条尚未派发的 lead 排队消息(整条正文替换,按原派发格式重建)。 */
  updateWorkerQueuedMessage(params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageId: string;
    message: string;
  }): Promise<WorkerQueuedMessageControlResult>;
  /** 外部调用边界：撤回一条尚未派发的 lead 排队消息(经 coordinator remove 结清 accepted 暂存)。 */
  cancelWorkerQueuedMessage(params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageId: string;
  }): Promise<WorkerQueuedMessageControlResult>;
  captureWorkerText(sessionId: string, text: string, opts?: { isFinal?: boolean }): void;
  clearAutoBridgeState(sessionId: string): void;
  handleWorkerTurnStarted(sessionId: string): Promise<void>;
  handleWorkerTerminalTurn(params: WorkerTerminalTurnParams): Promise<void>;
}

/** ready/inFlight/version 共同保证极速 terminal 与重派活不会重复 bridge 或删错状态。 */
interface AutoBridgeState {
  pending: true;
  ready: boolean;
  inFlight: boolean;
  version: number;
  workerId: string;
  leadSessionId: string;
  capturedText: string;
  retryAfterRejectedDelivery: boolean;
  deferred?: {
    status: 'done' | 'error';
    finalText: string;
  };
}

const MAX_CAPTURED_TEXT = 8192;

/**
 * switch_focus 专用的 worker 解析：worker_id / session_id 优先精确匹配，label 兜底。
 * 与 resolveWorkerRef（send/idle/archive 等 mutation 工具，只认 worker_id / session_id）
 * 故意不同——focus 是纯 UI 操作，额外接受人类友好的 label。命中返回该 worker，否则 null。
 */
export function findFocusTargetWorker<
  T extends { id: string; sessionId: string; label: string | null },
>(workers: readonly T[], ref: string): T | null {
  const canonicalLabel = ref.toLowerCase();
  return (
    workers.find((w) => w.id === ref || w.sessionId === ref) ??
    workers.find((w) => w.label?.toLowerCase() === canonicalLabel) ??
    null
  );
}

export function createOrcaTeamService(deps: OrcaTeamServiceDeps): OrcaTeamService {
  const autoBridge = new Map<string, AutoBridgeState>();
  /** Per-worker transition tails serialize dispatch reservations against implicit done acknowledgement. */
  const workerTransitionTails = new Map<string, Promise<void>>();
  /** Active dispatch count stays positive from pre-resume reservation through host dispatch settlement. */
  const activeWorkerDispatches = new Map<string, number>();

  async function withWorkerTransition<T>(workerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = workerTransitionTails.get(workerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    workerTransitionTails.set(workerId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (workerTransitionTails.get(workerId) === current) {
        workerTransitionTails.delete(workerId);
      }
    }
  }

  async function reserveWorkerDispatch(workerId: string): Promise<void> {
    await withWorkerTransition(workerId, async () => {
      activeWorkerDispatches.set(workerId, (activeWorkerDispatches.get(workerId) ?? 0) + 1);
    });
  }

  async function releaseWorkerDispatch(workerId: string): Promise<void> {
    await withWorkerTransition(workerId, async () => {
      const remaining = (activeWorkerDispatches.get(workerId) ?? 1) - 1;
      if (remaining > 0) activeWorkerDispatches.set(workerId, remaining);
      else activeWorkerDispatches.delete(workerId);
    });
  }

  function setPending(sessionId: string, input: { workerId: string; leadSessionId: string }): AutoBridgeState {
    const previous = autoBridge.get(sessionId);
    const state: AutoBridgeState = {
      pending: true,
      ready: false,
      inFlight: false,
      version: (previous?.version ?? 0) + 1,
      workerId: input.workerId,
      leadSessionId: input.leadSessionId,
      capturedText: '',
      retryAfterRejectedDelivery: false,
    };
    autoBridge.set(sessionId, state);
    return state;
  }

  function clearRuntimeState(sessionId: string): void {
    autoBridge.delete(sessionId);
    deps.clearManualInterrupt(sessionId);
  }

  function rollbackPending(
    sessionId: string,
    current: AutoBridgeState,
    previous: AutoBridgeState | undefined,
  ): boolean {
    if (autoBridge.get(sessionId) !== current) return false;
    if (previous) {
      autoBridge.set(sessionId, previous);
    } else {
      autoBridge.delete(sessionId);
    }
    return true;
  }

  async function markPendingReady(sessionId: string, current: AutoBridgeState): Promise<void> {
    if (autoBridge.get(sessionId) !== current) return;
    current.ready = true;
    const deferred = current.deferred;
    current.deferred = undefined;
    if (deferred) {
      await bridgeWorkerCompletion(sessionId, deferred);
    }
  }

  async function bridgeWorkerCompletion(
    sessionId: string,
    turn: { status: 'done' | 'error'; finalText: string },
  ): Promise<'accepted' | 'deferred' | 'rejected' | 'skipped'> {
    const state = autoBridge.get(sessionId);
    if (!state) return 'skipped';
    if (!state.ready) {
      state.deferred = turn;
      return 'deferred';
    }
    if (state.inFlight) return 'skipped';

    state.inFlight = true;
    state.retryAfterRejectedDelivery = false;
    const version = state.version;
    const finalText = turn.finalText || (state.capturedText.trim().length > 0 ? state.capturedText.trim() : '(no output captured)');
    const header = turn.status === 'error'
      ? '[Auto-bridged: worker 异常终止]'
      : '[Auto-bridged: worker 完成但未调 send_to_lead]';
    const bridgeText = `${header}\n\n${finalText}`;
    try {
      const result = await deps.sendAutoBridgeToLead(state.leadSessionId, bridgeText, state.workerId);
      const latest = autoBridge.get(sessionId);
      if (latest !== state || latest.version !== version) return 'skipped';
      if (result.accepted) {
        autoBridge.delete(sessionId);
        return 'accepted';
      }
      latest.inFlight = false;
      latest.retryAfterRejectedDelivery = true;
      return 'rejected';
    } catch (err) {
      const latest = autoBridge.get(sessionId);
      if (latest === state && latest.version === version) {
        latest.inFlight = false;
        latest.retryAfterRejectedDelivery = true;
      }
      deps.log.warn('orca auto-bridge failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return 'rejected';
    }
  }

  function uniqueWorkers(workers: OrcaWorkerRecordSnapshot[]): OrcaWorkerRecordSnapshot[] {
    const byId = new Map<string, OrcaWorkerRecordSnapshot>();
    for (const worker of workers) {
      byId.set(worker.id, worker);
    }
    return [...byId.values()];
  }

  async function resolveWorkerRef(
    callerLeadSessionId: string,
    ref: string,
  ): Promise<{
    ok: true;
    link: OrcaWorkerLinkSnapshot;
    worker: OrcaWorkerRecordSnapshot;
  } | {
    ok: false;
    errorCode: 'NOT_FOUND' | 'INTERNAL';
    message: string;
  }> {
    // worker_id 与 session_id 都当 opaque token 精确匹配，只在 caller 自己的 worker 列表内解析。
    const workers = await deps.listWorkersByLead(callerLeadSessionId);
    const matches = uniqueWorkers([
      ...workers.filter((worker) => worker.id === ref),
      ...workers.filter((worker) => worker.sessionId === ref),
    ]);
    if (matches.length === 0) {
      return { ok: false, errorCode: 'NOT_FOUND', message: `worker ${ref} not found` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        errorCode: 'INTERNAL',
        message: `worker reference ${ref} matched multiple workers`,
      };
    }
    const worker = matches[0]!;
    return {
      ok: true,
      worker,
      link: {
        workerId: worker.id,
        teamId: worker.teamId,
        workerSessionId: worker.sessionId,
        leadSessionId: worker.leadSessionId,
      },
    };
  }

  function workerRefFailureForControl(
    ref: string,
    found: Extract<Awaited<ReturnType<typeof resolveWorkerRef>>, { ok: false }>,
  ): Extract<OrcaOkResult, { ok: false }> {
    if (found.errorCode === 'NOT_FOUND') {
      return { ok: false, errorCode: 'WORKER_NOT_FOUND', message: `worker ${ref} not found` };
    }
    return { ok: false, errorCode: found.errorCode, message: found.message };
  }

  async function rollbackAcceptedDispatchState(params: {
    sessionId: string;
    worker: OrcaWorkerRecordSnapshot;
    previousStatus: OrcaWorkerStatus;
    currentPending: AutoBridgeState | undefined;
    previousPending: AutoBridgeState | undefined;
  }): Promise<void> {
    if (!params.currentPending) return;
    const didRollbackPending = rollbackPending(params.sessionId, params.currentPending, params.previousPending);
    if (!didRollbackPending) return;

    const workers = await deps.listWorkersByLead(params.worker.leadSessionId);
    const currentWorker = workers.find((worker) => worker.id === params.worker.id);
    if (currentWorker?.status !== 'running') return;

    await deps.updateWorkerStatus(params.worker.id, params.previousStatus);
    deps.broadcastOrcaWorkerChanged(params.worker.leadSessionId);
  }

  function dispatchFailureFromThrown(err: unknown, meta: DispatchWorkerTaskParams['dispatchMeta']): CollabDispatchFailureOutcome {
    return {
      ...createHostSendFailure('SEND_FAILED', err instanceof Error ? err.message : String(err)),
      source: meta.source,
      context: meta.context,
    };
  }

  function sendToWorkerFailureFromDispatchOutcome(outcome: CollabDispatchFailureOutcome): Extract<SendToWorkerResult, { ok: false }> {
    if (outcome.kind === 'host-send') {
      const errorCode: SendToWorkerFailureCode = (() => {
        switch (outcome.code) {
          case 'SESSION_NOT_FOUND':
            return 'NOT_FOUND';
          case 'SESSION_RUNNING':
          // 凭证切换等待其它 Codex 会话空闲,同属"等会儿再试"语义。
          case 'CREDENTIAL_SWITCH_BUSY':
            return 'BUSY';
          case 'WORKDIR_MISSING':
          case 'LAZY_CREATE_FAILED':
          case 'REHYDRATE_FAILED':
          case 'HOST_NOT_READY':
          case 'SEND_FAILED':
            return 'AGENT_NOT_READY';
        }
      })();
      return {
        ok: false,
        errorCode,
        message: outcome.message,
      };
    }
    return {
      ok: false,
      errorCode: 'INTERNAL',
      message: outcome.message,
    };
  }

  async function dispatchWorkerTask(params: DispatchWorkerTaskParams): Promise<DispatchWorkerTaskResult> {
    const link = await deps.getWorkerLinkBySessionId(params.targetSessionId);
    if (!link) {
      return {
        dispatched: false,
        dispatchOutcome: {
          ...createHostSendFailure('SESSION_NOT_FOUND', `worker session ${params.targetSessionId} not found in orca_workers`),
          source: params.dispatchMeta.source,
          context: params.dispatchMeta.context,
        },
      };
    }

    const workers = await deps.listWorkersByLead(link.leadSessionId);
    const target = workers.find((worker) => worker.sessionId === params.targetSessionId);
    if (!target) {
      return {
        dispatched: false,
        dispatchOutcome: {
          ...createHostSendFailure('SESSION_NOT_FOUND', `worker session ${params.targetSessionId} not found`),
          source: params.dispatchMeta.source,
          context: params.dispatchMeta.context,
        },
      };
    }

    await reserveWorkerDispatch(target.id);
    try {
      let acceptedSnapshot: {
        previousStatus: OrcaWorkerStatus;
        previousPending: AutoBridgeState | undefined;
      } | undefined;
      let currentPending: AutoBridgeState | undefined;
      const rollbackAccepted = async (): Promise<void> => {
        if (!acceptedSnapshot) return;
        await rollbackAcceptedDispatchState({
          sessionId: params.targetSessionId,
          worker: target,
          previousStatus: acceptedSnapshot.previousStatus,
          currentPending,
          previousPending: acceptedSnapshot.previousPending,
        });
      };

      let result: DispatchWorkerMessageResult;
      const wasLiveBeforeDispatch = deps.getLiveSession(target.sessionId) !== null;
      try {
        // Runtime liveness is independent from the persisted worker status. After a restart a
        // running/error worker can be dormant too, and must rehydrate through the Worker-specific
        // path so its stored permission mode and Orca vendor options are preserved.
        if (!wasLiveBeforeDispatch) {
          await deps.resumeWorkerSession(target, link);
        }
        result = await deps.dispatchWorkerMessage({
          targetSessionId: params.targetSessionId,
          message: params.message,
          workerId: link.workerId,
          dispatchMeta: params.dispatchMeta,
          onAccepted: async () => {
            const currentWorkers = await deps.listWorkersByLead(link.leadSessionId);
            const currentWorker = currentWorkers.find((worker) => worker.id === target.id);
            const previousPending = autoBridge.get(params.targetSessionId);
            acceptedSnapshot = {
              previousStatus: currentWorker?.status ?? target.status,
              previousPending,
            };
            await deps.updateWorkerStatus(target.id, 'running');
            deps.broadcastOrcaWorkerChanged(link.leadSessionId);
            currentPending = setPending(params.targetSessionId, {
              workerId: target.id,
              leadSessionId: link.leadSessionId,
            });
            await markPendingReady(params.targetSessionId, currentPending);
          },
          onAcceptedRollback: rollbackAccepted,
        });
      } catch (err) {
        await rollbackAccepted();
        return {
          dispatched: false,
          dispatchOutcome: dispatchFailureFromThrown(err, params.dispatchMeta),
        };
      }

      if (!result.ok) {
        await rollbackAccepted();
        return {
          dispatched: false,
          dispatchOutcome: result.dispatchOutcome,
        };
      }

      if (result.mode === 'queued') {
        return {
          dispatched: false,
          queued: true,
          dispatchOutcome: result.dispatchOutcome as CollabDispatchQueuedOutcome,
          agentKind: target.session.agentKind,
          wakeKind: 'queued',
          targetTitle: result.targetTitle ?? target.session.title,
          targetLastUserSendAt: result.targetLastUserSendAt,
          queuedMessageId: result.clientId,
        };
      }

      return {
        dispatched: true,
        dispatchOutcome: result.dispatchOutcome as CollabDispatchSuccessOutcome,
        agentKind: target.session.agentKind,
        wakeKind: wasLiveBeforeDispatch ? 'already-active' : 'resumed',
        targetTitle: result.targetTitle ?? target.session.title,
        targetLastUserSendAt: result.targetLastUserSendAt,
      };
    } finally {
      await releaseWorkerDispatch(target.id);
    }
  }

  async function sendToWorker(params: {
    callerLeadSessionId: string;
    targetSessionId: string;
    message: string;
  }): Promise<SendToWorkerResult> {
    const resolved = await resolveWorkerRef(params.callerLeadSessionId, params.targetSessionId);
    if (!resolved.ok) {
      return {
        ok: false,
        errorCode: resolved.errorCode,
        message: resolved.errorCode === 'NOT_FOUND'
          ? `worker session ${params.targetSessionId} not found`
          : resolved.message,
      };
    }
    const callerWorker = resolved.worker;

    const dispatchResult = await dispatchWorkerTask({
      targetSessionId: callerWorker.sessionId,
      message: params.message,
      dispatchMeta: {
        source: 'maker-ipc/collab',
        context: `send_to_worker/${callerWorker.sessionId}/dispatch-worker-message`,
      },
    });

    if (!dispatchResult.dispatched && dispatchResult.queued !== true) {
      return sendToWorkerFailureFromDispatchOutcome(dispatchResult.dispatchOutcome);
    }

    return {
      ok: true,
      agentKind: dispatchResult.agentKind,
      wakeKind: dispatchResult.wakeKind,
      targetTitle: dispatchResult.targetTitle,
      targetLastUserSendAt: dispatchResult.targetLastUserSendAt,
      ...(dispatchResult.queued === true ? { queuedMessageId: dispatchResult.queuedMessageId } : {}),
    };
  }

  async function idleWorker(params: { callerLeadSessionId: string; workerId: string; expectedStatus?: 'done' }): Promise<OrcaOkResult> {
    const found = await resolveWorkerRef(params.callerLeadSessionId, params.workerId);
    if (!found.ok) return workerRefFailureForControl(params.workerId, found);

    const performIdle = async (
      current: Extract<Awaited<ReturnType<typeof resolveWorkerRef>>, { ok: true }>,
    ): Promise<OrcaOkResult> => {
      const { link, worker } = current;
      if (params.expectedStatus && worker.status !== params.expectedStatus) {
        return {
          ok: false,
          errorCode: 'WORKER_STATE_CHANGED',
          message: `worker ${params.workerId} is ${worker.status}, expected ${params.expectedStatus}`,
        };
      }
      if (worker.status === 'idle') {
        return { ok: false, errorCode: 'ALREADY_IDLE', message: `worker ${params.workerId} is already idle` };
      }
      if (params.expectedStatus && deps.getLiveSession(worker.sessionId)?.isTurnRunning()) {
        return {
          ok: false,
          errorCode: 'WORKER_STATE_CHANGED',
          message: `worker ${params.workerId} has an active turn`,
        };
      }
      if (params.expectedStatus && deps.hasSendToSessionLock(worker.sessionId)) {
        return {
          ok: false,
          errorCode: 'WORKER_STATE_CHANGED',
          message: `worker ${params.workerId} has a send in progress`,
        };
      }
      if (params.expectedStatus && await deps.hasPendingWorkerInput(worker.sessionId)) {
        return {
          ok: false,
          errorCode: 'WORKER_STATE_CHANGED',
          message: `worker ${params.workerId} has queued input`,
        };
      }

      const didIdle = params.expectedStatus
        ? await deps.markWorkerIdleIfStatus(worker.id, params.expectedStatus)
        : (await deps.markWorkerIdle(worker.id), true);
      if (!didIdle) {
        return {
          ok: false,
          errorCode: 'WORKER_STATE_CHANGED',
          message: `worker ${params.workerId} is no longer ${params.expectedStatus}`,
        };
      }
      const rollbackDoneAcknowledgement = async (): Promise<void> => {
        await deps.restoreWorkerDoneIfIdle(worker.id);
        deps.broadcastOrcaWorkerChanged(link.leadSessionId);
      };
      // Queue state can change while the DB CAS awaits I/O. Preserve newly queued
      // follow-ups before close, then use Session.closeIfIdle for atomic send/close ordering.
      if (params.expectedStatus && await deps.hasPendingWorkerInput(worker.sessionId)) {
        await rollbackDoneAcknowledgement();
        return {
          ok: false,
          errorCode: 'WORKER_STATE_CHANGED',
          message: `worker ${params.workerId} has queued input`,
        };
      }
      if (params.expectedStatus) {
        const didClose = await closeWorkerSessionIfIdleBestEffort(worker.sessionId, 'idleWorker');
        if (!didClose) {
          await rollbackDoneAcknowledgement();
          return {
            ok: false,
            errorCode: 'WORKER_STATE_CHANGED',
            message: `worker ${params.workerId} has an active turn`,
          };
        }
      }
      clearRuntimeState(worker.sessionId);
      if (!params.expectedStatus) {
        await closeWorkerSessionBestEffort(worker.sessionId, 'idleWorker');
      }
      deps.broadcastOrcaWorkerChanged(link.leadSessionId);
      return { ok: true, workerId: worker.id };
    };

    if (!params.expectedStatus) return performIdle(found);

    return withWorkerTransition(found.worker.id, async () => {
      if ((activeWorkerDispatches.get(found.worker.id) ?? 0) > 0) {
        return {
          ok: false,
          errorCode: 'WORKER_STATE_CHANGED',
          message: `worker ${params.workerId} has a dispatch in progress`,
        };
      }
      const current = await resolveWorkerRef(params.callerLeadSessionId, params.workerId);
      if (!current.ok) return workerRefFailureForControl(params.workerId, current);
      return performIdle(current);
    });
  }

  async function archiveWorker(params: { callerLeadSessionId: string; workerId: string }): Promise<OrcaOkResult> {
    const found = await resolveWorkerRef(params.callerLeadSessionId, params.workerId);
    if (!found.ok) return workerRefFailureForControl(params.workerId, found);
    const { link, worker } = found;

    clearRuntimeState(worker.sessionId);
    deps.forgetWorkerSession?.(worker.sessionId);
    await deps.cancelWorkerSessionOperations(worker.sessionId);
    await closeWorkerSessionBestEffort(worker.sessionId, 'archiveWorker');
    await deps.archiveWorkerSession(worker.sessionId);
    // The archived status is the admission barrier for new Host work. Cancel
    // once more after publishing it to catch a build that registered between
    // the pre-close cancellation and the status transition.
    await deps.cancelWorkerSessionOperations(worker.sessionId);
    await deps.updateWorkerStatus(worker.id, 'done');
    deps.broadcastOrcaWorkerChanged(link.leadSessionId);
    return { ok: true, workerId: worker.id };
  }

  /** 排队消息 source 判定:worker 队列里 orca 条目只可能来自其 lead(通信拓扑为 Lead↔Worker)。 */
  function queuedMessageSource(item: AgentInputQueuedMessage): WorkerQueuedMessageSnapshot['source'] {
    if (item.origin?.kind === 'orca') return 'lead';
    if (item.origin?.kind === 'scheduler') return 'scheduler';
    return 'user';
  }

  /**
   * update / cancel 共用的目标定位与权限校验:worker 归属(resolveWorkerRef)→
   * 条目存在 → 必须是 lead 自己的 orca 条目(用户 / scheduler 排队消息绝不可动)→
   * 未进入 steering 投递。全部通过才返回条目与 link。
   */
  async function resolveLeadQueuedMessage(params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageId: string;
  }): Promise<
    | { ok: true; link: OrcaWorkerLinkSnapshot; entry: AgentInputQueuedMessage }
    | { ok: false; errorCode: WorkerQueuedMessageFailureCode; message: string }
  > {
    const found = await resolveWorkerRef(params.callerLeadSessionId, params.workerRef);
    if (!found.ok) {
      return found.errorCode === 'NOT_FOUND'
        ? { ok: false, errorCode: 'WORKER_NOT_FOUND', message: `worker ${params.workerRef} not found` }
        : { ok: false, errorCode: 'INTERNAL', message: found.message };
    }
    const snapshot = await deps.getSessionQueueSnapshot(found.worker.sessionId);
    const entry = snapshot.pendingQueue.find((item) => item.clientId === params.queuedMessageId);
    if (!entry) {
      return {
        ok: false,
        errorCode: 'QUEUED_MESSAGE_NOT_FOUND',
        message: `queued message ${params.queuedMessageId} not found — it may have been dispatched or cancelled already`,
      };
    }
    if (entry.origin?.kind !== 'orca') {
      return {
        ok: false,
        errorCode: 'NOT_LEAD_MESSAGE',
        message: `queued message ${params.queuedMessageId} was not sent by the lead; user/scheduler queued messages cannot be modified`,
      };
    }
    if (snapshot.steeringClientIds.includes(entry.clientId)) {
      return {
        ok: false,
        errorCode: 'MESSAGE_CONSUMING',
        message: `queued message ${params.queuedMessageId} is being delivered and can no longer be modified`,
      };
    }
    return { ok: true, link: found.link, entry };
  }

  async function listWorkerQueuedMessages(params: {
    callerLeadSessionId: string;
    workerRef: string;
  }): Promise<ListWorkerQueuedMessagesResult> {
    const found = await resolveWorkerRef(params.callerLeadSessionId, params.workerRef);
    if (!found.ok) {
      return found.errorCode === 'NOT_FOUND'
        ? { ok: false, errorCode: 'WORKER_NOT_FOUND', message: `worker ${params.workerRef} not found` }
        : { ok: false, errorCode: 'INTERNAL', message: found.message };
    }
    const snapshot = await deps.getSessionQueueSnapshot(found.worker.sessionId);
    const messages = snapshot.pendingQueue.map((item, index): WorkerQueuedMessageSnapshot => {
      const source = queuedMessageSource(item);
      // lead 条目回原始正文(displayText 缺失时回退带派发头的 text,可读性够诊断用);
      // 用户 / scheduler 条目回排队正文 —— 内容全可见,可操作性仍由 NOT_LEAD_MESSAGE 把关。
      const content = item.origin?.kind === 'orca'
        ? item.origin.displayText ?? item.text
        : item.text;
      return {
        queuedMessageId: item.clientId,
        position: index,
        source,
        content,
        consuming: snapshot.steeringClientIds.includes(item.clientId),
      };
    });
    return {
      ok: true,
      workerId: found.worker.id,
      workerSessionId: found.worker.sessionId,
      messages,
    };
  }

  async function updateWorkerQueuedMessage(params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageId: string;
    message: string;
  }): Promise<WorkerQueuedMessageControlResult> {
    if (params.message.trim().length === 0) {
      return { ok: false, errorCode: 'INVALID_ARGS', message: 'message must not be empty' };
    }
    const resolved = await resolveLeadQueuedMessage(params);
    if (!resolved.ok) return resolved;
    const next = rebuildQueuedOrcaLeadMessage(resolved.entry, params.message, resolved.link.workerId);
    const replaced = deps.replaceQueuedMessage(
      resolved.link.workerSessionId,
      params.queuedMessageId,
      next,
    );
    if (!replaced) {
      // resolve 与 replace 之间的窄竞态:条目刚被 drain 取走 / steering 挡住。
      return {
        ok: false,
        errorCode: 'QUEUED_MESSAGE_NOT_FOUND',
        message: `queued message ${params.queuedMessageId} was consumed before the update could apply`,
      };
    }
    deps.log.info('orca lead updated queued worker message', {
      workerId: resolved.link.workerId,
      workerSessionId: resolved.link.workerSessionId,
      queuedMessageId: params.queuedMessageId,
    });
    return { ok: true, workerId: resolved.link.workerId, queuedMessageId: params.queuedMessageId };
  }

  async function cancelWorkerQueuedMessage(params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageId: string;
  }): Promise<WorkerQueuedMessageControlResult> {
    const resolved = await resolveLeadQueuedMessage(params);
    if (!resolved.ok) return resolved;
    // coordinator.remove 内部触发 onDiscardedQueuedMessage → dispatcher 丢弃该
    // clientId 的 accepted 暂存回调,与 Stop 清队列共用同一条 settle 路径
    // (架构文档「queued accepted 也要同样结算」不变量);queued 未 accepted,
    // 无运行副作用需要回滚。
    const removed = deps.removeQueuedMessage(resolved.link.workerSessionId, params.queuedMessageId);
    if (!removed) {
      return {
        ok: false,
        errorCode: 'QUEUED_MESSAGE_NOT_FOUND',
        message: `queued message ${params.queuedMessageId} was consumed before the cancel could apply`,
      };
    }
    deps.log.info('orca lead cancelled queued worker message', {
      workerId: resolved.link.workerId,
      workerSessionId: resolved.link.workerSessionId,
      queuedMessageId: params.queuedMessageId,
    });
    return { ok: true, workerId: resolved.link.workerId, queuedMessageId: params.queuedMessageId };
  }

  async function closeWorkerSessionBestEffort(sessionId: string, owner: string): Promise<void> {
    try {
      await deps.closeWorkerSession(sessionId);
    } catch (err) {
      deps.log.warn(`${owner}: close worker session failed`, {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function closeWorkerSessionIfIdleBestEffort(sessionId: string, owner: string): Promise<boolean> {
    try {
      return await deps.closeWorkerSessionIfIdle(sessionId);
    } catch (err) {
      deps.log.warn(`${owner}: close idle worker session failed`, {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  return {
    dispatchWorkerTask,
    sendToWorker,
    idleWorker,
    archiveWorker,
    listWorkerQueuedMessages,
    updateWorkerQueuedMessage,
    cancelWorkerQueuedMessage,
    captureWorkerText(sessionId, text, opts) {
      const state = autoBridge.get(sessionId);
      if (!state || text.length === 0) return;
      state.capturedText = opts?.isFinal === true
        ? text.slice(-MAX_CAPTURED_TEXT)
        : (state.capturedText + text).slice(-MAX_CAPTURED_TEXT);
    },
    clearAutoBridgeState(sessionId) {
      clearRuntimeState(sessionId);
    },
    async handleWorkerTurnStarted(sessionId) {
      const link = await deps.getWorkerLinkBySessionId(sessionId);
      if (!link) return;

      const workers = await deps.listWorkersByLead(link.leadSessionId);
      const worker = workers.find((item) => item.id === link.workerId);
      if (!worker || worker.status === 'running') return;

      await deps.updateWorkerStatus(link.workerId, 'running');
      deps.broadcastOrcaWorkerChanged(link.leadSessionId);
    },
    async handleWorkerTerminalTurn(params) {
      const link = await deps.getWorkerLinkBySessionId(params.sessionId);
      if (!link) return;

      const workers = await deps.listWorkersByLead(link.leadSessionId);
      const worker = workers.find((item) => item.id === link.workerId);
      if (!worker) {
        clearRuntimeState(params.sessionId);
        return;
      }

      const state = autoBridge.get(params.sessionId);
      if (worker.status === 'done' || worker.status === 'error' || worker.status === 'idle') {
        if (state?.retryAfterRejectedDelivery === true) {
          await bridgeWorkerCompletion(params.sessionId, {
            status: params.status,
            finalText: params.finalText,
          });
          return;
        }
        clearRuntimeState(params.sessionId);
        return;
      }

      const manualInterrupt = deps.getManualInterrupt(params.sessionId);
      if (manualInterrupt) {
        await deps.markWorkerIdle(link.workerId);
        deps.broadcastOrcaWorkerChanged(link.leadSessionId);
        clearRuntimeState(params.sessionId);
        deps.log.info('worker manual interrupt: suppressed auto-bridge', {
          workerId: link.workerId,
          leadSessionId: link.leadSessionId,
          sessionId: params.sessionId,
          reason: manualInterrupt.reason,
          status: params.status,
        });
        return;
      }

      await deps.updateWorkerStatus(link.workerId, params.status);
      deps.broadcastOrcaWorkerChanged(link.leadSessionId);
      await bridgeWorkerCompletion(params.sessionId, {
        status: params.status,
        finalText: params.finalText,
      });
    },
  };
}
