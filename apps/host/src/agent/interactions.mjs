/**
 * Interaction broker for the browser/desktop clients.
 *
 * Permission prompts and questions arrive as a request that must be answered
 * before the turn can continue. The desktop main process owns that handshake
 * today; the host takes it over for clients: it publishes the request on the
 * event stream and resolves it from an HTTP response, denying on abort.
 */

/**
 * @param {{hub: {publish: (event: unknown) => void}}} deps
 */
export function createInteractionBroker(deps) {
  /** @type {Map<string, Map<string, {request: unknown, resolve: (decision: unknown) => void}>>} */
  const pending = new Map();
  const attached = new WeakSet();

  function bucket(sessionId) {
    let entries = pending.get(sessionId);
    if (!entries) {
      entries = new Map();
      pending.set(sessionId, entries);
    }
    return entries;
  }

  return {
    /** Install the resolver once per live session. */
    attach(session, sessionId) {
      if (!session || typeof session.setInteractionListener !== 'function') return;
      if (attached.has(session)) return;
      attached.add(session);

      session.setInteractionListener(async (request, signal) => {
        const requestId = String(request?.requestId ?? '');
        if (!requestId) return { kind: 'permission', behavior: 'deny', reason: 'missing request id' };

        const decision = await new Promise((resolve) => {
          bucket(sessionId).set(requestId, { request, resolve });
          deps.hub.publish({ type: 'interaction_request', sessionId, request });
          const onAbort = () => {
            bucket(sessionId).delete(requestId);
            deps.hub.publish({ type: 'interaction_dismissed', sessionId, requestId, reason: 'aborted' });
            resolve({ kind: 'permission', behavior: 'deny', reason: 'aborted' });
          };
          if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        bucket(sessionId).delete(requestId);
        deps.hub.publish({ type: 'interaction_dismissed', sessionId, requestId, reason: 'resolved' });
        return decision;
      });
    },

    pending(sessionId) {
      const entries = pending.get(sessionId);
      if (!entries) return [];
      return [...entries.entries()].map(([requestId, entry]) => ({
        requestId,
        request: entry.request,
      }));
    },

    respond(sessionId, requestId, decision) {
      const rid = String(requestId ?? '');
      if (!rid) return false;
      const fallbackDecision = decision ?? { kind: 'permission', behavior: 'deny', reason: 'dismissed' };
      if (sessionId) {
        const entries = pending.get(sessionId);
        const entry = entries?.get(rid);
        if (entry) {
          entries.delete(rid);
          entry.resolve(fallbackDecision);
          return true;
        }
      }
      for (const entries of pending.values()) {
        const entry = entries.get(rid);
        if (entry) {
          entries.delete(rid);
          entry.resolve(fallbackDecision);
          return true;
        }
      }
      return false;
    },
  };
}
