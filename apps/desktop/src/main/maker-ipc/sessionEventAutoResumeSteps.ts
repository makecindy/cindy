import type { AgentEvent } from '@cindy/maker-core';
import { syncBackgroundCommandWork, type BackgroundCommandWorkSession } from '../maker-host/claude-background-command-work-sync.js';
import { noteClaudeSessionTurnState } from '../maker-host/claude-session-background-activity.js';
import { isSubstantiveProgressEvent } from './interruptedTurnAutoResume.js';
import type { PrepareSessionEventDeps } from './sessionEventPreparation.js';

/**
 * The auto-resume bookkeeping and Claude background-activity steps of the session event
 * pipeline (sessionEventPreparation.ts, sessionEventDelivery.ts), shared with the Node Host's
 * event handling. Each is the pipeline's own lines; the pipeline calls them in place.
 */
type AutoResumeStepDeps = Pick<
  PrepareSessionEventDeps,
  | 'autoResumeBookkeeping'
  | 'pendingFailedTurnAssistantPersistId'
  | 'silentStopAutoResumeGuard'
  | 'interruptedTurnAutoResumeGuard'
  | 'usageLimitAutoResume'
>;

/** A running status of the foreground turn (not idle compaction or late background work). */
export function isForegroundRunningStatus<T extends { isRunning?: boolean }>(
  data: T,
  event: AgentEvent,
): data is T & { isRunning: true } {
  return data.isRunning === true && event.turnScope !== 'background';
}

/** A not-running status that ends the foreground turn (not a continuation boundary). */
export function endsForegroundTurnByStatus(
  data: { isRunning?: boolean },
  isContinuationBoundary: boolean,
  event: AgentEvent,
): boolean {
  return (
    data.isRunning === false &&
    !isContinuationBoundary &&
    event.turnScope !== 'background'
  );
}

/** A foreground running status starts a new attempt. */
export function noteForegroundTurnStarted(
  deps: AutoResumeStepDeps,
  session: { id: string },
  event: AgentEvent,
  { noteTurnStarted, noteSubagentObservationTurnStarted }: {
    noteTurnStarted(sessionId: string, turnAttemptToken: number | undefined): void;
    noteSubagentObservationTurnStarted(sessionId: string): void;
  },
): void {
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
}

/** A done that is not a continuation boundary settles its attempt as failed (no progress reached it). */
export function settleAutoResumeAttemptOnDone(
  deps: AutoResumeStepDeps,
  session: { id: string },
  event: AgentEvent,
  isContinuationBoundary: boolean,
): void {
  const doneAttemptToken = event.turnAttemptToken;
  if (typeof doneAttemptToken === 'number' && !isContinuationBoundary) {
    deps.autoResumeBookkeeping.settleOutcome(session.id, doneAttemptToken, 'failed');
    deps.interruptedTurnAutoResumeGuard.noteAttemptSettled(session.id, doneAttemptToken);
  }
}

/** A terminal error settles its attempt as failed. */
export function settleAutoResumeAttemptOnTerminalError(
  deps: AutoResumeStepDeps,
  session: { id: string },
  event: AgentEvent,
): void {
  // **任何**终态失败都先把上一条重连记录钉成失败 —— 不管这次错误本身是否值得自愈。
  // 只在"命中白名单、准备再接管"时才 settle 的话,非白名单的终态(认证 / 计费 /
  // invalid-request)会让记录悬空,随后一个无关 turn 的首个产出事件就把它标成
  // 「已重新连接」(codex P1)。
  const failedAttemptToken = event.turnAttemptToken;
  if (typeof failedAttemptToken === 'number') {
    deps.autoResumeBookkeeping.settleOutcome(session.id, failedAttemptToken, 'failed');
    deps.interruptedTurnAutoResumeGuard.noteAttemptSettled(session.id, failedAttemptToken);
  }
}

/** Substantive foreground output resets the consecutive-failure count and settles the attempt as succeeded. */
export function noteAutoResumeProgress(
  deps: AutoResumeStepDeps,
  session: { id: string },
  event: AgentEvent,
): void {
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
    deps.usageLimitAutoResume?.noteProgress(session.id);
  }
}

/** Background-activity detection: the logical turn ended; refresh the background command work. */
export function noteBackgroundActivityTurnEnded(session: BackgroundCommandWorkSession): void {
  syncBackgroundCommandWork(session);
  noteClaudeSessionTurnState(session.id, false);
}
