import { AsyncLocalStorage } from 'node:async_hooks';
import type { HostSessionCaller, SessionAdmission } from './controller.js';
import { SessionAdmissionError } from './controller.js';

/** Main-only policy closure, installed by a verified entry adapter, never serialized. */
export interface SessionCallerPolicy {
  source: HostSessionCaller['source'];
  authorize(admission: SessionAdmission): Promise<void>;
  assertCurrent?: () => void;
}

const context = new AsyncLocalStorage<{ policy: SessionCallerPolicy; active: boolean }>();

export function withSessionCaller<T>(policy: SessionCallerPolicy, operation: () => T): T {
  const entry = { policy, active: true };
  return context.run(entry, () => {
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        return Promise.resolve(result).finally(() => { entry.active = false; }) as T;
      }
      entry.active = false;
      return result;
    } catch (error) { entry.active = false; throw error; }
  });
}

export function requireSessionCaller(): SessionCallerPolicy {
  const policy = getSessionCaller();
  if (!policy) throw new SessionAdmissionError('NOT_AUTHORIZED', 'Session caller context is required');
  return policy;
}

/** Host adapters may preserve an already verified, narrower policy. */
export function getSessionCaller(): SessionCallerPolicy | undefined {
  const entry = context.getStore();
  return entry?.active ? entry.policy : undefined;
}
