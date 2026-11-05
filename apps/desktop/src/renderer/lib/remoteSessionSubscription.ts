/** Window-local owners share the host's window-scoped session topic. */
interface Subscription { owners: Set<symbol>; pending: Promise<void> }
const subscriptions = new Map<string, Subscription>();

export function createRemoteSessionSubscription(deviceId: string, sessionId: string) {
  const key = JSON.stringify([deviceId, sessionId]);
  const topics = [`session:${sessionId}`];
  const token = Symbol();
  let released = false;
  return {
    // Repeated calls deliberately forward: recovery needs a fresh remote ACK.
    subscribe() {
      if (released) return Promise.resolve();
      const entry = subscriptions.get(key) ?? { owners: new Set<symbol>(), pending: Promise.resolve() };
      subscriptions.set(key, entry);
      entry.owners.add(token);
      const request = window.electronAPI.deviceLink.subscribe(deviceId, topics);
      entry.pending = Promise.allSettled([entry.pending, request]).then(() => undefined);
      return request.then(() => undefined);
    },
    release() {
      if (released) return;
      released = true;
      const entry = subscriptions.get(key);
      if (!entry?.owners.delete(token)) return;
      const pending = entry.pending;
      // A replacement view may acquire the same topic while an old ACK is in
      // flight. Check current owners after it settles, before sending cleanup.
      void pending.then(() => {
        if (subscriptions.get(key) !== entry || entry.owners.size || entry.pending !== pending) return;
        subscriptions.delete(key);
        return window.electronAPI.deviceLink.unsubscribe(deviceId, topics);
      }).catch(() => undefined);
    },
  };
}
