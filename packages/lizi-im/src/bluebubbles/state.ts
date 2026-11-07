/** Receipt metadata only. Host owns atomic, account-scoped persistence. */
export interface BlueBubblesState {
  version: 1;
  activatedAt: number;
  cursors: Record<string, number>;
  inbox: Record<string, { receivedAt: number; state: 'pending' | 'dispatching' | 'accepted' | 'ignored' }>;
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
    && ['pending', 'dispatching', 'accepted', 'ignored'].includes(update.value.state)) state.inbox[update.id] = update.value;
  else if (update.kind === 'outbox' && update.value && typeof update.value.chatId === 'string'
    && ['sending', 'sent', 'unknown'].includes(update.value.state)) state.outbox[update.id] = update.value;
  else throw new Error('BLUEBUBBLES_INVALID_RECEIPTS');
}
export class BlueBubblesReceipts {
  private state: BlueBubblesState;
  private readonly pending = new Set<string>();
  private readonly dispatching = new Set<string>();
  private readonly unsettledSends = new Set<string>();
  constructor(private readonly storage: BlueBubblesStateStorage, now: number) {
    const saved = storage.read();
    if (saved && (saved.version !== 1 || !Number.isFinite(saved.activatedAt)
      || !saved.cursors || !saved.inbox || !saved.outbox)) throw new Error('BLUEBUBBLES_INVALID_RECEIPTS');
    this.state = saved ?? { version: 1, activatedAt: now, cursors: {}, inbox: {}, outbox: {} };
    if (!saved) storage.write(this.state);
    for (const [id, value] of Object.entries(this.state.inbox)) {
      applyBlueBubblesReceiptUpdate(this.state, { kind: 'inbox', id, value });
      if (value.state === 'pending') this.pending.add(id);
      if (value.state === 'dispatching') this.dispatching.add(id);
    }
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
  receivedAfter(guid: string, time: number): boolean { return (this.state.inbox[guid]?.receivedAt ?? 0) > time; }
  cursor(chat: string): number { return this.state.cursors[chat] ?? this.state.activatedAt; }
  nextPending(exclude: ReadonlySet<string>, active?: ReadonlySet<string>): string | undefined {
    for (const guid of this.pending) if (!exclude.has(guid) && !active?.has(guid)) return guid;
    return undefined;
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
      if (update.value.state === 'pending') this.pending.add(update.id); else this.pending.delete(update.id);
      if (update.value.state === 'dispatching') this.dispatching.add(update.id); else this.dispatching.delete(update.id);
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
