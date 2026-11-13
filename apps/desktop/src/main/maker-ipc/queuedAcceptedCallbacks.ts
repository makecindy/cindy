import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import type { AgentInputSendOpts, AgentInputSendResult } from './agent-input-coordinator.js';
import { runAcceptedCallback, runAcceptedRollback, type AcceptedCallbackLogger } from './acceptedCallbackRunner.js';

/** queued 消息的 accepted 副作用状态，用于派发失败时只回滚已经执行过的副作用。 */
interface QueuedAcceptedCallback {
  accepted: () => void | Promise<void>;
  rollback?: (reason?: 'cancelled-before-dispatch') => void | Promise<void>;
  commit?: () => void | Promise<void>;
  didRun: boolean;
}

/** One callback lifecycle for scheduled and inter-agent queued delivery. */
export function createQueuedAcceptedCallbacks(log?: AcceptedCallbackLogger) {
  const callbacks = new Map<string, QueuedAcceptedCallback>();

  const register = (
    clientId: string,
    accepted: () => void | Promise<void>,
    rollback?: (reason?: 'cancelled-before-dispatch') => void | Promise<void>,
    commit?: () => void | Promise<void>,
  ): void => {
    callbacks.set(clientId, {
      accepted,
      rollback,
      commit,
      didRun: false,
    });
  };

  const rollback = async (
    sessionId: string,
    clientId: string | undefined,
  ): Promise<void> => {
    if (!clientId) return;
    const callback = callbacks.get(clientId);
    if (!callback?.didRun) return;
    callbacks.delete(clientId);
    await runAcceptedRollback(callback.rollback, sessionId, clientId, log);
  };

  const settle = async (
    sessionId: string,
    sendOpts: AgentInputSendOpts,
    result: AgentInputSendResult,
  ): Promise<void> => {
    const clientId = sendOpts.persistUserMessage?.clientId;
    if (!clientId) return;
    const callback = callbacks.get(clientId);
    if (!callback) return;
    if (result.kind === 'session-dispatch' && result.dispatched) {
      callbacks.delete(clientId);
      if (callback.didRun) {
        await runAcceptedCallback(callback.commit, sessionId, clientId, log);
      }
      return;
    }
    if (callback.didRun) {
      callbacks.delete(clientId);
      const reason =
        result.kind === 'session-dispatch' && result.reason === 'cancelled-before-dispatch'
          ? result.reason
          : undefined;
      await runAcceptedRollback(
        () => callback.rollback?.(reason),
        sessionId,
        clientId,
        log,
      );
    }
  };

  const run = (
    sessionId: string,
    item: AgentInputQueuedMessage,
  ): Promise<void> | undefined => {
    const callback = callbacks.get(item.clientId);
    if (!callback) return undefined;
    callback.didRun = true;
    return runAcceptedCallback(callback.accepted, sessionId, item.clientId, log);
  };

  const discard = (clientId: string): void => {
    callbacks.delete(clientId);
  };

  return { register, rollback, settle, run, discard, has: (id: string) => callbacks.has(id) };
}
