import type { AgentEvent, Session } from '@cindy/maker-core';

// sidebar-card-mode: turn-done 后刷新列表预览,并按需生成置顶卡片摘要
import {
  maybeGenerateSessionTaskSummary,
  refreshSessionListPreview,
} from '../sessionTaskSummary.js';

import { createLogger } from '../logger.js';
import {
  consumeLastAssistantPersistId,
  consumeLastTopLevelAssistantPersistId,
  drainPersistQueue,
  flushAssistantBlock,
  flushOrphanToolResults,
  isSuccessfulCodexDoneEventData,
  markAssistantTurnCompleted,
  markAssistantTurnFailed,
  clearCodexPlanRowsForSession,
  persistCodexPlanOnDone,
  persistCodexPlanOnTerminalError,
  preserveTurnPersistStateForBackground,
  onTurnErrorEvent,
  releaseReservedTurnErrorPersistId,
  reserveTurnErrorPersistId,
  resetTurnPersistState,
  saveTurnStartedAtForDeferred,
} from '../messagePersistBroadcaster.js';
import { AgentInputCoordinator } from './agent-input-coordinator.js';
import { MAKER_PUSH } from './channels.js';
import { type OrcaTeamService } from './orcaTeamService.js';
import {
  createContextOverflowRollover,
  isContextOverflowErrorData,
  isOversizedHistoryErrorData,
} from './contextOverflowRollover.js';
import { isTerminalTurnErrorEvent } from './sessionTurnActivityTracker.js';
import { ProductTurnUsageTargetTracker } from './turnWallClock.js';
import { createWorkerTurnStartSequencer } from './workerTurnStartSequencer.js';
import { AutoResumeBookkeeping, shouldSkipOrcaWorkerTerminal } from './autoResumeBookkeeping.js';
import { isSuccessfulAssistantReplyDoneData } from '../cindy-brain/assistantReplyHook.js';
import { hasEnabledGhostAssistantHook, runGhostAssistantReplyHook } from '../cindy-brain/index.js';
import { withGhostAssistantHookModel } from '../cindy-brain/subscriptionGateway.js';
import type { PreparedSessionEvent } from './sessionEventPreparation.js';
import type { SessionDeliveryResult } from './sessionEventDelivery.js';
import { isSessionErrorSuppressed } from './sessionErrorSuppression.js';
export interface FinishSessionTerminalEventDeps {
  readonly pendingFailedTurnAssistantPersistId: Map<string, string>;
  readonly autoResumeBookkeeping: Pick<
    AutoResumeBookkeeping,
    | 'noteFailedTurnCompletionTail'
    | 'stashSuppressedError'
    | 'stashOrcaSuppressedTerminal'
    | 'discardReplacementProvenByProviderEvent'
    | 'consumeFailedTurnCompletionTail'
    | 'hasSuppressedError'
  >;
  readonly productTurnUsageTargetTracker: Pick<
    ProductTurnUsageTargetTracker,
    'remember' | 'finish'
  >;
  readonly agentInputCoordinatorHolder: Pick<
    AgentInputCoordinator,
    | 'getAutoResumeAttemptToken'
    | 'getAutoResumeDeferredOwner'
    | 'isAutoResumePending'
    | 'isAutoResumeDeferred'
  > | null;
  readonly contextOverflowRolloverHolder: Pick<
    ReturnType<typeof createContextOverflowRollover>,
    'claim' | 'tryRecover'
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
  readonly log: Pick<ReturnType<typeof createLogger>, 'warn'>;
  readonly markTurnEndedAfterPersistDrain: (sessionId: string) => void;
  readonly turnModelPromiseBySession: Map<string, Promise<string>>;
  readonly workerTurnStartSequencer: Pick<
    ReturnType<typeof createWorkerTurnStartSequencer>,
    'waitForStart'
  >;
  readonly orcaTeamServiceForEvents: Pick<OrcaTeamService, 'handleWorkerTerminalTurn'> | null;
}

export function finishSessionTerminalEvent(
  deps: FinishSessionTerminalEventDeps,
  session: Session,
  prepared: PreparedSessionEvent,
  delivery: SessionDeliveryResult,
) {
  const {
    event,
    attributedEvent,
    eventAgentMeta,
    isContinuationBoundary,
    isPlannedUpgradeClose,
    isRemoteAuthRetry,
    isGatewayProxyTokenRecovery,
  } = prepared;
  const { persistId, workerTerminalCapture } = delivery;
  // done / 终止型 error 持久化边界:把在飞 assistant 落库(与 text isFinal 互斥幂等)。
  // tool_use 边界的 flush 已在上面 broadcast 前做(需先于 tool_use 落库);
  // ask_user / plan_review / permission 不走 onEvent(走 interaction listener),
  // 它们的 flush 在 setInteractionListener 里。
  //
  // 可重试 error 仍属于同一 turn，不能 reset lastAgentMeta / tool_result 配对状态；
  // 否则未来出现 turn 中途的非终止型 error 时会打断后续 tool_result 关联。
  // 本 turn 最后一条 assistant 的 persistId(挂 per-turn 费用 / turn 边界用)。terminal
  // error 同样 consume，写失败 seal 后再按需交接给 paired done；纯 tool 轮为 undefined。
  let turnAssistantPersistId: string | undefined;
  let turnBoundaryAssistantPersistId: string | undefined;
  let isPairedFailedTurnDone = false;
  if (event.type === 'done' || isTerminalTurnErrorEvent(event)) {
    flushAssistantBlock(session.id, eventAgentMeta);
    turnAssistantPersistId = consumeLastAssistantPersistId(session.id);
    turnBoundaryAssistantPersistId = consumeLastTopLevelAssistantPersistId(session.id);
    if (isTerminalTurnErrorEvent(event) && event.type !== 'done') {
      // 失败 turn: 记账发生在稍后的配对 done(usage 在那条事件上), 把这里
      // consume 到的 persistId 交接过去(见 pendingFailedTurnAssistantPersistId)。
      if (turnAssistantPersistId) {
        deps.pendingFailedTurnAssistantPersistId.set(session.id, turnAssistantPersistId);
      }
      // persistId 只覆盖有 assistant 行的失败轮。零输出 / 纯 tool 轮没有 id，
      // 用户接手还会 flush 掉 suppressed entry 并清 pending。这条 tail 活过
      // flush，按失败轮 generation 配对；不同代的 done 不得当成这条尾巴。
      if (!isContinuationBoundary && typeof event.sessionTurnGeneration === 'number') {
        deps.autoResumeBookkeeping.noteFailedTurnCompletionTail(
          session.id,
          event.sessionTurnGeneration,
        );
      }
    } else {
      // done: 优先本事件 consume 的 id, 失败 turn 场景回收交接的 id;
      // 无论用没用到都清掉, 防残留错配下一轮。
      const pendingFailedPersistId = deps.pendingFailedTurnAssistantPersistId.get(session.id);
      if (!turnAssistantPersistId && pendingFailedPersistId) {
        turnAssistantPersistId = pendingFailedPersistId;
        isPairedFailedTurnDone = true;
      }
      deps.pendingFailedTurnAssistantPersistId.delete(session.id);
    }
    if (event.type === 'done' && event.source === 'claude-code') {
      if (isContinuationBoundary) {
        deps.productTurnUsageTargetTracker.remember(session.id, turnAssistantPersistId);
      } else {
        turnAssistantPersistId = deps.productTurnUsageTargetTracker.finish(
          session.id,
          turnAssistantPersistId,
        );
      }
    }
    flushOrphanToolResults(session.id, eventAgentMeta);
    if (turnBoundaryAssistantPersistId) {
      // 在同一 durable FIFO 内先盖 turn seal、再复用 local-db:messages:created 广播
      // 更新后的完整行。失败轮的 paired done 只复用 id 做 usage 记账，不能把
      // terminal error 已写的 false seal 覆盖成 true、让施工播报重新进入标题素材。
      // Codex 的 interrupted / failed 同样以 done 收尾；即使没有配套 error，也必须
      // 写 false，避免历史计划兼容逻辑把用户主动停止的半截计划推成全部完成。
      const isSuccessfulDone =
        event.type === 'done' &&
        (event.source !== 'codex' || isSuccessfulCodexDoneEventData(event.data));
      if (!isSuccessfulDone) {
        void markAssistantTurnFailed(session.id, turnBoundaryAssistantPersistId);
      } else if (!isPairedFailedTurnDone) {
        const nativeForkAnchor = eventAgentMeta?.nativeForkAnchor;
        void markAssistantTurnCompleted(
          session.id,
          turnBoundaryAssistantPersistId,
          nativeForkAnchor ? { nativeForkAnchor } : undefined,
        );
      }
    }
    // error 行在 flushOrphanToolResults 之后入队,保证 orphan tool_result 排在
    // error 行之前(历史时间线:tool 输出 → 错误卡,而非错误卡插到 tool 输出之前)。
    // 自愈接管中 → 压住 error 行:成功续跑时历史里只留一条「已自动继续」分隔条,
    // 救不回来时由 AutoResumeBookkeeping.finalizeSuppressedError 补落。判据取 coordinator 的实时
    // 接管态(而非 host 自己的 map):退避期间用户若自己发了消息,接管态已被清,那之后
    // 新 turn 的失败必须照常落库。
    //
    // 还有一种时序:terminal error 早于用户气泡落库完成到达时,接管决策要推迟到
    // settlePendingTerminalEventAfterPersist 才能做(recovery 留不留得住是前提)。那时
    // error 行早就落库了、压不回去,接管成功后历史里会同时留下错误卡与重连行(codex P1)。
    // 所以决策未定时也一并压住(isAutoResumeDeferred),由 coordinator 在三个「最终没接管」
    // 的出口回调 onResumableTurnErrorDiscarded 让它补落。
    const workerTerminalDoneData = event.data as {
      result?: unknown;
      message?: unknown;
      sdkError?: unknown;
      reason?: unknown;
      error?: { message?: unknown };
    } | null;
    const workerTerminalFinalText =
      typeof workerTerminalDoneData?.result === 'string' && workerTerminalDoneData.result.length > 0
        ? workerTerminalDoneData.result
        : '';
    const workerTerminalDiagnostic = isTerminalTurnErrorEvent(event)
      ? [
          workerTerminalDoneData?.message,
          workerTerminalDoneData?.sdkError,
          workerTerminalDoneData?.reason,
          workerTerminalDoneData?.error?.message,
        ].find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : undefined;
    const autoResumeSuppressesPersist = isSessionErrorSuppressed(
      deps.agentInputCoordinatorHolder,
      session.id,
      event,
    );
    // Only skip handleWorkerTerminalTurn after the Orca payload is actually
    // hanging on the suppressed-error owner. stashOrca 失败必须立刻收口，
    // 否则 worker 会永远停在 running。
    let deferredOrcaWorkerTerminal = false;
    const overflowClaim =
      event.type === 'error' &&
      !session.remoteHostId &&
      isTerminalTurnErrorEvent(event) &&
      !isPlannedUpgradeClose &&
      !isRemoteAuthRetry &&
      !isGatewayProxyTokenRecovery &&
      !autoResumeSuppressesPersist &&
      (isContextOverflowErrorData(attributedEvent.data) ||
        isOversizedHistoryErrorData(attributedEvent.data))
        ? (deps.contextOverflowRolloverHolder?.claim(session.id) ?? 'idle')
        : 'idle';
    if (overflowClaim === 'claimed') {
      const overflowErrorData = attributedEvent.data;
      const surfaceOverflowFailure = (): void => {
        const overflowErrorPayload = overflowErrorData as {
          message?: unknown;
          reason?: unknown;
          sdkError?: unknown;
        } | null;
        const overflowPersistId = reserveTurnErrorPersistId(
          session.id,
          overflowErrorPayload,
          eventAgentMeta,
        );
        const stashed = deps.overflowSuppressedBroadcasts.get(session.id);
        deps.overflowSuppressedBroadcasts.delete(session.id);
        if (stashed) {
          deps.broadcastToAllWindows(MAKER_PUSH.EVENT, {
            ...stashed,
            persistId: overflowPersistId ?? stashed.persistId,
          });
          deps.handleAgentIslandEventAfterBroadcast(session, stashed.event);
        }
        onTurnErrorEvent(session.id, overflowErrorPayload, eventAgentMeta, overflowPersistId);
      };
      void deps.contextOverflowRolloverHolder
        ?.tryRecover(session.id, overflowErrorData)
        .then((recovered) => {
          if (recovered) {
            deps.overflowSuppressedBroadcasts.delete(session.id);
            return;
          }
          surfaceOverflowFailure();
        })
        .catch((error) => {
          deps.log.warn('context overflow rollover rejected', {
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
          surfaceOverflowFailure();
        });
    } else if (overflowClaim === 'in-flight') {
      // 同一 turn 的重复终态 error：继续压住，避免污染历史。
      if (persistId) releaseReservedTurnErrorPersistId(session.id, persistId);
    } else if (
      event.type === 'error' &&
      !isPlannedUpgradeClose &&
      !isRemoteAuthRetry &&
      !isGatewayProxyTokenRecovery &&
      !autoResumeSuppressesPersist
    ) {
      onTurnErrorEvent(
        session.id,
        attributedEvent.data as {
          message?: unknown;
          reason?: unknown;
          sdkError?: unknown;
        } | null,
        eventAgentMeta,
        persistId,
      );
    } else if (persistId) {
      releaseReservedTurnErrorPersistId(session.id, persistId);
    }
    // 压住的错误详情必须在这里存一份:决策推迟场景下 onResumableTurnError 还没被调用过
    // (它自己那份 set 发生在接管成立时),不存就无从补落。同 clientId 内容,覆盖无害。
    if (autoResumeSuppressesPersist) {
      deps.autoResumeBookkeeping.stashSuppressedError(
        session.id,
        attributedEvent.data,
        deps.agentInputCoordinatorHolder?.getAutoResumeAttemptToken(session.id) ?? null,
        deps.agentInputCoordinatorHolder?.getAutoResumeDeferredOwner(session.id) ?? null,
      );
      // Orca terminal 与 error 行共用同一条 owner：L2 不 bridge / 不标 error，
      // L3 surface 时用这份 capture 恰好一次收口。
      if (isTerminalTurnErrorEvent(event)) {
        deferredOrcaWorkerTerminal = deps.autoResumeBookkeeping.stashOrcaSuppressedTerminal(
          session.id,
          {
            status: 'error',
            finalText: workerTerminalFinalText,
            diagnostic: workerTerminalDiagnostic,
            capture: workerTerminalCapture,
          },
        );
      }
    } else if (event.type === 'error' && isTerminalTurnErrorEvent(event)) {
      // replacement 可在 sendToAgent 返回前同步失败并让 coordinator 的 activeTurn
      // 失效；这个新终态已经取代旧中断，按 dispatch phase 直接清旧 owner。
      deps.autoResumeBookkeeping.discardReplacementProvenByProviderEvent(session.id);
    }
    // deferred 路径保存 turn 开始时刻:isRemoteAuthRetry 时 onTurnErrorEvent 被跳过，
    // renderer 会稍后调 persistTurnErrorDeferred IPC。在 resetTurnPersistState 清掉
    // _turnStartedAtBySession 之前保存一份，让 deferred 路径能正确做 /clear 竞态 cap。
    // 自愈压住 error 行时同理:补落发生在 resetTurnPersistState 之后(退避 3–20 秒,
    // 或决策推迟的那一小段),不先存一份会让 /clear 竞态 cap 判错。
    if (
      event.type === 'error' &&
      (isRemoteAuthRetry || isGatewayProxyTokenRecovery || autoResumeSuppressesPersist)
    ) {
      saveTurnStartedAtForDeferred(session.id);
    }
    // turn 收尾打标:本 turn 已知持久化(assistant flush / orphan tool_result /
    // error 行)已全部入队,在此统一定格并等排空后写。done 与 terminal error
    // 同一规则(planned upgrade close / remote auth retry 分支无 error 行,
    // drain 同样无害)。
    // A claim-bearing done seals this SDK segment, but the product turn is
    // still running and may emit another continuation segment. Reset the
    // per-SDK-turn persistence maps while deferring the logical turn marker.
    // 没有 done 的终态 error(Codex 在 terminal error 后显式压掉迟到的
    // turnCompleted,persistCodexPlanOnDone 永远不会跑到):本 turn 的计划行
    // 既没有章也没有 turnCompleted:false,面板会把全勾完的失败计划当旧数据
    // 兜底退场。在这里补失败印记——只盖 turn 存活标记,不动步骤状态。
    if (
      !isContinuationBoundary &&
      event.source === 'codex' &&
      event.type !== 'done' &&
      isTerminalTurnErrorEvent(event)
    ) {
      const errorTurnId =
        typeof (event.data as { raw?: { id?: unknown } } | null | undefined)?.raw?.id === 'string'
          ? ((event.data as { raw?: { id?: unknown } }).raw!.id as string)
          : null;
      persistCodexPlanOnTerminalError(session.id, errorTurnId);
    }
    if (!isContinuationBoundary && event.source === 'codex' && event.type === 'done') {
      // Renderer applies this terminal snapshot immediately. Persist the
      // same state before sealing the persist queue and clearing the
      // turn-owned lookup maps. The drain barrier below must include this
      // write, otherwise app exit can still leave an in-progress plan.
      persistCodexPlanOnDone(
        session.id,
        event.data as
          { plan?: unknown; raw?: { id?: unknown; status?: unknown } } | null | undefined,
      );
    }
    if (!isContinuationBoundary) {
      deps.markTurnEndedAfterPersistDrain(session.id);
      // 逻辑 turn 结束:跨段存活的计划行引用到此回收(continuation boundary
      // 上必须保留,否则最终 done 找不到计划行 → 无章无失败印记 → 胶囊永久
      // 钉住,review P1-1)。
      clearCodexPlanRowsForSession(session.id);
    }
    preserveTurnPersistStateForBackground(session.id);
    resetTurnPersistState(session.id);
    // sidebar-card-mode: 摘要触发挪到本轮 assistant 块 flush 入队之后(原先在
    // done 早段、flush 之前触发,流式轮次会读到上一轮文本)。只在正常 done 触发。
    // codex review:flushAssistantBlock 仅把 assistant insert 入队 writeChain、未落库,
    // latestMessageText 立刻读库可能读到本轮 assistant 写入之前的旧状态;先 await
    // drainPersistQueue() 等持久化队列排空,确立"读在写后"的边界,再起摘要。
    if (event.type === 'done' && !isContinuationBoundary) {
      void (async () => {
        await drainPersistQueue();
        // 列表预览与置顶卡片摘要解耦:无论置顶区是不是卡片、这条有没有置顶,
        // 都要把最近一条可见消息立刻写回 session.preview。摘要生成失败也不能
        // 让侧栏停在进入本轮前的旧句子。
        await refreshSessionListPreview(session.id);
        // force:turn-done 是权威刷新点(本轮 assistant 已落库),必须以最新内容覆盖
        // 任何 pin 触发 / 上一轮残留的摘要——绕过 in-flight 早返与 20s 节流
        // (codex review:pin during running turn 会让卡片停在部分/旧摘要)。
        await maybeGenerateSessionTaskSummary(session.id, { force: true });
      })();
    }
    // will-assistant-message 出口钩子(先定案 → 一拍后替换):仅 done(非终止
    // error)、有真实回复文本 + 已落库的 assistant persistId + 有启用的出口钩子
    // 意识时,派一个独立异步续跑跑裁决并原地更新那条消息(rewrite 换文本 /
    // render 换自绘卡)。同步守卫 hasEnabledGhostAssistantHook 保证无此类意识时
    // 不 schedule —— 与今天行为逐字节一致,零额外开销(规则 10 不碰热路径)。
    if (
      event.type === 'done' &&
      !isContinuationBoundary &&
      !isPairedFailedTurnDone &&
      !isTerminalTurnErrorEvent(event) &&
      isSuccessfulAssistantReplyDoneData(event.data) &&
      turnAssistantPersistId
    ) {
      const doneResult = (event.data as { result?: unknown } | null)?.result;
      const replyText = typeof doneResult === 'string' ? doneResult : '';
      if (replyText.length > 0 && hasEnabledGhostAssistantHook()) {
        const turnModel =
          deps.turnModelPromiseBySession.get(session.id) ??
          Promise.resolve(session.model || 'unknown');
        const assistantPersistId = turnAssistantPersistId;
        withGhostAssistantHookModel(turnModel, () => {
          runGhostAssistantReplyHook(session.id, assistantPersistId, replyText);
        });
      }
    }
    // Worker turn 结束后交给 OrcaTeamService 处理 DB status、广播与 auto-bridge。
    // L2（auto-resume 仍拥有这次失败）不得在这里收口：否则 Lead 会先收到「异常终止」，
    // 而聊天里还在显示自动重试。Codex/Claude 失败轮随后的 unclaimed done 同样不是
    // 产品终态。L3 由 AutoResumeBookkeeping 的 surface 路径补调。
    const isFailedTurnCompletionTail =
      event.type === 'done' &&
      !isContinuationBoundary &&
      deps.autoResumeBookkeeping.consumeFailedTurnCompletionTail(
        session.id,
        event.sessionTurnGeneration,
      );
    if (
      !shouldSkipOrcaWorkerTerminal({
        isContinuationBoundary,
        stashedThisErrorEvent: deferredOrcaWorkerTerminal,
        eventType: event.type,
        isPairedFailedTurnDone,
        isFailedTurnCompletionTail,
        hasSuppressedError: deps.autoResumeBookkeeping.hasSuppressedError(session.id),
        isAutoResumePending:
          deps.agentInputCoordinatorHolder?.isAutoResumePending(session.id) === true,
        isAutoResumeDeferred:
          deps.agentInputCoordinatorHolder?.isAutoResumeDeferred(session.id) === true,
      })
    ) {
      void (async () => {
        try {
          await deps.workerTurnStartSequencer.waitForStart(session.id);
          await deps.orcaTeamServiceForEvents?.handleWorkerTerminalTurn({
            sessionId: session.id,
            status: isTerminalTurnErrorEvent(event) ? 'error' : 'done',
            finalText: workerTerminalFinalText,
            diagnostic: workerTerminalDiagnostic,
            capture: workerTerminalCapture,
          });
        } catch {
          /* non-fatal */
        }
      })();
    }
  }
  return { turnAssistantPersistId };
}
