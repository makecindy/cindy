/**
 * Short reuse window for the `/` command palette's Skill listing.
 *
 * One palette load reaches `maker:list-agent-skills` from several places (mount,
 * context switch, the open itself), and each miss starts an isolated discovery
 * process and rescans every Skill root. Every change Cindy knows about — SkillHub
 * activation, Pi package install/update, the Pi runtime catalog retry — already
 * asks for `forceReload`, so that call refreshes the snapshot while the rest read
 * it. Only an edit made outside Cindy can be up to one window stale.
 */

export interface PaletteDiscoveryReuse<T> {
  read(key: string): T | undefined;
  write(key: string, value: T): void;
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
  const entries = new Map<string, { at: number; value: T }>();
  const scopedKey = (key: string) => (options.scope ? `${options.scope()}\u0000${key}` : key);
  return {
    read(key) {
      const scoped = scopedKey(key);
      const entry = entries.get(scoped);
      if (!entry) return undefined;
      if (now() - entry.at >= options.ttlMs) {
        entries.delete(scoped);
        return undefined;
      }
      // Touch so eviction follows the entry a session keeps coming back to.
      entries.delete(scoped);
      entries.set(scoped, entry);
      return entry.value;
    },
    write(key, value) {
      const scoped = scopedKey(key);
      // Re-insert so the eviction order follows the most recent use.
      entries.delete(scoped);
      entries.set(scoped, { at: now(), value });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    clear() {
      entries.clear();
    },
  };
}
