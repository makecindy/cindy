import type { SessionOperation } from '@cindy/maker-shared/session-controller';
import { createSessionController, sessionOperation, type SessionControllerDeps } from './controller.js';
import { captureInternalSessionCaller } from './internalCaller.js';
import { withSessionCaller, type SessionCallerPolicy } from './callerContext.js';

/** For host-owned composition ports whose existing transactions must stay intact.
 * Capture this before preparation; authorization is repeated by the lower write
 * boundaries. Caller policy remains in the owning host, never in a wire DTO. */
export function createHostSessionOperation(host: SessionControllerDeps, input: {
  source: SessionCallerPolicy['source']; operation: SessionOperation;
  sessionIds: readonly string[]; assertCurrent?: () => void;
}) {
  const policy = captureInternalSessionCaller(host, { ...input, operations: [input.operation] });
  return <T>(execute: () => Promise<T>): Promise<T> => {
    const controller = createSessionController(host, {
      run: sessionOperation({ operation: input.operation, targets: () => input.sessionIds, execute }),
    });
    return withSessionCaller(policy, () => controller.invoke(controller.issueCaller(policy), 'run'));
  };
}
