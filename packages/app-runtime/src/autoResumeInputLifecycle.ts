import type { AgentInputQueuedMessage } from "@cindy/maker-shared/agent-input-queue";
import { isAutomaticInputOriginKind } from "@cindy/maker-shared/agent-input-queue";
import type { AgentInputCoordinator } from "./agent-input-coordinator.js";
import type { AutoResumeBookkeeping } from "./autoResumeBookkeeping.js";
import {
  isAutoResumeUserMessage,
  type InterruptedTurnAutoResumeGuard,
} from "./interruptedTurnAutoResume.js";
import { USAGE_LIMIT_RESET_AUTO_RESUME_REASON } from "@cindy/maker-shared/agent-input-queue";
import type { createSchedulerRecoveryBridge } from "./schedulerRecoveryBridge.js";

/** Original ownership and budget accounting around the durable user-row boundary. */
export function createAutoResumeInputLifecycle(host: {
  bookkeeping(): AutoResumeBookkeeping;
  interrupted(): InterruptedTurnAutoResumeGuard;
  coordinator(): AgentInputCoordinator | null;
  scheduler: ReturnType<typeof createSchedulerRecoveryBridge>;
  noteSilentStopUserSend(id: string): void;
  noteUsageLimitUserAction(id: string): void;
  noteProviderGroupUserAction?(id: string): void;
  settleProviderGroupContinuation?(id: string, dispatched: boolean): void;
}) {
  function autoResumeAttemptToken(
    item: AgentInputQueuedMessage,
  ): number | null {
    // 额度重置后的续跑不走中断自愈记账,它的 sessionTotal(0)不是令牌。
    if (item.autoResumeInfo?.reason === USAGE_LIMIT_RESET_AUTO_RESUME_REASON)
      return null;
    const value = item.autoResumeInfo?.sessionTotal;
    return item.autoResume === true && typeof value === "number" ? value : null;
  }

  /** 持久化 user row 的 agentMeta 归属；不要把它与 AgentEvent 的 runtime token 混用。 */
  function autoResumeAttemptTokenFromAgentMeta(
    agentMeta: unknown,
  ): number | null {
    if (!agentMeta || typeof agentMeta !== "object") return null;
    const info = (agentMeta as { autoResumeInfo?: unknown }).autoResumeInfo;
    if (!info || typeof info !== "object") return null;
    const value = (info as { sessionTotal?: unknown }).sessionTotal;
    return typeof value === "number" ? value : null;
  }

  function settleUndispatchedAutoResumeOutcome(
    sessionId: string,
    item: AgentInputQueuedMessage,
    attemptToken: number,
  ): boolean {
    // markOutcome 复用 durable-write 队列；持久化中取消时，failed patch 会排在
    // 正在进行的 user row insert 后面，不会出现先 patch、后 insert 的窗口。
    return host
      .bookkeeping()
      .settleOutcomeForClient(sessionId, attemptToken, item.clientId, "failed");
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
      host
        .coordinator()
        ?.restoreAutoResumeRecovery(sessionId, item.clientId, null);
      const pending =
        host.scheduler.pendingSchedulerAutoResumeRunBySession.get(sessionId);
      if (
        pending?.usageLimitToken !== undefined &&
        pending.retryClientId === item.clientId
      ) {
        host.scheduler.finishSchedulerUsageLimitWait(
          sessionId,
          pending.usageLimitToken,
        );
      }
      // 供应商组换电脑后的续跑没派出去：协同 Worker 的这次异常终止回报给 Lead。
      host.settleProviderGroupContinuation?.(sessionId, false);
      return false;
    }
    const attemptToken = autoResumeAttemptToken(item);
    if (attemptToken === null) return false;
    const ownsAttempt = host
      .bookkeeping()
      .hasPendingLifecycleForClient(sessionId, attemptToken, item.clientId);
    const restored =
      host
        .coordinator()
        ?.restoreAutoResumeRecovery(sessionId, item.clientId, attemptToken) ===
      true;
    settleUndispatchedAutoResumeOutcome(sessionId, item, attemptToken);
    if (!ownsAttempt) return false;
    host.interrupted().noteResumeSendFailed(sessionId, attemptToken);
    host.bookkeeping().finalizeSuppressedError(sessionId, attemptToken, {
      surfaceBanner: restored,
    });
    return true;
  }

  function beforePersist(
    sessionId: string,
    message: { clientId?: string; agentMeta?: unknown },
  ): () => void {
    // 真实用户消息(renderer 发送事务)→ 给两个自动续跑守卫充值额度。
    //
    // **必须按 agentMeta.autoResume 排除自动补发的消息。** silent-stop 的自动续跑
    // 走 session.send 直发、天然绕开本路径,但**中断自动续跑走的正是本路径**
    // (coordinator 队列 → makerSendTransaction.onAccepted → 这里)。不排除的话它
    // 每次续跑都给自己(和 silent-stop)重新充值,「每条人话最多买 N 个自动 turn」
    // 这条防死循环的硬保证就没了 —— 上游连环抽风时会无限自动续跑。
    if (isAutoResumeUserMessage(message.agentMeta)) {
      // 这条自动续跑消息的结果还不知道,登记待确认(产出→succeeded / 再被打断→failed)。
      const attemptToken = autoResumeAttemptTokenFromAgentMeta(
        message.agentMeta,
      );
      if (attemptToken !== null) {
        host
          .bookkeeping()
          .registerPendingOutcome(sessionId, attemptToken, message.clientId);
      }
    } else {
      const origin =
        message.agentMeta && typeof message.agentMeta === "object"
          ? (message.agentMeta as { origin?: unknown }).origin
          : undefined;
      const originKind =
        origin && typeof origin === "object"
          ? (origin as { kind?: unknown }).kind
          : undefined;
      // Automatic inputs (scheduler / goal / Orca / tool-sent session messages) are not fresh
      // human intervention. They may share the coordinator persistence path with composer
      // messages, but must not recharge the interrupted-turn episode budget and defeat its
      // hard upper bound.
      const isAutomaticPrompt = isAutomaticInputOriginKind(originKind);
      host.noteSilentStopUserSend(sessionId);
      if (!isAutomaticPrompt) {
        host.interrupted().noteUserSend(sessionId);
        host.noteUsageLimitUserAction(sessionId);
        host.noteProviderGroupUserAction?.(sessionId);
      }
    }
    // 落库失败 → 撤掉刚才那条待确认登记:那条消息压根不存在,留着会让后续事件去 patch
    // 一个不存在的 clientId,map 也一直脏着(copilot review)。登记刻意放在写之前(不能
    // 让写完到登记之间的事件漏掉结算),所以这里补一条失败回滚。
    const releasePendingOutcomeOnFailure = () => {
      if (!isAutoResumeUserMessage(message.agentMeta)) return;
      const attemptToken = autoResumeAttemptTokenFromAgentMeta(
        message.agentMeta,
      );
      if (attemptToken !== null) {
        host
          .bookkeeping()
          .releasePendingOutcome(sessionId, attemptToken, message.clientId);
      }
    };
    return releasePendingOutcomeOnFailure;
  }
  function dispatched(
    sessionId: string,
    item: AgentInputQueuedMessage,
  ): { attemptToken: number | null; discarded: boolean } {
    host.scheduler.onDispatchedUserTurn(sessionId, item);
    const token = autoResumeAttemptToken(item);
    const discarded =
      token !== null &&
      host.bookkeeping().discardSuppressedError(sessionId, token);
    if (
      item.autoResume &&
      item.origin?.kind === "scheduler" &&
      typeof item.origin.runId === "string" &&
      token !== null
    )
      host.scheduler.clearSchedulerAutoResumePending(
        sessionId,
        item.origin.runId,
        token,
      );
    return { attemptToken: token, discarded };
  }
  function retry(
    sessionId: string,
    clientId: string,
    source: "manual" | "auto",
    token?: number,
  ): void {
    host.scheduler.onUiRetry(sessionId, clientId, source);
    host
      .bookkeeping()
      .claimSuppressedErrorForRetry(sessionId, clientId, source);
    if (source === "auto" && token !== undefined)
      host
        .bookkeeping()
        .bindSuppressedErrorToClient(sessionId, token, clientId);
  }
  function unconfirmed(sessionId: string, item: AgentInputQueuedMessage): void {
    host.scheduler.onUnconfirmedAutoResumeTurn(sessionId, item);
    const token = autoResumeAttemptToken(item);
    if (token !== null)
      host
        .bookkeeping()
        .abandonUnconfirmedPersistedResume(sessionId, token, item.clientId);
  }
  return {
    beforePersist,
    dispatched,
    retry,
    unconfirmed,
    autoResumeAttemptToken,
    autoResumeAttemptTokenFromAgentMeta,
    settleUndispatchedInterruptedAutoResume,
  };
}
