/**
 * Short reuse window for the `/` command palette's Skill listing.
 *
 * One palette load reaches `maker:list-agent-skills` from several places (mount,
 * context switch, the open itself), and each miss starts an isolated discovery
 * process and rescans every Skill root. Every change Cindy knows about — SkillHub
 * activation, Pi package install/update, the Pi runtime catalog retry, a Ghost
 * install/toggle — asks for `forceReload`, which clears the snapshot for every
 * context. Only an edit made outside Cindy can be up to one window stale.
 */

export interface PaletteDiscoveryReuse<T> {
  read(key: string): T | undefined;
  /**
   * Stamp taken before a scan starts. `clear()` moves it on, so a scan that began
   * before the clear can no longer publish its pre-change result afterwards.
   */
  generation(): number;
  /**
   * `limits.ttlMs` sets this entry's own window; it never extends past the store
   * default — a write whose data carries its own expiry (a warm cache it merged
   * from) may only be kept shorter.
   */
  write(key: string, value: T, generation: number, limits?: { ttlMs?: number }): void;
  clear(): void;
}

export function createPaletteDiscoveryReuse<T>(
  options: {
    ttlMs: number;
    maxEntries?: number;
    now?: () => number;
    /** Data owner the entries belong to; another owner must never read them. */
    scope?: () => string;
  },
): PaletteDiscoveryReuse<T> {
  const maxEntries = options.maxEntries ?? 16;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { at: number; value: T; ttlMs?: number }>();
  const scopedKey = (key: string) => (options.scope ? `${options.scope()}\u0000${key}` : key);
  let generation = 0;
  return {
    read(key) {
      const scoped = scopedKey(key);
      const entry = entries.get(scoped);
      if (!entry) return undefined;
      if (now() - entry.at >= (entry.ttlMs ?? options.ttlMs)) {
        entries.delete(scoped);
        return undefined;
      }
      // Touch so eviction follows the entry a session keeps coming back to.
      entries.delete(scoped);
      entries.set(scoped, entry);
      return entry.value;
    },
    generation: () => generation,
    write(key, value, stamped, limits) {
      if (stamped !== generation) return;
      const scoped = scopedKey(key);
      // Re-insert so the eviction order follows the most recent use.
      entries.delete(scoped);
      entries.set(scoped, {
        at: now(),
        value,
        ttlMs: limits?.ttlMs === undefined ? undefined : Math.min(limits.ttlMs, options.ttlMs),
      });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    clear() {
      entries.clear();
      generation += 1;
    },
  };
}
