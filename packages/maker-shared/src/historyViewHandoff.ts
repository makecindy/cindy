import { historyViewLeaves, type HistoryMessageSource } from './historyView.js';
import type { HistoryViewSnapshot } from './historyViewController.js';

/** Live content may be newer, but its provisional timestamp must not replace known history order. */
export function liveContentWithHistoryOrder<T extends HistoryMessageSource>(live: T, history: T): T {
  if (live.createdAt === history.createdAt && live.rowid === history.rowid) return live;
  return { ...live, createdAt: history.createdAt, rowid: history.rowid };
}

/** View-local identities only; message bodies remain in the existing raw store.
 * A finalized live row stays visible until history takes over. Removing it from
 * the raw store (delete/rewind/clear) cancels the handoff rather than reviving it.
 */
export class HistoryViewHandoff<T extends HistoryMessageSource> {
  private readonly pending = new Set<string>();
  private ready = false;

  constructor(private readonly streaming: (row: T) => boolean) {}

  reconcile(snapshot: HistoryViewSnapshot<T>, raw: readonly T[]) {
    if (this.ready && !snapshot.ready) this.pending.clear();
    this.ready = snapshot.ready;
    const available = historyViewLeaves(snapshot.items).flatMap((item) => item.type === 'messages' ? item.messages : []);
    for (const detail of snapshot.details.values()) available.push(...detail.messages);
    const history = new Map(available.map(row => [row.clientId, row]));
    const current = new Set(raw.map(row => row.clientId));
    for (const id of this.pending) if (!current.has(id)) this.pending.delete(id);
    for (const row of raw) {
      if (row.role !== 'assistant') continue;
      if (this.streaming(row)) this.pending.add(row.clientId);
      else if (history.has(row.clientId) && !this.streaming(history.get(row.clientId)!)) this.pending.delete(row.clientId);
    }
    const pending = new Set(this.pending);
    if (!snapshot.ready) return { messages: raw, pending };
    for (const row of raw) if (pending.has(row.clientId)) {
      const known = history.get(row.clientId);
      history.set(row.clientId, known ? liveContentWithHistoryOrder(row, known) : row);
    }
    const messages = [...history.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.rowid ?? 0) - (b.rowid ?? 0));
    return { messages, pending };
  }
}
