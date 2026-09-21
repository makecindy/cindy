import { Buffer } from 'node:buffer';

/** Host policy, not plugin-configurable. Receipts are bounded separately from user history. */
export const ROUTINE_EVENT_LIMITS = {
  windowMs: 60_000,
  perSource: 60,
  global: 240,
  pendingPerSource: 8,
  pendingGlobal: 32,
  receiptTtlMs: 24 * 60 * 60_000,
  receiptBytesPerSource: 256 * 1024,
  receiptBytesGlobal: 2 * 1024 * 1024,
} as const;

/** Reserve before cloning/queuing plugin requests; separate instances isolate event and status quotas. */
export class RoutineEventAdmission {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private global = { start: 0, count: 0 };
  private readonly pending = new Map<string, number>();
  private totalPending = 0;

  acquire(sourceId: string, now: number): () => void {
    const limits = ROUTINE_EVENT_LIMITS;
    for (const [id, window] of this.windows)
      if (now - window.start >= limits.windowMs) this.windows.delete(id);
    if (now - this.global.start >= limits.windowMs) this.global = { start: now, count: 0 };
    const window = this.windows.get(sourceId) ?? { start: now, count: 0 };
    if (window.count >= limits.perSource || this.global.count >= limits.global)
      throw new Error('Routine request rate limit reached; retry after 60 seconds');
    const pending = this.pending.get(sourceId) ?? 0;
    if (pending >= limits.pendingPerSource || this.totalPending >= limits.pendingGlobal)
      throw new Error('Routine request intake is busy; retry later');
    window.count += 1;
    this.global.count += 1;
    this.windows.set(sourceId, window);
    this.pending.set(sourceId, pending + 1);
    this.totalPending += 1;
    return () => {
      const remaining = (this.pending.get(sourceId) ?? 1) - 1;
      if (remaining) this.pending.set(sourceId, remaining);
      else this.pending.delete(sourceId);
      this.totalPending -= 1;
    };
  }
}

function sourceOf(key: string): string | undefined {
  try {
    const parts: unknown = JSON.parse(key);
    if (Array.isArray(parts) && parts.length === 2 && parts.every((part) => typeof part === 'string' && part.length > 0))
      return parts[0] as string;
  } catch { /* Ignore malformed legacy receipt keys. */ }
  return undefined;
}

function entryBytes(key: string, timestamp: number): number {
  // Includes the quoted/escaped key, colon, timestamp and a comma (conservative for the last entry).
  return Buffer.byteLength(JSON.stringify(key), 'utf8') + String(timestamp).length + 2;
}

export function receiptIsLive(timestamp: number, now: number): boolean {
  return Number.isSafeInteger(timestamp) && timestamp >= 0 && now - timestamp < ROUTINE_EVENT_LIMITS.receiptTtlMs;
}

/** Startup migration keeps newest receipts within byte limits, without deleting any run history. */
export function compactRoutineReceipts(receipts: Record<string, number>, now: number): Record<string, number> {
  const result: Record<string, number> = {};
  const perSource = new Map<string, number>();
  let total = 2;
  for (const [key, timestamp] of Object.entries(receipts).sort((a, b) => b[1] - a[1])) {
    const source = sourceOf(key);
    if (!source || !receiptIsLive(timestamp, now)) continue;
    const bytes = entryBytes(key, timestamp);
    const sourceBytes = perSource.get(source) ?? 2;
    if (total + bytes > ROUTINE_EVENT_LIMITS.receiptBytesGlobal || sourceBytes + bytes > ROUTINE_EVENT_LIMITS.receiptBytesPerSource) continue;
    result[key] = timestamp;
    total += bytes;
    perSource.set(source, sourceBytes + bytes);
  }
  return result;
}

/** Reject overflow instead of evicting live receipts and allowing forced duplicate execution. */
export function addRoutineReceipt(receipts: Record<string, number>, sourceId: string, key: string, now: number): void {
  let total = 2;
  let sourceBytes = 2;
  for (const [existing, timestamp] of Object.entries(receipts)) {
    if (!receiptIsLive(timestamp, now)) {
      delete receipts[existing];
      continue;
    }
    const bytes = entryBytes(existing, timestamp);
    total += bytes;
    if (sourceOf(existing) === sourceId) sourceBytes += bytes;
  }
  const bytes = entryBytes(key, now);
  if (total + bytes > ROUTINE_EVENT_LIMITS.receiptBytesGlobal || sourceBytes + bytes > ROUTINE_EVENT_LIMITS.receiptBytesPerSource)
    throw new Error('Routine receipt storage is full; retry after receipts expire (24 hours)');
  receipts[key] = now;
}
