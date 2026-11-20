import type { AgentInputCoordinatorDeps } from './agent-input-coordinator.js';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { canRecoverUndeliveredOrcaReport } from '../../shared/sharedTaskRecovery.js';
import type { AutoResumeBookkeeping, SuppressedTurnErrorOwner } from './autoResumeBookkeeping.js';
import {
  isContinuationOnlyAutoResumeReason,
  isInterruptedTurnError,
  isUnexpectedWorkerStreamEnd,
  type InterruptedTurnAutoResumeGuard,
  type InterruptedTurnErrorSignals,
} from './interruptedTurnAutoResume.js';
import { BOT_SUBSCRIPTION_STARTUP_ADMISSION_REASON, isBotCandidateUnavailable, isModelGroupConnectionOutOfCredit, canResumeAfterRuntimeFallback, type RuntimeFallbackResult } from './botCandidateRecovery.js';
import { isAccountUsageLimitError } from './usageLimitAutoResume.js';

type Hook<K extends keyof AgentInputCoordinatorDeps> = NonNullable<AgentInputCoordinatorDeps[K]>;

/**
 * What the interrupted-turn auto-resume hooks read and act through (the desktop: register.ts).
 * The coordinator is the one these hooks are handed to, so it is read when a hook runs.
 */
export interface InterruptedTurnAutoResumeHookPorts<RuntimeSession extends object> {
  inputCoordinator: {
    isExecutionPaused(sessionId: string): boolean;
    isAutoResumeAttemptCurrent(sessionId: string, attemptToken: number): boolean;
    autoRetryLastError(sessionId: string, attemptToken: number): Promise<'resumed' | 'superseded' | 'no-progress'>;
  };
  interruptedTurnAutoResumeGuard: Pick<InterruptedTurnAutoResumeGuard, 'onInterruptedTurn' | 'noteResumeSendFailed'>;
  /** Settle a still-current paused retry into history without a banner. Opted into by the Node Host. */
  settlePausedResumeIntoHistory?: boolean;
  autoResumeBookkeeping: Pick<
    AutoResumeBookkeeping,
    | 'takeDeferredError' | 'surfaceSuppressedError' | 'flushSuppressedError' | 'beginAttempt' | 'schedule'
    | 'finalizeSuppressedError' | 'abandonUnconfirmedPersistedResume' | 'surfaceSuppressedErrorForRetry'
  >;
  resumeQuotaWait?(sessionId: string, item: AgentInputQueuedMessage, signals: InterruptedTurnErrorSignals): void;
  botFallbackInputs: { has(createOpts: object): boolean };
  modelGroupInputs?: { has(createOpts: object): boolean };
  workerInputs?: { has(createOpts: object): boolean };
  scheduledQuotaInputs?: { has(createOpts: object): boolean };
  saveTurnStartedAtForDeferred(sessionId: string): void;
  beginSchedulerAutoResume(sessionId: string, runId: string, attemptToken: number, error?: string): void;
  getStableSessionForTurnBoundary(sessionId: string): RuntimeSession | null | undefined;
  pendingContinuationOnlyAutoResumeRebuilds: { set(session: RuntimeSession, attemptToken: number): unknown };
  maybeApplySessionRuntimeFallback(
    sessionId: string,
    episodeAttempt: number,
    attemptToken: number,
    requireRouteChange: boolean,
    isCurrent: () => boolean,
    groupRecovery?: { accountUnavailable: boolean; hasImages: boolean },
  ): Promise<RuntimeFallbackResult<RuntimeSession>>;
  pendingSessionRuntimeFallbackRebuilds: { delete(session: RuntimeSession): unknown };
  providerGroupHeldErrors: { stash(sessionId: string, holdId: number, detail: unknown): void };
  providerGroupHeldTerminals: { stash(sessionId: string, holdId: number, terminal: unknown): void };
  pendingSchedulerAutoResumeRunBySession: {
    get(sessionId: string): { runId: string; attemptToken: number; usageLimitToken?: number; retryClientId?: string } | undefined;
  };
  notifySchedulerAutoResumeFailed(sessionId: string, runId: string, attemptToken?: number): void;
  autoResumeAttemptToken(item: AgentInputQueuedMessage): number | null;
  log: {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * The input coordinator's interrupted-turn auto-resume hooks: when the upstream interrupts a turn
 * that already produced output, continue it for the user once the guard grants an attempt, and
 * surface or flush the held error when no attempt runs. Shared by the desktop and the Node Host.
 */
export function createInterruptedTurnAutoResumeHooks<RuntimeSession extends object>({
  inputCoordinator, interruptedTurnAutoResumeGuard, autoResumeBookkeeping, resumeQuotaWait, botFallbackInputs, modelGroupInputs, scheduledQuotaInputs, workerInputs,
  settlePausedResumeIntoHistory,
  saveTurnStartedAtForDeferred, beginSchedulerAutoResume, getStableSessionForTurnBoundary,
  pendingContinuationOnlyAutoResumeRebuilds, maybeApplySessionRuntimeFallback, pendingSessionRuntimeFallbackRebuilds,
  providerGroupHeldErrors, providerGroupHeldTerminals, pendingSchedulerAutoResumeRunBySession,
  notifySchedulerAutoResumeFailed, autoResumeAttemptToken, log,
}: InterruptedTurnAutoResumeHookPorts<RuntimeSession>) {
  const canRecoverTurn = (signals: InterruptedTurnErrorSignals, item?: AgentInputQueuedMessage | null) =>
    item && scheduledQuotaInputs?.has(item.createOpts) && isAccountUsageLimitError(signals)
      ? false // Same-provider quota waiting owns this run; never enter a cross-route candidate chain.
      : signals.reason === 'scheduler-snapshot-preparation'
      ? item?.origin?.kind === 'scheduler' && !!item.origin.runId
      : signals.reason === 'orca-report-preparation'
      ? !!item?.orcaReportDelivery && item.origin?.kind === 'orca' && canRecoverUndeliveredOrcaReport(signals.message)
      : signals.reason === 'session_event_loop_crashed'
      ? !!item && workerInputs?.has(item.createOpts) === true && isUnexpectedWorkerStreamEnd(signals)
      : isInterruptedTurnError(signals) ||
        (!!item && (botFallbackInputs.has(item.createOpts) || modelGroupInputs?.has(item.createOpts) === true) && isBotCandidateUnavailable(signals));
  const hooks: {
    onResumableTurnErrorDiscarded: Hook<'onResumableTurnErrorDiscarded'>;
    onResumableTurnError: Hook<'onResumableTurnError'>;
    onUnconfirmedAutoResumeTurn: Hook<'onUnconfirmedAutoResumeTurn'>;
  } = {
    onResumableTurnErrorDiscarded: (
      sessionId: string,
      options: { surfaceError: boolean; owner: SuppressedTurnErrorOwner; providerGroupSwitchHoldId?: number },
    ) => {
      if (options.providerGroupSwitchHoldId !== undefined) {
        const deferred = autoResumeBookkeeping.takeDeferredError(sessionId, options.owner);
        if (deferred) {
          providerGroupHeldErrors.stash(sessionId, options.providerGroupSwitchHoldId, deferred.detail);
          if (deferred.orcaTerminal || deferred.groupTerminal) {
            providerGroupHeldTerminals.stash(sessionId, options.providerGroupSwitchHoldId, deferred);
          }
        }
        return;
      }
      if (options.surfaceError) {
        autoResumeBookkeeping.surfaceSuppressedError(sessionId, { deferredOwner: options.owner });
      } else {
        autoResumeBookkeeping.flushSuppressedError(sessionId, { deferredOwner: options.owner });
      }
    },
    onResumableTurnError: (
      sessionId: string,
      signals: InterruptedTurnErrorSignals,
      item: AgentInputQueuedMessage,
    ) => {
      if (!canRecoverTurn(signals, item) || inputCoordinator.isExecutionPaused(sessionId)) return null;
      const modelGroupInput = modelGroupInputs?.has(item.createOpts) === true;
      const configuredInput = modelGroupInput || botFallbackInputs.has(item.createOpts);
      const requireRouteChange = configuredInput && isBotCandidateUnavailable(signals);
      const reportPreparation = signals.reason === 'orca-report-preparation';
      const localPreparation = signals.reason === 'scheduler-snapshot-preparation';
      const startupAdmission = signals.reason === BOT_SUBSCRIPTION_STARTUP_ADMISSION_REASON;
      const sameRouteRetryable = reportPreparation || localPreparation || isInterruptedTurnError(signals);
      const erroredAt = Date.now();
      const decision = interruptedTurnAutoResumeGuard.onInterruptedTurn(sessionId, erroredAt);
      if (decision.action !== 'resume') {
        // 不接管 → coordinator 走常规错误呈现(落 error 行 + 红横幅 + 「继续任务」)。
        // 额度耗尽 / 熔断 / 开关关闭都走这里:自愈救不动了就把方向盘交回用户。
        log.debug('interrupted-turn auto-resume not granted', {
          sessionId,
          action: decision.action,
        });
        return null;
      }
      // 接管:压住这条错误的落库与横幅,只在聊天流里显示低调的自愈提示。
      //
      // **详情的暂存刻意不在这里做**,由 onEvent 里"压住落库"那一刻唯一负责
      // (`autoResumeSuppressesPersist` 分支)。原先两处都 stash 一遍,内容相同、看着无害,
      // 但 stashSuppressedError 现在要在覆盖前把**上一次**中断补落 —— 同一次中断 stash 两遍
      // 就会把正在压制中的自己补落出来,红色错误卡与活动行同时出现。每次中断只 stash 一次
      // 是那条 flush 成立的前提。
      //
      // saveTurnStartedAtForDeferred 与 isRemoteAuthRetry 同款 —— 补落时 turn 开始时刻
      // 已被 resetTurnPersistState 清掉,不先存一份会让 /clear 竞态 cap 判错。
      saveTurnStartedAtForDeferred(sessionId);
      log.info('interrupted-turn auto-resume scheduled', {
        sessionId,
        attempt: decision.attempt,
        maxAttempts: decision.maxAttempts,
        episodeAttempt: decision.episodeAttempt,
        maxEpisodeAttempts: decision.maxEpisodeAttempts,
        sessionTotal: decision.sessionTotal,
        attemptToken: decision.attemptToken,
        delayMs: decision.delayMs,
      });
      autoResumeBookkeeping.beginAttempt(sessionId, decision.attemptToken);
      const schedulerRunId =
        item.origin?.kind === 'scheduler' && typeof item.origin.runId === 'string'
          ? item.origin.runId
          : null;
      if (schedulerRunId) {
        beginSchedulerAutoResume(sessionId, schedulerRunId, decision.attemptToken, signals.message);
      }
      if (isContinuationOnlyAutoResumeReason(signals.reason)) {
        const runtimeSession = getStableSessionForTurnBoundary(sessionId);
        if (runtimeSession) {
          pendingContinuationOnlyAutoResumeRebuilds.set(runtimeSession, decision.attemptToken);
        }
      }
      // 排期的撤旧、补落与令牌都在 AutoResumeBookkeeping.schedule 里(带单测),这里只给
      // 退避时长和到点要干的事。
      autoResumeBookkeeping.schedule(
        sessionId,
        decision.attemptToken,
        decision.delayMs,
        (attempt) => {
          return (async () => {
            let fallbackRebuildSession: RuntimeSession | null = null;
            const isCurrent = () => attempt.isCurrent() && !inputCoordinator.isExecutionPaused(sessionId)
              && (!startupAdmission || inputCoordinator.isAutoResumeAttemptCurrent(sessionId, decision.attemptToken) === true);
            const ownsAttempt = () => attempt.isCurrent()
              && (!startupAdmission || inputCoordinator.isAutoResumeAttemptCurrent(sessionId, decision.attemptToken) === true);
            const mayContinue = settlePausedResumeIntoHistory ? () => {
              if (!ownsAttempt()) return false;
              if (!inputCoordinator.isExecutionPaused(sessionId)) return true;
              interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId, decision.attemptToken);
              autoResumeBookkeeping.finalizeSuppressedError(sessionId, decision.attemptToken, { surfaceBanner: false });
              return false;
            } : isCurrent;
            try {
              // Report retries must enter the original queue checkpoint before any
              // allocation. Runtime fallback can eagerly bootstrap a different route.
              if (!mayContinue()) return;
              const fallback: RuntimeFallbackResult<RuntimeSession> = reportPreparation || localPreparation
                ? { session: null, outcome: 'unchanged' }
                : await maybeApplySessionRuntimeFallback(
                  sessionId,
                  decision.episodeAttempt,
                  decision.attemptToken,
                  requireRouteChange,
                  settlePausedResumeIntoHistory
                    ? () => ownsAttempt() && !inputCoordinator.isExecutionPaused(sessionId)
                    : isCurrent,
                  ...(modelGroupInput ? [{
                    accountUnavailable: isModelGroupConnectionOutOfCredit(signals),
                    hasImages: item.files?.some(file => file.category === 'image') === true,
                  }] as const : []),
                );
              fallbackRebuildSession = fallback.session;
              if (!mayContinue()) return;
              if (!canResumeAfterRuntimeFallback(requireRouteChange, fallback, sameRouteRetryable)) {
                interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId, decision.attemptToken);
                const released = autoResumeBookkeeping.finalizeSuppressedError(sessionId, decision.attemptToken, {
                  surfaceBanner: true,
                });
                if (released && modelGroupInput && fallback.outcome === 'exhausted' && isAccountUsageLimitError(signals)) {
                  resumeQuotaWait?.(sessionId, item, signals);
                }
                return;
              }
              // 退避窗口内用户可能已经自己发了消息 / 清了会话。判据是 coordinator 的 recovery
              // 与**接管态**(enqueue / clearError / teardown 会清掉接管态,recovery 未必),
              // autoRetryLastError 内部复核后会 no-op 并返回非 resumed —— 此时必须回滚
              // pendingResume。
              // A queue-head retry keeps its original input ID and has no
              // replacement turn to release the guard. Retain the attempt budget.
              if (reportPreparation || startupAdmission) interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId, decision.attemptToken);
              const outcome = await inputCoordinator.autoRetryLastError(
                sessionId,
                decision.attemptToken,
              );
              if (!attempt.isCurrent()) {
                log.debug('interrupted-turn auto-resume completion superseded', {
                  sessionId,
                  outcome,
                });
                return;
              }
              if (outcome !== 'resumed') {
                interruptedTurnAutoResumeGuard.noteResumeSendFailed(
                  sessionId,
                  decision.attemptToken,
                );
                // superseded = 用户自己接手了,别再弹横幅打扰(但中断要补进历史);
                // no-progress = 零产出、按设计不自动续跑,这是一次没人接手的真失败,
                // 必须把横幅还给用户,否则被静默吞掉(copilot review)。
                autoResumeBookkeeping.finalizeSuppressedError(sessionId, decision.attemptToken, {
                  surfaceBanner: outcome === 'no-progress',
                });
                log.debug('interrupted-turn auto-resume not dispatched', { sessionId, outcome });
                return;
              }
              // resumed 只表示续跑项已经进队。被压住的错误要等 vendor 真正接受后再丢弃；
              // 派发前被 Stop / clear / ghost block 丢弃时，discard/undispatched 回调会恢复
              // 原 recovery 并把错误回落给用户。
              log.info('interrupted-turn auto-resume queued', { sessionId });
            } catch (err) {
              if (!attempt.isCurrent()) {
                log.debug('interrupted-turn auto-resume rejection superseded', { sessionId });
                return;
              }
              interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId, decision.attemptToken);
              // 补发本身失败 → 回落成常规错误呈现,让用户能手点重试。
              autoResumeBookkeeping.finalizeSuppressedError(sessionId, decision.attemptToken, {
                surfaceBanner: true,
              });
              log.warn('interrupted-turn auto-resume failed', {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            } finally {
              if (fallbackRebuildSession) {
                pendingSessionRuntimeFallbackRebuilds.delete(fallbackRebuildSession);
              }
            }
          })();
        },
      );
      // 回传展示信息:coordinator 存进 autoResumePending → projection → 活动行
      // (「重新连接中 attempt/maxAttempts」+ 展开详情里的原因与会话累计)。
      return {
        ...(signals.message !== undefined ? { error: signals.message } : {}),
        ...(typeof signals.reason === 'string' && signals.reason.length > 0
          ? { reason: signals.reason }
          : {}),
        attempt: decision.attempt,
        maxAttempts: decision.maxAttempts,
        sessionTotal: decision.sessionTotal,
      };
    },
    onUnconfirmedAutoResumeTurn: (sessionId, item) => {
      const pending = pendingSchedulerAutoResumeRunBySession.get(sessionId);
      if (pending?.usageLimitToken !== undefined && pending.retryClientId === item.clientId) {
        // Outcome is uncertain: settle the waiter without restoring/replaying input.
        notifySchedulerAutoResumeFailed(sessionId, pending.runId, pending.attemptToken);
      }
      const attemptToken = autoResumeAttemptToken(item);
      if (attemptToken === null) return;
      autoResumeBookkeeping.abandonUnconfirmedPersistedResume(
        sessionId,
        attemptToken,
        item.clientId,
      );
    },
  };
  return {
    canRecoverTurn,
    ...hooks,
    /** The auto-resume part of onRejectedUserTurn. */
    onRejectedUserTurn: (sessionId: string, item: AgentInputQueuedMessage) => {
      // Auto-resume items have an exact-token cleanup boundary below. Keep
      // their attempt lease until that boundary can restore recovery and
      // finalize the suppressed error; releasing it here would make a later
      // undispatched discard skip finalizeSuppressedError.
      if (item.autoResume) return;
      autoResumeBookkeeping.surfaceSuppressedErrorForRetry(sessionId, item.clientId);
    },
  };
}
