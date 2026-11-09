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

        return new Promise((resolve) => {
          const entries = bucket(sessionId);
          if (entries.has(requestId)) {
            resolve({ kind: 'permission', behavior: 'deny', reason: 'duplicate request id' });
            return;
          }
          let settled = false;
          const finish = (decision, reason) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            entries.delete(requestId);
            if (entries.size === 0) pending.delete(sessionId);
            deps.hub.publish({ type: 'interaction_dismissed', sessionId, requestId, reason });
            resolve(decision);
          };
          const onAbort = () => finish({ kind: 'permission', behavior: 'deny', reason: 'aborted' }, 'aborted');
          entries.set(requestId, { request, resolve: decision => finish(decision, 'resolved') });
          if (signal?.aborted) { onAbort(); return; }
          signal?.addEventListener('abort', onAbort, { once: true });
          deps.hub.publish({ type: 'interaction_request', sessionId, request });
        });
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
        return false;
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
