import { randomBytes } from 'node:crypto';

/** 60 s from `previewTabs` to `previewStart`. */
export const PREVIEW_GRANT_TTL_MS = 60_000;
/**
 * A still-valid grant is handed out again (the phone polls the list while its task is open)
 * until it has less than this left; then a fresh one replaces it.
 */
export const PREVIEW_GRANT_REUSE_MIN_MS = 20_000;
/** Whole-table ceiling; the oldest grant goes first. */
const MAX_GRANTS = 64;
/** Per requesting peer, so one phone cannot crowd out another. */
const MAX_GRANTS_PER_PEER = 32;

interface Entry<T> {
  peer: string;
  target: T;
  key: string;
  expiresAt: number;
}

/**
 * One-time `previewStart` tokens: 32 random bytes (43 base64url chars), bound to the
 * requesting peer and to one tab. In memory only; never logged or persisted.
 */
export class PreviewGrantTable<T> {
  private readonly entries = new Map<string, Entry<T>>();

  /**
   * @param keyOf identifies the tab (and guest generation) a grant targets. Listing is
   * side-effect free for the caller: asking again for the same peer and tab returns the same
   * unused grant while it has time left, so polling neither grows the table nor churns tokens.
   */
  constructor(
    private readonly keyOf: (target: T) => string,
    private readonly now: () => number = Date.now,
  ) {}

  issue(peer: string, target: T): string {
    this.purge();
    const key = this.keyOf(target);
    const now = this.now();
    for (const [grant, entry] of this.entries) {
      if (entry.peer !== peer || entry.key !== key) continue;
      if (entry.expiresAt - now >= PREVIEW_GRANT_REUSE_MIN_MS) return grant;
      this.entries.delete(grant);
    }
    this.evict((entry) => entry.peer === peer, MAX_GRANTS_PER_PEER - 1);
    this.evict(() => true, MAX_GRANTS - 1);
    const grant = randomBytes(32).toString('base64url');
    this.entries.set(grant, { peer, target, key, expiresAt: this.now() + PREVIEW_GRANT_TTL_MS });
    return grant;
  }

  /** Consumes the grant. A wrong peer, an expired or an unknown token all read as null. */
  redeem(peer: string, grant: string): T | null {
    this.purge();
    const entry = this.entries.get(grant);
    if (!entry || entry.peer !== peer) return null;
    this.entries.delete(grant);
    return entry.target;
  }

  /** Forget everything a peer was offered (it was revoked or disconnected). */
  clearPeer(peer: string): void {
    for (const [grant, entry] of this.entries) if (entry.peer === peer) this.entries.delete(grant);
  }

  get size(): number {
    this.purge();
    return this.entries.size;
  }

  private purge(): void {
    const now = this.now();
    for (const [grant, entry] of this.entries)
      if (entry.expiresAt <= now) this.entries.delete(grant);
  }

  private evict(match: (entry: Entry<T>) => boolean, keep: number): void {
    const matching = [...this.entries].filter(([, entry]) => match(entry));
    for (const [grant] of matching.slice(0, Math.max(0, matching.length - keep)))
      this.entries.delete(grant);
  }
}
