import type { AgentEvent, Session } from '@cindy/maker-core';

import type { GitSnapshotCoordinator } from '../git-snapshot/gitSnapshotCoordinator.js';
import { reserveTurnErrorPersistId } from '../messagePersistBroadcaster.js';
import { AgentInputCoordinator } from './agent-input-coordinator.js';
import { MAKER_PUSH } from './channels.js';
import { type OrcaTeamService } from './orcaTeamService.js';
import {
  isContextOverflowErrorData,
  isOversizedHistoryErrorData,
} from './contextOverflowRollover.js';
import { noteClaudeSessionTurnState } from '../maker-host/claude-session-background-activity.js';
import { DeferredCodexRestartService } from './deferredCodexRestart.js';
import {
  isTerminalTurnErrorEvent,
  SessionTurnActivityTracker,
} from './sessionTurnActivityTracker.js';
import type { PreparedSessionEvent } from './sessionEventPreparation.js';
import type { SessionStreamResult } from './sessionEventStream.js';
import { isSessionErrorSuppressed } from './sessionErrorSuppression.js';
export interface DeliverSessionEventDeps {
  readonly orcaTeamServiceForEvents: Pick<OrcaTeamService, 'captureWorkerTerminalTurn'> | null;
  readonly agentInputCoordinatorHolder: Pick<
    AgentInputCoordinator,
    'onExternalTurnSettled' | 'isAutoResumePending' | 'isAutoResumeDeferred'
  > | null;
  readonly overflowSuppressedBroadcasts: Map<
    string,
    { sessionId: string; event: AgentEvent; persistId?: string; resolvedContent?: unknown }
  >;
  readonly broadcastToAllWindows: (channel: string, payload: unknown) => void;
  readonly handleAgentIslandEventAfterBroadcast: (
    session: {
      id: string;
      agentKind?: unknown;
      workDir?: unknown;
      workspaceKind?: unknown;
      remoteHostId?: unknown;
    },
    event: AgentEvent,
  ) => void;
  readonly sessionTurnActivityTracker: Pick<
    SessionTurnActivityTracker,
    'scheduleIdleAfterTerminalBroadcast' | 'scheduleIdleAfterStatusBroadcast'
  >;
  readonly notifyGoalIdleAfterTurnSettled: (sessionId: string) => void;
  readonly settlePendingCredentialSwitch: (sessionId: string, source: string) => void;
  readonly settlePendingSessionRuntimeControlHolder:
    ((sessionId: string, reason: string) => void) | null;
  readonly deferredCodexRestartHolder: Pick<DeferredCodexRestartService, 'onSessionSettled'> | null;
  readonly refreshRemoteCodexMcpOnTurnSettledHolder: ((sessionId: string) => void) | null;
  readonly markTurnEndedAfterPersistDrain: (sessionId: string) => void;
  readonly gitSnapshotCoordinator: Pick<GitSnapshotCoordinator, 'onTurnEnd' | 'onTurnAbort'> | null;
}

export function deliverSessionEvent(
  deps: DeliverSessionEventDeps,
  session: Session,
  prepared: PreparedSessionEvent,
  stream: SessionStreamResult,
) {
  const {
    event,
    attributedEvent,
    broadcastEvent,
    eventAgentMeta,
    shouldMarkTurnStatusIdleAfterBroadcast,
    shouldMarkTurnTerminalIdleAfterBroadcast,
    isContinuationBoundary,
    isPlannedUpgradeClose,
    isRemoteAuthRetry,
    isGatewayProxyTokenRecovery,
  } = prepared;
  let { persistId } = stream;
  const { resolvedContent } = stream;
  // 先 broadcast 保 UI 实时性,再 flush(flush 只入队、不阻塞)。
  // Keep the raw event for main-side coordination/persistence, but only
  // cross renderer/device-link boundaries with the redacted copy.
  // Capture Orca terminal ownership before the tracker wakes queue drain.
  // The replacement input may be accepted while the async persistence and
  // turn-start barriers below yield; that later turn must not inherit this
  // terminal event or lose the lead_interrupt marker before it is observed.
  const workerTerminalCapture =
    !isContinuationBoundary && (event.type === 'done' || isTerminalTurnErrorEvent(event))
      ? deps.orcaTeamServiceForEvents?.captureWorkerTerminalTurn(session.id)
      : undefined;
  // Reserve against the current recovery owner. Terminal persistence reads
  // again after delivery and idle callbacks, which may change that owner.
  const autoResumeWouldSuppressPersist = isSessionErrorSuppressed(
    deps.agentInputCoordinatorHolder,
    session.id,
    event,
  );
  const suppressOverflowBroadcast =
    !session.remoteHostId &&
    event.type === 'error' &&
    isTerminalTurnErrorEvent(event) &&
    (isContextOverflowErrorData(event.data) || isOversizedHistoryErrorData(event.data));
  if (
    event.type === 'error' &&
    isTerminalTurnErrorEvent(event) &&
    !isPlannedUpgradeClose &&
    !isRemoteAuthRetry &&
    !isGatewayProxyTokenRecovery &&
    !autoResumeWouldSuppressPersist &&
    !suppressOverflowBroadcast
  ) {
    persistId = reserveTurnErrorPersistId(
      session.id,
      attributedEvent.data as {
        message?: unknown;
        reason?: unknown;
        sdkError?: unknown;
      } | null,
      eventAgentMeta,
    );
  }
  if (suppressOverflowBroadcast) {
    deps.overflowSuppressedBroadcasts.set(session.id, {
      sessionId: session.id,
      event: broadcastEvent,
      persistId,
      resolvedContent,
    });
  } else {
    deps.broadcastToAllWindows(MAKER_PUSH.EVENT, {
      sessionId: session.id,
      event: broadcastEvent,
      persistId,
      resolvedContent,
    });
    deps.handleAgentIslandEventAfterBroadcast(session, broadcastEvent);
  }
  if (shouldMarkTurnTerminalIdleAfterBroadcast) {
    deps.sessionTurnActivityTracker.scheduleIdleAfterTerminalBroadcast(session.id);
    // #9 idle 兜底:正常 done、终止型 error（含 abort）统一在 tracker 已置 idle 后
    // 唤醒 Goal controller。无 goal / 非 active / 已取消的 deferred Resume 均为 no-op。
    deps.notifyGoalIdleAfterTurnSettled(session.id);
    // 后台活动检测:done / 终止型 error = 逻辑 turn 结束,记录结束时刻。
    // 此后若该会话进程仍有 API 流量(后台子 agent),record 路径会点亮横幅。
    noteClaudeSessionTurnState(session.id, false);
    // turn 收尾打标(last_turn_ended_at)不在此处:done / terminal error 的本 turn
    // 持久化(assistant flush / orphan tool_result / error 行)在下方 flush 块才
    // 入队,统一在那之后走 markTurnEndedAfterPersistDrain(见该 helper 注释)。
    // turn 边界(done / 终止型 error):必须在 tracker 标 idle **之后**再兑现本会话的
    // 延迟凭证切换、唤醒被本会话挡住的等待者 —— vendor 可能不发前置 status:false,
    // 提前唤醒会让 apply/重试读到 isSessionInTurn=true 而空转,退化到 10s 兜底
    // (review P2 2026-07-04)。apply 内部串行 + 幂等,fire-and-forget 安全;
    // planned upgrade close 等场景多唤一次也只是 no-op。
    deps.settlePendingCredentialSwitch(session.id, `event:${event.type}`);
    deps.settlePendingSessionRuntimeControlHolder?.(session.id, `event:${event.type}`);
    deps.deferredCodexRestartHolder?.onSessionSettled();
    deps.agentInputCoordinatorHolder?.onExternalTurnSettled(session.id);
    deps.refreshRemoteCodexMcpOnTurnSettledHolder?.(session.id);
  } else if (shouldMarkTurnStatusIdleAfterBroadcast) {
    deps.sessionTurnActivityTracker.scheduleIdleAfterStatusBroadcast(session.id);
    // status:isRunning=false 即逻辑 turn 结束(可重试 error 不发这个信号)。
    deps.markTurnEndedAfterPersistDrain(session.id);
    noteClaudeSessionTurnState(session.id, false);
  }
  if (event.type === 'done' && !isContinuationBoundary) {
    void deps.gitSnapshotCoordinator?.onTurnEnd(session.id);
  }
  if (isTerminalTurnErrorEvent(event)) {
    deps.gitSnapshotCoordinator?.onTurnAbort(session.id);
  }
  return { persistId, workerTerminalCapture };
}

export type SessionDeliveryResult = ReturnType<typeof deliverSessionEvent>;
