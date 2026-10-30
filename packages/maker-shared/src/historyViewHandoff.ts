import { historyViewLeaves, historyWorkSummaries, historyCacheReceiptFollows, isHistoryCacheReceipt, type HistoryMessageSource } from './historyView.js';
import type { HistoryViewSnapshot } from './historyViewController.js';

/** Live content may be newer, but its provisional timestamp must not replace known history order. */
export function liveContentWithHistoryOrder<T extends HistoryMessageSource>(live: T, history: T): T {
  if (live.createdAt === history.createdAt && live.rowid === history.rowid) return live;
  return { ...live, createdAt: history.createdAt, rowid: history.rowid };
}

/** Latest moment the snapshot covers: its newest row or the end of its newest work run. */
export function historyViewEndMs<T extends HistoryMessageSource>(snapshot: Pick<HistoryViewSnapshot<T>, 'items'>): number {
  let endMs = 0;
  for (const item of historyViewLeaves(snapshot.items)) {
    if (item.type !== 'messages') continue;
    for (const row of item.messages) {
      const ms = Date.parse(row.createdAt);
      if (Number.isFinite(ms)) endMs = Math.max(endMs, ms);
    }
  }
  for (const summary of historyWorkSummaries(snapshot.items)) endMs = Math.max(endMs, summary.endedAtMs);
  return endMs;
}

const EMPTY = new Set<string>();

/** View-local identities only; message bodies remain in the existing raw store.
 * A finalized live row stays visible until history takes over. Removing it from
 * the raw store (delete/rewind/clear) cancels the handoff rather than reviving it.
 *
 * A stale snapshot (restored from disk, or kept while the view was away) may end
 * before user/assistant rows the raw store already received. Those rows form the
 * `tail` and are shown after the snapshot until the next page read covers them.
 */
export class HistoryViewHandoff<T extends HistoryMessageSource> {
  private readonly pending = new Set<string>();
  // Shown below a stale snapshot. A later page read before such a row existed must not hide it.
  private readonly tail = new Set<string>();
  private ready = false;

  constructor(private readonly streaming: (row: T) => boolean) {}

  reconcile(snapshot: HistoryViewSnapshot<T>, raw: readonly T[]) {
    if (this.ready && !snapshot.ready) { this.pending.clear(); this.tail.clear(); }
    this.ready = snapshot.ready;
    const available = historyViewLeaves(snapshot.items).flatMap((item) => item.type === 'messages' ? item.messages : []);
    for (const detail of snapshot.details.values()) available.push(...detail.messages);
    const history = new Map(available.map(row => [row.clientId, row]));
    // IDs and createdAt do not change when a saved body is updated. A push
    // received after this page's read began must remain visible even if that
    // older page arrives later. Fresh reads also retire receipts from an earlier run.
    const receivedAfterRead = (row: T) => historyCacheReceiptFollows(row.cacheReceipt, snapshot.readReceipt, snapshot.stale);
    // Only a complete, authoritative empty read can prove an absent body was
    // removed. Apply the same receipt evidence before either handoff is merged.
    const cleared = snapshot.ready && !snapshot.stale && !snapshot.hasMore && snapshot.items.length === 0;
    const supersededByEmptyRead = (row: T) => cleared
      && isHistoryCacheReceipt(row.cacheReceipt) && isHistoryCacheReceipt(snapshot.readReceipt)
      && !receivedAfterRead(row);
    const current = new Set(raw.map(row => row.clientId));
    for (const id of this.pending) if (!current.has(id)) this.pending.delete(id);
    for (const row of raw) {
      if (row.role !== 'assistant') continue;
      if (supersededByEmptyRead(row)) this.pending.delete(row.clientId);
      else if (this.streaming(row)) this.pending.add(row.clientId);
      else if (history.has(row.clientId) && !this.streaming(history.get(row.clientId)!)) this.pending.delete(row.clientId);
    }
    const pending = new Set(this.pending);
    if (!snapshot.ready) return { messages: raw, pending, tail: EMPTY };
    for (const row of raw) if (pending.has(row.clientId)) {
      const known = history.get(row.clientId);
      history.set(row.clientId, known ? liveContentWithHistoryOrder(row, known) : row);
    }
    const rawById = new Map(raw.map(row => [row.clientId, row]));
    for (const id of this.tail) {
      const row = rawById.get(id);
      if (!row || supersededByEmptyRead(row) || (history.has(id) && !receivedAfterRead(row))) {
        this.tail.delete(id);
      }
    }
    const endMs = snapshot.stale ? historyViewEndMs(snapshot) : 0;
    for (const row of raw) {
      if (row.role !== 'user' && row.role !== 'assistant') continue;
      const known = history.get(row.clientId);
      if (known) {
        if (receivedAfterRead(row)) {
          this.tail.add(row.clientId);
          history.set(row.clientId, liveContentWithHistoryOrder(row, known));
        }
        continue;
      }
      // Once receipt order is available, wall-clock fallback must not revive an
      // already superseded body when this fresh view becomes stale on blur.
      if (receivedAfterRead(row) || (!isHistoryCacheReceipt(row.cacheReceipt)
        && snapshot.stale && Date.parse(row.createdAt) > endMs)) this.tail.add(row.clientId);
      if (this.tail.has(row.clientId)) history.set(row.clientId, row);
    }
    const tail = this.tail.size ? new Set(this.tail) : EMPTY;
    const messages = [...history.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.rowid ?? 0) - (b.rowid ?? 0));
    return { messages, pending, tail };
  }
}
