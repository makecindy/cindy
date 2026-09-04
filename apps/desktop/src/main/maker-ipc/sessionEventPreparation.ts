import type {
  AgentEvent,
  InteractionDecision,
  InteractionRequest,
  SendOrigin,
  Session,
} from '@cindy/maker-core';

import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';

import type { AgentMeta } from '../../renderer/lib/ccAgent.types';
import { parseAgentInputToolLoopDetails } from '../../shared/agentInputQueue.js';
import { noteSubagentObservationTurnStarted } from '../subagentObservationRewindFence.js';
import { persistSessionFields } from '../localDb/ipc/sessions.js';

import { createLogger } from '../logger.js';
import type { GitSnapshotCoordinator } from '../git-snapshot/gitSnapshotCoordinator.js';
import { markSessionTurnStarted } from '../localDb/sessionActiveTurn.js';
import {
  backgroundTurnPredatesSessionClear,
  noteAgentMeta,
  noteTurnStarted,
} from '../messagePersistBroadcaster.js';
import { isCcMgrUpgradeInFlight } from '../remote-ssh/index.js';
import { AgentInputCoordinator } from './agent-input-coordinator.js';
import { clearPromptPredictionSessionStopped } from './promptPredictionStopLedger.js';
import { MAKER_PUSH } from './channels.js';
import { finalizeTurnChangeSet } from '../turn-change-set/store.js';
import { type OrcaTeamService } from './orcaTeamService.js';
import { getSessionFastMode } from '../maker-host/session-effort-store.js';
import { noteClaudeSessionTurnState } from '../maker-host/claude-session-background-activity.js';
import { consumeClaudeOpusPlanMismatch } from '../maker-host/claude-gateway-error-observer.js';
import {
  isTerminalTurnErrorEvent,
  SessionTurnActivityTracker,
} from './sessionTurnActivityTracker.js';
import { SilentStopTurnLeaseGate } from './sessionTurnLease.js';
import { ProductTurnUsageTargetTracker, ProductTurnWallClockTracker } from './turnWallClock.js';
import { createWorkerTurnStartSequencer } from './workerTurnStartSequencer.js';
import { SilentStopAutoResumeGuard } from './silentStopAutoResume.js';
import { AutoResumeBookkeeping } from './autoResumeBookkeeping.js';
import {
  InterruptedTurnAutoResumeGuard,
  isSubstantiveProgressEvent,
} from './interruptedTurnAutoResume.js';

interface DismissedInteraction {
  kind: InteractionRequest['kind'];
  resolve: (decision: InteractionDecision) => void;
  request: InteractionRequest;
  persistId?: string;
}

export interface PrepareSessionEventDeps {
  readonly isFencedStaleSessionTerminal: (sessionId: string, event: AgentEvent) => boolean;
  readonly log: Pick<ReturnType<typeof createLogger>, 'debug' | 'warn'>;
  readonly interruptedTurnAutoResumeGuard: Pick<
    InterruptedTurnAutoResumeGuard,
    'noteAttemptEvent' | 'noteTurnStarted' | 'noteAttemptSettled' | 'noteProgress'
  >;
  readonly redactEventForRenderer: (event: AgentEvent) => AgentEvent;
  readonly handleAgentIslandInteractionDismissed: (sessionId: string, requestId: string) => void;
  readonly clearPendingInteraction: (requestId: string) => DismissedInteraction | null;
  readonly defaultDecisionForPending: (
    kind: InteractionRequest['kind'],
    reason: string,
  ) => InteractionDecision;
  readonly persistInteractionDecision: (
    sessionId: string,
    persistId: string | undefined,
    kind: InteractionRequest['kind'],
    request: InteractionRequest,
    decision: InteractionDecision | Record<string, unknown>,
  ) => void;
  readonly broadcastToAllWindows: (channel: string, payload: unknown) => void;
  readonly broadcastCodexImageAsToolResult: (sessionId: string, event: AgentEvent) => Promise<void>;
  readonly autoResumeBookkeeping: Pick<
    AutoResumeBookkeeping,
    'discardReplacementProvenByProviderEvent' | 'clearFailedTurnCompletionTail' | 'settleOutcome'
  >;
  readonly pendingFailedTurnAssistantPersistId: Map<string, string>;
  readonly silentStopAutoResumeGuard: Pick<SilentStopAutoResumeGuard, 'noteTurnStarted'>;
  readonly sessionTurnActivityTracker: Pick<
    SessionTurnActivityTracker,
    'isSessionInTurn' | 'setSessionInTurn'
  >;
  readonly productTurnWallClockTracker: Pick<ProductTurnWallClockTracker, 'start' | 'finish'>;
  readonly productTurnUsageTargetTracker: Pick<ProductTurnUsageTargetTracker, 'clear'>;
  readonly advanceSessionTurnBoundaryGeneration: (sessionId: string) => number;
  readonly gitSnapshotCoordinator: Pick<
    GitSnapshotCoordinator,
    'hasPendingTurnStart' | 'onTurnStart'
  > | null;
  readonly workerTurnStartSequencer: Pick<
    ReturnType<typeof createWorkerTurnStartSequencer>,
    'start'
  >;
  readonly orcaTeamServiceForEvents: Pick<OrcaTeamService, 'handleWorkerTurnStarted'> | null;
  readonly turnModelPromiseBySession: Map<string, Promise<string>>;
  readonly readSessionModelForUsage: (sessionId: string) => Promise<string>;
  readonly turnPiFastModeBySession: Map<string, boolean>;
  readonly silentStopTurnLeaseGate: Pick<SilentStopTurnLeaseGate, 'turnLeaseIdForEvent'>;
  readonly agentInputCoordinatorHolder: Pick<
    AgentInputCoordinator,
    'onTurnEvent' | 'noteSuppressedTerminalError'
  > | null;
  readonly handleSilentStopTurnEnd: (
    session: Session,
    doneAt: number,
    turnLeaseId: string,
    turnOrigin?: SendOrigin,
  ) => Promise<void>;
  readonly isRemoteAuthRetryErrorEvent: (
    session: { agentKind?: unknown; remoteHostId?: unknown },
    event: AgentEvent,
  ) => boolean;
  readonly isGatewayProxyTokenRecoveryErrorEvent: (sessionId: string, event: AgentEvent) => boolean;
}

export function prepareSessionEvent(
  deps: PrepareSessionEventDeps,
  session: Session,
  event: AgentEvent,
) {
  // Exact patches are main-owned durable data. They have a dedicated summary push and
  // on-demand detail IPC; forwarding the raw diff through maker:event would duplicate a
  // potentially multi-megabyte payload to every renderer and device-link controller.
  if (event.type === 'turn_diff') return;
  if (
    event.turnScope === 'background' &&
    Object.prototype.hasOwnProperty.call(event, 'backgroundTurnStartedAt') &&
    backgroundTurnPredatesSessionClear(session.id, event.backgroundTurnStartedAt)
  ) {
    return;
  }
  if (deps.isFencedStaleSessionTerminal(session.id, event)) {
    deps.log.debug('ignored stale terminal after leftover turn reclaim', {
      sessionId: session.id,
      eventType: event.type,
      sessionTurnGeneration: event.sessionTurnGeneration ?? null,
      sessionInstanceId: event.sessionInstanceId ?? null,
    });
    return;
  }
  // 自动续跑的 pending 不能只靠 status(isRunning=true) 清理：Pi/Claude 的
  // terminal-only 路径可能首个事件就是 error。Session 已把 host-owned token
  // 盖到事件上，首个匹配 token 的事件即视为 provider accepted。
  if (typeof event.turnAttemptToken === 'number') {
    deps.interruptedTurnAutoResumeGuard.noteAttemptEvent(session.id, event.turnAttemptToken);
  }
  let attributedEvent = event;
  if (event.type === 'error' && isTerminalTurnErrorEvent(event)) {
    const reason =
      !session.remoteHostId && session.agentKind === 'claude-code'
        ? consumeClaudeOpusPlanMismatch(session.id)
        : null;
    if (reason) {
      const eventData =
        event.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : {};
      attributedEvent = { ...event, data: { ...eventData, reason } };
      deps.log.warn('Claude Opus plan error normalized for renderer', {
        sessionId: session.id,
        model: session.model,
        reason,
      });
    }
  }
  const broadcastEvent = deps.redactEventForRenderer(attributedEvent);
  if (event.type === 'interaction_dismissed') {
    const data = event.data as { requestId?: unknown; reason?: unknown };
    if (typeof data.requestId === 'string') {
      deps.handleAgentIslandInteractionDismissed(session.id, data.requestId);
      const entry = deps.clearPendingInteraction(data.requestId);
      if (entry) {
        const decision = deps.defaultDecisionForPending(
          entry.kind,
          typeof data.reason === 'string' ? data.reason : 'dismissed',
        );
        entry.resolve(decision);
        deps.persistInteractionDecision(
          session.id,
          entry.persistId,
          entry.kind,
          entry.request,
          decision,
        );
      }
    }
    deps.broadcastToAllWindows(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: session.id,
      ...(event.data as object),
    });
    return;
  }
  if (event.type === 'image' && event.source === 'codex') {
    void deps.broadcastCodexImageAsToolResult(session.id, event);
    return;
  }
  if (event.type === 'plan_mode_changed') {
    // agent 自行切换计划模式(典型: 计划批准后自动退出)。main 是持久化收口点:
    // 复用 persistSessionFields 回写 sessions.plan_mode_enabled 并广播
    // sessions:patched, 本机窗口与 device-link 控制端镜像同步收敛。
    const data = event.data as { enabled?: unknown };
    if (typeof data?.enabled === 'boolean') {
      void persistSessionFields(session.id, { planModeEnabled: data.enabled }).catch((err) => {
        deps.log.warn('persist plan_mode_changed failed', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return;
  }
  // turn 结束的 status event (isRunning=false + status='Done') 携带 endSnapshot。
  // contextTokens / contextWindow 的持久化统一在 main 端做，避免多 window 竞写；
  // 但不能挡在 EVENT broadcast 前面，否则 final/done 已到 main 后还会被同步 SQLite
  // 和 usage 广播拖住。这里先记录待写快照，广播后再执行。
  // Claude / Codex 同形 (usageTracker.snapshot() 两边都给 contextTokens / contextWindow),
  // 不按 source 分支 —— 之前漏接 codex 导致重启后圆环归零。
  let pendingContextSnapshot: { contextTokens: number; contextWindow: number } | null = null;
  let pendingCodexAccountUsageSnapshot: unknown | null = null;
  let shouldMarkTurnStatusIdleAfterBroadcast = false;
  let shouldMarkTurnTerminalIdleAfterBroadcast = false;
  let completedTurnWallClockMs: number | undefined;
  const isContinuationBoundary = isTurnContinuationBoundaryEvent(event);
  // 探针:continuation 边界命中会跳过 status idle / ended 写 / tracker idle,
  // 若 claim 悬挂会导致 UI 永久「正在生成」。区分「claim 悬挂」与「done 未到达」。
  if (isContinuationBoundary && (event.type === 'done' || event.type === 'status')) {
    deps.log.debug('turn continuation boundary event skipped from turn-finalize', {
      sessionId: session.id,
      eventType: event.type,
      turnContinuationId: event.turnContinuationId,
    });
  }
  if (event.type === 'account_usage' && event.source === 'codex' && !session.remoteHostId) {
    pendingCodexAccountUsageSnapshot = event.data;
  }
  if (event.type === 'status') {
    const data = event.data as {
      isRunning?: boolean;
      status?: string;
      contextTokens?: number;
      contextWindow?: number;
    };
    // Idle compact / late background work may still send isRunning for UI
    // copy. It must not latch the product turn tracker or idle bookkeeping.
    if (data.isRunning === true && event.turnScope !== 'background') {
      // replacement 已进入 vendor 后，running 是新 attempt 的权威起点。不要依赖
      // sendToAgent 返回后的 onDispatched 回调：provider 可同步发事件并先清 activeTurn。
      deps.autoResumeBookkeeping.discardReplacementProvenByProviderEvent(session.id);
      // 新 turn 启动: 上一轮未配对的失败记账交接 id 已无归属, 丢弃防错配。
      deps.pendingFailedTurnAssistantPersistId.delete(session.id);
      // Tokenless status(true) can be a delayed tail of the failed turn.
      // Only a token-bearing running event proves a new attempt started.
      if (typeof event.turnAttemptToken === 'number') {
        deps.autoResumeBookkeeping.clearFailedTurnCompletionTail(session.id);
      }
      // 记录 turn 开始时刻，供 onTurnErrorEvent 判断 error 是否属于 /clear 之前的旧 turn。
      noteTurnStarted(session.id, event.turnAttemptToken);
      noteSubagentObservationTurnStarted(session.id);
      // silent-stop 守卫:新 turn 开始 → 清 pendingResume + 记录时刻(陈旧判定)。
      deps.silentStopAutoResumeGuard.noteTurnStarted(session.id);
      deps.interruptedTurnAutoResumeGuard.noteTurnStarted(session.id, {
        // A tokenless status(true) can be a delayed tail from the failed turn. It
        // must not consume the pending token of the next scheduled auto-resume.
        clearPending: typeof event.turnAttemptToken === 'number',
      });
      const wasInTurn = deps.sessionTurnActivityTracker.isSessionInTurn(session.id);
      if (!wasInTurn && event.source === 'claude-code') {
        const startedProductTurn = deps.productTurnWallClockTracker.start(session.id);
        if (startedProductTurn) deps.productTurnUsageTargetTracker.clear(session.id);
      }
      deps.sessionTurnActivityTracker.setSessionInTurn(session.id, data.isRunning);
      if (!wasInTurn) deps.advanceSessionTurnBoundaryGeneration(session.id);
      // 后台活动检测:turn 开始 → 该会话的 API 流量回归主线,后台横幅熄灭。
      noteClaudeSessionTurnState(session.id, true);
      if (!wasInTurn) {
        if (!deps.gitSnapshotCoordinator?.hasPendingTurnStart(session.id)) {
          void deps.gitSnapshotCoordinator?.onTurnStart(session.id);
        }
        deps.workerTurnStartSequencer.start(session.id, async () => {
          await deps.orcaTeamServiceForEvents?.handleWorkerTurnStarted(session.id);
        });
        // interrupted-turn-resume:记录 turn 启动时刻,与正常收尾时刻配对做
        // 「疑似中断」纯读判定(设计总述见 localDb/sessionActiveTurn.ts 文件头)。
        // SSH remote 会话同样记录:session 行在本地 DB、事件流走本进程,只是
        // agent 跑在远端;device-link 被控会话不进本进程 maker-core,天然不经过。
        clearPromptPredictionSessionStopped(session.id);
        markSessionTurnStarted(session.id);
      }
      if (
        (event.source === 'claude-code' || event.source === 'codex' || event.source === 'pi') &&
        !deps.turnModelPromiseBySession.has(session.id)
      ) {
        deps.turnModelPromiseBySession.set(session.id, deps.readSessionModelForUsage(session.id));
      }
      if (event.source === 'pi' && !deps.turnPiFastModeBySession.has(session.id)) {
        deps.turnPiFastModeBySession.set(session.id, getSessionFastMode(session.id));
      }
    } else if (
      data.isRunning === false &&
      !isContinuationBoundary &&
      event.turnScope !== 'background'
    ) {
      shouldMarkTurnStatusIdleAfterBroadcast = true;
    }
    if (
      data.isRunning === false &&
      data.status === 'Done' &&
      typeof data.contextTokens === 'number'
    ) {
      pendingContextSnapshot = {
        contextTokens: data.contextTokens,
        contextWindow: data.contextWindow ?? 0,
      };
    }
  }
  if (event.type === 'done') {
    const doneAttemptToken = event.turnAttemptToken;
    if (typeof doneAttemptToken === 'number' && !isContinuationBoundary) {
      deps.autoResumeBookkeeping.settleOutcome(session.id, doneAttemptToken, 'failed');
      deps.interruptedTurnAutoResumeGuard.noteAttemptSettled(session.id, doneAttemptToken);
    }
    const rawTurn = (event.data as { raw?: { id?: unknown; status?: unknown } } | null)?.raw;
    const carriesSilentStop =
      (event.data as { silentStop?: boolean } | null | undefined)?.silentStop === true;
    const silentStopTurnLeaseId = carriesSilentStop
      ? deps.silentStopTurnLeaseGate.turnLeaseIdForEvent(event)
      : undefined;
    if (carriesSilentStop && !silentStopTurnLeaseId) {
      deps.log.debug('ignored stale silent-stop terminal from an older turn', {
        sessionId: session.id,
      });
      return;
    }
    const isSilentStopDone = carriesSilentStop;
    if (event.source === 'claude-code' && !isContinuationBoundary && !isSilentStopDone) {
      completedTurnWallClockMs = deps.productTurnWallClockTracker.finish(session.id);
    }
    if (!isContinuationBoundary && !isSilentStopDone) {
      shouldMarkTurnTerminalIdleAfterBroadcast = true;
    }
    if (!isContinuationBoundary && !isSilentStopDone) {
      finalizeTurnChangeSet(
        session.id,
        typeof rawTurn?.id === 'string' ? rawTurn.id : null,
        rawTurn && rawTurn.status !== 'completed' ? 'partial' : 'complete',
      );
    }
    // turn 正常收尾但一路没有实质产出时,上一条重连记录同样不能停在"结果未回填":
    // 成功路径已在产出事件里 settle 成 succeeded(此处 no-op),走到这里就是没产出。
    // silent-stop done:自动续跑会在 1.5s 后启动新 turn(或弹耗尽横幅),
    // 不标 idle/不触发 goal idle/不通知 coordinator done——避免 renderer
    // 在 500ms 完成去抖窗口内显示假完成通知,下一个 turn 开始后又跳回 running。
    if (isContinuationBoundary) {
      // A claimed done only closes the current SDK segment. It must not enter
      // silent-stop recovery or settle the auto-resume attempt; the later
      // unclaimed product terminal owns those side effects.
    } else if (!isSilentStopDone) {
      // 兜底: 有些 vendor 的 done 不必先发 status:isRunning=false。
      // 但 idle 恢复不能挡在 EVENT broadcast 前，否则隐藏窗口可能在 done
      // 还没进入 renderer 时就重新被 Chromium 节流。
      deps.agentInputCoordinatorHolder?.onTurnEvent(session.id, 'done', undefined, undefined, {
        sessionTurnGeneration: event.sessionTurnGeneration,
        sessionInstanceId: event.sessionInstanceId,
      });
    } else {
      // silent-stop 自动续跑:translator 判定本 turn 被上游空内容消息静默收尾时在
      // done.data 附加 silentStop 标记(见 maker-core translator)。延迟一拍再决策,
      // 让本次 turn-end 的落库/收口先走完,也给"用户恰好自己发了消息"留出让位窗口
      //(守卫内部还有 doneAt 陈旧判定,双保险,绝不插队)。
      // 回拨 in-turn 状态:translator 在 done 之前推了 status(isRunning=false),
      // 那条事件已经把 tracker 标成 idle。恢复 in-turn 让 renderer 在 1.5s 决策
      // 窗口内不触发 500ms 完成去抖的假通知。settleSilentStopDone / 新 turn 的
      // noteTurnStarted 会再正确设置最终状态。
      deps.sessionTurnActivityTracker.setSessionInTurn(session.id, true);
      // 后台活动检测:silent-stop 决策窗内逻辑 turn 仍在继续,同步回拨。
      noteClaudeSessionTurnState(session.id, true);
      const silentStopDoneAt = Date.now();
      const silentStopTurnOrigin = event.turnOrigin;
      setTimeout(() => {
        void deps.handleSilentStopTurnEnd(
          session,
          silentStopDoneAt,
          silentStopTurnLeaseId!,
          silentStopTurnOrigin,
        );
      }, 1_500);
    }
  }
  // 提前声明在终止型 error 块与 done/terminal 边界块两处均需使用的持久化条件标志。
  let isPlannedUpgradeClose = false;
  let isRemoteAuthRetry = false;
  let isGatewayProxyTokenRecovery = false;
  if (isTerminalTurnErrorEvent(event)) {
    finalizeTurnChangeSet(session.id, null, 'partial');
    // **任何**终态失败都先把上一条重连记录钉成失败 —— 不管这次错误本身是否值得自愈。
    // 只在"命中白名单、准备再接管"时才 settle 的话,非白名单的终态(认证 / 计费 /
    // invalid-request)会让记录悬空,随后一个无关 turn 的首个产出事件就把它标成
    // 「已重新连接」(codex P1)。
    const failedAttemptToken = event.turnAttemptToken;
    if (typeof failedAttemptToken === 'number') {
      deps.autoResumeBookkeeping.settleOutcome(session.id, failedAttemptToken, 'failed');
      deps.interruptedTurnAutoResumeGuard.noteAttemptSettled(session.id, failedAttemptToken);
    }
    // 终止型 error 可能没有后续 status/done（SDK/event loop crash 等），需要在
    // EVENT broadcast 后结束逻辑 turn，并保留 terminal grace 给 renderer 收尾；
    // 可重试 error 保持 running。
    shouldMarkTurnTerminalIdleAfterBroadcast = true;
    if (event.source === 'claude-code' || event.source === 'codex' || event.source === 'pi') {
      deps.turnModelPromiseBySession.delete(session.id);
      if (event.source === 'pi') deps.turnPiFastModeBySession.delete(session.id);
    }
    const errData =
      attributedEvent.type === 'error'
        ? (attributedEvent.data as
            | {
                message?: unknown;
                reason?: unknown;
                sdkError?: unknown;
                errorStatus?: unknown;
                toolLoop?: unknown;
              }
            | undefined)
        : undefined;
    // Terminal error details cross the coordinator/device-link boundary as untrusted data.
    // Keep only the bounded tool-loop shape; never let a provider-controlled object become
    // live projection state or renderer interpolation.
    const toolLoop = parseAgentInputToolLoopDetails(errData?.toolLoop);
    // 计划内 cc-mgr 升级窗口的 daemon 关闭(reason='remote_daemon_closed')是
    // 预期噪音: renderer 事件路径按同语义静默 banner, 这里同样不给 coordinator
    // 记 error —— 否则 paired-done 保留会让升级后的 projection 复现
    // [REMOTE_DAEMON_CLOSED] banner。范围与 renderer 一致**按 session**(仅
    // banner-clicker):同 host 其它会话的中断照真实失败浮现;窗口外的 daemon
    // 死亡同样不受影响(保留 + 通知)。
    isPlannedUpgradeClose =
      errData?.reason === 'remote_daemon_closed' && isCcMgrUpgradeInFlight(session.id);
    // Legacy CC/XD 远程 auth 错误跳过持久化：renderer 会静默 auto-retry（makerChatStore 在 reducer
    // 前拦截、关闭旧会话、重发消息，不显示 ErrorBanner）；若 main 已落库，retry 成功后
    // 重开会话会看到虚假错误卡。判定与 renderer 的 isAuthError 保持一致，覆盖
    // sdkError === 'authentication_failed' 以及 message 命中 authentication_error /
    // invalid api key / 401 的情形。本地会话（无 remoteHostId）无 auto-retry，不跳过。
    isRemoteAuthRetry = deps.isRemoteAuthRetryErrorEvent(session, event);
    isGatewayProxyTokenRecovery = deps.isGatewayProxyTokenRecoveryErrorEvent(session.id, event);
    if (isPlannedUpgradeClose) {
      deps.agentInputCoordinatorHolder?.noteSuppressedTerminalError(session.id, {
        generation: event.sessionTurnGeneration,
        reason: 'remote_daemon_closed',
        instanceId: event.sessionInstanceId ?? session.instanceId,
      });
    } else {
      deps.agentInputCoordinatorHolder?.onTurnEvent(
        session.id,
        'error',
        typeof broadcastEvent.data === 'object' &&
          broadcastEvent.data !== null &&
          typeof (broadcastEvent.data as { message?: unknown }).message === 'string'
          ? (broadcastEvent.data as { message: string }).message
          : undefined,
        // 结构化信号:自动续跑的判据靠它们收紧(见 isInterruptedTurnError),不靠文本猜。
        {
          ...(typeof errData?.sdkError === 'string' ? { sdkError: errData.sdkError } : {}),
          ...(typeof errData?.reason === 'string' ? { reason: errData.reason } : {}),
          ...(typeof errData?.errorStatus === 'number' ? { errorStatus: errData.errorStatus } : {}),
          ...(toolLoop ? { toolLoop } : {}),
        },
        {
          sessionTurnGeneration: event.sessionTurnGeneration,
          sessionInstanceId: event.sessionInstanceId,
        },
      );
    }
  }
  // F1-a Phase 2: assistant 文本持久化收口 main 单点(根除多窗各落一份的重复)。
  // 在 onEvent 同步路径只做 O(1):为在飞 assistant 分配 / 复用 persistId、累积全文,
  // 把 persistId 盖进广播 payload 让 renderer 在途气泡用同一 id;真正落库走模块内
  // 异步队列、不在此同步执行(规则19 热路径)。终止型 error 同样在广播前预留 persistId
  // (O(1) createId,不 flush、不写库),让 live 横幅与事后 error 行绑定同一 id。
  const eventAgentMeta = (event as { agentMeta?: AgentMeta | null }).agentMeta ?? null;
  // 跟踪会话最近一次非空 agentMeta(镜像 renderer state.lastAgentMeta),给 interaction
  // 边界 flush 当兜底锚点,保 agent_meta 不丢(rewind/fork)。
  if (eventAgentMeta && event.turnScope !== 'background') noteAgentMeta(session.id, eventAgentMeta);

  // tool_result 家族:main 解析出的权威内容,盖进 payload 让 renderer 即时显示
  // (Option C:内容重排状态机只在 main 一份,与落库同源同值)。

  // 中断自愈的额度判据是「是否在推进」:模型产出了实质内容(文本 / 工具调用)就把
  // 连续失败计数归零；人工介入周期的硬总上限不归零，保证始终有限。
  // 刻意只认这两类事件:thinking / status / 空消息都不算产出;guard 侧是 O(1)、
  // 无 IO、无日志,放在热路径安全。
  // 晚到 background 事件仍需广播和持久化,但不能给当前中断回合充值。
  if (event.turnScope !== 'background' && isSubstantiveProgressEvent(event)) {
    const progressAttemptToken = event.turnAttemptToken;
    const accepted = deps.interruptedTurnAutoResumeGuard.noteProgress(
      session.id,
      progressAttemptToken ?? undefined,
    );
    // 同一个信号也是「上一次重连真的成功了」的唯一证据；旧 attempt 的迟到事件
    // token 不匹配时不会结算当前新 attempt。
    if (accepted && typeof progressAttemptToken === 'number') {
      deps.autoResumeBookkeeping.settleOutcome(session.id, progressAttemptToken, 'succeeded');
    }
  }
  return {
    event,
    attributedEvent,
    broadcastEvent,
    eventAgentMeta,
    pendingContextSnapshot,
    pendingCodexAccountUsageSnapshot,
    shouldMarkTurnStatusIdleAfterBroadcast,
    shouldMarkTurnTerminalIdleAfterBroadcast,
    completedTurnWallClockMs,
    isContinuationBoundary,
    isPlannedUpgradeClose,
    isRemoteAuthRetry,
    isGatewayProxyTokenRecovery,
  };
}

export type PreparedSessionEvent = NonNullable<ReturnType<typeof prepareSessionEvent>>;
