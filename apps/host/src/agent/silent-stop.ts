import type { AgentEvent, Session } from '@cindy/maker-core';
import { SilentStopTurnLeaseGate } from '../../../desktop/src/main/maker-ipc/sessionTurnLease.ts';
import { handleSilentStopTurnEndWithPorts, type SilentStopTurnEndPorts } from '../../../desktop/src/main/maker-ipc/silentStopTurnEnd.ts';
import {
  settleSilentStopDoneWithPorts,
  type SilentStopSettlePorts,
  type SilentStopSettleReason,
} from '../../../desktop/src/main/maker-ipc/silentStopSettle.ts';
import { surfaceSilentStopFailureWithPorts } from '../../../desktop/src/main/maker-ipc/silentStopFailure.ts';
import { SILENT_STOP_DECISION_DELAY_MS, type SilentStopAutoResumeGuard } from '../../../desktop/src/main/maker-ipc/silentStopAutoResume.ts';
import type { SessionListActivityTracker } from '../../../desktop/src/main/maker-ipc/sessionTurnActivityTracker.ts';
import { noteClaudeSessionTurnState } from '../../../desktop/src/main/maker-host/claude-session-background-activity.ts';
import { explicitPorts } from './explicit-ports.ts';

export interface HostSilentStopPorts<Turn> {
  /** The task's input coordinator (input-queue.mjs); read when the decision runs. */
  coordinator: {
    hasPendingQueuedWork(sessionId: string): boolean;
    noteHostTurnContinuation(sessionId: string, vendorTurnGeneration: number): void;
    noteHostTurnContinuationFailed(sessionId: string, adoptedVendorTurnGeneration: number): void;
  };
  /** The silent-stop guard of this owner runtime (auto-resume.ts); without it nothing is scheduled. */
  guard(): SilentStopAutoResumeGuard | null;
  /** The task list's activity tracker (product-turn.ts), if the runtime has one. */
  listActivity(): Pick<SessionListActivityTracker, 'captureContinuation' | 'commit'> | null;
  /** Coexistence plan A (input-queue.mjs holdForDesktop): the profile is the desktop's while held. */
  isProfileHeld(): boolean;
  /** A row of the task (the continuation's user row, the exhausted marker), behind its reply rows. */
  writeRow: SilentStopTurnEndPorts['createDbMessage'];
  /** The exhausted banner's error event, to the task's clients (the window and /api/chat). */
  publishFailure(sessionId: string, turn: Turn, data: object): void;
  /** The executor still runs this turn record for the task (no newer turn replaced it). */
  isTurnCurrent(sessionId: string, turn: Turn): boolean;
  /** The continuation reserved a new generation for this turn: its events are this turn's from now on. */
  adoptGeneration(turn: Turn, generation: number): void;
  /** The continuation was not dispatched: the turn goes back to the generation it had. */
  rollbackGeneration(turn: Turn, generation: number): void;
  /** The turn's change record ends (turn-change-set/store.ts, complete). */
  finalizeChangeSet(sessionId: string, turn: Turn): void;
  /** The turn ends without a continuation (turn-executor.mjs finish, which hands the coordinator its done). */
  endTurn(sessionId: string, turn: Turn, reason: SilentStopSettleReason): void;
  log: SilentStopTurnEndPorts['log'];
}

/**
 * The desktop's silent-stop continuation on the Node Host. A turn the engine ended with an empty reply
 * (its done carries `silentStop`, the Claude Code and Pi translators) is not over yet. As the desktop's
 * turn observer (sessionTurnObserver.ts onTerminal), its terminal is scheduled once and the runtime keeps
 * its generation for the continuation (claimHostTurnContinuation, so neither retirement nor idle release
 * closes it meanwhile). As the desktop's preparation (sessionEventPreparation.ts), the decision comes
 * SILENT_STOP_DECISION_DELAY_MS later, through the shared silentStopTurnEnd.ts. A hidden "继续" continues
 * the same turn on a new generation, or the turn settles (silentStopSettle.ts): skipped when work is
 * queued or the guard declines, or exhausted with the "继续" banner (silentStopFailure.ts).
 *
 * The desktop's settle also idles its turn tracker, wakes the coordinator, lands a pending credential
 * switch and runtime control, and notifies its Codex restart services. On the Host one step does all of
 * that: the turn's finish, which hands the coordinator its done once the rows settle and then runs the
 * Host's settled-turn hooks (input-queue.mjs onTerminal, onSessionSettled). Those ports are bound empty
 * here with that reason.
 */
export function createHostSilentStop<Turn>(ports: HostSilentStopPorts<Turn>) {
  const gate = new SilentStopTurnLeaseGate();

  function settlePorts(sessionId: string, turn: Turn, reason: SilentStopSettleReason): SilentStopSettlePorts {
    return explicitPorts<SilentStopSettlePorts>({
      silentStopTurnLeaseGate: gate,
      // The desktop's turn lease (sessionTurnLease.ts) answers whether a newer turn of the task started;
      // on the Host that is the executor's turn record. The runtime's claim is released either way.
      sessionTurnLeaseTracker: {
        markTurnEndedAndCheckIdle: async (_sessionId, _turnLeaseId, onSettled) => {
          try {
            return ports.isTurnCurrent(sessionId, turn);
          } finally {
            onSettled?.();
          }
        },
      },
      finalizeTurnChangeSet: async () => { ports.finalizeChangeSet(sessionId, turn); },
      sessionListActivityTracker: { commit: id => ports.listActivity()?.commit(id) },
      // The product turn's wall clock and usage target arrive with the Host's usage records (release table row 13).
      productTurnWallClockTracker: { clear: () => {} },
      productTurnUsageTargetTracker: { clear: () => {} },
      // The turn's finish below (endTurn).
      sessionTurnActivityTracker: { scheduleIdleAfterTerminalBroadcast: () => {} },
      noteClaudeSessionTurnState,
      agentInputCoordinatorHolder: {
        onTurnEvent: () => ports.endTurn(sessionId, turn, reason),
        // The Host's other turn ends (finish) do not call it either.
        onExternalTurnSettled: () => {},
      },
      // The turn's finish (endTurn) runs the Host's settled-turn hooks: these happen there.
      settlePendingCredentialSwitch: () => {},
      settlePendingSessionRuntimeControlHolder: undefined,
      deferredCodexRestartHolder: undefined,
      gatewayCodexRestartHolder: undefined,
      // The Host runs no remote Codex tasks.
      refreshRemoteCodexMcpOnTurnSettledHolder: undefined,
      // No in-process runner (scheduler, hook, IM) waits on a silent stop on the Host.
      fireSilentStopSettled: () => {},
      log: ports.log,
    });
  }

  function turnEndPorts(sessionId: string, turn: Turn, guard: SilentStopAutoResumeGuard): SilentStopTurnEndPorts {
    return explicitPorts<SilentStopTurnEndPorts>({
      silentStopTurnLeaseGate: gate,
      agentInputCoordinatorHolder: {
        // While the profile is held, its writes are the desktop's: no continuation is sent, as no queued
        // input would be, and the turn settles as one that had queued work.
        hasPendingQueuedWork: id => ports.isProfileHeld() || ports.coordinator.hasPendingQueuedWork(id),
        noteHostTurnContinuation: (id, generation) => {
          ports.adoptGeneration(turn, generation);
          ports.coordinator.noteHostTurnContinuation(id, generation);
        },
        noteHostTurnContinuationFailed: (id, generation) => {
          ports.rollbackGeneration(turn, generation);
          ports.coordinator.noteHostTurnContinuationFailed(id, generation);
        },
      },
      silentStopAutoResumeGuard: guard,
      sessionListActivityTracker: {
        captureContinuation: id => ports.listActivity()?.captureContinuation(id) ?? (() => {}),
      },
      // The product turn's wall clock arrives with the Host's usage records (release table row 13).
      productTurnWallClockTracker: { preserveForContinuation: () => {} },
      // The IM runtime-recovery notice: the Host has no IM channels.
      advanceRuntimeRecoveryNotice: () => {},
      createDbMessage: ports.writeRow,
      settleSilentStopDone: (id, reason, turnLeaseId, runtime, generation) =>
        settleSilentStopDoneWithPorts(id, reason, turnLeaseId, runtime, generation, settlePorts(sessionId, turn, reason)),
      surfaceSilentStopExhaustedBanner: (id, cause) => surfaceSilentStopFailureWithPorts(id, cause, {
        createDbMessage: ports.writeRow,
        broadcast: data => ports.publishFailure(id, turn, data),
        log: ports.log,
      }),
      log: ports.log,
    });
  }

  return {
    /**
     * At a silent-stop done of the task's current turn, before anything else handles it: 'scheduled'
     * (one decision for this terminal, the runtime keeps its generation), 'duplicate' (the desktop drops
     * a second terminal of the same generation), or null (not a silent stop, or no guard).
     */
    schedule(session: Session, event: AgentEvent): 'scheduled' | 'duplicate' | null {
      if (event.type !== 'done' || (event.data as { silentStop?: unknown } | null | undefined)?.silentStop !== true
        || !ports.guard()) return null;
      const generation = typeof event.sessionTurnGeneration === 'number' ? event.sessionTurnGeneration : session.getTurnGeneration();
      if (!gate.schedule(session.id, event, `${session.instanceId}:${generation}`)) return 'duplicate';
      session.claimHostTurnContinuation(generation);
      return 'scheduled';
    },
    /** This event is the silent-stop done a decision was scheduled for. */
    isScheduled: (event: AgentEvent) => gate.turnLeaseIdForEvent(event) !== undefined,
    /** The decision, SILENT_STOP_DECISION_DELAY_MS after the done (sessionEventPreparation.ts). */
    decideLater(session: Session, turn: Turn, event: AgentEvent): void {
      const turnLeaseId = gate.turnLeaseIdForEvent(event);
      const guard = ports.guard();
      if (!turnLeaseId || !guard) return;
      const doneAt = Date.now();
      const turnOrigin = event.turnOrigin;
      setTimeout(() => {
        // The desktop's main process logs an unhandled rejection; the Host's would end the process.
        void handleSilentStopTurnEndWithPorts(session, doneAt, turnLeaseId, turnOrigin, turnEndPorts(session.id, turn, guard))
          .catch(error => ports.log.warn('silent-stop decision failed', {
            sessionId: session.id, error: error instanceof Error ? error.name : typeof error,
          }));
      }, SILENT_STOP_DECISION_DELAY_MS);
    },
    /** A newer provider turn of the task, or a terminal that is not a silent stop (sessionTurnObserver.ts). */
    supersede: (sessionId: string) => gate.supersede(sessionId),
    /** The runtime is no longer the task's (sessionTurnObserver.ts teardown). */
    released: (sessionId: string, instanceId: string) => gate.supersedeOwnedBy(sessionId, `${instanceId}:`),
  };
}
