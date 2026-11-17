import { randomUUID } from 'node:crypto';
import type { Maker, SendOrigin } from '@cindy/maker-core';
import type { createMessage as createDbMessageType } from '../localDb/ipc/messages.js';
import { toDesktopSessionDispatchOutcome } from '../maker-host/send-outcome.js';
import type { AgentInputCoordinator } from './agent-input-coordinator.js';
import { bindSilentStopContinuationGeneration } from './silentStopContinuationBinding.js';
import { SILENT_STOP_RESUME_PROMPT, type SilentStopAutoResumeGuard } from './silentStopAutoResume.js';
import type { SilentStopTurnLeaseGate } from './sessionTurnLease.js';
import type { SessionListActivityTracker } from './sessionTurnActivityTracker.js';
import type { ProductTurnWallClockTracker } from './turnWallClock.js';
import type { SilentStopFailureCause } from './silentStopFailure.js';

type SilentStopSession = NonNullable<ReturnType<Maker['getSession']>>;

/** What settling a silent-stop turn end reads and acts through (the desktop: register.ts). */
export interface SilentStopTurnEndPorts {
  silentStopTurnLeaseGate: Pick<SilentStopTurnLeaseGate, 'claim'>;
  /** The input coordinator as it is when the decision timer fires. */
  agentInputCoordinatorHolder: Pick<
    AgentInputCoordinator,
    'hasPendingQueuedWork' | 'noteHostTurnContinuation' | 'noteHostTurnContinuationFailed'
  > | null | undefined;
  silentStopAutoResumeGuard: Pick<SilentStopAutoResumeGuard, 'onSilentStop' | 'noteResumeSendFailed'>;
  sessionListActivityTracker: Pick<SessionListActivityTracker, 'captureContinuation'>;
  productTurnWallClockTracker: Pick<ProductTurnWallClockTracker, 'preserveForContinuation'>;
  advanceRuntimeRecoveryNotice(session: SilentStopSession): void;
  createDbMessage: typeof createDbMessageType;
  settleSilentStopDone(
    sessionId: string,
    outcome: 'skip' | 'exhausted',
    turnLeaseId: string,
    session: SilentStopSession,
    generation: number,
  ): Promise<void>;
  surfaceSilentStopExhaustedBanner(sessionId: string, cause: SilentStopFailureCause): Promise<void>;
  log: {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * A silent-stop turn end, once its decision timer fires: continue the turn with a hidden
 * continuation when the guard grants it, otherwise settle it (skip) or surface the exhausted
 * banner. Shared by the desktop and the Node Host.
 */
export async function handleSilentStopTurnEndWithPorts(
  session: SilentStopSession,
  doneAt: number,
  turnLeaseId: string,
  turnOrigin: SendOrigin | undefined,
  {
    silentStopTurnLeaseGate, agentInputCoordinatorHolder, silentStopAutoResumeGuard, sessionListActivityTracker,
    productTurnWallClockTracker, advanceRuntimeRecoveryNotice, createDbMessage, settleSilentStopDone,
    surfaceSilentStopExhaustedBanner, log,
  }: SilentStopTurnEndPorts,
): Promise<void> {
  const generation = session.getTurnGeneration();
  if (!silentStopTurnLeaseGate.claim(session.id, turnLeaseId)) {
    log.debug('ignored superseded silent-stop decision timer', {
      sessionId: session.id,
      turnLeaseId,
    });
    return;
  }
  if (agentInputCoordinatorHolder?.hasPendingQueuedWork(session.id)) {
    log.debug('silent-stop auto-resume skipped — coordinator has queued work', {
      sessionId: session.id,
    });
    await settleSilentStopDone(session.id, 'skip', turnLeaseId, session, generation);
    return;
  }
  const decision = silentStopAutoResumeGuard.onSilentStop(session.id, doneAt);
  if (decision.action === 'resume') {
    const discardEndedActivity = sessionListActivityTracker.captureContinuation(session.id);
    // 续跑绕过 send 事务:generation 的绑定/失败回滚接线集中在 binding 对象
    // (bindSilentStopContinuationGeneration,见该文件头)。漏掉任一半边会让
    // 协调器残留的 activeTurn 与续跑的真实 done 永久失配，输入边界卡在忙
    // (僵尸 activeTurn)。声明在 try 外，未派发/抛出两条失败收口都要用。
    const binding = bindSilentStopContinuationGeneration(session.id, {
      noteHostTurnContinuation: (bindingSessionId, generation) =>
        agentInputCoordinatorHolder?.noteHostTurnContinuation(bindingSessionId, generation),
      noteHostTurnContinuationFailed: (bindingSessionId, adoptedGeneration) =>
        agentInputCoordinatorHolder?.noteHostTurnContinuationFailed(
          bindingSessionId,
          adoptedGeneration,
        ),
    });
    try {
      // The next Claude running boundary belongs to the same user-visible turn.
      // Mark it before send(), which may synchronously emit status events.
      productTurnWallClockTracker.preserveForContinuation(session.id);
      const clientId = randomUUID();
      const sendResult = await session.sendHostTurnContinuation(
        { type: 'user', content: SILENT_STOP_RESUME_PROMPT },
        {
          origin: turnOrigin,
          onDispatching: () => advanceRuntimeRecoveryNotice(session),
          // 预约(onTurnReserved)在 binding.sendOpts；语义与不变量见
          // silentStopContinuationBinding.ts 文件头。
          ...binding.sendOpts,
          onAccepted: async () => {
            await createDbMessage(session.id, {
              clientId,
              role: 'user',
              content: SILENT_STOP_RESUME_PROMPT,
              // autoResume: renderer 据此隐藏用户气泡、渲染「已自动继续」分隔线;
              // 也是审计标记(DB/transcript 里可查每次自动续跑)。
              agentMeta: {
                delivery: 'turn',
                autoResume: true,
                ...(turnOrigin?.kind === 'scheduler' && turnOrigin.scheduleId
                  ? {
                      origin: {
                        kind: 'scheduler' as const,
                        scheduleId: turnOrigin.scheduleId,
                        ...(turnOrigin.scheduleName
                          ? { scheduleName: turnOrigin.scheduleName }
                          : {}),
                        ...(turnOrigin.runId ? { runId: turnOrigin.runId } : {}),
                      },
                    }
                  : {}),
              },
            });
          },
        },
      );
      // send outcome 统一走 toDesktopSessionDispatchOutcome 消费(directSessionSendGuard
      // 强制的调用点协议),不手检 accepted。
      const outcome = toDesktopSessionDispatchOutcome(sendResult, {
        source: 'silent-stop-auto-resume',
        context: `maker-ipc.silent-stop.auto-resume sessionId=${session.id}`,
      });
      if (!outcome.dispatched) {
        silentStopAutoResumeGuard.noteResumeSendFailed(session.id);
        // Session 在派发确认前失败会回滚 turnGeneration;绑定必须跟着回滚,
        // 否则失败收口合成的 done 会因 generation 不匹配被 ownership 守卫丢弃,
        // 形成与本次修复对称的反向僵尸(输入边界永久忙)。
        binding.rollbackBinding();
        log.warn('silent-stop auto-resume send not accepted', {
          sessionId: session.id,
          reason: outcome.reason,
        });
        await surfaceSilentStopExhaustedBanner(session.id, 'dispatch-not-accepted');
        await settleSilentStopDone(session.id, 'exhausted', turnLeaseId, session, generation);
      } else {
        // 只在供应商确认派发后丢弃原结束时间；未派发或抛出时由失败收口按原时间提交。
        discardEndedActivity();
        log.info('silent-stop auto-resume dispatched', { sessionId: session.id });
      }
    } catch (err) {
      silentStopAutoResumeGuard.noteResumeSendFailed(session.id);
      binding.rollbackBinding();
      log.warn('silent-stop auto-resume send failed', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await surfaceSilentStopExhaustedBanner(session.id, 'dispatch-error');
      await settleSilentStopDone(session.id, 'exhausted', turnLeaseId, session, generation);
    }
    return;
  }
  if (decision.action === 'exhausted') {
    await surfaceSilentStopExhaustedBanner(session.id, decision.cause);
    await settleSilentStopDone(session.id, 'exhausted', turnLeaseId, session, generation);
  }
  if (decision.action === 'skip') {
    await settleSilentStopDone(session.id, 'skip', turnLeaseId, session, generation);
  }
}
