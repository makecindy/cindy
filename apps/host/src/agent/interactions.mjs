import { installDesktopInteractionHandler, requestHostInteraction, allowHostPagePermission } from '../../../desktop/src/main/maker-ipc/interactionRouter.ts';

/** Client presentation for the shared Session interaction router. Routing,
 * aborts and unattended-turn policy remain the same as Desktop and IM. */
export function createInteractionBroker(deps) {
  const pending = new Map();
  const bindings = new Map();

  /** @returns {import('@cindy/maker-core').InteractionDecision} */
  const fallback = (request, reason) => request.kind === 'ask_user_question'
    ? { kind: request.kind, answers: {}, dismissed: true }
    : { kind: request.kind, behavior: 'deny', reason, dismissed: true };

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
      if (entry.binding === binding) settle(entry, fallback(entry.request, reason), reason);
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
          return Promise.resolve(fallback(request, 'owner_changed'));
        }
        if (!request.requestId || pending.has(request.requestId)) {
          return Promise.resolve(fallback(request, 'duplicate_request_id'));
        }
        return new Promise(resolve => {
          binding.history?.flushAssistantBlock(sessionId);
          const persistId = binding.history?.onInteractionMessage(sessionId, request);
          pending.set(request.requestId, { binding, request, persistId, resolve });
          deps.hub.publish({ type: 'interaction_request', sessionId,
            request: { ...request, ...(persistId ? { persistId } : {}) } });
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
      if (!options.isCurrent()) return Promise.resolve(fallback(request, 'owner_changed'));
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

    pending(sessionId) {
      return [...pending.values()].filter(entry => entry.binding.sessionId === sessionId && entry.binding.isCurrent())
        .map(({ request, persistId }) => ({ requestId: request.requestId,
          request: { ...request, ...(persistId ? { persistId } : {}) } }));
    },

    respond(sessionId, requestId, decision) {
      const entry = pending.get(String(requestId ?? ''));
      if (!entry || (sessionId && entry.binding.sessionId !== sessionId)) return false;
      if (!entry.binding.isCurrent() || bindings.get(entry.binding.sessionId) !== entry.binding) {
        settle(entry, fallback(entry.request, 'owner_changed'), 'owner_changed');
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

    detach,
    dispose() { for (const id of bindings.keys()) detach(id); },
  };
  return api;
}
