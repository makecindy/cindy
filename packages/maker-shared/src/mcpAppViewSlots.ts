// A viewing desktop or phone coordinates its own opens. Slot notifications never cross device-link.
type WindowLimit = 'pending' | 'document';
interface Release {
  through: number;
  caller: string;
  peer?: string;
  window?: WindowLimit | 'mounted'; // Removing a mounted remote View frees both window limits.
}
interface SlotTicket {
  linkEpoch: number;
  caller: string;
  owner: unknown;
  peer: string;
  limit?: WindowLimit;
  refused?: boolean;
  waitingSince?: number;
  granted?: Release;
  grant: (available: boolean) => void;
  ready: Promise<boolean>;
}

export class McpAppWindowLimitError extends Error {
  constructor(readonly limit: WindowLimit) { super('MCP_APP_VIEW_LIMIT'); }
}

/** A previously opened remote View may have been retired by its Host before the viewer closes it. */
export function confirmsMcpAppViewGone(error: unknown): boolean {
  return /\bMCP_APP_VIEW_UNAVAILABLE\b/.test(String(error));
}

function matches(ticket: SlotTicket, release: Release): boolean {
  return ticket.limit
    ? ticket.caller === release.caller && (release.window === 'mounted' || release.window === ticket.limit)
    : ticket.peer === release.peer;
}

export class McpAppViewSlots {
  private readonly tickets = new Map<string, SlotTicket>();
  private nextWaiter = 0;

  cancelCaller(caller: string): void {
    for (const [id, ticket] of this.tickets) {
      if (ticket.caller === caller) this.cancel(id, ticket);
    }
  }

  private remove(id: string, ticket: SlotTicket): void {
    if (this.tickets.get(id) !== ticket) return;
    this.tickets.delete(id);
    ticket.grant(false);
  }

  private cancel(id: string, ticket: SlotTicket): void {
    if (this.tickets.get(id) !== ticket) return;
    this.remove(id, ticket);
    if (ticket.granted) this.grantNext(ticket.owner, ticket.granted);
  }

  released(owner: unknown, caller: string, peer?: string, window?: Release['window']): void {
    this.grantNext(owner, { caller, peer, window, through: this.nextWaiter });
  }

  private grantNext(owner: unknown, release: Release): void {
    for (const ticket of this.tickets.values()) {
      // A close funds one retry of a card already refused when it occurred. If the recipient
      // leaves before sending open, only another original waiter can use that same slot.
      if (ticket.owner !== owner || ticket.granted || ticket.waitingSince === undefined ||
          ticket.waitingSince > release.through || !matches(ticket, release)) continue;
      ticket.granted = release;
      ticket.grant(true);
      return;
    }
  }

  async control(owner: unknown, caller: string, peer: string, input: Record<string, unknown>,
    send: () => Promise<unknown>, linkEpoch = 0, watchClose?: (closed: () => void) => () => void): Promise<unknown> {
    const { op, openId } = input;
    if (typeof openId !== 'string') return op === 'wait-for-view-slot' ? false : send();
    const id = JSON.stringify([caller, openId]);
    const previous = this.tickets.get(id);
    if (previous && (op === 'open' || op === 'open-resource' || op === 'wait-for-view-slot')) {
      if (previous.owner !== owner || previous.peer !== peer || previous.linkEpoch !== linkEpoch) {
        this.cancel(id, previous);
        throw new Error(previous.owner !== owner ? 'MCP_APP_OWNER_CHANGED' : 'MCP_APP_LINK_CLOSED');
      }
    }
    if (op === 'wait-for-view-slot') {
      if (!previous?.refused) return false;
      if (previous.waitingSince === undefined) {
        previous.waitingSince = ++this.nextWaiter;
        this.tickets.delete(id);
        this.tickets.set(id, previous);
      }
      const unwatch = watchClose?.(() => {
        if (!previous.granted) this.cancel(id, previous);
      });
      try { return await previous.ready; }
      finally { unwatch?.(); }
    }
    if (previous && op === 'cancel-open') {
      this.cancel(id, previous);
      if (previous.refused) return {};
    }
    if (op !== 'open' && op !== 'open-resource') return send();
    if (previous) this.remove(id, previous); // Starting the retry consumes its grant.
    let grant!: (available: boolean) => void;
    const ready = new Promise<boolean>(resolve => { grant = resolve; });
    const ticket: SlotTicket = { linkEpoch, caller, owner, peer, ready, grant };
    this.tickets.set(id, ticket);
    try {
      const result = await send();
      this.remove(id, ticket);
      return result;
    } catch (error) {
      if (this.tickets.get(id) === ticket && /\bMCP_APP_VIEW_LIMIT\b/.test(String(error))) {
        // Older and current executors also use this wire error for transient global pressure.
        // They cannot signal its end. Wait for a close on this viewer or the user's manual reload.
        ticket.refused = true;
        if (error instanceof McpAppWindowLimitError) ticket.limit = error.limit;
      } else this.remove(id, ticket);
      throw error;
    }
  }
}
