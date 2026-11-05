/** Window-local owners share the host's window-scoped session topic. */
interface Subscription { owners: Set<symbol>; pending: number }
const subscriptions = new Map<string, Subscription>();

export function createRemoteSessionSubscription(deviceId: string, sessionId: string) {
  const key = JSON.stringify([deviceId, sessionId]);
  const topics = [`session:${sessionId}`];
  const token = Symbol();
  let released = false;
  const releaseIfUnused = (entry: Subscription) => {
    if (subscriptions.get(key) !== entry || entry.owners.size || entry.pending) return;
    subscriptions.delete(key);
    void window.electronAPI.deviceLink.unsubscribe(deviceId, topics).catch(() => undefined);
  };
  return {
    // Repeated calls deliberately forward: recovery needs a fresh remote ACK.
    subscribe() {
      if (released) return Promise.resolve();
      const entry = subscriptions.get(key) ?? { owners: new Set<symbol>(), pending: 0 };
      subscriptions.set(key, entry);
      entry.owners.add(token);
      entry.pending++;
      return window.electronAPI.deviceLink.subscribe(deviceId, topics).finally(() => {
        entry.pending--;
        // The last ACK can settle after its owner leaves or is replaced.
        releaseIfUnused(entry);
      }).then(() => undefined);
    },
    release() {
      if (released) return;
      released = true;
      const entry = subscriptions.get(key);
      if (!entry?.owners.delete(token)) return;
      // Preserve immediate local cleanup on offline unmount when ACKs have
      // already settled; only in-flight acquisitions require deferred cleanup.
      releaseIfUnused(entry);
    },
  };
}
