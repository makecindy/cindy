import type {
  SessionControllerErrorCode,
  SessionExecutionIdentity,
  SessionOperation,
  SessionResourceRef,
  SessionTarget,
} from '@cindy/maker-shared/session-controller';
import { isSessionResourceLocalTo, SESSION_READ_OPERATIONS } from '@cindy/maker-shared/session-controller';
import { withSessionOperation } from './operationContext.js';

/** Host-only capability. Copying its fields (or sending JSON) cannot recreate a caller. */
export interface HostSessionCaller {
  readonly source: 'ui' | 'session' | 'companion' | 'plugin' | 'scheduler' | 'hook' | 'orca' | 'host';
}

export interface SessionAdmission {
  operation: SessionOperation;
  targets: readonly SessionTarget[];
  /** Creation and listing have a device, but no invented sessionId. */
  deviceId: string;
}

export interface SessionOperationScope {
  /** Call again after an await, inside the existing write/dispatch lock. */
  assertCurrent(): void;
  /** Re-evaluate turn authority, plugin revocation and project scope at a late boundary. */
  authorize(): Promise<void>;
  /** Query another operation for this target without granting or executing it. */
  allows(operation: SessionOperation, sessionIds?: readonly string[]): Promise<boolean>;
}

export interface SessionOperationPort<Args extends unknown[], Result> {
  operation: SessionOperation | ((...args: Args) => SessionOperation);
  targets(...args: Args): readonly string[];
  execute(scope: SessionOperationScope, ...args: Args): Result;
}

type PortMap = Record<string, SessionOperationPort<never[], unknown>>;
type PortArgs<P> = P extends SessionOperationPort<infer Args, unknown> ? Args : never;
type PortResult<P> = P extends SessionOperationPort<never[], infer Result> ? Awaited<Result> : never;

export class SessionAdmissionError extends Error {
  constructor(readonly code: SessionControllerErrorCode, message: string) {
    super(message);
    this.name = 'SessionAdmissionError';
  }
}

export interface SessionControllerDeps {
  deviceId(): string;
  /** Identity of the current account/database scope; null means not ready. */
  owner(): object | null;
  execution(sessionId: string): SessionExecutionIdentity | null;
}

interface CallerAuthority {
  owner: object;
  authorize(admission: SessionAdmission): Promise<void>;
  assertCurrent(): void;
}

/**
 * One typed, transport-independent entrance to the existing Session business ports.
 * Owns no records, queue, runtime, timers or receipts. Policies supply host-only caller
 * capabilities; business ports retain their existing locks and persistence transactions.
 */
export function createSessionController<Ports extends PortMap>(
  deps: SessionControllerDeps,
  ports: Ports,
) {
  const callers = new WeakMap<HostSessionCaller, CallerAuthority>();

  function issueCaller(input: {
    source: HostSessionCaller['source'];
    authorize(admission: SessionAdmission): Promise<void>;
    assertCurrent?: () => void;
  }): HostSessionCaller {
    const owner = deps.owner();
    if (!owner) throw new SessionAdmissionError('HOST_NOT_READY', 'Session host is not ready');
    const caller: HostSessionCaller = Object.freeze({ source: input.source });
    callers.set(caller, { owner, authorize: input.authorize, assertCurrent: input.assertCurrent ?? (() => {}) });
    return caller;
  }

  function scopeFor(caller: HostSessionCaller, admission: SessionAdmission): SessionOperationScope {
    const authority = callers.get(caller);
    if (!authority) throw new SessionAdmissionError('NOT_AUTHORIZED', 'A host-verified caller is required');
    const assertCurrent = () => {
      if (deps.owner() !== authority.owner) {
        throw new SessionAdmissionError('OWNER_SCOPE_CHANGED', 'Session owner changed');
      }
      authority.assertCurrent();
    };
    return {
      assertCurrent,
      async allows(operation, sessionIds) {
        assertCurrent();
        try {
          await authority.authorize({ ...admission, operation,
            ...(sessionIds ? { targets: sessionIds.map(sessionId => ({ deviceId: admission.deviceId, sessionId })) } : {}),
          });
          assertCurrent();
          return true;
        } catch (error) {
          if (error instanceof SessionAdmissionError && error.code === 'NOT_AUTHORIZED') return false;
          throw error;
        }
      },
      async authorize() {
        assertCurrent();
        await authority.authorize(admission);
        assertCurrent();
      },
    };
  }

  async function invoke<Key extends keyof Ports>(
    caller: HostSessionCaller,
    operation: Key,
    ...args: PortArgs<Ports[Key]>
  ): Promise<PortResult<Ports[Key]>> {
    const port = ports[operation];
    if (!port) throw new SessionAdmissionError('UNSUPPORTED_CAPABILITY', 'Session operation is unavailable');
    const deviceId = deps.deviceId();
    const domainOperation = typeof port.operation === 'function' ? port.operation(...args as never[]) : port.operation;
    const scope = scopeFor(caller, {
      operation: domainOperation,
      deviceId,
      targets: port.targets(...args as never[]).map(sessionId => ({ deviceId, sessionId })),
    });
    await scope.authorize();
    // No normalization of business results: accepted/deferred/no-active-turn remain
    // exactly the port's result. In particular, a successful call is never completed.
    const result = await withSessionOperation(scope, () => port.execute(scope, ...args as never[])) as PortResult<Ports[Key]>;
    if (SESSION_READ_OPERATIONS.includes(domainOperation)) await scope.authorize();
    return result;
  }

  /** Synchronous late guard intended for the port's existing execution lock. */
  function assertExecution(target: SessionTarget, expected: SessionExecutionIdentity): void {
    if (target.deviceId !== deps.deviceId()) {
      throw new SessionAdmissionError('INVALID_ARGS', 'Execution must be checked by its owning device');
    }
    const current = deps.execution(target.sessionId);
    if (!current || current.instanceId !== expected.instanceId || current.generation !== expected.generation) {
      throw new SessionAdmissionError('CONFLICT', 'Session execution changed');
    }
  }

  function assertResources(resources: readonly SessionResourceRef[], remoteHostId: string | null): void {
    for (const resource of resources) {
      if (!isSessionResourceLocalTo(resource, { deviceId: deps.deviceId(), remoteHostId })) {
        throw new SessionAdmissionError('RESOURCE_UNREACHABLE', 'Resource belongs to another device or SSH namespace');
      }
    }
  }

  return { issueCaller, invoke, assertExecution, assertResources };
}

/** Inference helper retains each port's actual argument tuple and return contract. */
export function sessionOperation<Args extends unknown[], Result>(
  port: SessionOperationPort<Args, Result>,
): SessionOperationPort<Args, Result> {
  return port;
}
