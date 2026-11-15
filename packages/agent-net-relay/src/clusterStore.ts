import { emptySharingState, type SharingStorage } from '@cindy/device-link-sharing/repositories';
import type { DelegationRequest } from '@cindy/agent-net-protocol';
import type { RelayClusterBackend, RelayStateEntry } from './cluster.js';
import type { NetworkRecord, RelayStore, State, TenantRequestRecord } from './store.js';

const NETWORK = 'network:';
const GLOBAL = new Set(['sharing', 'delegationRequests', 'primaryNetworkId', 'tenantInvites', 'tenantRequests']);
const MAX_ATTEMPTS = 16;

/** Keys another replica committed; `before` holds this replica's previous value of each. */
export interface RelayStoreChange { networks: Set<string>; global: Set<string>; before: Map<string, unknown>; }
/**
 * The shared state could not be read or written (backend unreachable, or every retry lost to other
 * replicas). Not an authorization result: callers answer 503 so clients retry instead of treating
 * the credential as revoked.
 */
export class RelayStateUnavailableError extends Error {
  constructor(readonly code: 'STATE_UNAVAILABLE' | 'STATE_CONTENDED', options?: { cause?: unknown }) { super(code, options); }
}

function normalize(key: string, value: unknown): unknown {
  if (!key.startsWith(NETWORK) || !value || typeof value !== 'object') return value;
  const network = value as NetworkRecord;
  network.pushTokens ??= {}; network.media ??= {};
  return network;
}
function valid(key: string, value: unknown): boolean {
  if (!key.startsWith(NETWORK)) return true;
  const n = value as Partial<NetworkRecord> | null;
  return !!n && typeof n === 'object' && n.id === key.slice(NETWORK.length) && !!n.devices && !!n.joins && !!n.joinCodes && !!n.grants
    && typeof n.rootPublicKey === 'string';
}

/**
 * RelayStore for one replica of a cluster. Like Store it keeps the whole state in memory, so the
 * per-datagram authorization path never waits on the backend. Each network and each global document
 * is a separate versioned key: a transaction commits only the keys it changed, checked against the
 * versions of every key it read, and reruns on a fresh copy when another replica committed first.
 */
export class ClusterStore implements RelayStore {
  private state: State = { schema: 1, networks: Object.create(null) as Record<string, NetworkRecord> };
  private readonly versions = new Map<string, number>();
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(change: RelayStoreChange) => void>();
  private unsubscribe: () => void = () => undefined;
  private constructor(private readonly backend: RelayClusterBackend, private readonly origin: string) {}

  static async open(backend: RelayClusterBackend, origin: string): Promise<ClusterStore> {
    const store = new ClusterStore(backend, origin);
    const early: RelayStateEntry[][] = [];
    let ready = false;
    store.unsubscribe = backend.onChange(entries => { if (ready) store.apply(entries, true); else early.push(entries); });
    try {
      const snapshot = await backend.snapshot();
      if (snapshot.some(entry => entry.value !== undefined && !valid(entry.key, entry.value))) throw new Error('INVALID_AGENT_NET_STATE');
      store.apply(snapshot, false);
    } catch (error) { store.unsubscribe(); throw error; }
    ready = true;
    for (const entries of early) store.apply(entries, true);
    return store;
  }
  network(id: string): NetworkRecord | undefined { return Object.hasOwn(this.state.networks, id) ? structuredClone(this.state.networks[id]) : undefined; }
  networks(): NetworkRecord[] { return Object.values(structuredClone(this.state.networks)); }
  networkIds(): string[] { return Object.keys(this.state.networks); }
  /** A targeted read barrier before control-plane authorization. Notifications may arrive later
   * than a successful write on another replica; datagrams continue using the in-memory view. */
  async synchronize(keys: readonly string[]): Promise<void> {
    const expected = Object.fromEntries([...new Set(keys)].map(key => [key, this.versions.get(key) ?? 0]));
    if (!Object.keys(expected).length) return;
    const result = await this.backend.commit({ origin: this.origin, expected, writes: [] });
    if (!result.ok) {
      if (result.latest.some(entry => entry.value !== undefined && !valid(entry.key, entry.value))) throw new Error('INVALID_AGENT_NET_STATE');
      this.apply(result.latest, true);
    }
  }
  delegationRequests(): DelegationRequest[] { return structuredClone(this.state.delegationRequests ?? []); }
  primaryNetworkId(): string | undefined { return this.state.primaryNetworkId; }
  tenantRequests(): TenantRequestRecord[] { return Object.values(structuredClone(this.state.tenantRequests ?? {})); }
  sharingStorage(): SharingStorage {
    return { read: () => structuredClone(this.state.sharing ?? emptySharingState()), revision: () => this.revision,
      transaction: work => this.transaction(async state => work(state.sharing ??= emptySharingState())) };
  }
  /** Changes committed by other replicas, after they are applied locally. */
  onRemoteChange(listener: (change: RelayStoreChange) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  async transaction<T>(update: (state: State) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // The replica that just committed starts its next commit a round trip ahead of the one that lost;
        // without a growing, jittered pause the loser keeps losing for as long as the winner keeps writing.
        if (attempt) await new Promise(resolve => setTimeout(resolve, Math.min(100, 2 ** attempt) * (0.5 + Math.random())));
        const run = await this.attempt(update);
        if (run.done) return run.result;
      }
      throw new RelayStateUnavailableError('STATE_CONTENDED');
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  async settled(): Promise<void> { await this.queue; }
  /** Refresh under the shared attachment lock, before checking offsets or touching its bytes. */
  mediaOperation<T>(networkId: string, mediaId: string, work: () => Promise<T>): Promise<T> {
    let started = false;
    return this.backend.withMediaLock(NETWORK + networkId, mediaId, async (latest) => {
      if (latest.key !== NETWORK + networkId || latest.value !== undefined && !valid(latest.key, latest.value)) throw new Error('INVALID_AGENT_NET_STATE');
      this.apply([latest], true);
      started = true;
      return work();
    }).catch((error: unknown) => {
      // Failing to take the lock is an outage; errors from the work itself (offset checks, I/O) pass through.
      if (!started) throw new RelayStateUnavailableError('STATE_UNAVAILABLE', { cause: error });
      throw error;
    });
  }
  close(): void { this.unsubscribe(); this.listeners.clear(); }

  private read(key: string): unknown {
    if (key.startsWith(NETWORK)) { const id = key.slice(NETWORK.length); return Object.hasOwn(this.state.networks, id) ? this.state.networks[id] : undefined; }
    return (this.state as unknown as Record<string, unknown>)[key];
  }
  private write(key: string, value: unknown): void {
    if (key.startsWith(NETWORK)) {
      const id = key.slice(NETWORK.length);
      if (value === undefined) delete this.state.networks[id]; else this.state.networks[id] = value as NetworkRecord;
    } else if (value === undefined) delete (this.state as unknown as Record<string, unknown>)[key];
    else (this.state as unknown as Record<string, unknown>)[key] = value;
  }
  private apply(entries: RelayStateEntry[], notify: boolean): void {
    const change: RelayStoreChange = { networks: new Set(), global: new Set(), before: new Map() };
    for (const entry of entries) {
      if (!entry.key.startsWith(NETWORK) && !GLOBAL.has(entry.key)) continue;
      if (entry.version <= (this.versions.get(entry.key) ?? 0)) continue;
      change.before.set(entry.key, this.read(entry.key));
      this.write(entry.key, entry.value === undefined ? undefined : normalize(entry.key, structuredClone(entry.value)));
      this.versions.set(entry.key, entry.version);
      if (entry.key.startsWith(NETWORK)) change.networks.add(entry.key.slice(NETWORK.length)); else change.global.add(entry.key);
    }
    if (!change.before.size) return;
    this.revision++;
    if (notify) for (const listener of this.listeners) listener(change);
  }
  /** One optimistic run: lazily copies each key the update touches and remembers its version. */
  private async attempt<T>(update: (state: State) => T | Promise<T>): Promise<{ done: true; result: T } | { done: false }> {
    const expected: Record<string, number> = {};
    const drafts = new Map<string, { value: unknown }>();
    const touch = (key: string) => { if (!Object.hasOwn(expected, key)) expected[key] = this.versions.get(key) ?? 0; };
    const draft = (key: string): unknown => {
      touch(key);
      let current = drafts.get(key);
      if (!current) { const base = this.read(key); current = { value: base === undefined ? undefined : structuredClone(base) }; drafts.set(key, current); }
      return current.value;
    };
    const assign = (key: string, value: unknown) => { touch(key); drafts.set(key, { value }); };
    const networks = new Proxy(Object.create(null) as Record<string, NetworkRecord>, {
      get: (_target, id) => typeof id === 'string' ? draft(NETWORK + id) : undefined,
      set: (_target, id, value) => { if (typeof id !== 'string') return false; assign(NETWORK + id, value); return true; },
      deleteProperty: (_target, id) => { if (typeof id === 'string') assign(NETWORK + id, undefined); return true; },
      has: (_target, id) => typeof id === 'string' && draft(NETWORK + id) !== undefined,
      ownKeys: () => {
        const ids = new Set(Object.keys(this.state.networks));
        for (const [key, current] of drafts) if (key.startsWith(NETWORK)) {
          if (current.value === undefined) ids.delete(key.slice(NETWORK.length)); else ids.add(key.slice(NETWORK.length));
        }
        return [...ids];
      },
      getOwnPropertyDescriptor: (_target, id) => {
        if (typeof id !== 'string') return undefined;
        const value = draft(NETWORK + id);
        return value === undefined ? undefined : { value, writable: true, enumerable: true, configurable: true };
      },
    });
    const state = new Proxy(Object.create(null) as State, {
      get: (_target, field) => field === 'networks' ? networks : field === 'schema' ? 1
        : typeof field === 'string' && GLOBAL.has(field) ? draft(field) : undefined,
      set: (_target, field, value) => { if (typeof field !== 'string' || !GLOBAL.has(field)) return false; assign(field, value); return true; },
      deleteProperty: (_target, field) => { if (typeof field === 'string' && GLOBAL.has(field)) assign(field, undefined); return true; },
    });
    const result = await update(state);
    const writes: { key: string; value?: unknown }[] = [];
    for (const [key, current] of drafts) {
      if (JSON.stringify(this.read(key)) === JSON.stringify(current.value)) continue;
      writes.push(current.value === undefined ? { key } : { key, value: current.value });
    }
    if (!writes.length) return { done: true, result: structuredClone(result) };
    let committed;
    try { committed = await this.backend.commit({ origin: this.origin, expected, writes }); }
    catch (error) { throw new RelayStateUnavailableError('STATE_UNAVAILABLE', { cause: error }); }
    if (!committed.ok) { this.apply(committed.latest, true); return { done: false }; }
    this.apply(writes.map(write => ({ ...write, version: committed.versions[write.key] })), false);
    return { done: true, result: structuredClone(result) };
  }
}
