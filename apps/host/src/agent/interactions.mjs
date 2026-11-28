import { installDesktopInteractionHandler, requestHostInteraction, allowHostPagePermission } from '../../../desktop/src/main/maker-ipc/interactionRouter.ts';
import { redactToolInputForUntrustedBoundary } from '../../../desktop/src/main/toolInputRedaction.ts';
import { defaultDecisionForPending } from '../../../desktop/src/main/maker-ipc/sessionEventPreparationSteps.ts';

/** Client presentation for the shared Session interaction router. Routing,
 * aborts and unattended-turn policy remain the same as Desktop and IM. */
export function createInteractionBroker(deps) {
  const pending = new Map();
  const bindings = new Map();

  // A card closed without an answer (abort, replaced runtime, owner change, duplicate request id) gets
  // the desktop's default decision (register.ts uses the same defaultDecisionForPending).

  function settle(entry, decision, reason) {
    if (pending.get(entry.request.requestId) !== entry) return false;
    pending.delete(entry.request.requestId);
    const { binding, request, persistId } = entry;
    if (binding.isCurrent()) {
      if (request.kind === 'ask_user_question' || request.kind === 'plan_review') {
        binding.history?.onInteractionResolved(binding.sessionId, persistId, request.kind, request, decision);
      }
      deps.hub.publish({ type: 'interaction_dismissed', sessionId: binding.sessionId,
        requestId: request.requestId, reason, decision });
    }
    entry.resolve(decision);
    return true;
  }

  function detach(sessionId, reason = 'session_closed') {
    const binding = bindings.get(sessionId);
    if (!binding) return;
    bindings.delete(sessionId);
    for (const entry of pending.values()) {
      if (entry.binding === binding) settle(entry, defaultDecisionForPending(entry.request.kind, reason), reason);
    }
  }

  const api = {
    attach(session, sessionId, options = {}) {
      if (!session || typeof session.setInteractionListener !== 'function') return;
      if (bindings.get(sessionId)?.session === session) return;
      detach(sessionId, 'session_replaced');
      const binding = { session, sessionId, history: options.history,
        isCurrent: options.isCurrent ?? (() => true), isPaused: options.isPaused ?? (() => false) };
      bindings.set(sessionId, binding);
      installDesktopInteractionHandler(session, request => {
        if (!binding.isCurrent() || bindings.get(sessionId) !== binding) {
          return Promise.resolve(defaultDecisionForPending(request.kind, 'owner_changed'));
        }
        if (!request.requestId || pending.has(request.requestId)) {
          return Promise.resolve(defaultDecisionForPending(request.kind, 'duplicate_request_id'));
        }
        return new Promise(resolve => {
          binding.history?.flushAssistantBlock(sessionId);
          const persistId = binding.history?.onInteractionMessage(sessionId, request);
          // As the desktop (register.ts installDesktopInteractionListener): a permission request
          // reaches the clients and the device link with its tool input redacted; the Host keeps
          // the original for the decision.
          const boundaryRequest =
            request.kind === 'permission'
              ? {
                  ...request,
                  input: redactToolInputForUntrustedBoundary(
                    request.toolName,
                    request.input,
                  ),
                }
              : request;
          pending.set(request.requestId, { binding, request, boundaryRequest, persistId, resolve });
          deps.hub.publish({ type: 'interaction_request', sessionId,
            request: { ...boundaryRequest, ...(persistId ? { persistId } : {}) } });
        });
      }, (requestId, decision) => {
        const entry = pending.get(requestId);
        if (entry?.binding === binding) settle(entry, decision, 'aborted');
      }, (requestId, decision) => {
        const entry = pending.get(requestId);
        if (entry?.binding === binding) settle(entry, decision, 'resolved');
      });
    },

    requestHost(sessionId, request, signal, options) {
      signal.throwIfAborted();
      if (!options.isCurrent()) return Promise.resolve(defaultDecisionForPending(request.kind, 'owner_changed'));
      // Historical cards have no running Agent. The interaction-only object is
      // the same surface used by Desktop; it cannot execute a task or grant FS.
      const session = options.session ?? bindings.get(sessionId)?.session
        ?? { id: sessionId, setInteractionListener() {} };
      api.attach(session, sessionId, { isCurrent: options.isCurrent });
      return requestHostInteraction(session, request, signal);
    },

    allowHostPage(sessionId, requestId) {
      const binding = bindings.get(sessionId);
      if (binding?.isCurrent()) allowHostPagePermission(binding.session, requestId);
    },

    // Sidebar status needs only the existence of a current request. Keep the card and tool input in the broker.
    hasPending(sessionId) {
      for (const { binding } of pending.values()) {
        if (binding.sessionId === sessionId && binding.isCurrent()) return true;
      }
      return false;
    },

    pending(sessionId) {
      return [...pending.values()].filter(entry => entry.binding.sessionId === sessionId && entry.binding.isCurrent())
        .map(({ request, boundaryRequest, persistId }) => ({ requestId: request.requestId,
          request: { ...boundaryRequest, ...(persistId ? { persistId } : {}) } }));
    },

    respond(sessionId, requestId, decision) {
      const entry = pending.get(String(requestId ?? ''));
      if (!entry || (sessionId && entry.binding.sessionId !== sessionId)) return false;
      if (!entry.binding.isCurrent() || bindings.get(entry.binding.sessionId) !== entry.binding) {
        settle(entry, defaultDecisionForPending(entry.request.kind, 'owner_changed'), 'owner_changed');
        return false;
      }
      if (entry.binding.isPaused()) return false;
      const kind = entry.request.kind;
      if (!decision || typeof decision !== 'object' || Array.isArray(decision)
        || (decision.kind !== undefined && decision.kind !== kind)) return false;
      if (kind === 'ask_user_question') {
        // An editing acknowledgement must not resume the harness as an answer.
        if (decision.inProgress === true) return entry.request.isBlocking === false;
        if (!decision.answers || typeof decision.answers !== 'object' || Array.isArray(decision.answers)
          || Object.values(decision.answers).some(answer => typeof answer !== 'string')) return false;
      } else if (decision.behavior !== 'allow' && decision.behavior !== 'deny') return false;
      return settle(entry, { ...decision, kind }, 'resolved');
    },

    /** As the desktop's clearPendingInteraction (register.ts): the card leaves the pending ones, unsettled;
     * the caller resolves it and saves its decision (sessionEventPreparationSteps.ts). Only the task's own
     * card: another task's request id is not this runtime's to close. */
    clearPending(requestId, sessionId) {
      const entry = pending.get(requestId);
      if (!entry || entry.binding.sessionId !== sessionId) return null;
      pending.delete(requestId);
      return { kind: entry.request.kind, request: entry.request, persistId: entry.persistId, resolve: entry.resolve };
    },

    detach,
    dispose() { for (const id of bindings.keys()) detach(id); },
  };
  return api;
}
