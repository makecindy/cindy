import type { SessionOperation } from '@cindy/maker-shared/session-controller';
import type { SessionCallerPolicy } from './callerContext.js';
import { SessionAdmissionError, type SessionControllerDeps } from './controller.js';
import { captureSessionOperation } from './operationContext.js';

/** Internal host lifecycle authority is captured before asynchronous preparation.
 * The caller supplies its existing cancellation/lifecycle check, not model claims. */
export function captureInternalSessionCaller(host: SessionControllerDeps, input: {
  source: SessionCallerPolicy['source']; sessionIds: readonly string[]; operations: readonly SessionOperation[];
  assertCurrent?: () => void; inheritOperation?: boolean;
}): SessionCallerPolicy {
  const owner = host.owner();
  const parent = input.inheritOperation === false ? undefined : captureSessionOperation();
  const assertCurrent = () => {
    parent?.assertCurrent();
    if (!owner || owner !== host.owner()) throw new SessionAdmissionError('OWNER_SCOPE_CHANGED', '内部任务的账号归属已变化。');
    input.assertCurrent?.();
  };
  return { source: input.source, assertCurrent, authorize: async admission => {
    assertCurrent();
    if (!input.operations.includes(admission.operation)
      || admission.targets.some(target => !input.sessionIds.includes(target.sessionId))) {
      throw new SessionAdmissionError('NOT_AUTHORIZED', '内部调用超出了本次任务范围。');
    }
    await parent?.authorize();
    assertCurrent();
  } };
}
