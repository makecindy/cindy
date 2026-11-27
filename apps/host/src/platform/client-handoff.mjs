/** Platform operations stay with the signed client. Only undispatched work may
 * wait for its replacement; a dispatched operation is never replayed. */
export function createPlatformClientHandoff({ assertCurrent, maxWaiting = 128, isRetired = async (_identity) => false }) {
  let client = null, paused = false, closed = false, lost = false;
  let inFlight = 0, preparing = false, prepared = false;
  const waiting = new Set();
  const sessionClients = new Map();
  const check = () => {
    if (closed) throw Error('PLATFORM_RUNTIME_CLOSED');
    assertCurrent();
  };
  const matches = identity => client?.id === identity.id && client?.pid === identity.pid;
  function wake() {
    if (!client || paused) return;
    for (const waiter of waiting) waiter.resolve();
    waiting.clear();
  }
  function rejectWaiting(error) {
    for (const waiter of waiting) waiter.reject(error);
    waiting.clear();
  }
  return {
    attach(next) {
      check();
      if (!next?.id || !Number.isSafeInteger(next.pid) || next.pid <= 0
        || typeof next.call !== 'function' || typeof next.canDetach !== 'function'
        || typeof next.resume !== 'function')
        throw Error('PLATFORM_CLIENT_INVALID');
      if (client) throw Error('PLATFORM_CLIENT_ALREADY_ATTACHED');
      client = next; prepared = false; lost = false; paused = false; wake();
    },
    async call(operation, { signal, sessionId } = {}) {
      for (;;) {
        check(); signal?.throwIfAborted();
        if (client && !paused) break;
        if (waiting.size >= maxWaiting) throw Error('PLATFORM_WAIT_QUEUE_FULL');
        await new Promise((resolve, reject) => {
          const waiter = { resolve: () => { cleanup(); resolve(); }, reject: error => { cleanup(); reject(error); } };
          const abort = () => waiter.reject(signal.reason);
          const cleanup = () => { waiting.delete(waiter); signal?.removeEventListener('abort', abort); };
          waiting.add(waiter); signal?.addEventListener('abort', abort, { once: true });
        });
      }
      const selected = client;
      if (sessionId) sessionClients.set(sessionId, { id: selected.id, pid: selected.pid });
      // No await between selection and admission: prepare() cannot miss a call.
      inFlight++;
      try {
        const result = await selected.call(operation, { signal });
        check(); signal?.throwIfAborted();
        if (client !== selected || lost) throw Error('PLATFORM_CLIENT_RESULT_UNCERTAIN');
        return result;
      } finally { inFlight--; }
    },
    async cleanupSession(sessionId, operation) {
      // Cleanup belongs to the process that executed the task, never to its
      // replacement. A frozen/disconnected executor cleans up on its own exit.
      const identity = sessionClients.get(sessionId);
      sessionClients.delete(sessionId);
      if (closed) return;
      check();
      if (!identity || !matches(identity) || paused || lost) return;
      const selected = client;
      inFlight++;
      try { await selected.call(operation); }
      finally { inFlight--; }
    },
    async prepare(identity) {
      check();
      if (!matches(identity) || paused || lost) throw Error('PLATFORM_CLIENT_CHANGED');
      const selected = client;
      paused = true; preparing = true; prepared = false;
      let safeToResume = true;
      try {
        if (inFlight) throw Error('PLATFORM_OPERATIONS_BUSY');
        // The client must freeze local admissions (remote input, page creation)
        // while proving there is no live state which would be lost by exit.
        safeToResume = false;
        const detachable = await selected.canDetach();
        if (detachable === false) { safeToResume = true; throw Error('PLATFORM_STATE_REQUIRES_CLIENT'); }
        if (detachable !== true) throw Error('PLATFORM_CLIENT_FREEZE_UNCONFIRMED');
        check();
        if (client !== selected || lost || inFlight) throw Error('PLATFORM_CLIENT_CHANGED');
        prepared = true;
        return { id: selected.id, pid: selected.pid };
      } catch (error) {
        if (client === selected && !lost && safeToResume) { paused = false; wake(); }
        throw error;
      } finally { preparing = false; }
    },
    async cancel(identity) {
      check();
      if (!matches(identity) || lost || preparing) throw Error('PLATFORM_CLIENT_CHANGED');
      const selected = client;
      if (paused && await selected.resume() !== true) throw Error('PLATFORM_CLIENT_RESUME_UNCONFIRMED');
      check();
      if (client !== selected || lost) throw Error('PLATFORM_CLIENT_CHANGED');
      prepared = false; paused = false; wake();
    },
    detach(identity) {
      check();
      if (!matches(identity) || lost || !paused || !prepared || preparing || inFlight) throw Error('PLATFORM_CLIENT_NOT_DRAINED');
      client = null;
    },
    lost(identity) {
      check();
      if (!matches(identity)) return;
      lost = true; paused = true;
      // In-flight requests remain owned by their original transport and settle
      // there as success/uncertain. Never put them back in the waiting queue.
    },
    async retireLost(identity) {
      check();
      const selected = client;
      if (!matches(identity) || !lost || inFlight) throw Error('PLATFORM_CLIENT_NOT_DRAINED');
      if (await isRetired(identity) !== true) throw Error('PLATFORM_CLIENT_EXIT_UNCONFIRMED');
      check();
      if (client !== selected || inFlight) throw Error('PLATFORM_CLIENT_CHANGED');
      client = null;
    },
    // The same signed process may reconnect only after its old executor has
    // drained. Preserve an acknowledged local freeze; a socket recovery is not
    // permission to cancel a pending upgrade. Identity is a process nonce + PID.
    reconnect(next, frozen) {
      check();
      if (!matches(next) || !lost || inFlight || preparing || typeof frozen !== 'boolean')
        throw Error('PLATFORM_CLIENT_NOT_DRAINED');
      client = next; lost = false; paused = frozen; prepared = frozen; wake();
    },
    status() { return { attached: Boolean(client) && !lost, paused, inFlight, waiting: waiting.size }; },
    close() { closed = true; client = null; sessionClients.clear(); rejectWaiting(Error('PLATFORM_RUNTIME_CLOSED')); },
  };
}
