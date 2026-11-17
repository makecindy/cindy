/** Receipt metadata only. Host owns atomic, account-scoped persistence. */
export interface BlueBubblesState {
  version: 1;
  activatedAt: number;
  /** Chats enabled after the connection was created; absent in older journals. */
  chatActivatedAt?: Record<string, number>;
  cursors: Record<string, number>;
  inbox: Record<string, { receivedAt: number; state: 'pending' | 'dispatching' | 'accepted' | 'ignored';
    stop?: { chatId: string; sentAt: number; before: string[] } }>;
  outbox: Record<string, { chatId: string; state: 'sending' | 'sent' | 'unknown'; messageId?: string }>;
}
export type BlueBubblesReceiptUpdate =
  | { kind: 'inbox'; id: string; value: BlueBubblesState['inbox'][string] }
  | { kind: 'outbox'; id: string; value: BlueBubblesState['outbox'][string] }
  | { kind: 'cursor'; id: string; value: number };
export interface BlueBubblesStateStorage {
  read(): BlueBubblesState | null;
  write(state: BlueBubblesState): void;
  /** Durable incremental write. Avoid rewriting the entire receipt history for each webhook. */
  update?(update: BlueBubblesReceiptUpdate): void;
}
export function applyBlueBubblesReceiptUpdate(state: BlueBubblesState, update: BlueBubblesReceiptUpdate): void {
  if (!update || typeof update.id !== 'string' || !update.id || ['__proto__', 'constructor', 'prototype'].includes(update.id)) throw new Error('BLUEBUBBLES_INVALID_RECEIPTS');
  if (update.kind === 'cursor' && Number.isFinite(update.value)) state.cursors[update.id] = update.value;
  else if (update.kind === 'inbox' && update.value && Number.isFinite(update.value.receivedAt)
    && ['pending', 'dispatching', 'accepted', 'ignored'].includes(update.value.state)) {
    const stop = update.value.stop;
    if (stop && (typeof stop.chatId !== 'string' || !stop.chatId || !Number.isFinite(stop.sentAt)
      || !Array.isArray(stop.before) || stop.before.some(id => typeof id !== 'string'))) throw new Error('BLUEBUBBLES_INVALID_RECEIPTS');
    state.inbox[update.id] = update.value;
  }
  else if (update.kind === 'outbox' && update.value && typeof update.value.chatId === 'string'
    && ['sending', 'sent', 'unknown'].includes(update.value.state)) state.outbox[update.id] = update.value;
  else throw new Error('BLUEBUBBLES_INVALID_RECEIPTS');
}
export class BlueBubblesReceipts {
  private state: BlueBubblesState;
  private readonly pending = new Set<string>();
  private readonly arrivalOrder = new Map<string, number>();
  private readonly dispatching = new Set<string>();
  private readonly unsettledSends = new Set<string>();
  private readonly unresolved = new Set<string>();
  private readonly stops = new Map<string, { sentAt: number; before: Set<string> }>();
  constructor(private readonly storage: BlueBubblesStateStorage, now: number) {
    const saved = storage.read();
    if (saved && (saved.version !== 1 || !Number.isFinite(saved.activatedAt)
      || !saved.cursors || !saved.inbox || !saved.outbox)) throw new Error('BLUEBUBBLES_INVALID_RECEIPTS');
    this.state = saved ?? { version: 1, activatedAt: now, cursors: {}, inbox: {}, outbox: {} };
    if (this.state.chatActivatedAt && Object.values(this.state.chatActivatedAt).some(value => !Number.isFinite(value))) throw new Error('BLUEBUBBLES_INVALID_RECEIPTS');
    if (!saved) storage.write(this.state);
    for (const [id, value] of Object.entries(this.state.inbox)) {
      applyBlueBubblesReceiptUpdate(this.state, { kind: 'inbox', id, value });
      this.arrivalOrder.set(id, this.arrivalOrder.size);
      if (value.state === 'pending') this.pending.add(id);
      if (value.state === 'dispatching') this.dispatching.add(id);
      if (value.state === 'pending' || value.state === 'dispatching') this.unresolved.add(id);
    }
    for (const value of Object.values(this.state.inbox)) this.indexStop(value.stop);
    for (const [id, value] of Object.entries(this.state.outbox)) {
      applyBlueBubblesReceiptUpdate(this.state, { kind: 'outbox', id, value });
      if (value.state !== 'sent') this.unsettledSends.add(id);
    }
    for (const [id, value] of Object.entries(this.state.cursors)) applyBlueBubblesReceiptUpdate(this.state, { kind: 'cursor', id, value });
  }
  snapshot(): BlueBubblesState { return structuredClone(this.state); }
  uncertainCounts(activeDispatches: ReadonlySet<string>, activeSends: ReadonlySet<string>) {
    let uncertainInputs = 0, uncertainSends = 0;
    for (const id of this.dispatching) if (!activeDispatches.has(id)) uncertainInputs++;
    for (const id of this.unsettledSends) if (!activeSends.has(id)) uncertainSends++;
    return { uncertainInputs, uncertainSends };
  }
  get activatedAt(): number { return this.state.activatedAt; }
  activatedAtFor(chat: string): number { return Math.max(this.state.activatedAt, this.state.chatActivatedAt?.[chat] ?? this.state.activatedAt); }
  /** One checkpoint per settings edit, retaining every existing receipt and cursor. */
  activateChats(chats: string[], at: number): void {
    if (!chats.length) return;
    const next = this.snapshot();
    next.chatActivatedAt = { ...next.chatActivatedAt };
    for (const chat of chats) next.chatActivatedAt[chat] = at;
    this.storage.write(next);
    this.state = next;
  }
  isPending(guid: string): boolean { return this.state.inbox[guid]?.state === 'pending'; }
  /** Stable first observation order, independent of recovery's pending sort. */
  receivedBefore(earlier: string, later: string): boolean {
    const a = this.arrivalOrder.get(earlier), b = this.arrivalOrder.get(later);
    return a !== undefined && b !== undefined && a < b;
  }
  receivedAfter(guid: string, time: number): boolean { return (this.state.inbox[guid]?.receivedAt ?? 0) > time; }
  cursor(chat: string): number { return this.state.cursors[chat] ?? this.state.activatedAt; }
  nextPending(exclude: ReadonlySet<string>, active?: ReadonlySet<string>): string | undefined {
    for (const guid of this.pending) if (!exclude.has(guid) && !active?.has(guid)) return guid;
    return undefined;
  }
  pendingGuids(): string[] { return [...this.pending]; }
  /** Recovery merges persisted, missed and live receipts before dispatch resumes. */
  orderPending(ordered: Iterable<string>): void {
    const remaining = new Set(this.pending);
    this.pending.clear();
    for (const guid of ordered) if (remaining.delete(guid)) this.pending.add(guid);
    for (const guid of remaining) this.pending.add(guid);
  }
  private indexStop(stop: BlueBubblesState['inbox'][string]['stop']): void {
    if (!stop) return;
    const previous = this.stops.get(stop.chatId);
    if (previous && previous.sentAt > stop.sentAt) return;
    const boundary = previous?.sentAt === stop.sentAt ? previous : { sentAt: stop.sentAt, before: new Set<string>() };
    for (const guid of stop.before) if (this.unresolved.has(guid)) boundary.before.add(guid);
    for (const guid of boundary.before) if (!this.unresolved.has(guid)) boundary.before.delete(guid);
    this.stops.set(stop.chatId, boundary);
  }
  rememberStop(guid: string, chatId: string, sentAt: number): void {
    const previous = this.state.inbox[guid];
    if (!previous || !this.unresolved.has(guid)) throw new Error('BLUEBUBBLES_RECEIPT_MISSING');
    const before: string[] = [];
    for (const id of this.unresolved) { if (id === guid) break; before.push(id); }
    // Same inbox update format: old readers retain the optional metadata.
    this.update({ kind: 'inbox', id: guid, value: { ...previous, stop: { chatId, sentAt, before } } });
  }
  wasStopped(guid: string, chatId: string, sentAt: number): boolean {
    const boundary = this.stops.get(chatId);
    // Receipt order breaks equal-time ties only; it cannot override a later send.
    return !!boundary && (sentAt < boundary.sentAt || (sentAt === boundary.sentAt && boundary.before.has(guid)));
  }
  private update(update: BlueBubblesReceiptUpdate): void {
    // Validation before persistence; only replace in-memory facts after a durable write succeeds.
    const test: BlueBubblesState = { version: 1, activatedAt: 0, inbox: {}, outbox: {}, cursors: {} };
    applyBlueBubblesReceiptUpdate(test, update);
    if (this.storage.update) this.storage.update(update);
    else {
      const next = this.snapshot(); applyBlueBubblesReceiptUpdate(next, update); this.storage.write(next);
    }
    applyBlueBubblesReceiptUpdate(this.state, update);
    if (update.kind === 'inbox') {
      if (!this.arrivalOrder.has(update.id)) this.arrivalOrder.set(update.id, this.arrivalOrder.size);
      if (update.value.state === 'pending') this.pending.add(update.id); else this.pending.delete(update.id);
      if (update.value.state === 'dispatching') this.dispatching.add(update.id); else this.dispatching.delete(update.id);
      if (update.value.state === 'pending' || update.value.state === 'dispatching') this.unresolved.add(update.id);
      else this.unresolved.delete(update.id);
      this.indexStop(update.value.stop);
    } else if (update.kind === 'outbox') {
      if (update.value.state !== 'sent') this.unsettledSends.add(update.id); else this.unsettledSends.delete(update.id);
    }
  }
  setCursor(chat: string, value: number): void { this.update({ kind: 'cursor', id: chat, value }); }
  mark(guid: string, state: BlueBubblesState['inbox'][string]['state']): void {
    const previous = this.state.inbox[guid];
    if (!previous) throw new Error('BLUEBUBBLES_RECEIPT_MISSING');
    this.update({ kind: 'inbox', id: guid, value: { ...previous, state } });
  }
  outgoing(id: string, value: BlueBubblesState['outbox'][string]): void { this.update({ kind: 'outbox', id, value }); }
  receive(guid: string, now: number): boolean {
    if (Object.hasOwn(this.state.inbox, guid)) return false;
    this.update({ kind: 'inbox', id: guid, value: { receivedAt: now, state: 'pending' } });
    return true;
  }
}
