import type { Maker, Session, SessionStorage } from '@cindy/maker-core';
import { createSessionController, sessionOperation, SessionAdmissionError, type SessionControllerDeps } from './controller.js';
import { withSessionCaller, type SessionCallerPolicy } from './callerContext.js';

type Identity = { runtime: Session; generation: number };

/** Internal host ports for scheduler/hook/Orca lifecycle transactions. They keep
 * their original native options, callbacks and accepted result. Public explicit
 * Abort/Close requests use lifecycle.ts, including Goal and recovery semantics.
 * Synchronous pre-dispatch cancellation remains in its owning transaction.
 */
export function createNativeSessionController(maker: Pick<Maker, 'createSession' | 'getSession' | 'closeSession'>, deps: SessionControllerDeps,
  storage?: Pick<SessionStorage, 'create'>) {
  const identity = (runtime: Session): Identity => ({ runtime, generation: runtime.getTurnGeneration() });
  const assertRuntime = (expected: Identity) => {
    if (maker.getSession(expected.runtime.id) !== expected.runtime
      || expected.runtime.getTurnGeneration() !== expected.generation) {
      throw new SessionAdmissionError('CONFLICT', 'Session execution changed before the host operation');
    }
  };
  const controller = createSessionController(deps, {
    createRecord: sessionOperation({
      operation: 'createRecord', targets: (_meta: Parameters<SessionStorage['create']>[0]) => [],
      execute: async (scope, meta: Parameters<SessionStorage['create']>[0]) => {
        if (!storage) throw new SessionAdmissionError('UNSUPPORTED_CAPABILITY', 'Record storage is unavailable');
        await scope.authorize();
        return storage.create(meta);
      },
    }),
    ensureRuntime: sessionOperation({
      operation: 'ensureRuntime', targets: (opts: Parameters<Maker['createSession']>[0]) => opts.id ? [opts.id] : [],
      execute: (_scope, opts: Parameters<Maker['createSession']>[0]) => maker.createSession(opts),
    }),
    send: sessionOperation({
      operation: 'send', targets: (expected: Identity, ..._args: Parameters<Session['send']>) => [expected.runtime.id],
      execute: (scope, expected: Identity, message: Parameters<Session['send']>[0], options?: Parameters<Session['send']>[1]) => {
        assertRuntime(expected);
        return expected.runtime.send(message, {
          ...options,
          onDispatching: () => { scope.assertCurrent(); options?.onDispatching?.(); scope.assertCurrent(); },
          onAccepted: async () => { await scope.authorize(); await options?.onAccepted?.(); scope.assertCurrent(); },
        });
      },
    }),
    setModel: sessionOperation({
      operation: 'selectRuntime', targets: (expected: Identity, ..._args: Parameters<Session['setModel']>) => [expected.runtime.id],
      execute: (_scope, expected: Identity, ...args: Parameters<Session['setModel']>) => {
        assertRuntime(expected);
        return expected.runtime.setModel(...args);
      },
    }),
    setEffort: sessionOperation({ operation: 'selectRuntime', targets: (expected: Identity, _effort: Parameters<Session['setEffort']>[0]) => [expected.runtime.id],
      execute: (_scope, expected: Identity, effort: Parameters<Session['setEffort']>[0]) => { assertRuntime(expected); return expected.runtime.setEffort(effort); } }),
    setFastMode: sessionOperation({ operation: 'selectRuntime', targets: (expected: Identity, _enabled: boolean) => [expected.runtime.id],
      execute: (_scope, expected: Identity, enabled: boolean) => { assertRuntime(expected); return expected.runtime.setFastMode(enabled); } }),
    closeOwnedRuntime: sessionOperation({
      operation: 'closeRuntime', targets: (expected: Identity) => [expected.runtime.id],
      execute: (_scope, expected: Identity) => { assertRuntime(expected); return maker.closeSession(expected.runtime.id); },
    }),
    closeOwnedHandle: sessionOperation({ operation: 'closeRuntime', targets: (expected: Identity) => [expected.runtime.id],
      execute: (_scope, expected: Identity) => { assertRuntime(expected); return expected.runtime.close(); } }),
    abortOwnedRuntime: sessionOperation({ operation: 'abortTurn', targets: (expected: Identity) => [expected.runtime.id],
      execute: (_scope, expected: Identity) => { assertRuntime(expected); return expected.runtime.abort(); } }),
  });
  const ports = {
    createRecord: (policy: SessionCallerPolicy, meta: Parameters<SessionStorage['create']>[0]) =>
      withSessionCaller(policy, () => controller.invoke(controller.issueCaller(policy), 'createRecord', meta)),
    ensureRuntime: (policy: SessionCallerPolicy, opts: Parameters<Maker['createSession']>[0]) =>
      withSessionCaller(policy, () => controller.invoke(controller.issueCaller(policy), 'ensureRuntime', opts)),
    send: (policy: SessionCallerPolicy, runtime: Session, ...args: Parameters<Session['send']>) =>
      withSessionCaller(policy, () => controller.invoke(controller.issueCaller(policy), 'send', identity(runtime), ...args)),
    setModel: (policy: SessionCallerPolicy, runtime: Session, ...args: Parameters<Session['setModel']>) =>
      withSessionCaller(policy, () => controller.invoke(controller.issueCaller(policy), 'setModel', identity(runtime), ...args)),
    setEffort: (policy: SessionCallerPolicy, runtime: Session, effort: Parameters<Session['setEffort']>[0]) =>
      withSessionCaller(policy, () => controller.invoke(controller.issueCaller(policy), 'setEffort', identity(runtime), effort)),
    setFastMode: (policy: SessionCallerPolicy, runtime: Session, enabled: boolean) =>
      withSessionCaller(policy, () => controller.invoke(controller.issueCaller(policy), 'setFastMode', identity(runtime), enabled)),
    closeOwnedRuntime: (policy: SessionCallerPolicy, runtime: Session) =>
      withSessionCaller(policy, () => controller.invoke(controller.issueCaller(policy), 'closeOwnedRuntime', identity(runtime))),
    closeOwnedHandle: (policy: SessionCallerPolicy, runtime: Session) =>
      withSessionCaller(policy, () => controller.invoke(controller.issueCaller(policy), 'closeOwnedHandle', identity(runtime))),
    abortOwnedRuntime: (policy: SessionCallerPolicy, runtime: Session) =>
      withSessionCaller(policy, () => controller.invoke(controller.issueCaller(policy), 'abortOwnedRuntime', identity(runtime))),
  };
  return { ...ports,
    /** A narrow host view, not a replacement runtime or Proxy in Maker's registry. */
    ownedView(policy: SessionCallerPolicy, runtime: Session, isStopping?: () => boolean): Pick<Session, 'id' | 'agentKind' | 'send' | 'abort' | 'onEvent' | 'onStatusChange' | 'getStatus' | 'isTurnRunning'> {
      return { id: runtime.id, agentKind: runtime.agentKind,
        send: (...args) => ports.send(policy, runtime, ...args), abort: () => {
          if (!isStopping?.()) return ports.abortOwnedRuntime(policy, runtime);
          // Physical cleanup of this host's exact handle must remain possible
          // after logout clears the database. No lookup-by-id, record write,
          // replacement runtime, or new user operation is admitted here.
          try {
            assertRuntime(identity(runtime));
            return runtime.abort();
          } catch (error) { return Promise.reject(error); }
        },
        onEvent: listener => runtime.onEvent(listener), onStatusChange: listener => runtime.onStatusChange(listener), getStatus: () => runtime.getStatus(), isTurnRunning: () => runtime.isTurnRunning() };
    },
  };
}
