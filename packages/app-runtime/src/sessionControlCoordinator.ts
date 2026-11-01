import type { SessionControlServiceDeps } from './sessionControlService.js';
import type { createSessionControlInputBuilder } from './sessionControlInput.js';
import type { createAgentRequestCapture } from './agentRequestCapture.js';
import { sessionQueueOriginForDispatcher } from './sessionControlService.js';
import type { createSessionSenderIdentityReader } from './sessionSenderIdentity.js';
import type { AgentInputCoordinator } from './agent-input-coordinator.js';
import type { createQueueReorderAdapter } from '@cindy/im-runtime/sessionQueueControl';

/** Original queue mutations and delivery guards shared by every host. */
export function createSessionControlCoordinator<Meta>(host:{
  captureSessionAgentRequest(sessionId:string,message:string):ReturnType<ReturnType<typeof createAgentRequestCapture>>;
  getSessionMeta(id:string):Promise<Meta|null>;
  buildSessionControlInputItem:ReturnType<typeof createSessionControlInputBuilder<Meta>>;
  readSenderIdentity:ReturnType<typeof createSessionSenderIdentityReader>;
  inputCoordinator:Pick<AgentInputCoordinator,'ensureQueueRestored'|'isQueueRestored'|'steer'|'getQueueControlSnapshot'|'getQueueInspection'|'hasQueuedItemWhere'|'replaceQueuedMessage'|'remove'>;
} & ReturnType<typeof createQueueReorderAdapter>):Pick<SessionControlServiceDeps,'createQueuedMessage'|'steerQueuedMessage'|'getQueueSnapshot'|'replaceQueuedMessage'|'removeQueuedMessage'|'steerStoredQueuedMessage'|'moveQueuedMessage'> {
  const {captureSessionAgentRequest,getSessionMeta,buildSessionControlInputItem,readSenderIdentity,steerStoredControlMessage,moveStoredControlMessage}=host;
  return {
    createQueuedMessage: async ({ targetSessionId, callerSessionId, queuedMessageId, message }) => {
      const request = await captureSessionAgentRequest(callerSessionId, message);
      message = request.message;
      const meta = await getSessionMeta(targetSessionId);
      if (!meta) throw new Error(`session ${targetSessionId} not found`);
      return buildSessionControlInputItem({
        targetSessionId,
        message,
        persistedContent: message,
        clientId: queuedMessageId,
        autoReviewUserText: request.autoReviewUserText,
        meta,
        origin: sessionQueueOriginForDispatcher({
          dispatcherSessionId: callerSessionId,
          ...(await readSenderIdentity(callerSessionId)),
          message,
        }),
      });
    },
    steerQueuedMessage: async (sessionId, item, expectedTurn) => {
      await host.inputCoordinator.ensureQueueRestored(sessionId);
      await expectedTurn.beforeMutation?.();
      return host.inputCoordinator.steer(sessionId, item, {
        touchUserSend: true,
        fallbackToTurn: false,
        expectedTurnSession: expectedTurn.session,
        expectedTurnGeneration: expectedTurn.turnGeneration,
        beforeMutation: expectedTurn.beforeMutation,
      });
    },
    getQueueSnapshot: async (sessionId) => {
      await host.inputCoordinator.ensureQueueRestored(sessionId);
      if (!host.inputCoordinator.isQueueRestored(sessionId)) {
        throw new Error(`queue restore incomplete for ${sessionId}`);
      }
      const snapshot = host.inputCoordinator.getQueueControlSnapshot(sessionId);
      const consumingClientIds = host.inputCoordinator
        .getQueueInspection(sessionId)
        .filter((entry) => entry.consuming)
        .map((entry) => entry.queuedMessageId);
      return { pendingQueue: snapshot.pendingQueue, consumingClientIds };
    },
    replaceQueuedMessage: (sessionId, clientId, next, expected) =>
      (!expected || host.inputCoordinator.hasQueuedItemWhere(sessionId, item => item === expected))
      && host.inputCoordinator.replaceQueuedMessage(sessionId, clientId, next),
    removeQueuedMessage: (sessionId, clientId, expected) => {
      if (!host.inputCoordinator.hasQueuedItemWhere(sessionId, (item) => item.clientId === clientId && (!expected || item === expected))) {
        return false;
      }
      host.inputCoordinator.remove(sessionId, clientId);
      return !host.inputCoordinator.hasQueuedItemWhere(sessionId, (item) => item.clientId === clientId);
    },
    steerStoredQueuedMessage: steerStoredControlMessage,
    moveQueuedMessage: moveStoredControlMessage,
  };
}
