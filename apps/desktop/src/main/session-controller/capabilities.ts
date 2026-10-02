import type { Capabilities } from '@cindy/maker-core';
import { SESSION_OPERATIONS, type SessionCapability, type SessionOperation } from '@cindy/maker-shared/session-controller';

/** Read-only projection from the existing harness and live handle. Caller
 * filtering is applied by observation.ts after these host capability checks. */
export function projectSessionCapabilities(input: {
  capabilities: Capabilities;
  runtimeLoaded: boolean;
  gracefulStop: boolean;
  stopBackgroundTask: boolean;
  recordActive: boolean;
}): SessionCapability[] {
  const c = input.capabilities;
  const supported = new Map<SessionOperation, boolean>([
    ['steer', input.runtimeLoaded && c.sameTurnSteer.supported],
    ['requestStop', input.gracefulStop],
    ['abortTurn', input.runtimeLoaded && c.abort.supported],
    ['stopBackgroundTask', input.stopBackgroundTask],
    ['inspectHistory', c.sessionTree?.supported === true || c.rewind.supported],
    ['rewind', c.rewind.supported || c.sessionTree?.supported === true],
    ['fork', c.fork.supported],
    ['compact', input.runtimeLoaded && c.manualCompact?.supported === true],
  ]);
  const activeOnly: readonly SessionOperation[] = ['send', 'enqueue', 'steer', 'ensureRuntime', 'resumeQueue', 'retryInput', 'selectRuntime'];
  return SESSION_OPERATIONS.map(operation => ({ operation,
    supported: (supported.get(operation) ?? true) && (input.recordActive || !activeOnly.includes(operation)),
    ...(!input.recordActive && activeOnly.includes(operation) ? { reason: 'record-not-active' }
      : supported.get(operation) === false ? { reason: input.runtimeLoaded ? 'harness-unsupported' : 'runtime-unloaded-or-harness-unsupported' } : {}),
  }));
}
