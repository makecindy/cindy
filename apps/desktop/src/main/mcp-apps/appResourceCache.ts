import { Buffer } from 'node:buffer';

export const MCP_APP_DOCUMENT_CACHE_MAX_ENTRIES = 32;
export const MCP_APP_DOCUMENT_CACHE_MAX_BYTES = 16 * 1024 * 1024;

type CacheEntry<T> = { value: T; bytes: number };

/** Owner-scoped, bounded LRU cache for prepared App resource documents. */
export class OwnerScopedAppResourceCache<T extends { html: string }> {
  private readonly owners = new WeakMap<object, Map<string, CacheEntry<T>>>();
  constructor(
    private readonly maxEntries = MCP_APP_DOCUMENT_CACHE_MAX_ENTRIES,
    private readonly maxBytes = MCP_APP_DOCUMENT_CACHE_MAX_BYTES,
  ) {}
  get(owner: object, key: string): T | undefined {
    const entries = this.owners.get(owner);
    const entry = entries?.get(key);
    if (!entry) return undefined;
    entries!.delete(key);
    entries!.set(key, entry);
    return entry.value;
  }
  set(owner: object, key: string, value: T): void {
    const entries = this.owners.get(owner) ?? new Map<string, CacheEntry<T>>();
    this.owners.set(owner, entries);
    entries.delete(key);
    entries.set(key, { value, bytes: Buffer.byteLength(key) + Buffer.byteLength(value.html) });
    let bytes = 0;
    for (const entry of entries.values()) bytes += entry.bytes;
    while (entries.size > this.maxEntries || bytes > this.maxBytes) {
      const oldest = entries.entries().next().value as [string, CacheEntry<T>] | undefined;
      if (!oldest) break;
      entries.delete(oldest[0]);
      bytes -= oldest[1].bytes;
    }
  }
  clear(owner: object): void { this.owners.delete(owner); }
}
