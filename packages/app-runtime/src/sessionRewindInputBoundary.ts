import {throwIpcError} from '@cindy/remote-agent/ipcValidate';
import type {AgentInputCoordinator} from './agent-input-coordinator.js';
import type {Logger} from '@cindy/maker-core';
export function createSessionRewindInputBoundary(host:{
 getCoordinator():Pick<AgentInputCoordinator,'ensureQueueRestored'|'isQueueRestored'|'setInteractionLock'|'hasActiveTurnForRewind'|'stop'|'pausePendingQueueForRewind'|'waitForRewindBoundaryIdle'|'releaseRewindLockWhenIdle'>|null;
 stopGoal?(id:string):Promise<unknown>;
 rewinding:Set<string>;
 logger:Pick<Logger,'error'>;
}) {
 const {rewinding:rewindInputSessions,logger:log}=host;
 const SESSION_REWIND_INPUT_LOCK_ID='session-rewind';
 const SESSION_REWIND_STOP_TIMEOUT_MS=15_000;
 async function withSessionInputStoppedForRewind<T>(
  sessionId: string,
  action: () => Promise<T>,
): Promise<T> {
  const coordinator = host.getCoordinator();
  let releaseInputLockOnExit = true;
  if (!coordinator) {
    throwIpcError('INTERNAL', 'Agent input coordinator is not initialized');
  }
  if (rewindInputSessions.has(sessionId)) {
    throwIpcError('SESSION_RUNNING', 'A rewind is already in progress for this session');
  }

  rewindInputSessions.add(sessionId);
  try {
    await coordinator.ensureQueueRestored(sessionId).catch(() => undefined);
    if (!coordinator.isQueueRestored(sessionId)) {
      throwIpcError('INTERNAL', 'Failed to restore queued input before rewind');
    }

    coordinator.setInteractionLock(sessionId, SESSION_REWIND_INPUT_LOCK_ID, true, {
      preserveOnStop: true,
    });
    if (coordinator.hasActiveTurnForRewind(sessionId)) {
      // Pause /goal before abort so the terminal event cannot auto-resume it.
      await host.stopGoal?.(sessionId);
      coordinator.stop(sessionId, { keepQueue: true, pauseQueue: true });
    } else {
      coordinator.pausePendingQueueForRewind(sessionId);
    }

    const stopped = await coordinator.waitForRewindBoundaryIdle(
      sessionId,
      SESSION_REWIND_STOP_TIMEOUT_MS,
    );
    if (!stopped) {
      // The old turn / interaction is still authoritative. Keep both the input
      // lock and duplicate-rewind guard after returning the timeout error, then
      // release them automatically once the real terminal boundary arrives.
      releaseInputLockOnExit = false;
      void coordinator
        .releaseRewindLockWhenIdle(sessionId, SESSION_REWIND_INPUT_LOCK_ID)
        .then(() => rewindInputSessions.delete(sessionId))
        .catch((err) => {
          log.error('failed to release retained rewind input lock', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      throwIpcError('SESSION_RUNNING', 'Timed out waiting for the session to stop before rewind');
    }

    return await action();
  } finally {
    coordinator.pausePendingQueueForRewind(sessionId);
    if (releaseInputLockOnExit) {
      coordinator.setInteractionLock(sessionId, SESSION_REWIND_INPUT_LOCK_ID, false);
      rewindInputSessions.delete(sessionId);
    }
  }
}
 return {withSessionInputStoppedForRewind};
}
