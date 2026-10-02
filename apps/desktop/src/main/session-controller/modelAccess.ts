import type { SessionOperation, SessionControlRequest } from '@cindy/maker-shared/session-controller';
import { SessionAdmissionError } from './controller.js';

/** Model-facing surface retains ordinary Session tool authority. The complete
 * host service also serves trusted UI approval and destructive history controls;
 * discovering those methods does not grant a model the user's approval powers. */
const hostOnly = new Set<SessionOperation>([
  'changePermission', 'resolveInteraction', 'clearInputs', 'deleteMessage',
  'setInputLock', 'updateInputPresentation',
]);
export function assertModelSessionOperationAllowed(operation: SessionOperation, request?: SessionControlRequest): void {
  if (hostOnly.has(operation) || (request?.command.operation === 'setRecordStatus' && request.command.args.status === 'deleted')) {
    throw new SessionAdmissionError('NOT_AUTHORIZED', '此操作需要已有的用户或宿主授权入口。');
  }
}
