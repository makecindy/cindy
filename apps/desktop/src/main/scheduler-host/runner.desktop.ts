import { shouldApplyExclusiveProviderRerouteLive } from '../maker-host/model-route-guard-live.js';
import { createMessage, rewindPersistedUserMessageAfterClear } from '../localDb/ipc/messages.js';
import { getSessionRowSnapshot, getSessionFsSnapshot, touchUserSendInDb } from '../localDb/ipc/sessions.js';
import { wireSessionToIpc, isSessionInTurn, noteSilentStopUserSend, onSilentStopSettled } from '../maker-ipc/register.js';
import { agentHandoffPending } from '../maker-ipc/agentHandoffPendingSingleton.js';
import { resolveWorkingDir } from './workdir-resolver';
import { WorktreePool } from '../worktree';
import { isManagedScheduledTarget, restoreScheduledTarget } from './restore-target.desktop';
import { MakerScheduleRunner as SharedScheduleRunner, type MakerScheduleRunnerDeps } from './runner.js';
export * from './runner.js';

export class MakerScheduleRunner extends SharedScheduleRunner {
  constructor(deps: MakerScheduleRunnerDeps) {
    super(deps, {
      shouldApplyExclusiveProviderRerouteLive: (...args) => shouldApplyExclusiveProviderRerouteLive(...args),
      createMessage: (...args) => createMessage(...args),
      rewindPersistedUserMessageAfterClear: (...args) => rewindPersistedUserMessageAfterClear(...args),
      getSessionRowSnapshot: (...args) => getSessionRowSnapshot(...args),
      getSessionFsSnapshot: (...args) => getSessionFsSnapshot(...args),
      touchUserSendInDb: (...args) => touchUserSendInDb(...args),
      wireSessionToIpc: (...args) => wireSessionToIpc(...args),
      isSessionInTurn: (...args) => isSessionInTurn(...args),
      noteSilentStopUserSend: (...args) => noteSilentStopUserSend(...args),
      onSilentStopSettled: (...args) => onSilentStopSettled(...args),
      agentHandoffPending: { peek: (...args) => agentHandoffPending.peek(...args), consume: (...args) => agentHandoffPending.consume(...args) },
      resolveWorkingDir: (...args) => resolveWorkingDir(...args),
      releaseWorktree: (...args) => WorktreePool.releaseWorktree(...args),
      isManagedScheduledTarget: (...args) => isManagedScheduledTarget(...args),
      restoreScheduledTarget: (...args) => restoreScheduledTarget(...args),
    });
  }
}
