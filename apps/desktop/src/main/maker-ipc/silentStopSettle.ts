import type { Maker } from '@cindy/maker-core';
import type { AgentInputCoordinator } from './agent-input-coordinator.js';
import type { SilentStopTurnLeaseGate, SessionTurnLeaseTracker } from './sessionTurnLease.js';
import type { SessionListActivityTracker, SessionTurnActivityTracker } from './sessionTurnActivityTracker.js';
import type { ProductTurnUsageTargetTracker, ProductTurnWallClockTracker } from './turnWallClock.js';

type SilentStopSession = NonNullable<ReturnType<Maker['getSession']>>;

export type SilentStopSettleReason = 'exhausted' | 'skip' | 'send-failed';

/** What settling a silent-stop done reads and acts through (the desktop: register.ts). */
export interface SilentStopSettlePorts {
  silentStopTurnLeaseGate: Pick<SilentStopTurnLeaseGate, 'settle'>;
  sessionTurnLeaseTracker: Pick<SessionTurnLeaseTracker, 'markTurnEndedAndCheckIdle'>;
  finalizeTurnChangeSet(sessionId: string, providerTurnId: string | null, terminalState: 'complete'): Promise<void>;
  sessionListActivityTracker: Pick<SessionListActivityTracker, 'commit'>;
  productTurnWallClockTracker: Pick<ProductTurnWallClockTracker, 'clear'>;
  productTurnUsageTargetTracker: Pick<ProductTurnUsageTargetTracker, 'clear'>;
  sessionTurnActivityTracker: Pick<SessionTurnActivityTracker, 'scheduleIdleAfterTerminalBroadcast'>;
  noteClaudeSessionTurnState(sessionId: string, running: boolean): void;
  /** The input coordinator as it is when the settle runs. */
  agentInputCoordinatorHolder: Pick<AgentInputCoordinator, 'onTurnEvent' | 'onExternalTurnSettled'> | null | undefined;
  settlePendingCredentialSwitch(sessionId: string, source: string): void;
  settlePendingSessionRuntimeControlHolder: ((sessionId: string, reason: string) => void) | null | undefined;
  deferredCodexRestartHolder: { onSessionSettled(): void } | null | undefined;
  gatewayCodexRestartHolder: { onSessionSettled(): void } | null | undefined;
  refreshRemoteCodexMcpOnTurnSettledHolder: ((sessionId: string) => void) | null | undefined;
  fireSilentStopSettled(sessionId: string, reason: SilentStopSettleReason): void;
  log: {
    debug(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * silent-stop done 时 idle 转换被延迟(避免假完成通知);当守卫决定不续跑时
 * (skip / exhausted / send 失败)补发被推迟的 idle + coordinator done 信号,
 * 让 renderer 正确显示 stopped、scheduler/hook runner 收到 done 并 finish。
 * Shared by the desktop (register.ts settleSilentStopDone) and the Node Host.
 */
export async function settleSilentStopDoneWithPorts(
  sessionId: string,
  reason: SilentStopSettleReason,
  turnLeaseId: string,
  runtime: SilentStopSession,
  generation: number,
  {
    silentStopTurnLeaseGate, sessionTurnLeaseTracker, finalizeTurnChangeSet, sessionListActivityTracker,
    productTurnWallClockTracker, productTurnUsageTargetTracker, sessionTurnActivityTracker, noteClaudeSessionTurnState,
    agentInputCoordinatorHolder, settlePendingCredentialSwitch, settlePendingSessionRuntimeControlHolder,
    deferredCodexRestartHolder, gatewayCodexRestartHolder, refreshRemoteCodexMcpOnTurnSettledHolder,
    fireSilentStopSettled, log,
  }: SilentStopSettlePorts,
): Promise<void> {
  silentStopTurnLeaseGate.settle(sessionId, turnLeaseId);
  try {
    if (!(await sessionTurnLeaseTracker.markTurnEndedAndCheckIdle(
      sessionId, turnLeaseId, () => runtime.settleHostTurnContinuation(generation),
    ))) {
      log.debug('ignored stale silent-stop settle after a newer turn started', {
        sessionId,
        turnLeaseId,
      });
      return;
    }
  } catch (error) {
    log.warn('silent-stop turn lease settle failed closed', {
      sessionId,
      turnLeaseId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  void finalizeTurnChangeSet(sessionId, null, 'complete');
  sessionListActivityTracker.commit(sessionId);
  productTurnWallClockTracker.clear(sessionId);
  productTurnUsageTargetTracker.clear(sessionId);
  sessionTurnActivityTracker.scheduleIdleAfterTerminalBroadcast(sessionId);
  noteClaudeSessionTurnState(sessionId, false);
  agentInputCoordinatorHolder?.onTurnEvent(sessionId, 'done');
  settlePendingCredentialSwitch(sessionId, `silent-stop:${reason}`);
  settlePendingSessionRuntimeControlHolder?.(sessionId, `silent-stop:${reason}`);
  deferredCodexRestartHolder?.onSessionSettled();
  gatewayCodexRestartHolder?.onSessionSettled();
  agentInputCoordinatorHolder?.onExternalTurnSettled(sessionId);
  refreshRemoteCodexMcpOnTurnSettledHolder?.(sessionId);
  fireSilentStopSettled(sessionId, reason);
}
