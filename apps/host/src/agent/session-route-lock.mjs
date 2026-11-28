import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';

/**
 * The Host entries that change a task's runtime or route run under the task's send lock, as their
 * desktop counterparts do (register.ts: model, effort and runtime changes, discarding an unsent
 * task, closing a task). A send of the same task, and context
 * recovery, cannot interleave with them. Switching engines only records an intent, applied when the
 * next input is queued (the send transaction's applyPendingAgentSwitch); reading that intent and
 * stopping a turn do not take the lock (a stop must interrupt whoever holds it).
 *
 * Sends and runtime starts enter the input command chain before waiting for this lock.
 * Deletion holds the lock while stopping the task: Stop aborts pending lock admission
 * before waiting for the command chain. A held lock is still released by its owner.
 */
export function lockSessionRoute(route) {
  return (sessionId, ...args) => withSendToSessionLock(sessionId, () => route(sessionId, ...args));
}
