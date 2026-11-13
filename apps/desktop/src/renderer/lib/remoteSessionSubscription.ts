/** Window-local owners share the host's window-scoped session topic. */
interface Subscription {
  owners: Set<symbol>;
  pending: number;
  ack?: Promise<void>;
  offStatus?: () => void;
}
const subscriptions = new Map<string, Subscription>();

export function createRemoteSessionSubscription(deviceId: string, sessionId: string) {
  const key = JSON.stringify([deviceId, sessionId]);
  const topics = [`session:${sessionId}`];
  const token = Symbol();
  let released = false;
  const releaseIfUnused = (entry: Subscription) => {
    if (subscriptions.get(key) !== entry || entry.owners.size || entry.pending) return;
    subscriptions.delete(key);
    entry.offStatus?.();
    void window.electronAPI.deviceLink.unsubscribe(deviceId, topics).catch(() => undefined);
  };
  return {
    // New owners share the current ACK, including after it settles. Repeating
    // subscribe on an existing owner normally needs a fresh remote ACK. History
    // can reuse a held ACK while reacquiring one cleared by an earlier failure.
    subscribe({ reuse = false }: { reuse?: boolean } = {}) {
      if (released) return Promise.resolve();
      const entry: Subscription = subscriptions.get(key) ?? { owners: new Set<symbol>(), pending: 0 };
      if (!subscriptions.has(key)) {
        // Main clears window topic references when the active link is torn down.
        // Keep the owners, but never reuse an ACK from that stopped link.
        const offStatus = window.electronAPI.deviceLink.onStatusChanged?.(({ status }) => {
          if (status === 'stopped') entry.ack = undefined;
        });
        const offControl = window.electronAPI.deviceLink.onControlTargetChanged?.((payload) => {
          if (payload.deviceId === deviceId && !payload.enabled) entry.ack = undefined;
        });
        entry.offStatus = () => { offStatus?.(); offControl?.(); };
      }
      subscriptions.set(key, entry);
      const recovering = !reuse && entry.owners.has(token);
      entry.owners.add(token);
      if (!recovering && entry.ack) return entry.ack;
      entry.pending++;
      const ack: Promise<void> = window.electronAPI.deviceLink.subscribe(deviceId, topics)
        .then(() => undefined)
        .catch((error) => {
          // A failed acquisition must not poison a later owner's retry. An
          // older failure must not discard a newer recovery's ACK either.
          if (entry.ack === ack) entry.ack = undefined;
          throw error;
        })
        .finally(() => {
          entry.pending--;
          // The last ACK can settle after its owner leaves or is replaced.
          releaseIfUnused(entry);
        });
      entry.ack = ack;
      return ack;
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
