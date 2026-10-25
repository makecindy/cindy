import type { Logger, Session } from '@cindy/maker-core';
import type { AgentInputQueuedMessage } from '@cindy/maker-shared/agent-input-queue';
import type { AgentInputCoordinator } from './agent-input-coordinator.js';
import type { InterruptedTurnAutoResumeGuard, InterruptedTurnErrorSignals } from './interruptedTurnAutoResume.js';
import { isAcceptedTurnContinuationOnlyReason } from './interruptedTurnAutoResume.js';
import { isBotCandidateUnavailable, canResumeAfterRuntimeFallback } from './botCandidateRecovery.js';
import type { AutoResumeBookkeeping } from './autoResumeBookkeeping.js';
import type { createSessionRuntimeFallback } from './sessionRuntimeFallback.js';
export function createInterruptedTurnRecovery(host: {
  coordinator(): AgentInputCoordinator;
  canRecoverTurn(signals: InterruptedTurnErrorSignals, item: AgentInputQueuedMessage): boolean;
  botFallbackInputs: WeakSet<object>;
  interruptedTurnAutoResumeGuard: InterruptedTurnAutoResumeGuard;
  saveTurnStartedAtForDeferred(id: string): void;
  log: Logger;
  autoResumeBookkeeping: AutoResumeBookkeeping;
  beginSchedulerAutoResume(id: string, runId: string, token: number): void;
  getStableSessionForTurnBoundary(id: string): Session | null | undefined;
  pendingContinuationOnlyAutoResumeRebuilds: WeakMap<Session, number>;
  maybeApplySessionRuntimeFallback: ReturnType<typeof createSessionRuntimeFallback>;
  pendingSessionRuntimeFallbackRebuilds: WeakMap<Session, number>;
}) {
const { canRecoverTurn, botFallbackInputs, interruptedTurnAutoResumeGuard, saveTurnStartedAtForDeferred, log, autoResumeBookkeeping, beginSchedulerAutoResume, getStableSessionForTurnBoundary, pendingContinuationOnlyAutoResumeRebuilds, maybeApplySessionRuntimeFallback, pendingSessionRuntimeFallbackRebuilds } = host;
return (
      sessionId: string,
      signals: InterruptedTurnErrorSignals,
      item: AgentInputQueuedMessage,
    ) => {
      if (!canRecoverTurn(signals, item) || host.coordinator().isExecutionPaused(sessionId)) return null;
      const requireRouteChange = botFallbackInputs.has(item.createOpts) && isBotCandidateUnavailable(signals);
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
        beginSchedulerAutoResume(sessionId, schedulerRunId, decision.attemptToken);
      }
      if (isAcceptedTurnContinuationOnlyReason(signals.reason)) {
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
            let fallbackRebuildSession: Session | null = null;
            try {
              const fallback = await maybeApplySessionRuntimeFallback(
                sessionId,
                decision.episodeAttempt,
                decision.attemptToken,
                requireRouteChange,
                () => attempt.isCurrent() && !host.coordinator().isExecutionPaused(sessionId),
              );
              fallbackRebuildSession = fallback.session;
              if (!attempt.isCurrent()) return;
              if (!canResumeAfterRuntimeFallback(requireRouteChange, fallback)) {
                interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId, decision.attemptToken);
                autoResumeBookkeeping.finalizeSuppressedError(sessionId, decision.attemptToken, {
                  surfaceBanner: true,
                });
                return;
              }
              // 退避窗口内用户可能已经自己发了消息 / 清了会话。判据是 coordinator 的 recovery
              // 与**接管态**(enqueue / clearError / teardown 会清掉接管态,recovery 未必),
              // autoRetryLastError 内部复核后会 no-op 并返回非 resumed —— 此时必须回滚
              // pendingResume。
              const outcome = await host.coordinator().autoRetryLastError(
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
    };
}
