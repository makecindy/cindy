import {createBotTodoDispatch} from './botTodoDispatch.js';
import type {createBotTodoAccess,TodoDispatchInput,TodoDispatchResult} from './botTodoAccess.js';
import type {createAgentInputQueueStore} from '@cindy/runtime-db/agentInputQueueSnapshots';
import type {createCurrentDbClient} from '@cindy/runtime-db/client/current';
import type {AgentInputCoordinator} from './agent-input-coordinator.js';
import type {Logger} from '@cindy/maker-core';
export function createBotTodoDelivery(host:Pick<ReturnType<typeof createBotTodoAccess>,'configureBotTodoDispatch'|'settleBotTodoForSession'>&Pick<ReturnType<typeof createAgentInputQueueStore>,'readInputDeliveryReceipts'|'saveCancelledInputDelivery'>&{
 send(input:TodoDispatchInput):Promise<TodoDispatchResult>;
 getCurrentDbClientSnapshot:ReturnType<typeof createCurrentDbClient>['getCurrentDbClientSnapshot'];
 isAppSessionBoundaryPending():boolean;
 inputCoordinator:Pick<AgentInputCoordinator,'ensureQueueRestored'|'isQueueRestored'|'hasQueuedItemWhere'>;
 log:Pick<Logger,'warn'>;
}) {
 const {send,configureBotTodoDispatch,settleBotTodoForSession,readInputDeliveryReceipts,saveCancelledInputDelivery,getCurrentDbClientSnapshot,isAppSessionBoundaryPending,log}=host;
  const todoDispatch = createBotTodoDispatch(
    send,

    settleBotTodoForSession,
  );
  configureBotTodoDispatch(todoDispatch.dispatch, async (sessionId, requestIds) => {
    const owner = getCurrentDbClientSnapshot();
    const assertCurrent = () => {
      if (
        !owner ||
        getCurrentDbClientSnapshot()?.clientEpoch !== owner.clientEpoch ||
        isAppSessionBoundaryPending()
      )
        throw new Error('OWNER_SCOPE_CHANGED');
    };
    assertCurrent();
    await host.inputCoordinator.ensureQueueRestored(sessionId);
    assertCurrent();
    if (!host.inputCoordinator.isQueueRestored(sessionId)) throw new Error('QUEUE_UNAVAILABLE');
    const recovered: Array<{ requestId: string; state: 'pending' | 'cancelled' | 'unknown' }> = [];
    for (let offset = 0; offset < requestIds.length; offset += 200) {
      const receipts = await readInputDeliveryReceipts(
        sessionId,
        requestIds.slice(offset, offset + 200),
      );
      assertCurrent();
      for (const receipt of receipts) {
        const pending =
          todoDispatch.hasPending(sessionId, receipt.clientId) ||
          receipt.state === 'pending' ||
          host.inputCoordinator.hasQueuedItemWhere(
            sessionId,
            (item) => item.clientId === receipt.clientId,
            { includeRecovery: true },
          );
        // Persisted user text proves receipt, not vendor dispatch. Never replay that uncertainty.
        const cancelled =
          !pending &&
          receipt.state !== 'accepted' &&
          (await saveCancelledInputDelivery(sessionId, receipt.clientId));
        assertCurrent();
        recovered.push({
          requestId: receipt.clientId,
          state: pending ? 'pending' : cancelled ? 'cancelled' : 'unknown',
        });
      }
    }
    return recovered;
  });
  const settleTodoDispatch = (sessionId: string, clientId: string, dispatched: boolean) =>
    todoDispatch.settle(sessionId, clientId, dispatched).catch(() => {
      log.warn('Todo input receipt could not be saved');
    });

return {settleTodoDispatch};
}
