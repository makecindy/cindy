/** Shared physical-frame budget after relay 1013; control frames never enter this gate. */
export class CongestionSendBudget {
  private window = -1;
  private spent = 0;
  private turn = -1;
  private readonly byPeer = new Map<string, number>();

  reset(): void {
    this.window = -1;
    this.spent = 0;
    this.turn = -1;
    this.byPeer.clear();
  }

  /** Settle the synchronous send attempt: only frames actually written cost credit. */
  refund(peer: string, unsentFrames: number): void {
    this.spent = Math.max(0, this.spent - unsentFrames);
    this.byPeer.set(peer, Math.max(0, (this.byPeer.get(peer) ?? 0) - unsentFrames));
  }

  take(peer: string, frames: number, peers: readonly string[], now: number): boolean {
    if (!this.canTake(peer, frames, peers, now)) return false;
    this.spent += frames;
    this.byPeer.set(peer, (this.byPeer.get(peer) ?? 0) + frames);
    return true;
  }

  /** Check admission without reserving credit; take uses exactly the same gate. */
  canTake(peer: string, frames: number, peers: readonly string[], now: number): boolean {
    const window = Math.floor(now / 250);
    if (window !== this.window) {
      this.spent = this.window >= 0 && window > this.window
        ? Math.max(0, this.spent - 8 * (window - this.window)) : 0;
      if (this.spent < 8) this.turn++;
      this.window = window;
      this.byPeer.clear();
    }
    const index = peers.indexOf(peer);
    const count = Math.max(1, peers.length);
    // Rotate turns when there are more peers than slots, including oversized heads.
    const offset = (Math.max(0, index) - this.turn % count + count) % count;
    if (offset >= 8) return false;
    const share = Math.max(1, Math.floor(8 / Math.min(8, count)));
    const used = this.byPeer.get(peer) ?? 0;
    // A logical message's chunks are atomic. Let an oversized head occupy one turn,
    // even if a small peer ran first. Charge its overflow to future windows and
    // rotate only when credit returns (wall-clock rotation can starve whole peers).
    if (frames > share) {
      if (offset !== 0 || used !== 0 || this.spent >= 8) return false;
    } else if (this.spent + frames > 8 || used + frames > share) return false;
    return true;
  }
}
