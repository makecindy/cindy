/**
 * Reads and writes of a companion's values on the Chat Server (cloud-companions.md §6).
 *
 * - Periodic checks read one preference row (`?key=`) instead of every stored value. An older
 *   server ignores the parameter and returns all rows; the row is picked here either way.
 * - When the server offers the companion store, values the preferences cannot hold (over
 *   60 KiB) go there instead of being skipped, large ones through the private bucket. Everything
 *   else stays in the preferences only, so nothing is stored or read twice.
 * - A full restore reads the preferences as before plus the store's (few) values, so a computer
 *   still running an older version, which writes preferences only, stays authoritative for
 *   everything it can write.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './uploader.js';
import { chatRejection, type CompanionApi } from './types.js';

/** `fromStore`: the value came from the companion store, so `revision` is the store's. */
export type CompanionRow = { key: string; value: unknown; revision: number; fromStore?: true };
/** What the preferences hold per value (server: 65536 bytes of JSON; the uploader keeps a margin). */
export const PREFERENCE_VALUE_MAX_BYTES = 60 * 1024;
export const PREFERENCE_KEY_MAX_LENGTH = 160;
/** Inline store writes stay under the server's 256 KB request limit; larger values go through the bucket. */
export const STORE_INLINE_MAX_BYTES = 190 * 1024;
export const STORE_KEY_MAX_LENGTH = 300;

/** Signed-URL transfers, validated like room media (https, or the isolated local server). */
export interface CompanionStoreTransfer {
  putBlob: (url: string, type: string, bytes: Buffer) => Promise<void>;
  getBlob: (url: string, size: number) => Promise<Buffer>;
}

interface StoreEntry { key: string; revision: number; cursor: string; hash: string; size: number; deleted: boolean; value?: unknown; blob?: true }

export function preferenceFits(key: string, json: string) {
  return key.length <= PREFERENCE_KEY_MAX_LENGTH && Buffer.byteLength(json) <= PREFERENCE_VALUE_MAX_BYTES;
}

/** One preference row, without downloading every other value. */
export async function readPreference(api: CompanionApi, actorId: string, key: string): Promise<CompanionRow | undefined> {
  const rows = await api<CompanionRow[]>(`/preferences?key=${encodeURIComponent(key)}`, 'GET', undefined, actorId);
  return (Array.isArray(rows) ? rows : []).find(row => row.key === key);
}

export async function readPreferences(api: CompanionApi, actorId: string): Promise<CompanionRow[]> {
  const rows = await api<CompanionRow[]>('/preferences', 'GET', undefined, actorId);
  return Array.isArray(rows) ? rows : [];
}

export type CompanionStore = ReturnType<typeof createCompanionStore>;

export function createCompanionStore(api: CompanionApi, options: { enabled: () => boolean; transfer?: CompanionStoreTransfer }) {
  /** The server answered that the store is switched off (or absent): use preferences only this run. */
  let off = false;
  const active = () => !off && options.enabled();
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); } catch (error) {
      if (chatRejection(error, 404, 'COMPANION_STORE_DISABLED') || chatRejection(error, 404, 'NOT_FOUND')) off = true;
      throw error;
    }
  };

  async function page(actorId: string, after: string, values: boolean) {
    return guard(() => api<{ entries: StoreEntry[]; cursor: string; hasMore: boolean }>(
      `/companion-store/changes?after=${after}&limit=200${values ? '&values=1' : ''}`, 'GET', undefined, actorId));
  }

  async function blobValue(actorId: string, entry: StoreEntry): Promise<unknown> {
    if (!options.transfer) throw new Error('MEDIA_STORAGE_UNAVAILABLE');
    const meta = await guard(() => api<{ url: string; size: number; hash: string }>(`/companion-store/blob?key=${encodeURIComponent(entry.key)}`, 'GET', undefined, actorId));
    const bytes = await options.transfer.getBlob(meta.url, meta.size);
    if (createHash('sha256').update(bytes).digest('hex') !== meta.hash) throw new Error('COMPANION_BLOB_MISMATCH');
    return JSON.parse(bytes.toString('utf8'));
  }

  return {
    active,
    /** Current store revision of every key (metadata only), for the uploader's compare-and-set. */
    async revisions(actorId: string): Promise<Map<string, { revision: number; hash: string }>> {
      const out = new Map<string, { revision: number; hash: string }>();
      let after = '0';
      for (;;) {
        const result = await page(actorId, after, false);
        for (const entry of result.entries) out.set(entry.key, { revision: entry.revision, hash: entry.hash });
        after = result.cursor;
        if (!result.hasMore) return out;
      }
    },
    /** Live values in the store (large ones downloaded). */
    async values(actorId: string): Promise<CompanionRow[]> {
      const rows: CompanionRow[] = [];
      let after = '0';
      for (;;) {
        const result = await page(actorId, after, true);
        for (const entry of result.entries) {
          if (entry.deleted) continue;
          rows.push({ key: entry.key, revision: entry.revision, value: entry.blob ? await blobValue(actorId, entry) : entry.value });
        }
        after = result.cursor;
        if (!result.hasMore) return rows;
      }
    },
    async entry(actorId: string, key: string) {
      return guard(() => api<StoreEntry>(`/companion-store/entry?key=${encodeURIComponent(key)}`, 'GET', undefined, actorId));
    },
    /** Write (or delete with null); compare-and-set on the store revision. Returns the new revision. */
    async write(actorId: string, key: string, value: unknown, expectedRevision: number): Promise<number> {
      const json = canonicalJson(value);
      const operation = createHash('sha256').update(`${key}\n${expectedRevision}\n${json}`).digest('hex').slice(0, 48);
      if (value === null || Buffer.byteLength(json) <= STORE_INLINE_MAX_BYTES) {
        const result = await guard(() => api<{ revision: number }>('/companion-store/entry', 'POST',
          { operationId: `cstore:${operation}`, key, expectedRevision, value }, actorId));
        return result.revision;
      }
      if (!options.transfer) throw new Error('MEDIA_STORAGE_UNAVAILABLE');
      const bytes = Buffer.from(json, 'utf8');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const prepared = await guard(() => api<{ uploadId: string; uploadUrl: string }>('/companion-store/blob', 'POST',
        { operationId: `cblob:${operation}`, key, expectedRevision, hash, size: bytes.length, type: 'application/json' }, actorId));
      await options.transfer.putBlob(prepared.uploadUrl, 'application/json', bytes);
      const done = await guard(() => api<{ revision: number }>('/companion-store/blob/complete', 'POST',
        { operationId: `cseal:${prepared.uploadId}`, uploadId: prepared.uploadId }, actorId));
      return done.revision;
    },
    /** Hash of a value as this client writes it; compares with the store's `hash` for blobs. */
    blobHash: (value: unknown) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'),
    async valueOf(actorId: string, key: string): Promise<CompanionRow | undefined> {
      const entry = await guard(() => api<StoreEntry>(`/companion-store/entry?key=${encodeURIComponent(key)}`, 'GET', undefined, actorId));
      if (!entry || entry.revision === 0 || entry.deleted) return undefined;
      return { key, revision: entry.revision, value: entry.blob ? await blobValue(actorId, entry) : entry.value, fromStore: true };
    },
  };
}

/** One value: the preference row, or the store when the preferences cannot hold it. */
export async function readCompanionValue(api: CompanionApi, store: CompanionStore | undefined, actorId: string, key: string): Promise<CompanionRow | undefined> {
  const row = await readPreference(api, actorId, key);
  if (row || !store?.active()) return row;
  try { return await store.valueOf(actorId, key); } catch (error) {
    if (!store.active()) return undefined;
    throw error;
  }
}

/**
 * Everything a restore or merge needs: the preference rows, plus from the store only the keys
 * the preferences could not hold (absent there, or too large for them).
 */
export async function readCompanionRows(api: CompanionApi, store: CompanionStore | undefined, actorId: string): Promise<CompanionRow[]> {
  const rows = await readPreferences(api, actorId);
  if (!store?.active()) return rows;
  let stored: CompanionRow[];
  try { stored = await store.values(actorId); } catch (error) {
    if (!store.active()) return rows;
    throw error;
  }
  const have = new Set(rows.map(row => row.key));
  const extra = stored.filter(row => !have.has(row.key) || !preferenceFits(row.key, canonicalJson(row.value)))
    .map(row => ({ ...row, fromStore: true as const }));
  const replaced = new Set(extra.map(row => row.key));
  return [...rows.filter(row => !replaced.has(row.key)), ...extra];
}
