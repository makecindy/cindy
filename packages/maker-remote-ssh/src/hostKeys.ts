/**
 * Host key verification (TOFU) for remote SSH connections.
 *
 * ssh2 accepts ANY host key when no `hostVerifier` is configured — unlike
 * OpenSSH, which prompts / refuses on an unknown or changed key. That default
 * leaves every connect open to a man-in-the-middle who can present their own
 * host key, then capture forwarded credentials and inject commands. This
 * module supplies the missing check: trust-on-first-use, persisted per host,
 * with a hard reject when a previously-trusted key changes.
 *
 * The store is maker-owned (a small JSON file under userData) rather than the
 * user's real ~/.ssh/known_hosts: we never mutate their OpenSSH state, and we
 * avoid the fragility of parsing the OpenSSH known_hosts format (hashed hosts,
 * bracketed non-22 ports, per-key-type entries).
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Persistence for trusted host-key fingerprints, keyed by a caller-chosen
 * string (we use `hostname:port`). Injected into RemoteHost so the package
 * stays decoupled from Electron / userData paths (design rule 2).
 */
export interface HostKeyStore {
  /** Trusted fingerprint for `key`, or null when the host is unknown. */
  get(key: string): Promise<string | null>;
  /**
   * Record the trusted fingerprint for `key`. `shouldCommit` is checked inside
   * the serialized write slot so a cancelled SSH attempt cannot persist after
   * it has become stale while waiting for another host-key write.
   */
  set(key: string, fingerprint: string, shouldCommit?: () => boolean): Promise<void>;
  /**
   * Discard any in-memory cache so the next `get` or `set` re-reads from
   * the backing store. For in-memory stores this is a no-op.
   *
   * Called by RemoteHost before each connection attempt so that a user who
   * manually repairs the known-hosts file (e.g. removes a stale entry after a
   * legitimate server re-key) sees the update on reconnect without restarting
   * the app.
   */
  reload(): void;
}

/**
 * SHA256 fingerprint of a raw SSH host public key, in the same
 * `SHA256:<base64-no-pad>` form printed by `ssh-keygen -lf`.
 */
export function hostKeyFingerprint(hostKey: Buffer): string {
  const b64 = createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '');
  return `SHA256:${b64}`;
}

/** Stable store key for a host — identity is (hostname, port), not the alias. */
export function hostKeyId(hostname: string, port: number): string {
  return `${hostname}:${port}`;
}

export type HostKeyDecision = 'trust-new' | 'match' | 'mismatch';

/**
 * Pure TOFU decision, split out so the policy is unit-testable without ssh2:
 *   - no stored fingerprint  → trust-new  (first use; caller persists)
 *   - stored === presented   → match      (accept)
 *   - stored !== presented   → mismatch   (reject — possible MITM / re-keyed host)
 */
export function decideHostKey(stored: string | null, presented: string): HostKeyDecision {
  if (stored === null) return 'trust-new';
  return stored === presented ? 'match' : 'mismatch';
}

/**
 * File-backed HostKeyStore. Persists a flat `{ "host:port": "SHA256:..." }`
 * JSON map, cached in memory after first read. Writes go through a temp file +
 * rename so a crash mid-write can't corrupt the map, and the file is created
 * 0600 (best-effort; chmod is a no-op on Windows).
 */
export class FileHostKeyStore implements HostKeyStore {
  private readonly filePath: string;
  private cache: Record<string, string> | null = null;
  private loadPromise: Promise<Record<string, string>> | null = null;
  private loadSettled = false; // true once loadPromise has resolved or rejected
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async get(key: string): Promise<string | null> {
    const map = await this.load();
    return map[key] ?? null;
  }

  reload(): void {
    // If a load is currently in flight (loadPromise set but not yet settled),
    // preserve the shared promise. Discarding it would cause concurrent callers
    // to start separate loads and end up with different map objects — breaking
    // the writeChain conflict check in set(), which relies on every concurrent
    // caller mutating the same map reference.
    // A failed (rejected) load is considered settled so reload() can clear it,
    // allowing the caller to retry without restarting the app.
    const loadInFlight = this.loadPromise !== null && !this.loadSettled;
    this.cache = null;
    if (!loadInFlight) {
      this.loadPromise = null;
      this.loadSettled = false;
    }
  }

  async set(key: string, fingerprint: string, shouldCommit?: () => boolean): Promise<void> {
    // Load inside the slot, not outside. If reload() is called between a
    // caller's get() and their set() (post-load/pre-persist window), an
    // outside-slot load returns a stale map reference and the conflict check
    // misses writes from the concurrent slot — see regression test.
    // The .catch resets a previously-failed chain so one bad write doesn't
    // permanently poison all subsequent writes.
    const mySlot = this.writeChain.catch(() => {}).then(async () => {
      const map = await this.load();
      if (shouldCommit && !shouldCommit()) return;
      if (map[key] === fingerprint) return; // concurrent winner already did our work
      if (map[key] !== undefined) {
        // A concurrent first-use already claimed this key with a different
        // fingerprint — fail closed.
        throw new Error(`concurrent first-use conflict for "${key}"`);
      }
      map[key] = fingerprint;
      try {
        await this.persist({ ...map });
      } catch (err) {
        // Roll back so a reconnect in the same process also fails closed
        // rather than matching the unpersisted fingerprint.
        delete map[key];
        throw err;
      }
    });
    this.writeChain = mySlot;
    await mySlot;
  }

  /**
   * Load the map once. Concurrent callers share a single in-flight read so
   * they end up mutating the same cached object — otherwise simultaneous
   * first-connects to different hosts each build their own map and the last
   * writer wins, silently dropping the others' trusted keys.
   */
  private load(): Promise<Record<string, string>> {
    if (this.cache) return Promise.resolve(this.cache);
    if (!this.loadPromise) {
      this.loadSettled = false;
      this.loadPromise = (async () => {
        try {
          const raw = await fs.readFile(this.filePath, 'utf8');
          const parsed = JSON.parse(raw) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new TypeError('known-hosts file is not a JSON object');
          }
          // Validate every entry value — a null or non-string would make
          // get() return null (via ?? null), re-entering trust-new and
          // accepting a changed key as if it were first use.
          const record = parsed as Record<string, unknown>;
          for (const [host, value] of Object.entries(record)) {
            if (typeof value !== 'string') {
              throw new TypeError(
                `known-hosts entry for "${host}" has a non-string value`,
              );
            }
          }
          this.cache = record as Record<string, string>;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // No file yet — first use, start from empty map.
            this.cache = {};
          } else {
            // Unreadable or malformed → fail closed: propagate so the
            // caller refuses the connection rather than silently trusting.
            // Mark settled so reload() can clear this failed promise,
            // letting the caller retry without restarting the app.
            this.loadSettled = true;
            throw err;
          }
        }
        this.loadSettled = true;
        return this.cache!;
      })();
    }
    return this.loadPromise;
  }

  private async persist(map: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
    // Enforce mode even if the file pre-existed with looser perms.
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
  }
}
