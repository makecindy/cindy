import { createLogger } from '../logger.js';
import { runAcceptedCallback as run, runAcceptedRollback as rollback, type AcceptedCallbackLogger } from '@cindy/im-runtime/acceptedCallbackRunner';
export { AcceptedCallbackDispatchCancelled } from '@cindy/im-runtime/acceptedCallbackRunner';
export type { AcceptedCallbackLogger } from '@cindy/im-runtime/acceptedCallbackRunner';
const defaultLog = createLogger('maker-ipc');
export function runAcceptedCallback(callback: (() => void | Promise<void>) | undefined, sessionId: string, clientId: string, log: AcceptedCallbackLogger = defaultLog): Promise<void> {
  return run(callback, sessionId, clientId, log);
}
export function runAcceptedRollback(callback: (() => void | Promise<void>) | undefined, sessionId: string, clientId: string, log: AcceptedCallbackLogger = defaultLog): Promise<void> {
  return rollback(callback, sessionId, clientId, log);
}
