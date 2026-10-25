import type {
  AgentInputCoordinator,
  AgentInputCoordinatorDeps,
} from "./agent-input-coordinator.js";
import type { AutoResumeBookkeeping } from "./autoResumeBookkeeping.js";
import type { UsageLimitAutoResume } from "./usageLimitAutoResume.js";

/** Original scheduler run ownership; chat recovery remains the sole retry owner. */
export function createSchedulerRecoveryBridge(host: {
  coordinator(): AgentInputCoordinator | null;
  bookkeeping(): AutoResumeBookkeeping;
  usageLimit(): UsageLimitAutoResume;
}) {
  const pendingSchedulerAutoResumeRunBySession = new Map<
    string,
    {
      runId: string;
      attemptToken: number;
      usageLimitToken?: number;
      retryClientId?: string;
    }
  >();
  interface SchedulerRecoveryListener {
    failed(): void;
    quotaWait?: { start(): void; resume(): boolean };
  }
  const schedulerAutoResumeFailureListeners = new Map<
    string,
    Set<SchedulerRecoveryListener>
  >();

  function schedulerAutoResumeRunKey(sessionId: string, runId: string): string {
    return JSON.stringify([sessionId, runId]);
  }

  function beginSchedulerAutoResume(
    sessionId: string,
    runId: string,
    attemptToken: number,
  ): void {
    pendingSchedulerAutoResumeRunBySession.set(sessionId, {
      runId,
      attemptToken,
    });
  }

  function clearSchedulerAutoResumePending(
    sessionId: string,
    runId: string,
    attemptToken?: number,
  ): void {
    const current = pendingSchedulerAutoResumeRunBySession.get(sessionId);
    if (
      current?.runId === runId &&
      (attemptToken === undefined || current.attemptToken === attemptToken)
    ) {
      pendingSchedulerAutoResumeRunBySession.delete(sessionId);
    }
  }

  function notifySchedulerAutoResumeFailed(
    sessionId: string,
    runId: string,
    attemptToken?: number,
  ): void {
    const current = pendingSchedulerAutoResumeRunBySession.get(sessionId);
    if (
      current?.runId !== runId ||
      (attemptToken !== undefined && current.attemptToken !== attemptToken)
    ) {
      return;
    }
    clearSchedulerAutoResumePending(sessionId, runId, attemptToken);
    const listeners = schedulerAutoResumeFailureListeners.get(
      schedulerAutoResumeRunKey(sessionId, runId),
    );
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener.failed();
      } catch {
        // Runner listener failures must not break chat recovery cleanup.
      }
    }
  }

  function failPendingSchedulerAutoResume(
    sessionId: string,
    attemptToken?: number,
  ): void {
    const current = pendingSchedulerAutoResumeRunBySession.get(sessionId);
    if (
      !current ||
      (attemptToken !== undefined && current.attemptToken !== attemptToken)
    )
      return;
    notifySchedulerAutoResumeFailed(sessionId, current.runId, attemptToken);
  }

  /** Quota waits use the same run waiter; no second scheduler timer or replay queue. */
  function finishSchedulerUsageLimitWait(
    sessionId: string,
    token: number,
  ): void {
    const pending = pendingSchedulerAutoResumeRunBySession.get(sessionId);
    if (pending?.usageLimitToken !== token) return;
    notifySchedulerAutoResumeFailed(
      sessionId,
      pending.runId,
      pending.attemptToken,
    );
    host.usageLimit().clear(sessionId);
    host
      .coordinator()
      ?.releaseScheduledUsageLimitRecovery(
        sessionId,
        pending.runId,
        pending.retryClientId,
      );
  }

  function isSchedulerAutoResumePending(
    sessionId: string,
    runId: string,
  ): boolean {
    return (
      pendingSchedulerAutoResumeRunBySession.get(sessionId)?.runId === runId
    );
  }

  function onSchedulerAutoResumeFailed(
    sessionId: string,
    runId: string,
    listener: () => void,
    quotaWait?: SchedulerRecoveryListener["quotaWait"],
  ): () => void {
    const key = schedulerAutoResumeRunKey(sessionId, runId);
    let listeners = schedulerAutoResumeFailureListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      schedulerAutoResumeFailureListeners.set(key, listeners);
    }
    const entry = { failed: listener, quotaWait };
    listeners.add(entry);
    return () => {
      listeners!.delete(entry);
      if (listeners!.size === 0)
        schedulerAutoResumeFailureListeners.delete(key);
    };
  }

  /** Schedule pause/delete：只撤销仍属于该 run 的普通聊天自动续跑。 */
  function cancelSchedulerAutoResume(
    sessionId: string,
    runId: string,
  ): boolean {
    if (!isSchedulerAutoResumePending(sessionId, runId)) return false;
    const pending = pendingSchedulerAutoResumeRunBySession.get(sessionId);
    if (pending?.usageLimitToken !== undefined) {
      finishSchedulerUsageLimitWait(sessionId, pending.usageLimitToken);
      return true;
    }
    // teardown 是既有唯一生命周期出口：撤退避、清 coordinator 接管与隐藏续跑、
    // 结算活动行并通知 runner。runId 校验防止迟到的旧 abort 误杀新 run。
    host.bookkeeping().teardown(sessionId);
    return true;
  }

  function beforeContinue(sessionId: string, token: number) {
    const pending = pendingSchedulerAutoResumeRunBySession.get(sessionId);
    if (pending?.usageLimitToken === token) {
      const listeners = schedulerAutoResumeFailureListeners.get(
        schedulerAutoResumeRunKey(sessionId, pending.runId),
      );
      for (const listener of listeners ?? []) {
        if (listener.quotaWait?.resume() === false) return false;
      }
    }
    return true;
  }
  const onUsageLimitedTurnError = (
    ...[sessionId, signals, item, candidateToken]: Parameters<
      NonNullable<AgentInputCoordinatorDeps["onUsageLimitedTurnError"]>
    >
  ): boolean => {
    if (item.origin?.kind === "scheduler" && item.origin.runId) {
      // Claim synchronously, before the runner consumes this error. Reset-time
      // lookup is async; unknown/unsafe resets release the run but keep Retry.
      pendingSchedulerAutoResumeRunBySession.set(sessionId, {
        runId: item.origin.runId,
        attemptToken: 0,
        usageLimitToken: candidateToken,
      });
      for (const listener of schedulerAutoResumeFailureListeners.get(
        schedulerAutoResumeRunKey(sessionId, item.origin.runId),
      ) ?? []) {
        listener.quotaWait?.start();
      }
      void host
        .usageLimit()
        .onTurnError(sessionId, signals, candidateToken)
        .then((armed) => {
          if (!armed) finishSchedulerUsageLimitWait(sessionId, candidateToken);
        });
      return true;
    }
    return false;
  };
  function onDispatchedUserTurn(
    sessionId: string,
    item: Parameters<
      NonNullable<AgentInputCoordinatorDeps["onDispatchedUserTurn"]>
    >[1],
  ) {
    const quotaClaim = pendingSchedulerAutoResumeRunBySession.get(sessionId);
    if (
      quotaClaim?.usageLimitToken !== undefined &&
      quotaClaim.retryClientId === item.clientId
    ) {
      clearSchedulerAutoResumePending(
        sessionId,
        quotaClaim.runId,
        quotaClaim.attemptToken,
      );
    }
  }
  function onUiRetry(
    sessionId: string,
    clientId: string,
    source: "auto" | "manual",
  ) {
    const quotaClaim = pendingSchedulerAutoResumeRunBySession.get(sessionId);
    if (source === "auto" && quotaClaim?.usageLimitToken !== undefined) {
      quotaClaim.retryClientId = clientId;
    }
  }
  function onUnconfirmedAutoResumeTurn(
    sessionId: string,
    item: Parameters<
      NonNullable<AgentInputCoordinatorDeps["onUnconfirmedAutoResumeTurn"]>
    >[1],
  ) {
    const pending = pendingSchedulerAutoResumeRunBySession.get(sessionId);
    if (
      pending?.usageLimitToken !== undefined &&
      pending.retryClientId === item.clientId
    ) {
      // Outcome is uncertain: settle the waiter without restoring/replaying input.
      notifySchedulerAutoResumeFailed(
        sessionId,
        pending.runId,
        pending.attemptToken,
      );
    }
  }
  function emitProjection(
    projection: Parameters<AgentInputCoordinatorDeps["emitProjection"]>[0],
  ) {
    const quotaClaim = pendingSchedulerAutoResumeRunBySession.get(
      projection.sessionId,
    );
    if (
      quotaClaim?.usageLimitToken !== undefined &&
      !quotaClaim.retryClientId &&
      !host
        .coordinator()
        ?.hasUsageLimitRecovery(
          projection.sessionId,
          quotaClaim.usageLimitToken,
        )
    ) {
      finishSchedulerUsageLimitWait(
        projection.sessionId,
        quotaClaim.usageLimitToken,
      );
    }
  }

  return {
    onUsageLimitedTurnError,
    onDispatchedUserTurn,
    onUiRetry,
    onUnconfirmedAutoResumeTurn,
    emitProjection,
    pendingSchedulerAutoResumeRunBySession,
    schedulerAutoResumeFailureListeners,
    schedulerAutoResumeRunKey,
    beginSchedulerAutoResume,
    clearSchedulerAutoResumePending,
    notifySchedulerAutoResumeFailed,
    failPendingSchedulerAutoResume,
    finishSchedulerUsageLimitWait,
    isSchedulerAutoResumePending,
    onSchedulerAutoResumeFailed,
    cancelSchedulerAutoResume,
    beforeContinue,
  };
}
