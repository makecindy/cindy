/** Local resource policy only; neither provider execution concurrency nor a wire limit. */
export const DIRECT_LINK_MAX_PEERS = 16;
/** Initial desktop ceiling verified by direct-link-smoke --capacity; Mobile stays at 16. */
export const DIRECT_LINK_DESKTOP_MAX_PEERS = 64;
export const DIRECT_LINK_DESKTOP_RESERVED_PEERS = 8;
export const DIRECT_LINK_IDLE_MS = 5 * 60_000;
const MAX_WAITERS = 256;
export type DirectPeerKind = 'device' | 'share';
export class DirectCapacityError extends Error {
  constructor(readonly code: 'DIRECT_CAPACITY_FULL' | 'DIRECT_QUEUE_FULL' = 'DIRECT_CAPACITY_FULL') { super(code); }
}

/** Shared by all clients using one native runtime (including cross-region clients).
 * FIFO per class, alternating classes. Reservations are deliberately not borrowed:
 * capacity for a new group link must not require evicting a healthy share channel.
 */
export class DirectCapacityPool {
  private readonly active = new Map<string, DirectPeerKind>();
  private readonly waiting = new Map<() => void, DirectPeerKind>();
  private scheduled = false;
  private serving?: () => void;
  private next: DirectPeerKind = 'device';
  constructor(readonly limit = DIRECT_LINK_MAX_PEERS, readonly reserved = 0) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > DIRECT_LINK_DESKTOP_MAX_PEERS
      || !Number.isSafeInteger(reserved) || reserved < 0 || 2 * reserved > limit) throw new Error('DIRECT_CAPACITY_INVALID');
  }
  snapshot() {
    let device = 0;
    for (const kind of this.active.values()) if (kind === 'device') device++;
    return { active: this.active.size, limit: this.limit, reserved: this.reserved, queued: this.waiting.size,
      device, share: this.active.size - device };
  }
  private available(kind: DirectPeerKind): boolean {
    const counts = this.snapshot();
    return counts.active < this.limit && counts[kind] < this.limit - this.reserved;
  }
  /** Retire an idle channel only when its slot can actually serve a waiting class. */
  needsSlotFrom(kind: DirectPeerKind): boolean {
    const counts = this.snapshot();
    return [...this.waiting.values()].some(waiting => !this.available(waiting)
      && counts.active - 1 < this.limit
      && counts[waiting] - (waiting === kind ? 1 : 0) < this.limit - this.reserved);
  }
  acquire(id: string, kind: DirectPeerKind): () => void {
    if (this.active.has(id)) throw new Error('DIRECT_CONNECTION_EXISTS');
    if (!this.available(kind) || (!this.serving && [...this.waiting.values()].some(k => this.available(k)))) {
      throw new DirectCapacityError();
    }
    this.active.set(id, kind);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(id);
      this.wake();
    };
  }
  wait(kind: DirectPeerKind, callback: () => void): () => void {
    if (this.waiting.size >= MAX_WAITERS) throw new DirectCapacityError('DIRECT_QUEUE_FULL');
    this.waiting.set(callback, kind);
    this.wake();
    return () => { this.waiting.delete(callback); this.wake(); };
  }
  wake(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    void Promise.resolve().then(() => {
      this.scheduled = false;
      // Process each candidate at most once per wake, even if it queues itself again.
      const candidates = new Map(this.waiting);
      while (candidates.size) {
        const entries = [...candidates];
        const entry = entries.find(([, k]) => k === this.next && this.available(k))
          ?? entries.find(([, k]) => this.available(k));
        if (!entry) break;
        const [callback, kind] = entry;
        candidates.delete(callback);
        if (!this.waiting.delete(callback)) continue;
        this.next = kind === 'device' ? 'share' : 'device';
        this.serving = callback;
        try { callback(); } finally { this.serving = undefined; }
      }
    });
  }
}
