import { randomBytes } from 'node:crypto';

export const DRAG_TICKET_METHOD = 'cindy/composer-attachment/drag-ticket';
export const DRAG_TICKETS_INVALIDATED = 'cindy/composer-attachment/tickets-invalidated';
export const invalidDragTicket = () => new Error('MCP_APP_COMPOSER_DRAG_INVALID');

/** Verified with native cross-origin drags on macOS / Electron 42.11.12. */
export function supportsComposerDrag(platform: string, electronVersion?: string): boolean {
  return platform === 'darwin' && electronVersion?.split('.')[0] === '42';
}

/** Owned by one live View. Dropping the document or suspending invalidates outstanding reads too. */
export class ComposerDragTickets {
  private readonly tickets = new Map<string, { until: number; add(): Promise<unknown> }>();
  private issuedAt: number[] = [];
  private lifetime = new AbortController();

  get signal(): AbortSignal { return this.lifetime.signal; }

  reserve(): void {
    const now = performance.now();
    this.issuedAt = this.issuedAt.filter(time => now - time < 60_000);
    if (this.issuedAt.length >= 60) throw new Error('MCP_APP_COMPOSER_ATTACHMENT_RATE_LIMIT');
    this.issuedAt.push(now);
  }

  issue(add: () => Promise<unknown>): string {
    const now = performance.now();
    for (const [token, entry] of this.tickets) if (entry.until <= now) this.tickets.delete(token);
    const token = randomBytes(24).toString('hex');
    this.tickets.set(token, { until: now + 30_000, add });
    return token;
  }

  take(token: string) {
    const entry = this.tickets.get(token);
    if (!entry) return;
    this.tickets.delete(token);
    if (entry.until <= performance.now()) throw invalidDragTicket();
    return entry.add;
  }

  invalidate(): void {
    this.tickets.clear();
    this.lifetime.abort(invalidDragTicket());
    this.lifetime = new AbortController();
  }
}
