import type { TodoDispatchInput, TodoDispatchResult } from './botTodoAccess.js';

/** Consume the existing coordinator's dispatch/discard receipts; enqueue is not dispatch. */
export function createBotTodoDispatch(
  send: (input: TodoDispatchInput) => Promise<TodoDispatchResult>,
  restored?: (sessionId: string, requestId: string, dispatched: boolean) => Promise<void>,
) {
  const pending = new Map<string, TodoDispatchInput>();
  const key = (sessionId: string, requestId: string) => sessionId + '\0' + requestId;
  return {
    async dispatch(input: TodoDispatchInput): Promise<TodoDispatchResult> {
      const id = key(input.sessionId, input.requestId);
      pending.set(id, input);
      try {
        const result = await send(input);
        if (!result.ok || !result.queued) pending.delete(id);
        return result;
      } catch (error) {
        pending.delete(id);
        throw error;
      }
    },
    async settle(sessionId: string, requestId: string, dispatched: boolean): Promise<void> {
      const id = key(sessionId, requestId);
      const input = pending.get(id);
      if (!input) {
        await restored?.(sessionId, requestId, dispatched);
        return;
      }
      try {
        input.assertCurrent();
      } catch (error) {
        // A switched-back owner has a new generation. Rebuild from its current profile,
        // never run the old closure or write a different owner's home.
        if (!restored || !input.canRecover()) throw error;
        await restored(sessionId, requestId, dispatched);
        if (pending.get(id) === input) pending.delete(id);
        return;
      }
      await input.onSettled({ ok: dispatched, ...(!dispatched ? { error: 'CANCELLED' } : {}) });
      if (pending.get(id) === input) pending.delete(id);
    },
  };
}
