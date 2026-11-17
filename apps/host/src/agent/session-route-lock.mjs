import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';

/**
 * The Host entries that change a task's runtime or route run under the task's send lock, as their
 * desktop counterparts do (register.ts: model, effort and runtime changes, discarding an unsent
 * task, closing a task, restoring a plugin page's task). A send of the same task, and context
 * recovery, cannot interleave with them. Switching engines only records an intent, applied by
 * `updateSession` when the next input is queued; reading that intent and stopping a turn do not
 * take the lock (a stop must interrupt whoever holds it).
 *
 * None of these is called from inside an input-queue command, and no command takes this lock: a
 * holder may wait for a task's command chain (deletion stops the task), never the reverse.
 */
export function lockSessionRoute(route) {
  return (sessionId, ...args) => withSendToSessionLock(sessionId, () => route(sessionId, ...args));
}
