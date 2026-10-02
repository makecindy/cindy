import type { SessionOperation } from '@cindy/maker-shared/session-controller';
import { SessionAdmissionError } from './controller.js';
import { withSessionCaller, type SessionCallerPolicy } from './callerContext.js';

/** Main-only adapter for an existing policy service, after it has verified its
 * caller. The closure is bound to this operation/target, never a reusable grant.
 * Its live policy check is repeated by the controller at the existing write lock.
 */
export function withBoundSessionCaller<T>(input: {
  source: SessionCallerPolicy['source'];
  operation: SessionOperation;
  sessionIds: readonly string[];
  assertCurrent: () => void;
  authorize?: () => Promise<void>;
}, run: () => T): T {
  const targets = new Set(input.sessionIds);
  return withSessionCaller({
    source: input.source,
    assertCurrent: input.assertCurrent,
    authorize: async admission => {
      if (admission.operation !== input.operation
        || admission.targets.some(target => !targets.has(target.sessionId))
        || (targets.size === 0 && admission.targets.length !== 0)) {
        throw new SessionAdmissionError('NOT_AUTHORIZED', 'Operation is outside the verified caller scope');
      }
      input.assertCurrent();
      await input.authorize?.();
      input.assertCurrent();
    },
  }, run);
}
