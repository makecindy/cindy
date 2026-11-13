import type { RelayClusterBackend, RelayClusterMember, RelayStateEntry } from './cluster.js';

/**
 * Reference RelayClusterBackend for replicas in one process (tests, local trials). It keeps the
 * contract a database-backed implementation must keep: per-key versions, all-or-nothing commits,
 * asynchronous change delivery in commit order, single-claim nonces and a live member list.
 */
export function createMemoryRelayCluster(): RelayClusterBackend {
  const entries = new Map<string, { version: number; value?: unknown }>();
  const changeListeners = new Set<(entries: RelayStateEntry[]) => void>();
  const memberListeners = new Set<(members: readonly RelayClusterMember[]) => void>();
  const nonces = new Map<string, number>();
  let members: RelayClusterMember[] = [];
  const entry = (key: string): RelayStateEntry => {
    const current = entries.get(key);
    return current?.value === undefined ? { key, version: current?.version ?? 0 } : { key, version: current.version, value: structuredClone(current.value) };
  };
  // Deliveries are queued in commit order; a real backend's notifications also arrive later.
  let delivery = Promise.resolve();
  const later = (work: () => void) => { delivery = delivery.then(() => new Promise<void>(resolve => setImmediate(() => { work(); resolve(); }))); };
  const announceMembers = () => {
    const snapshot = members.map(member => ({ ...member }));
    later(() => { for (const listener of memberListeners) listener(snapshot); });
  };
  return {
    async snapshot() {
      return [...entries.keys()].map(entry).filter(item => item.value !== undefined);
    },
    async commit({ expected, writes }) {
      const moved = Object.entries(expected).filter(([key, version]) => (entries.get(key)?.version ?? 0) !== version);
      if (moved.length) return { ok: false, latest: moved.map(([key]) => entry(key)) };
      const committed = writes.map(({ key, value }) => {
        entries.set(key, { version: (entries.get(key)?.version ?? 0) + 1, ...(value === undefined ? {} : { value: structuredClone(value) }) });
        return entry(key);
      });
      later(() => { for (const listener of changeListeners) listener(committed.map(item => structuredClone(item))); });
      return { ok: true, versions: Object.fromEntries(committed.map(item => [item.key, item.version])) };
    },
    onChange(listener) { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
    async claimNonce(id, expiresAt) {
      const at = Date.now();
      for (const [nonce, until] of nonces) if (until <= at) nonces.delete(nonce);
      if (nonces.has(id)) return false;
      nonces.set(id, expiresAt); return true;
    },
    async join(member) {
      members = [...members.filter(item => item.id !== member.id), { ...member }];
      announceMembers();
    },
    async leave(id) {
      members = members.filter(item => item.id !== id);
      announceMembers();
    },
    members() { return members.map(member => ({ ...member })); },
    onMembers(listener) { memberListeners.add(listener); return () => { memberListeners.delete(listener); }; },
  };
}
