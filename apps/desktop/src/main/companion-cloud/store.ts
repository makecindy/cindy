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

/**
 * `fromStore`: the value came from the companion store, so `revision` is the store's.
 * `prefRevision`: the key's preference revision when that store value was written; a preference
 * row with a higher revision is newer (a deletion or small value written while the store was off).
 */
export type CompanionRow = { key: string; value: unknown; revision: number; fromStore?: true; prefRevision?: number };

/**
 * What this computer records for a live store value it wrote or restored: the value and the
 * preference revision it supersedes, so a value written again over a newer preference row is
 * not taken as already uploaded.
 */
export function storedValueHash(value: unknown, prefRevision: number) {
  return createHash('sha256').update(`${prefRevision}\n${canonicalJson(value)}`).digest('hex');
}

/** How a value is kept in the store: with the preference revision it supersedes. */
interface StoredValue { companionStore: 1; prefRevision: number; value: unknown }
const wrap = (value: unknown, prefRevision: number): StoredValue => ({ companionStore: 1, prefRevision, value });
function unwrap(stored: unknown): { value: unknown; prefRevision?: number } {
  const candidate = stored as Partial<StoredValue> | null;
  return candidate && typeof candidate === 'object' && candidate.companionStore === 1 && typeof candidate.prefRevision === 'number'
    ? { value: candidate.value, prefRevision: candidate.prefRevision } : { value: stored };
}
/** What the preferences hold per value (server: 65536 bytes of JSON; the uploader keeps a margin). */
export const PREFERENCE_VALUE_MAX_BYTES = 60 * 1024;
export const PREFERENCE_KEY_MAX_LENGTH = 160;
/** Inline store writes stay under the server's 256 KB request limit; larger values go through the bucket. */
export const STORE_INLINE_MAX_BYTES = 190 * 1024;
export const STORE_KEY_MAX_LENGTH = 300;
/** After the server says the store is off, how long to use preferences only before asking again. */
export const STORE_OFF_RETRY_MS = 10 * 60_000;

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
  /** The server answered that the store is switched off (or absent): preferences only for a while, then ask again. */
  let offUntil = 0;
  const active = () => Date.now() >= offUntil && options.enabled();
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); } catch (error) {
      if (chatRejection(error, 404, 'COMPANION_STORE_DISABLED') || chatRejection(error, 404, 'NOT_FOUND')) offUntil = Date.now() + STORE_OFF_RETRY_MS;
      throw error;
    }
  };

  async function page(actorId: string, after: string, values: boolean) {
    return guard(() => api<{ entries: StoreEntry[]; cursor: string; hasMore: boolean }>(
      `/companion-store/changes?after=${after}&limit=200${values ? '&values=1' : ''}`, 'GET', undefined, actorId));
  }

  async function blobValue(actorId: string, entry: StoreEntry): Promise<{ value: unknown; prefRevision?: number }> {
    if (!options.transfer) throw new Error('MEDIA_STORAGE_UNAVAILABLE');
    const meta = await guard(() => api<{ url: string; size: number; hash: string }>(`/companion-store/blob?key=${encodeURIComponent(entry.key)}`, 'GET', undefined, actorId));
    const bytes = await options.transfer.getBlob(meta.url, meta.size);
    if (createHash('sha256').update(bytes).digest('hex') !== meta.hash) throw new Error('COMPANION_BLOB_MISMATCH');
    return unwrap(JSON.parse(bytes.toString('utf8')));
  }
  const inline = (entry: StoreEntry) => unwrap(entry.value);

  return {
    active,
    /** Ask the server again now instead of waiting out the switch-off pause (before a hand-over). */
    retryNow() { offUntil = 0; },
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
    /**
     * Every value in the store (large ones downloaded); a deletion comes as `null`, like a
     * preference tombstone, so a restore removes what another computer deleted.
     */
    async values(actorId: string): Promise<CompanionRow[]> {
      const rows: CompanionRow[] = [];
      let after = '0';
      for (;;) {
        const result = await page(actorId, after, true);
        for (const entry of result.entries) {
          const stored = entry.deleted ? { value: null } : entry.blob ? await blobValue(actorId, entry) : inline(entry);
          rows.push({ key: entry.key, revision: entry.revision, ...stored });
        }
        after = result.cursor;
        if (!result.hasMore) return rows;
      }
    },
    /** One entry's metadata; an inline value comes unwrapped. */
    async entry(actorId: string, key: string) {
      const entry = await guard(() => api<StoreEntry>(`/companion-store/entry?key=${encodeURIComponent(key)}`, 'GET', undefined, actorId));
      return entry && !entry.deleted && !entry.blob ? { ...entry, ...inline(entry) } : entry;
    },
    /**
     * Write (or delete with null); compare-and-set on the store revision. `prefRevision` is the
     * key's preference revision this value supersedes. Returns the new revision.
     */
    async write(actorId: string, key: string, raw: unknown, expectedRevision: number, prefRevision = 0): Promise<number> {
      const value = raw === null ? null : wrap(raw, prefRevision);
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
    blobHash: (value: unknown, prefRevision = 0) => createHash('sha256').update(canonicalJson(wrap(value, prefRevision)), 'utf8').digest('hex'),
    async valueOf(actorId: string, key: string): Promise<CompanionRow | undefined> {
      const entry = await guard(() => api<StoreEntry>(`/companion-store/entry?key=${encodeURIComponent(key)}`, 'GET', undefined, actorId));
      if (!entry || entry.revision === 0 || entry.deleted) return undefined;
      return { key, revision: entry.revision, ...(entry.blob ? await blobValue(actorId, entry) : inline(entry)), fromStore: true };
    },
  };
}

/** One value: the preference row, or the store when the preferences cannot hold it. */
export async function readCompanionValue(api: CompanionApi, store: CompanionStore | undefined, actorId: string, key: string,
  options: { probe?: boolean } = {}): Promise<CompanionRow | undefined> {
  const row = await readPreference(api, actorId, key);
  // An explicit action (a take-over check) asks again; periodic reads keep the switch-off pause.
  if (!row && options.probe) store?.retryNow();
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
  // A restore is complete or fails: never let a switch-off pause decide what it reads.
  store?.retryNow();
  if (!store?.active()) return readPreferences(api, actorId);
  // The store first: an upload writes the preference row before the store deletion it leaves
  // behind, so a value shrinking back meanwhile is never read as that deletion alone.
  let stored: CompanionRow[];
  try { stored = await store.values(actorId); } catch (error) {
    if (!store.active()) return readPreferences(api, actorId);
    throw error;
  }
  const rows = await readPreferences(api, actorId);
  // A store deletion counts only for a key the preferences do not have: a value that shrank back
  // into the preferences leaves a deletion in the store, and the preference row wins.
  // A large store value wins over its preference row unless that row is newer than the value
  // (a deletion or small value written while the store was off).
  const prefRevisions = new Map(rows.map(row => [row.key, row.revision]));
  const extra = stored.filter(row => {
    const prefRevision = prefRevisions.get(row.key);
    if (prefRevision === undefined) return true;
    if (preferenceFits(row.key, canonicalJson(row.value))) return false;
    return row.prefRevision === undefined || prefRevision <= row.prefRevision;
  }).map(row => ({ ...row, fromStore: true as const }));
  const replaced = new Set(extra.map(row => row.key));
  return [...rows.filter(row => !replaced.has(row.key)), ...extra];
}
