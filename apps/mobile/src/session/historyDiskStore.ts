/** Disk retention has no total quota; explicit lifecycle cleanup still applies. */
export const HISTORY_DISK_BUDGET_BYTES = Infinity;
export const HISTORY_DISK_ITEM_BYTES = 8 * 1024 * 1024;

/** Conservative JSON/UTF-8 bound with early exit; never copies message bodies. */
export function historyValueBytes(value: unknown, limit: number, depth = 0): number {
  if (limit <= 0 || depth > 64) return Infinity;
  if (typeof value === 'string') return 2 + 6 * value.length;
  if (!value || typeof value !== 'object') return 32;
  let bytes = 16;
  const add = (child: unknown) => { bytes += historyValueBytes(child, limit - bytes, depth + 1) + 16; };
  if (value instanceof Map) {
    for (const [key, child] of value) { add(key); add(child); if (bytes > limit) return Infinity; }
  } else if (value instanceof Set || Array.isArray(value)) {
    for (const child of value) { add(child); if (bytes > limit) return Infinity; }
  } else {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      add(key); add((value as Record<string, unknown>)[key]);
      if (bytes > limit) return Infinity;
    }
  }
  return bytes;
}
export interface HistoryDiskIO {
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
  files(): Promise<string[]>;
}
type Entry = { file: string; bytes: number; accessed: number };
export class HistoryDiskStore {
  private entries: Record<string, Entry> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  constructor(private io: HistoryDiskIO, private budget = HISTORY_DISK_BUDGET_BYTES) {}
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // A failed remove/index write may leave orphaned files. Reconcile against disk before
    // the next operation instead of letting repeated IO failures escape quota accounting.
    this.tail = result.catch(() => { this.entries = null; });
    return result;
  }
  private async init(): Promise<void> {
    if (this.entries) return;
    let parsed: unknown;
    try { parsed = JSON.parse(await this.io.read('index.json') ?? '{}'); } catch { parsed = {}; }
    const files = new Set(await this.io.files());
    this.entries = Object.create(null) as Record<string, Entry>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        const e = value as Entry;
        if (e && /^view-[a-z0-9-]+\.json$/.test(e.file) && files.has(e.file)
          && Number.isFinite(e.bytes) && e.bytes > 0 && Number.isFinite(e.accessed)) this.entries[key] = e;
      }
    }
    const owned = new Set(Object.values(this.entries).map(e => e.file));
    for (const file of files) {
      if (file !== 'index.json' && !owned.has(file)) await this.io.remove(file);
    }
  }
  private persist(): Promise<void> { return this.io.write('index.json', JSON.stringify(this.entries)); }
  read(key: string, current: () => boolean): Promise<string | null> {
    const epoch = this.epoch;
    return this.run(async () => {
      await this.init();
      if (epoch !== this.epoch || !current()) return null;
      const entry = this.entries![key];
      if (!entry || entry.bytes > HISTORY_DISK_ITEM_BYTES) return null;
      const text = await this.io.read(entry.file);
      if (epoch !== this.epoch || !current()) return null;
      if (text === null) delete this.entries![key];
      else entry.accessed = Date.now();
      await this.persist();
      return text;
    }).catch(() => null);
  }
  write(key: string, text: string, current: () => boolean): Promise<void> {
    if (text.length > HISTORY_DISK_ITEM_BYTES) return Promise.resolve();
    const epoch = this.epoch;
    // UTF-8 bytes, rather than JS UTF-16 code units, own the disk budget.
    const bytes = new TextEncoder().encode(text).byteLength;
    return this.run(async () => {
      await this.init();
      if (epoch !== this.epoch || !current() || bytes > Math.min(this.budget, HISTORY_DISK_ITEM_BYTES)) return;
      const file = `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.json`;
      await this.io.write(file, text);
      if (epoch !== this.epoch || !current()) { await this.io.remove(file); return; }
      const previous = { ...this.entries! };
      const old = this.entries![key];
      this.entries![key] = { file, bytes, accessed: Date.now() };
      const discarded = old ? [old.file] : [];
      let total = Number.isFinite(this.budget)
        ? Object.values(this.entries!).reduce((sum, entry) => sum + entry.bytes, 0) : 0;
      for (const [candidate, entry] of Number.isFinite(this.budget)
        ? Object.entries(this.entries!).sort((a, b) => a[1].accessed - b[1].accessed) : []) {
        if (total <= this.budget) break;
        if (candidate === key) continue;
        delete this.entries![candidate]; total -= entry.bytes; discarded.push(entry.file);
      }
      try { await this.persist(); }
      catch (error) { this.entries = previous; await this.io.remove(file); throw error; }
      for (const name of discarded) await this.io.remove(name);
    }).catch(() => undefined);
  }
  clear(matches: (key: string) => boolean = () => true): Promise<void> {
    // Revoke queued work immediately, including reads already waiting on native IO.
    this.epoch++;
    return this.run(async () => {
      await this.init();
      for (const [key, entry] of Object.entries(this.entries!)) {
        if (!matches(key)) continue;
        // Keep failed deletions indexed so a subsequent clear retries them.
        await this.io.remove(entry.file);
        delete this.entries![key];
      }
      await this.persist();
    });
  }
}
