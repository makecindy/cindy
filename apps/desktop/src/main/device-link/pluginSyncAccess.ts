import { randomUUID } from 'node:crypto';

interface Deps {
  /** Same-account, online desktop, not locally revoked. Independent of control links. */
  eligible(peer: string): boolean;
  revokedByRemote(peer: string): boolean;
  send(peer: string, frame: unknown): void;
  invalidate(peer: string): void;
}

/** Sync-only grants over the authenticated same-account relay. Never restores remote control.
 * A fresh challenge must be answered by the peer after its local deny check.
 */
export class PluginSyncAccess {
  private readonly grants = new Set<string>();
  private readonly probes = new Map<string, { nonce: string; expires: number }>();
  private readonly replies = new Map<string, number>();
  private readonly revoking = new Map<string, number>();
  constructor(private readonly deps: Deps) {}

  private eligible(peer: string): boolean {
    return !this.revoking.has(peer) && this.deps.eligible(peer);
  }
  allowed(peer: string): boolean {
    return this.eligible(peer) && (!this.deps.revokedByRemote(peer) || this.grants.has(peer));
  }
  invalidate(peer: string): void {
    this.grants.delete(peer);
    this.probes.delete(peer);
    this.replies.delete(peer);
    this.deps.invalidate(peer);
  }
  beginRevocation(peer: string): () => void {
    this.revoking.set(peer, (this.revoking.get(peer) ?? 0) + 1);
    this.invalidate(peer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.revoking.get(peer) ?? 1) - 1;
      if (remaining) this.revoking.set(peer, remaining);
      else this.revoking.delete(peer);
      this.invalidate(peer);
    };
  }
  reset(): void {
    this.grants.clear();
    this.probes.clear();
    this.replies.clear();
    // An outstanding disk write still denies admission after a relay reconnect.
  }
  /** Called by the existing plugin status polling; no additional background timer. */
  probe(peer: string): void {
    if (!this.eligible(peer) || !this.deps.revokedByRemote(peer) || this.grants.has(peer)) return;
    const now = Date.now();
    for (const [id, probe] of this.probes) if (probe.expires <= now) this.probes.delete(id);
    if (this.probes.has(peer) || this.probes.size >= 64) return;
    const nonce = randomUUID();
    this.probes.set(peer, { nonce, expires: now + 30_000 });
    try { this.deps.send(peer, { version: 1, kind: 'authorize', nonce }); }
    catch { this.probes.delete(peer); }
  }
  /** Consume only metadata handshakes. Data/key frames must still pass allowed(). */
  receive(peer: string, raw: unknown): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const frame = raw as Record<string, unknown>;
    if (frame.kind !== 'authorize' && frame.kind !== 'authorized') return false;
    if (frame.version !== 1 || typeof frame.nonce !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(frame.nonce) || !this.eligible(peer)) return true;
    if (frame.kind === 'authorize') {
      const now = Date.now();
      for (const [id, time] of this.replies) if (now - time >= 5000) this.replies.delete(id);
      if (this.replies.has(peer) || this.replies.size >= 64) return true;
      this.replies.set(peer, now);
      try { this.deps.send(peer, { version: 1, kind: 'authorized', nonce: frame.nonce }); }
      catch { /* A later bounded probe can retry. */ }
    } else {
      const pending = this.probes.get(peer);
      if (!pending || pending.nonce !== frame.nonce || pending.expires <= Date.now()) return true;
      this.probes.delete(peer);
      this.grants.add(peer);
    }
    return true;
  }
}
