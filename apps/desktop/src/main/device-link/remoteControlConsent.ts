import { randomUUID } from 'node:crypto';
import { isCindyApp } from '@cindy/maker-shared/device-list';

export const REMOTE_CONTROL_CONSENT_CHANNEL = 'device-link:remote-control-consent';
const TTL = 45_000;
export type ConsentResult = 'enabled' | 'declined' | 'expired' | 'unavailable' | 'busy' | 'failed' | 'no_response';
interface Deps {
  scope(): unknown;
  eligible(peer: string): boolean;
  /** UX routing only: these dialogs are implemented by Cindy, not other Apps. */
  app?(peer: string): string | undefined;
  enabled(): boolean;
  send(peer: string, frame: unknown): void;
  prompt(peer: string, purpose: string, signal: AbortSignal): Promise<boolean>;
  enable(assertCurrent: () => void): Promise<void>;
}

/** Remote text is one bounded line; it cannot add apparent dialog sections or bidi controls. */
export function consentDisplayText(value: string): string {
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const characters = Array.from(text);
  return characters.length > 200 ? characters.slice(0, 200).join('') + '…' : text;
}

export function consentDeviceName(name: string | undefined, deviceId: string): string {
  return consentDisplayText(name ?? '') || deviceId.slice(0, 8);
}

/** A request can only show a local dialog. No remote frame can grant permission.
 * Pending state is scoped to this connection/account and is discarded on teardown.
 */
export class RemoteControlConsent {
  private outgoing = new Map<string, { peer: string; scope: unknown; finish(result: ConsentResult): void }>();
  private incoming: { peer: string; id: string; abort: AbortController } | null = null;
  private seen = new Map<string, number>();
  private prompted = new Map<string, number>();
  constructor(private readonly deps: Deps) {}

  request(peer: string, purpose: string): Promise<ConsentResult> {
    if (!isCindyApp(this.deps.app?.(peer)) || !this.deps.eligible(peer)) return Promise.resolve('unavailable');
    if (!purpose.trim() || purpose.length > 500) return Promise.resolve('failed');
    if ([...this.outgoing.values()].some(p => p.peer === peer)) return Promise.resolve('busy');
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => finish('no_response'), TTL + 2_000);
      const finish = (result: ConsentResult) => {
        clearTimeout(timer);
        this.outgoing.delete(id);
        resolve(result);
      };
      this.outgoing.set(id, { peer, scope: this.deps.scope(), finish });
      try { this.deps.send(peer, { version: 1, kind: 'request', id, purpose: purpose.trim(), ttlMs: TTL }); }
      catch { finish('unavailable'); }
    });
  }

  async receive(peer: string, raw: unknown): Promise<void> {
    if (!isCindyApp(this.deps.app?.(peer)) || !this.deps.eligible(peer) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const frame = raw as Record<string, unknown>;
    if (frame.version !== 1 || typeof frame.id !== 'string' || !/^[a-f0-9-]{36}$/.test(frame.id)) return;
    const id = frame.id;
    if (frame.kind === 'result') {
      const pending = this.outgoing.get(id);
      if (pending?.peer === peer && pending.scope === this.deps.scope() && ['enabled', 'declined', 'expired', 'busy', 'failed', 'unavailable'].includes(String(frame.result))) {
        pending.finish(frame.result as ConsentResult);
      }
      return;
    }
    if (frame.kind !== 'request' || typeof frame.purpose !== 'string' || !frame.purpose.trim() || frame.purpose.length > 500 ||
      typeof frame.ttlMs !== 'number' || !Number.isFinite(frame.ttlMs)) return;
    // A relative lifetime, counted on this computer's own clock: two computers' clocks
    // may differ by far more than the dialog lifetime.
    const now = Date.now();
    const remaining = Math.min(frame.ttlMs, TTL);
    if (remaining <= 0) return;
    const expiresAt = now + remaining;
    const key = `${peer}:${id}`;
    for (const [entry, expiry] of this.seen) if (expiry <= now) this.seen.delete(entry);
    if (this.seen.has(key)) return;
    // Bounds unsolicited requests and avoids repeatedly presenting a replayed dialog.
    if (this.seen.size >= 64) return;
    this.seen.set(key, now + TTL + 5_000);
    const reply = (result: ConsentResult) => {
      if (this.deps.eligible(peer)) {
        try { this.deps.send(peer, { version: 1, kind: 'result', id, result }); } catch { /* requester times out */ }
      }
    };
    if (this.deps.enabled()) { reply('enabled'); return; }
    for (const [p, expiry] of this.prompted) if (expiry <= now) this.prompted.delete(p);
    if (this.incoming || this.prompted.has(peer)) { reply('busy'); return; }
    this.prompted.set(peer, now + 60_000);
    const scope = this.deps.scope();
    const active = { peer, id, abort: new AbortController() };
    this.incoming = active;
    const timer = setTimeout(() => active.abort.abort(), Math.min(remaining, TTL));
    let onAbort!: () => void;
    const aborted = new Promise<false>(resolve => {
      onAbort = () => resolve(false);
      active.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      // Some native window failures never settle their promise. Expiry must still
      // return a result and release admission independently of dialog completion.
      const accepted = await Promise.race([
        this.deps.prompt(peer, consentDisplayText(frame.purpose), active.abort.signal), aborted,
      ]);
      if (this.incoming !== active || this.deps.scope() !== scope || !this.deps.eligible(peer)) return;
      if (active.abort.signal.aborted || Date.now() >= expiresAt) { reply('expired'); return; }
      if (!accepted) { reply('declined'); return; }
      await this.deps.enable(() => {
        if (this.incoming !== active || this.deps.scope() !== scope || active.abort.signal.aborted || Date.now() >= expiresAt || !this.deps.eligible(peer)) {
          throw new Error('Remote control consent is no longer current');
        }
      });
      if (this.incoming === active && this.deps.scope() === scope && this.deps.eligible(peer)) reply(this.deps.enabled() ? 'enabled' : 'failed');
    } catch { if (this.incoming === active && this.deps.scope() === scope) reply(active.abort.signal.aborted ? 'expired' : 'failed'); }
    finally {
      clearTimeout(timer);
      active.abort.signal.removeEventListener('abort', onAbort);
      if (this.incoming === active) this.incoming = null;
    }
  }

  /** The peer went offline: its dialog and pending request belong to a link that no longer exists,
   * and a quick reconnect must not revive them. */
  peerGone(peer: string): void {
    if (this.incoming?.peer === peer) this.incoming.abort.abort();
    for (const pending of [...this.outgoing.values()]) if (pending.peer === peer) pending.finish('unavailable');
  }

  reset(): void {
    this.incoming?.abort.abort();
    this.incoming = null;
    for (const pending of this.outgoing.values()) pending.finish('unavailable');
  }
}
