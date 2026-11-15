import type { createMessage as createDbMessageType } from '../localDb/ipc/messages.js';
import { isAutomaticInputOriginKind } from '../../shared/agentInputQueue.js';
import { findLatestAssistantTranscriptUuid } from './latestAssistantTranscriptUuid.js';
import { isAutoResumeUserMessage } from './interruptedTurnAutoResume.js';
import type { AutoResumeBookkeeping } from './autoResumeBookkeeping.js';
import type { InterruptedTurnAutoResumeGuard } from './interruptedTurnAutoResume.js';
import type { SilentStopAutoResumeGuard } from './silentStopAutoResume.js';

type CreateDbMessage = typeof createDbMessageType;
type DurableWriteOwnerScope = NonNullable<Parameters<CreateDbMessage>[2]>['broadcastOwnerScope'];

/**
 * What the user-turn row write reads and writes through (the desktop: register.ts). The guards
 * and the bookkeeping are the caller's single instances; the provider group is read when the
 * row is written, since it is assembled later.
 */
export interface UserMessageDurableWritePorts {
  autoResumeBookkeeping: Pick<AutoResumeBookkeeping, 'registerPendingOutcome' | 'releasePendingOutcome'>;
  silentStopAutoResumeGuard: Pick<SilentStopAutoResumeGuard, 'noteUserSend'>;
  interruptedTurnAutoResumeGuard: Pick<InterruptedTurnAutoResumeGuard, 'noteUserSend'>;
  usageLimitAutoResume: { noteUserAction(sessionId: string): void };
  getProviderGroupService(): { noteUserAction(sessionId: string): void } | null | undefined;
  enqueueDurableWrite<T>(label: string, write: (ownerScope: DurableWriteOwnerScope) => Promise<T>): Promise<T>;
  getLastAssistantTranscriptUuid(sessionId: string): string | undefined;
  getSessionDbAgentKind(sessionId: string): Parameters<CreateDbMessage>[1]['agentKind'] | undefined;
  createDbMessage: CreateDbMessage;
}

/** 持久化 user row 的 agentMeta 归属；不要把它与 AgentEvent 的 runtime token 混用。 */
export function autoResumeAttemptTokenFromAgentMeta(agentMeta: unknown): number | null {
  if (!agentMeta || typeof agentMeta !== 'object') return null;
  const info = (agentMeta as { autoResumeInfo?: unknown }).autoResumeInfo;
  if (!info || typeof info !== 'object') return null;
  const value = (info as { sessionTotal?: unknown }).sessionTotal;
  return typeof value === 'number' ? value : null;
}

/**
 * The one entry that writes the user row of a turn: it charges the auto-resume budgets for a
 * person's message (never for an automatic input or an auto-resume), registers an auto-resume's
 * pending outcome, and writes the row through the durable FIFO with its transcript anchor.
 */
export function createUserMessageDurableWrite({
  autoResumeBookkeeping, silentStopAutoResumeGuard, interruptedTurnAutoResumeGuard, usageLimitAutoResume,
  getProviderGroupService, enqueueDurableWrite, getLastAssistantTranscriptUuid, getSessionDbAgentKind, createDbMessage,
}: UserMessageDurableWritePorts): CreateDbMessage {
  return async (sessionId, message, opts) => {
    // 真实用户消息(renderer 发送事务)→ 给两个自动续跑守卫充值额度。
    //
    // **必须按 agentMeta.autoResume 排除自动补发的消息。** silent-stop 的自动续跑
    // 走 session.send 直发、天然绕开本路径,但**中断自动续跑走的正是本路径**
    // (coordinator 队列 → makerSendTransaction.onAccepted → 这里)。不排除的话它
    // 每次续跑都给自己(和 silent-stop)重新充值,「每条人话最多买 N 个自动 turn」
    // 这条防死循环的硬保证就没了 —— 上游连环抽风时会无限自动续跑。
    if (isAutoResumeUserMessage(message.agentMeta)) {
      // 这条自动续跑消息的结果还不知道,登记待确认(产出→succeeded / 再被打断→failed)。
      const attemptToken = autoResumeAttemptTokenFromAgentMeta(message.agentMeta);
      if (attemptToken !== null) {
        autoResumeBookkeeping.registerPendingOutcome(sessionId, attemptToken, message.clientId);
      }
    } else {
      const origin =
        message.agentMeta && typeof message.agentMeta === 'object'
          ? (message.agentMeta as { origin?: unknown }).origin
          : undefined;
      const originKind =
        origin && typeof origin === 'object' ? (origin as { kind?: unknown }).kind : undefined;
      // Automatic inputs (scheduler / goal / Orca / tool-sent session messages) are not fresh
      // human intervention. They may share the coordinator persistence path with composer
      // messages, but must not recharge the interrupted-turn episode budget and defeat its
      // hard upper bound.
      const isAutomaticPrompt = isAutomaticInputOriginKind(originKind);
      silentStopAutoResumeGuard.noteUserSend(sessionId);
      if (!isAutomaticPrompt) {
        interruptedTurnAutoResumeGuard.noteUserSend(sessionId);
        usageLimitAutoResume.noteUserAction(sessionId);
        getProviderGroupService()?.noteUserAction(sessionId);
      }
    }
    // 落库失败 → 撤掉刚才那条待确认登记:那条消息压根不存在,留着会让后续事件去 patch
    // 一个不存在的 clientId,map 也一直脏着(copilot review)。登记刻意放在写之前(不能
    // 让写完到登记之间的事件漏掉结算),所以这里补一条失败回滚。
    const releasePendingOutcomeOnFailure = () => {
      if (!isAutoResumeUserMessage(message.agentMeta)) return;
      const attemptToken = autoResumeAttemptTokenFromAgentMeta(message.agentMeta);
      if (attemptToken !== null) {
        autoResumeBookkeeping.releasePendingOutcome(sessionId, attemptToken, message.clientId);
      }
    };
    try {
      return await enqueueDurableWrite(`user:${sessionId}:${message.clientId}`, async (ownerScope) => {
        // Coordinator accepts can stamp transcriptParentUuid early; this late FIFO
        // fallback covers makerSendTransaction/direct createDbMessage paths.
        const hasTranscriptParent =
          typeof message.agentMeta?.transcriptParentUuid === 'string' &&
          message.agentMeta.transcriptParentUuid.length > 0;
        // 会话关闭（如远程电脑断线）会清掉内存里的值，重发的第一条消息就没有锚点；
        // 这时从库里补回上一条 assistant 的 uuid。
        const transcriptParentUuid = hasTranscriptParent
          ? undefined
          : getLastAssistantTranscriptUuid(sessionId)
            ?? await Promise.resolve().then(() => findLatestAssistantTranscriptUuid(sessionId)).catch(() => undefined);
        const enrichedMessage =
          transcriptParentUuid && !hasTranscriptParent
            ? { ...message, agentMeta: { ...message.agentMeta, transcriptParentUuid } }
            : message;
        // session-agent-switch:user 行逐行 stamp 当前引擎(见 messages.agent_kind 注释)。
        const agentKind = getSessionDbAgentKind(sessionId);
        const scopedOpts = {
          ...(opts ?? {}),
          // Keep a committed user row durable across an owner switch, while
          // preventing createMessage from relabelling its broadcast to the
          // next owner after the media-ref await.
          broadcastOwnerScope: ownerScope,
        };
        return createDbMessage(
          sessionId,
          agentKind ? { ...enrichedMessage, agentKind } : enrichedMessage,
          scopedOpts,
        );
      });
    } catch (err) {
      releasePendingOutcomeOnFailure();
      throw err;
    }
  };
}
