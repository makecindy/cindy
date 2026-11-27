/** Shared physical-frame budget; control frames never enter this gate. */
export class CongestionSendBudget {
  private window = -1;
  private spent = 0;
  private turn = -1;
  private turnAt = -Infinity;
  private readonly byPeer = new Map<string, number>();
  private blockedAt: number | null = null;
  // Strict mode meters a rolling interval. Fixed wall-clock buckets can admit
  // two full bursts a fraction of a millisecond apart at a bucket boundary.
  // At most capacity entries: each reservation costs at least one frame.
  private readonly reservations: Array<{ peer: string; frames: number; at: number }> = [];
  private synchronousSpent = 0;
  private yieldTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly capacity = 8,
    private readonly intervalMs = 250,
    private readonly allowOverflow = true,
    private readonly maxAtomicHeadFrames?: () => number,
  ) {}

  /** Admission denials are pressure evidence even if ACKs drain the queue later. */
  get lastBlockedAt(): number | null { return this.blockedAt; }

  reset(): void {
    this.window = -1;
    this.spent = 0;
    this.turn = -1;
    this.turnAt = -Infinity;
    this.byPeer.clear();
    this.blockedAt = null;
    this.reservations.length = 0;
    if (this.yieldTimer !== null) clearTimeout(this.yieldTimer);
    this.yieldTimer = null;
    this.synchronousSpent = 0;
  }

  /** Settle the synchronous send attempt: only frames actually written cost credit. */
  refund(peer: string, unsentFrames: number): void {
    this.spent = Math.max(0, this.spent - unsentFrames);
    const remaining = Math.max(0, (this.byPeer.get(peer) ?? 0) - unsentFrames);
    if (remaining > 0) this.byPeer.set(peer, remaining);
    else this.byPeer.delete(peer);
    if (!this.allowOverflow) {
      this.synchronousSpent = Math.max(0, this.synchronousSpent - unsentFrames);
      for (let i = this.reservations.length - 1; i >= 0 && unsentFrames > 0; i--) {
        const entry = this.reservations[i]!;
        if (entry.peer !== peer) continue;
        const refund = Math.min(unsentFrames, entry.frames);
        entry.frames -= refund;
        unsentFrames -= refund;
        if (entry.frames === 0) this.reservations.splice(i, 1);
      }
    }
  }

  /** Keep an atomic reservation until after its final physical write. Encoding
   * and synchronous socket writes may themselves take longer than an interval. */
  noteWrite(peer: string, now: number): void {
    if (this.allowOverflow) return;
    for (let i = this.reservations.length - 1; i >= 0; i--) {
      const entry = this.reservations[i]!;
      if (entry.peer === peer) { entry.at = Math.max(entry.at, now); return; }
    }
  }

  take(peer: string, frames: number, peers: readonly string[], now: number): boolean {
    if (!this.canTake(peer, frames, peers, now)) return false;
    this.spent += frames;
    this.byPeer.set(peer, (this.byPeer.get(peer) ?? 0) + frames);
    if (!this.allowOverflow) {
      this.reservations.push({ peer, frames, at: now });
      this.synchronousSpent += frames;
      // A long synchronous producer can span multiple time windows while TCP
      // is still buffering the same write turn. Time alone must not refill it.
      if (this.yieldTimer === null) this.yieldTimer = setTimeout(() => {
        this.yieldTimer = null;
        this.synchronousSpent = 0;
      }, 0);
    }
    return true;
  }

  /** Check admission without reserving credit; take uses exactly the same gate. */
  canTake(peer: string, frames: number, peers: readonly string[], now: number): boolean {
    if (!this.allowOverflow && this.synchronousSpent + frames > this.capacity) return this.block(now);
    if (!this.allowOverflow) {
      while (this.reservations.length && now - this.reservations[0]!.at >= this.intervalMs) {
        const expired = this.reservations.shift()!;
        this.spent -= expired.frames;
        const remaining = (this.byPeer.get(expired.peer) ?? 0) - expired.frames;
        if (remaining > 0) this.byPeer.set(expired.peer, remaining);
        else this.byPeer.delete(expired.peer);
      }
    }
    const window = Math.floor(now / this.intervalMs);
    if (!this.allowOverflow && this.spent < this.capacity && now - this.turnAt >= this.intervalMs) {
      this.turn++;
      this.turnAt = now;
    }
    if (window !== this.window) {
      if (this.allowOverflow) {
        this.spent = this.window >= 0 && window > this.window
          ? Math.max(0, this.spent - this.capacity * (window - this.window)) : 0;
        this.byPeer.clear();
      }
      if (this.allowOverflow && this.spent < this.capacity) this.turn++;
      this.window = window;
    }
    const index = peers.indexOf(peer);
    const count = Math.max(1, peers.length);
    // Reserve enough room for a waiting atomic head on its turn. Otherwise many
    // small peers can spend every replenished credit before a large head runs.
    // Derive it from live pending work: retirement cannot leave stale priority.
    const fairCapacity = !this.allowOverflow && count > 1
      ? Math.max(1, this.capacity - Math.max(frames, this.maxAtomicHeadFrames?.() ?? 1) + 1)
      : this.capacity;
    // Rotate turns when there are more peers than slots, including oversized heads.
    const offset = (Math.max(0, index) - this.turn % count + count) % count;
    if (offset >= fairCapacity) return this.block(now);
    const share = Math.max(1, Math.floor(fairCapacity / Math.min(fairCapacity, count)));
    const used = this.byPeer.get(peer) ?? 0;
    // A logical message's chunks are atomic. Let an oversized head occupy one turn,
    // even if a small peer ran first. Charge its overflow to future windows and
    // rotate only when credit returns (wall-clock rotation can starve whole peers).
    if (frames > share) {
      if (offset !== 0 || used !== 0 || this.spent >= this.capacity) return this.block(now);
    } else if (this.spent + frames > this.capacity || used + frames > share) return this.block(now);
    if (!this.allowOverflow && this.spent + frames > this.capacity) return this.block(now);
    return true;
  }

  private block(now: number): false {
    this.blockedAt = now;
    return false;
  }
}
