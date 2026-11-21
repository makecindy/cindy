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
  refusedAt?: number;
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

// A mounted page can free both a viewer window and an executor. Exclude a
// capacity once this attempt has used it, or learned it is still full.
function withoutCapacity(release: Release, caller: string, peer: string, limit?: WindowLimit): Release {
  if (!limit) return release.peer === peer ? { ...release, peer: undefined } : release;
  if (release.caller !== caller) return release;
  if (release.window === limit) return { ...release, window: undefined };
  if (release.window !== 'mounted') return release;
  return { ...release, window: limit === 'pending' ? 'document' : 'pending' };
}

// These rejections precede publication of the requested View. A transport timeout
// or a disconnected executor may have lost the reply after allocation.
function rejectedBeforeAllocation(error: unknown): boolean {
  return /\bMCP_APP_(?:SERVER_CHANGED|TOOL_(?:UNAVAILABLE|NOT_VISIBLE)|OPEN_(?:TIMEOUT|CANCELLED)|CARD_(?:UNAVAILABLE|TOO_LARGE)|(?:SOURCE|VIEW|SESSION)_UNAVAILABLE|RESOURCE_(?:MISSING|NOT_FOUND|TOO_LARGE)|INVALID_RESOURCE|FILES_LOCAL_ONLY|CONNECTION_LIMIT)\b/.test(String(error))
    || /\bMCP_PLUGIN_(?:UNAVAILABLE|CSP_DOMAIN_NOT_DECLARED)\b/.test(String(error));
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
    // Refusal order is also the queue order. Keep the grant on the refused ticket
    // even if the card is still checking its visibility before registering its wait.
    for (const ticket of this.tickets.values()) {
      if (ticket.owner !== owner || ticket.granted || ticket.refusedAt === undefined ||
          ticket.refusedAt > release.through || !matches(ticket, release)) continue;
      ticket.granted = release;
      ticket.grant(true);
      return;
    }
  }

  async control(owner: unknown, caller: string, peer: string, input: Record<string, unknown>,
    send: (allocated?: (limit?: WindowLimit) => void) => Promise<unknown>, linkEpoch = 0, watchClose?: (closed: () => void) => () => void): Promise<unknown> {
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
      if (previous?.refusedAt === undefined) return false;
      const unwatch = watchClose?.(() => {
        if (!previous.granted) this.cancel(id, previous);
      });
      try { return await previous.ready; }
      finally { unwatch?.(); }
    }
    if (previous && op === 'cancel-open') {
      this.cancel(id, previous);
      if (previous.refusedAt !== undefined) return {};
    }
    if (op !== 'open' && op !== 'open-resource') return send();
    let retryGrant = previous?.granted;
    if (previous) this.remove(id, previous);
    let grant!: (available: boolean) => void;
    const ready = new Promise<boolean>(resolve => { grant = resolve; });
    const ticket: SlotTicket = { linkEpoch, caller, owner, peer, ready, grant };
    this.tickets.set(id, ticket);
    try {
      const result = await send(limit => {
        // Once allocated, the actual reservation/remote View owns its release.
        if (retryGrant) retryGrant = withoutCapacity(retryGrant, caller, peer, limit);
      });
      this.remove(id, ticket);
      return result;
    } catch (error) {
      const atLimit = /\bMCP_APP_VIEW_LIMIT\b/.test(String(error));
      const failedLimit = error instanceof McpAppWindowLimitError ? error.limit : undefined;
      if (this.tickets.get(id) === ticket && atLimit) {
        // Older and current executors also use this wire error for transient global pressure.
        // They cannot signal its end. Wait for a close on this viewer or the user's manual reload.
        ticket.refusedAt = ++this.nextWaiter;
        this.tickets.delete(id);
        this.tickets.set(id, ticket);
        ticket.limit = failedLimit;
      } else {
        this.remove(id, ticket);
      }
      if (retryGrant) {
        // On a lost reply the executor may still have a View. Local document
        // capacity is known independently, including when the executor is full.
        if (atLimit || !rejectedBeforeAllocation(error)) retryGrant = withoutCapacity(retryGrant, caller, peer, failedLimit);
        if (retryGrant.window || retryGrant.peer) this.grantNext(owner, retryGrant);
      }
      throw error;
    }
  }
}
