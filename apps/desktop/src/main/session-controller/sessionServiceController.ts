import { createSessionController, sessionOperation, type SessionControllerDeps } from './controller.js';
import { requireSessionCaller } from './callerContext.js';
import type { SessionService } from './sessionService.js';
import { createSessionManagementController } from './management.js';

/** Existing implementations are injected once; all ordinary callers enter the same controller. */
export function createSessionServiceController(deps: SessionControllerDeps, service: SessionService): SessionService {
  const controller = createSessionController(deps, {
    ensureRuntime: sessionOperation({ operation: 'ensureRuntime', targets: (p: { sessionId: string }) => [p.sessionId],
      execute: (_scope, p: { sessionId: string }) => service.ensureRuntime(p) }),
    changePermission: sessionOperation({ operation: 'changePermission',
      targets: (p: Parameters<SessionService['changePermission']>[0]) => [p.sessionId],
      execute: (_scope, p: Parameters<SessionService['changePermission']>[0]) => service.changePermission(p) }),
    compact: sessionOperation({ operation: 'compact',
      targets: (p: Parameters<SessionService['compact']>[0]) => [p.sessionId],
      execute: (_scope, p: Parameters<SessionService['compact']>[0]) => service.compact(p) }),
    sendHostInput: sessionOperation({
      operation: 'send', targets: (p: Parameters<SessionService['sendHostInput']>[0]) => [p.targetSessionId],
      execute: (_scope, p: Parameters<SessionService['sendHostInput']>[0]) => service.sendHostInput(p),
    }),
    listActiveSessions: sessionOperation({
      operation: 'listActive', targets: () => [],
      execute: () => service.listActiveSessions(),
    }),
    sessionCapabilities: sessionOperation({
      operation: 'capabilities', targets: (id: string) => [id],
      execute: (_scope, id: string) => service.sessionCapabilities(id),
    }),
    stopBackgroundTask: sessionOperation({
      operation: 'stopBackgroundTask', targets: (p: Parameters<SessionService['stopBackgroundTask']>[0]) => [p.sessionId],
      execute: (_scope, p: Parameters<SessionService['stopBackgroundTask']>[0]) => service.stopBackgroundTask(p),
    }),
    abortSession: sessionOperation({
      operation: 'abortTurn', targets: (p: Parameters<SessionService['abortSession']>[0]) => [p.sessionId],
      execute: (_scope, p: Parameters<SessionService['abortSession']>[0]) => service.abortSession(p),
    }),
    closeSession: sessionOperation({
      operation: 'closeRuntime', targets: (p: Parameters<SessionService['closeSession']>[0]) => [p.sessionId],
      execute: (_scope, p: Parameters<SessionService['closeSession']>[0]) => service.closeSession(p),
    }),
    inspectSession: sessionOperation({
      operation: 'inspect', targets: (id: string) => [id],
      execute: (_scope, id: string) => service.inspectSession(id),
    }),
    diagnoseSession: sessionOperation({
      operation: 'diagnose', targets: (id: string) => [id],
      execute: (_scope, id: string) => service.diagnoseSession(id),
    }),
    listSessionQueue: sessionOperation({
      operation: 'inspectQueue', targets: (id: string) => [id],
      execute: (_scope, id: string) => service.listSessionQueue(id),
    }),
    listSessionQueuedCounts: sessionOperation({
      operation: 'inspectQueue', targets: (ids: string[]) => ids,
      execute: (_scope, ids: string[]) => service.listSessionQueuedCounts(ids),
    }),
    updateSessionQueuedMessage: sessionOperation({
      operation: 'editOwnedInput', targets: (p: Parameters<SessionService['updateSessionQueuedMessage']>[0]) => [p.targetSessionId],
      execute: (_scope, p: Parameters<SessionService['updateSessionQueuedMessage']>[0]) => service.updateSessionQueuedMessage(p),
    }),
    cancelSessionQueuedMessage: sessionOperation({
      operation: 'withdrawOwnedInput', targets: (p: Parameters<SessionService['cancelSessionQueuedMessage']>[0]) => [p.targetSessionId],
      execute: (_scope, p: Parameters<SessionService['cancelSessionQueuedMessage']>[0]) => service.cancelSessionQueuedMessage(p),
    }),
    steerSession: sessionOperation({
      operation: 'steer', targets: (p: Parameters<SessionService['steerSession']>[0]) => [p.targetSessionId],
      execute: (_scope, p: Parameters<SessionService['steerSession']>[0]) => service.steerSession(p),
    }),
    stopSessionTurn: sessionOperation({
      operation: 'requestStop', targets: (p: Parameters<SessionService['stopSessionTurn']>[0]) => [p.targetSessionId],
      execute: (_scope, p: Parameters<SessionService['stopSessionTurn']>[0]) => service.stopSessionTurn(p),
    }),
    getSessionRuntime: sessionOperation({
      operation: 'inspectRuntime', targets: (p: Parameters<SessionService['getSessionRuntime']>[0]) => [p.targetSessionId],
      execute: (_scope, p: Parameters<SessionService['getSessionRuntime']>[0]) => service.getSessionRuntime(p),
    }),
    setSessionRuntime: sessionOperation({
      operation: 'selectRuntime', targets: (p: Parameters<SessionService['setSessionRuntime']>[0]) => [p.targetSessionId],
      execute: (_scope, p: Parameters<SessionService['setSessionRuntime']>[0]) => service.setSessionRuntime(p),
    }),
    sendToSession: sessionOperation({
      operation: (p: Parameters<SessionService['sendToSession']>[0]) => p.targetSessionId ? 'send' : 'createRecord',
      targets: (p: Parameters<SessionService['sendToSession']>[0]) => p.targetSessionId ? [p.targetSessionId] : [],
      execute: (_scope, p: Parameters<SessionService['sendToSession']>[0]) => service.sendToSession(p),
    }),
  });
  const caller = () => controller.issueCaller(requireSessionCaller());
  return {
    ...createSessionManagementController(deps, service),
    ensureRuntime: p => controller.invoke(caller(), 'ensureRuntime', p),
    changePermission: p => controller.invoke(caller(), 'changePermission', p),
    compact: p => controller.invoke(caller(), 'compact', p),
    sendHostInput: p => controller.invoke(caller(), 'sendHostInput', p),
    listActiveSessions: () => controller.invoke(caller(), 'listActiveSessions'),
    sessionCapabilities: id => controller.invoke(caller(), 'sessionCapabilities', id),
    stopBackgroundTask: p => controller.invoke(caller(), 'stopBackgroundTask', p),
    abortSession: p => controller.invoke(caller(), 'abortSession', {
      ...p, expectedExecution: p.expectedExecution === undefined ? deps.execution(p.sessionId) : p.expectedExecution,
    }),
    closeSession: p => controller.invoke(caller(), 'closeSession', {
      ...p, expectedExecution: p.expectedExecution === undefined ? deps.execution(p.sessionId) : p.expectedExecution,
    }),
    inspectSession: id => controller.invoke(caller(), 'inspectSession', id),
    diagnoseSession: id => controller.invoke(caller(), 'diagnoseSession', id),
    listSessionQueue: id => controller.invoke(caller(), 'listSessionQueue', id),
    listSessionQueuedCounts: ids => controller.invoke(caller(), 'listSessionQueuedCounts', ids),
    updateSessionQueuedMessage: p => controller.invoke(caller(), 'updateSessionQueuedMessage', p),
    cancelSessionQueuedMessage: p => controller.invoke(caller(), 'cancelSessionQueuedMessage', p),
    steerSession: p => controller.invoke(caller(), 'steerSession', p),
    stopSessionTurn: p => controller.invoke(caller(), 'stopSessionTurn', {
      ...p, expectedExecution: p.expectedExecution === undefined ? deps.execution(p.targetSessionId) : p.expectedExecution,
    }),
    getSessionRuntime: p => controller.invoke(caller(), 'getSessionRuntime', p),
    setSessionRuntime: p => controller.invoke(caller(), 'setSessionRuntime', p),
    sendToSession: p => controller.invoke(caller(), 'sendToSession', p),
  };
}
