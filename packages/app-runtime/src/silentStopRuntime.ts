import {randomUUID} from 'node:crypto';
import type {Session, SendOrigin} from '@cindy/maker-core';
import type {DbLogger} from '@cindy/runtime-db/logging';
import type {AgentInputCoordinator} from './agent-input-coordinator.js';
import type {createMessageService} from './messageService.js';
import type {SilentStopTurnLeaseGate} from './sessionTurnLease.js';
import type {ProductTurnWallClockTracker} from './turnWallClock.js';
import {SILENT_STOP_RESUME_PROMPT, type SilentStopAutoResumeGuard} from '@cindy/remote-agent/host/silentStopAutoResume';
import {toDesktopSessionDispatchOutcome} from '@cindy/im-runtime/sendOutcome';
import {bindSilentStopContinuationGeneration} from './silentStopContinuationBinding.js';
export interface SilentStopRuntimeHost {
 readonly agentInputCoordinatorHolder: Pick<AgentInputCoordinator,'hasPendingQueuedWork'|'noteHostTurnContinuation'|'noteHostTurnContinuationFailed'>|null;
 silentStopTurnLeaseGate: Pick<SilentStopTurnLeaseGate,'claim'>;
 silentStopAutoResumeGuard: Pick<SilentStopAutoResumeGuard,'onSilentStop'|'noteResumeSendFailed'>;
 productTurnWallClockTracker: Pick<ProductTurnWallClockTracker,'preserveForContinuation'>;
 advanceRuntimeRecoveryNotice(session:Session):void;
 createDbMessage: ReturnType<typeof createMessageService>['createMessage'];
 settleSilentStopDone(sessionId:string, reason:'exhausted'|'skip'|'send-failed',turnLeaseId:string,session:Session,generation:number):Promise<void>;
 broadcastToAllWindows(channel:string,payload:unknown):void;
 readonly MAKER_PUSH:{readonly EVENT:string};
 log: DbLogger;
}
export function createSilentStopRuntime(host:SilentStopRuntimeHost) {
 const {silentStopTurnLeaseGate,silentStopAutoResumeGuard,productTurnWallClockTracker,advanceRuntimeRecoveryNotice,createDbMessage,settleSilentStopDone,broadcastToAllWindows,MAKER_PUSH,log}=host;
async function surfaceSilentStopExhaustedBanner(sessionId: string): Promise<void> {
  await createDbMessage(
    sessionId,
    {
      clientId: randomUUID(),
      role: 'error',
      content: {
        message: '模型连续多次返回空响应,自动续跑已暂停。点击「继续」恢复任务。',
        isTerminal: true,
        reason: 'silent-stop-exhausted',
      },
    },
    { shouldBroadcast: () => false },
  ).catch((err) => {
    log.warn('silent-stop exhausted marker persist failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  broadcastToAllWindows(MAKER_PUSH.EVENT, {
    sessionId,
    event: {
      type: 'error',
      data: {
        message: '模型连续多次返回空响应,自动续跑已暂停。点击「继续」恢复任务。',
        isTerminal: true,
        reason: 'silent-stop-exhausted',
      },
      source: 'claude-code',
    },
  });
  log.warn('silent-stop auto-resume exhausted — surfaced continue banner', { sessionId });
}

async function handleSilentStopTurnEnd(
  session: Session,
  doneAt: number,
  turnLeaseId: string,
  turnOrigin?: SendOrigin,
): Promise<void> {
  const generation = session.getTurnGeneration();
  if (!silentStopTurnLeaseGate.claim(session.id, turnLeaseId)) {
    log.debug('ignored superseded silent-stop decision timer', {
      sessionId: session.id,
      turnLeaseId,
    });
    return;
  }
  if (host.agentInputCoordinatorHolder?.hasPendingQueuedWork(session.id)) {
    log.debug('silent-stop auto-resume skipped — coordinator has queued work', {
      sessionId: session.id,
    });
    await settleSilentStopDone(session.id, 'skip', turnLeaseId, session, generation);
    return;
  }
  const decision = silentStopAutoResumeGuard.onSilentStop(session.id, doneAt);
  if (decision.action === 'resume') {
    // 续跑绕过 send 事务:generation 的绑定/失败回滚接线集中在 binding 对象
    // (bindSilentStopContinuationGeneration,见该文件头)。漏掉任一半边会让
    // 协调器残留的 activeTurn 与续跑的真实 done 永久失配，输入边界卡在忙
    // (僵尸 activeTurn)。声明在 try 外，未派发/抛出两条失败收口都要用。
    const binding = bindSilentStopContinuationGeneration(session.id, {
      noteHostTurnContinuation: (bindingSessionId, generation) =>
        host.agentInputCoordinatorHolder?.noteHostTurnContinuation(bindingSessionId, generation),
      noteHostTurnContinuationFailed: (bindingSessionId, adoptedGeneration) =>
        host.agentInputCoordinatorHolder?.noteHostTurnContinuationFailed(
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
        await surfaceSilentStopExhaustedBanner(session.id);
        await settleSilentStopDone(session.id, 'exhausted', turnLeaseId, session, generation);
      } else {
        log.info('silent-stop auto-resume dispatched', { sessionId: session.id });
      }
    } catch (err) {
      silentStopAutoResumeGuard.noteResumeSendFailed(session.id);
      binding.rollbackBinding();
      log.warn('silent-stop auto-resume send failed', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await surfaceSilentStopExhaustedBanner(session.id);
      await settleSilentStopDone(session.id, 'exhausted', turnLeaseId, session, generation);
    }
    return;
  }
  if (decision.action === 'exhausted') {
    await surfaceSilentStopExhaustedBanner(session.id);
    await settleSilentStopDone(session.id, 'exhausted', turnLeaseId, session, generation);
  }
  if (decision.action === 'skip') {
    await settleSilentStopDone(session.id, 'skip', turnLeaseId, session, generation);
  }
}
 return {surfaceSilentStopExhaustedBanner,handleSilentStopTurnEnd};
}
