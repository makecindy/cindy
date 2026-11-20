/**
 * The process-wide auto-resume runtime: the silent-stop and interrupted-turn guards, the per-session
 * bookkeeping of a taken-over error, and the settlement of an auto-resume item dropped before it reached
 * the vendor. Moved out of register.ts so the Node Host assembles the same runtime (checkpoint 4);
 * register.ts binds the desktop's side effects as ports. Decision semantics stay in the guard and
 * bookkeeping modules (silentStopAutoResume.ts, interruptedTurnAutoResume.ts, autoResumeBookkeeping.ts).
 */
import {
  USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
  type AgentInputQueuedMessage,
} from '../../shared/agentInputQueue.js';
import { AutoResumeBookkeeping, type AutoResumeBookkeepingDeps } from './autoResumeBookkeeping.js';
import {
  InterruptedTurnAutoResumeGuard,
  type InterruptedTurnAutoResumeGuardDeps,
} from './interruptedTurnAutoResume.js';
import {
  SilentStopAutoResumeGuard,
  type SilentStopAutoResumeGuardDeps,
} from './silentStopAutoResume.js';

export interface AutoResumeRuntimePorts {
  /** silent-stop kill switch, read on every decision (a settings change applies at once). */
  isSilentStopAutoResumeEnabled: () => boolean;
  /** interrupted-turn kill switch, read on every decision. */
  isInterruptedTurnAutoResumeEnabled: () => boolean;
  guardLog: SilentStopAutoResumeGuardDeps['log'] & InterruptedTurnAutoResumeGuardDeps['log'];
  /** The bookkeeping's side effects; rolling back the guard's pending resume is the runtime's own. */
  bookkeeping: Omit<AutoResumeBookkeepingDeps, 'rollbackGuardPendingResume'>;
  /**
   * The input coordinator restores the original recovery of an auto-resume item dropped before dispatch.
   * False when a user action superseded it, the session was cleared, or it already crossed dispatch.
   */
  restoreAutoResumeRecovery: (
    sessionId: string,
    clientId: string,
    attemptToken: number | null,
  ) => boolean;
  /** A dropped usage-limit continuation ends the scheduled run's quota wait it was retrying, if any. */
  finishScheduledUsageLimitWait: (sessionId: string, retryClientId: string) => void;
  /** The continuation after a provider-group switch was not dispatched. */
  settleProviderGroupContinuation: (sessionId: string, dispatched: boolean) => void;
}

export function createAutoResumeRuntime(ports: AutoResumeRuntimePorts) {
  // silent-stop 自动续跑守卫(决策语义与防死循环不变量见 silentStopAutoResume.ts 文件头)。
  // 纯内存、app 级单例:额度按 sessionId 记账,kill switch 每次决策时现读(改配置即生效)。
  const silentStopAutoResumeGuard = new SilentStopAutoResumeGuard({
    isEnabled: ports.isSilentStopAutoResumeEnabled,
    log: ports.guardLog,
  });
  // 中断自动续跑守卫(上游把已有产出的 turn 打断 → 自动替用户点一次「继续」)。
  // 与 silent-stop 那份**额度独立记账**,理由见 interruptedTurnAutoResume.ts 文件头。
  const interruptedTurnAutoResumeGuard = new InterruptedTurnAutoResumeGuard({
    isEnabled: ports.isInterruptedTurnAutoResumeEnabled,
    log: ports.guardLog,
  });

  /**
   * 中断自愈的每会话簿记(压住的错误详情 / 待确认的重连记录 / 退避排期)。
   *
   * 状态与生命周期不变量都在 `autoResumeBookkeeping.ts`(有单测);这里只注入副作用:
   * 落库、结果回填、守卫额度回滚、清 coordinator 接管态。
   */
  const autoResumeBookkeeping = new AutoResumeBookkeeping({
    ...ports.bookkeeping,
    rollbackGuardPendingResume: (sessionId, attemptToken) => {
      if (typeof attemptToken === 'number') {
        interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId, attemptToken);
      }
    },
  });

  function autoResumeAttemptToken(item: AgentInputQueuedMessage): number | null {
    // 额度重置后的续跑不走中断自愈记账,它的 sessionTotal(0)不是令牌。
    if (item.autoResumeInfo?.reason === USAGE_LIMIT_RESET_AUTO_RESUME_REASON) return null;
    const value = item.autoResumeInfo?.sessionTotal;
    return item.autoResume === true && typeof value === 'number' ? value : null;
  }

  function settleUndispatchedAutoResumeOutcome(
    sessionId: string,
    item: AgentInputQueuedMessage,
    attemptToken: number,
  ): boolean {
    // markOutcome 复用 durable-write 队列；持久化中取消时，failed patch 会排在
    // 正在进行的 user row insert 后面，不会出现先 patch、后 insert 的窗口。
    return autoResumeBookkeeping.settleOutcomeForClient(
      sessionId,
      attemptToken,
      item.clientId,
      'failed',
    );
  }

  /**
   * 自动续跑项在 vendor dispatch 前被丢弃：恢复 coordinator 的原 recovery，补落被压住的
   * error，并回滚 guard 的 pendingResume。用户已接手 / clearSession 时 coordinator 会返回
   * false，此时只补历史、不重新弹横幅。
   */
  function settleUndispatchedInterruptedAutoResume(
    sessionId: string,
    item: AgentInputQueuedMessage,
  ): boolean {
    // 额度重置后的自动继续不走中断自愈记账(sessionTotal 刻意为 0),只需恢复原错误与手动重试入口。
    if (
      item.autoResume === true &&
      item.autoResumeInfo?.reason === USAGE_LIMIT_RESET_AUTO_RESUME_REASON
    ) {
      ports.restoreAutoResumeRecovery(sessionId, item.clientId, null);
      ports.finishScheduledUsageLimitWait(sessionId, item.clientId);
      // 供应商组换电脑后的续跑没派出去：协同 Worker 的这次异常终止回报给 Lead。
      ports.settleProviderGroupContinuation(sessionId, false);
      return false;
    }
    const attemptToken = autoResumeAttemptToken(item);
    if (attemptToken === null) return false;
    const ownsAttempt = autoResumeBookkeeping.hasPendingLifecycleForClient(
      sessionId,
      attemptToken,
      item.clientId,
    );
    const restored = ports.restoreAutoResumeRecovery(sessionId, item.clientId, attemptToken);
    settleUndispatchedAutoResumeOutcome(sessionId, item, attemptToken);
    if (!ownsAttempt) return false;
    interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId, attemptToken);
    autoResumeBookkeeping.finalizeSuppressedError(sessionId, attemptToken, {
      surfaceBanner: restored,
    });
    return true;
  }

  return {
    silentStopAutoResumeGuard,
    interruptedTurnAutoResumeGuard,
    autoResumeBookkeeping,
    autoResumeAttemptToken,
    settleUndispatchedInterruptedAutoResume,
  };
}
