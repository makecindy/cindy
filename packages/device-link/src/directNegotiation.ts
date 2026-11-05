import type { DeviceLinkDirectChannel, DeviceLinkDirectPathHandle } from './directPath.js';
import { DirectCapacityPool, DirectCapacityError, DIRECT_LINK_IDLE_MS, type DirectPeerKind } from './directCapacity.js';
export { DIRECT_LINK_MAX_PEERS, DIRECT_LINK_DESKTOP_MAX_PEERS, DIRECT_LINK_DESKTOP_RESERVED_PEERS,
  DIRECT_LINK_IDLE_MS } from './directCapacity.js';

/** Optional, end-to-end capability. Signaling always stays on the authenticated relay. */
export const DIRECT_LINK_CAPABILITY = 'direct-link-v1';
/** Provider-share peers require both this capability and the ordinary direct-link capability. */
export const PROVIDER_SHARE_DIRECT_CAPABILITY = 'provider-share-direct-v1';
export const DIRECT_LINK_SIGNAL = 'device-link:direct-signal';
export const DIRECT_LINK_TIMEOUT_MS = 15_000;
export const DIRECT_LINK_MAX_SDP = 128 * 1024;

export type DirectRuntimeCloseReason = 'channel-closed' | 'network-failed' | 'runtime-timeout' | 'runtime-failed' | 'runtime-unavailable';
export type DirectDiagnosticReason = DirectRuntimeCloseReason | 'connected' | 'capacity-full' | 'queue-full'
  | 'negotiation-timeout' | 'idle-retired' | 'send-failed' | 'ack-timeout' | 'buffer-timeout';
export interface DirectDiagnostic {
  reason: DirectDiagnosticReason;
  kind: DirectPeerKind;
  active: number;
  limit: number;
  queued: number;
  device: number;
  share: number;
  reserved: number;
}
export interface DirectRuntimeEvents {
  open(): void;
  message(text: string): void;
  drained(): void;
  closed(reason?: DirectRuntimeCloseReason): void;
}
export interface DirectRuntimeSession {
  offer(): Promise<string>;
  accept(sdp: string): Promise<string>;
  answer(sdp: string): Promise<void>;
  send(text: string): void;
  readonly bufferedAmount: number;
  close(): void;
}
/** Browser WebRTC is injected by each host; no Electron/React dependency here. */
export interface DirectRuntime {
  create(id: string, events: DirectRuntimeEvents, options?: { kind: DirectPeerKind }): DirectRuntimeSession;
  /** One shared admission pool per native process, not one pool per relay client. */
  capacity?: DirectCapacityPool;
  /** Release the platform process when the authenticated relay generation ends. */
  suspend?(): void;
}
export type DirectSignal = {
  action: 'offer' | 'answer' | 'close';
  id: string;
  stream: string;
  targetStream: string;
  sdp?: string;
};
export function parseDirectSignal(value: unknown): DirectSignal | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if ((v.action !== 'offer' && v.action !== 'answer' && v.action !== 'close')
    || typeof v.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(v.id)
    || typeof v.stream !== 'string' || v.stream.length > 128 || !v.stream
    || typeof v.targetStream !== 'string' || v.targetStream.length > 128 || !v.targetStream) return null;
  if (v.action !== 'close' && (typeof v.sdp !== 'string' || !v.sdp || v.sdp.length > DIRECT_LINK_MAX_SDP)) return null;
  return { action: v.action as DirectSignal['action'], id: v.id, stream: v.stream,
    targetStream: v.targetStream, ...(v.action !== 'close' ? { sdp: v.sdp as string } : {}) };
}
interface Attempt {
  id: string;
  localStream: string;
  remoteStream: string;
  session: DirectRuntimeSession;
  handle?: DeviceLinkDirectPathHandle;
  timer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  release?(): void;
  opened: boolean;
}
interface Peer {
  attempt?: Attempt;
  retry?: ReturnType<typeof setTimeout>;
  failures: number;
  touched: number;
  offerExpiresAt?: number;
  waiting?: { cancel(): void; timer: ReturnType<typeof setTimeout>; offer?: DirectSignal };
  diagnostics?: Partial<Record<DirectDiagnosticReason, number>>;
}

/** One bounded negotiation per authorized peer; failures never delay ordinary relay traffic. */
export class DirectLinkNegotiator {
  private readonly peers = new Map<string, Peer>();
  private readonly localCapacity = new DirectCapacityPool();
  constructor(private readonly deps: {
    runtime: DirectRuntime;
    identity(): string | null;
    /** Physical identity for scoped peer keys; the scoped key itself is never an ordering identity. */
    peerDeviceId?(peer: string): string | null;
    /** Signaling needs the relay even when an established data channel remains usable. */
    canSignal?(peer: string): boolean;
    kind?(peer: string): DirectPeerKind;
    /** Outstanding requests, executing handlers or unacknowledged reliable data. */
    isBusy?(peer: string): boolean;
    diagnostic?(peer: string, event: DirectDiagnostic): void;
    streams(peer: string): { local: string; remote: string } | null;
    id(): string;
    signal(peer: string, signal: DirectSignal): void;
    attach(peer: string, channel: DeviceLinkDirectChannel): DeviceLinkDirectPathHandle;
  }) {}

  ready(peerId: string): void {
    if (!this.deps.streams(peerId) || this.deps.canSignal?.(peerId) === false) return;
    // Both endpoints run this, including a Mobile which only initiated a control link.
    // Exactly one creates offers, so mutual control cannot create glare or two channels.
    const self = this.deps.identity();
    const physicalPeer = this.deps.peerDeviceId ? this.deps.peerDeviceId(peerId) : peerId;
    if (!self || !physicalPeer || self >= physicalPeer) return;
    let peer = this.peers.get(peerId);
    if (!peer) {
      if (!this.makeRoom()) { this.rejected(peerId); return; }
      peer = { failures: 0, touched: Date.now() };
      this.peers.set(peerId, peer);
    }
    if (peer.attempt || peer.retry || peer.waiting) return;
    this.start(peerId, peer);
  }

  /** Business traffic wakes a retired path; negotiation/retry alone is not activity. */
  activity(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) peer.touched = Date.now();
    else this.ready(peerId);
  }

  private start(peerId: string, peer: Peer, offer?: DirectSignal): void {
    if (this.peers.get(peerId) !== peer || !this.deps.streams(peerId) || this.deps.canSignal?.(peerId) === false) {
      this.forget(peerId); return;
    }
    if (Date.now() - peer.touched >= DIRECT_LINK_IDLE_MS && !this.deps.isBusy?.(peerId)) {
      this.forget(peerId); return;
    }
    if (offer && Date.now() >= (peer.offerExpiresAt ?? 0)) { this.forget(peerId); return; }
    if (peer.attempt || peer.waiting) return;
    const attempt = this.createAttempt(peerId, peer, offer?.id ?? this.deps.id(), offer);
    if (!attempt) return;
    void (offer ? attempt.session.accept(offer.sdp!) : attempt.session.offer()).then((sdp) => {
      if (this.current(peerId, peer, attempt)) this.send(peerId, attempt, offer ? 'answer' : 'offer', sdp);
    }).catch((error) => this.failedOperation(peerId, peer, attempt, error, offer));
  }

  receive(peerId: string, signal: DirectSignal): void {
    if (this.deps.canSignal?.(peerId) === false) return;
    const streams = this.deps.streams(peerId);
    if (!streams || signal.stream !== streams.remote || signal.targetStream !== streams.local) return;
    let peer = this.peers.get(peerId);
    if (signal.action === 'offer') {
      const self = this.deps.identity();
      const physicalPeer = this.deps.peerDeviceId ? this.deps.peerDeviceId(peerId) : peerId;
      if (!self || !physicalPeer || physicalPeer >= self) return;
      if (!peer) {
        if (!this.makeRoom()) { this.rejected(peerId); return; }
        peer = { failures: 0, touched: Date.now() };
        this.peers.set(peerId, peer);
      }
      if (peer.attempt?.id === signal.id) return;
      // A live session is not displaced by a duplicate/late offer. A retry first closes it.
      if (peer.attempt) return;
      if (peer.waiting) return;
      peer.offerExpiresAt = Date.now() + DIRECT_LINK_TIMEOUT_MS;
      this.start(peerId, peer, signal);
    } else if (peer?.attempt?.id === signal.id) {
      const attempt = peer.attempt;
      if (signal.action === 'close') this.fail(peerId, peer, attempt, false);
      else if (this.deps.identity()! < (this.deps.peerDeviceId ? this.deps.peerDeviceId(peerId) ?? '' : peerId)) {
        void attempt.session.answer(signal.sdp!).catch(() => this.fail(peerId, peer!, attempt, true, 'runtime-failed'));
      }
    } else if (signal.action === 'close' && peer?.waiting?.offer?.id === signal.id) {
      this.forget(peerId);
    }
  }

  forget(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    clearTimeout(peer.retry);
    peer.waiting?.cancel();
    clearTimeout(peer.waiting?.timer);
    const attempt = peer.attempt;
    peer.attempt = undefined;
    if (attempt) {
      clearTimeout(attempt.timer);
      clearTimeout(attempt.idleTimer);
      attempt.release?.();
      attempt.handle?.closed();
      attempt.session.close();
    }
  }
  clear(): void { for (const id of this.peers.keys()) this.forget(id); }

  private get capacity(): DirectCapacityPool { return this.deps.runtime.capacity ?? this.localCapacity; }
  private kind(peer: string): DirectPeerKind { return this.deps.kind?.(peer) ?? 'device'; }
  private diagnose(peerId: string, peer: Peer, reason: DirectDiagnosticReason): void {
    const now = Date.now();
    const previous = peer.diagnostics?.[reason];
    if (previous !== undefined && now - previous < 60_000) return;
    (peer.diagnostics ??= {})[reason] = now;
    try { this.deps.diagnostic?.(peerId, { reason, kind: this.kind(peerId), ...this.capacity.snapshot() }); }
    catch { /* Diagnostics cannot interrupt relay fallback or capacity release. */ }
  }
  private rejected(peerId: string): void {
    this.diagnose(peerId, { failures: 0, touched: Date.now() }, 'queue-full');
  }
  private makeRoom(): boolean {
    if (this.peers.size < 256) return true;
    // Never evict a live channel to admit a new peer. Stale failure state has no slot.
    for (const [id, peer] of this.peers) if (!peer.attempt && Date.now() - peer.touched >= DIRECT_LINK_IDLE_MS) {
      this.forget(id); return true;
    }
    return false;
  }
  private wait(peerId: string, peer: Peer, offer?: DirectSignal): void {
    if (this.peers.get(peerId) !== peer || peer.waiting) return;
    try {
      const offerExpiresAt = peer.offerExpiresAt ?? 0;
      const cancel = this.capacity.wait(this.kind(peerId), () => {
        if (this.peers.get(peerId) !== peer) return;
        clearTimeout(peer.waiting?.timer);
        peer.waiting = undefined;
        // Recheck authorization and both stream generations before reusing an offer.
        const streams = this.deps.streams(peerId);
        if (offer && (Date.now() >= offerExpiresAt || streams?.local !== offer.targetStream || streams.remote !== offer.stream)) {
          this.forget(peerId); return;
        }
        this.start(peerId, peer, offer);
      });
      const expire = () => {
        if (this.peers.get(peerId) !== peer || !peer.waiting) return;
        if (!offer && (this.deps.isBusy?.(peerId) || Date.now() - peer.touched < DIRECT_LINK_IDLE_MS)) {
          peer.waiting.timer = setTimeout(expire, this.deps.isBusy?.(peerId) ? 60_000
            : Math.max(1, DIRECT_LINK_IDLE_MS - (Date.now() - peer.touched)));
        } else this.forget(peerId);
      };
      const timer = setTimeout(expire, offer ? Math.max(1, offerExpiresAt - Date.now())
        : Math.max(1, DIRECT_LINK_IDLE_MS - (Date.now() - peer.touched)));
      peer.waiting = { cancel, timer, offer };
      this.diagnose(peerId, peer, 'capacity-full');
    } catch {
      this.diagnose(peerId, peer, 'queue-full');
      this.forget(peerId);
    }
  }

  private current(peerId: string, peer: Peer, attempt: Attempt): boolean {
    const streams = this.deps.streams(peerId);
    return this.peers.get(peerId) === peer && peer.attempt === attempt
      && streams?.local === attempt.localStream && streams.remote === attempt.remoteStream;
  }
  private createAttempt(peerId: string, peer: Peer, id: string, offer?: DirectSignal): Attempt | null {
    const streams = this.deps.streams(peerId);
    if (!streams) return null;
    let attempt: Attempt;
    let release: (() => void) | undefined;
    try {
      if (!this.deps.runtime.capacity) release = this.localCapacity.acquire(id, this.kind(peerId));
      const session = this.deps.runtime.create(id, {
        open: () => {
          if (!this.current(peerId, peer, attempt) || attempt.opened) return;
          clearTimeout(attempt.timer);
          attempt.opened = true;
          this.diagnose(peerId, peer, 'connected');
          attempt.timer = setTimeout(() => {
            if (this.current(peerId, peer, attempt)) peer.failures = 0;
          }, 60_000);
          const channel: DeviceLinkDirectChannel = {
            send: (text) => { peer.touched = Date.now(); session.send(text); },
            get bufferedAmount() { return session.bufferedAmount; },
            close: (reason) => this.fail(peerId, peer, attempt, true,
              reason === 'send-failed' || reason === 'ack-timeout' || reason === 'buffer-timeout' ? reason : 'channel-closed'),
          };
          attempt.handle = this.deps.attach(peerId, channel);
          this.watchIdle(peerId, peer, attempt);
        },
        message: (text) => { if (this.current(peerId, peer, attempt)) { peer.touched = Date.now(); attempt.handle?.receive(text); } },
        drained: () => { if (this.current(peerId, peer, attempt)) attempt.handle?.drained(); },
        closed: (reason) => this.fail(peerId, peer, attempt, true, reason),
      }, { kind: this.kind(peerId) });
      attempt = { id, localStream: streams.local, remoteStream: streams.remote, session, opened: false, release };
      peer.attempt = attempt;
      attempt.timer = setTimeout(() => this.fail(peerId, peer, attempt, true, 'negotiation-timeout'),
        offer ? Math.max(1, (peer.offerExpiresAt ?? 0) - Date.now()) : DIRECT_LINK_TIMEOUT_MS);
      return attempt;
    } catch (error) {
      release?.();
      if (error instanceof DirectCapacityError) this.wait(peerId, peer, offer);
      else { this.diagnose(peerId, peer, 'runtime-unavailable'); this.retry(peerId, peer); }
      return null;
    }
  }
  private failedOperation(peerId: string, peer: Peer, attempt: Attempt, error: unknown, offer?: DirectSignal): void {
    if (error instanceof DirectCapacityError && this.current(peerId, peer, attempt)) {
      peer.attempt = undefined;
      clearTimeout(attempt.timer);
      attempt.release?.();
      attempt.session.close();
      this.wait(peerId, peer, offer);
    } else {
      const message = error instanceof Error ? error.message : '';
      this.fail(peerId, peer, attempt, true, message === 'DIRECT_RUNTIME_TIMEOUT' ? 'runtime-timeout'
        : message === 'DIRECT_RUNTIME_UNAVAILABLE' || message === 'DIRECT_RUNTIME_CLOSED' ? 'runtime-unavailable' : 'runtime-failed');
    }
  }
  private watchIdle(peerId: string, peer: Peer, attempt: Attempt): void {
    attempt.idleTimer = setTimeout(() => {
      if (!this.current(peerId, peer, attempt)) return;
      if (this.capacity.needsSlotFrom(this.kind(peerId)) && Date.now() - peer.touched >= DIRECT_LINK_IDLE_MS && !this.deps.isBusy?.(peerId)
        && attempt.session.bufferedAmount === 0) {
        this.diagnose(peerId, peer, 'idle-retired');
        this.forget(peerId);
        try { this.send(peerId, attempt, 'close'); } catch { /* Relay may be offline. */ }
      } else this.watchIdle(peerId, peer, attempt);
    }, 60_000);
  }
  private send(peerId: string, attempt: Attempt, action: DirectSignal['action'], sdp?: string): void {
    if (sdp && sdp.length > DIRECT_LINK_MAX_SDP) throw new Error('DIRECT_SDP_TOO_LARGE');
    this.deps.signal(peerId, { action, id: attempt.id, stream: attempt.localStream,
      targetStream: attempt.remoteStream, ...(sdp ? { sdp } : {}) });
  }
  private fail(peerId: string, peer: Peer, attempt: Attempt, notify = true, reason: DirectDiagnosticReason = 'channel-closed'): void {
    if (this.peers.get(peerId) !== peer || peer.attempt !== attempt) return;
    peer.attempt = undefined;
    clearTimeout(attempt.timer);
    clearTimeout(attempt.idleTimer);
    attempt.release?.();
    this.diagnose(peerId, peer, reason);
    // Clear the registration first: closing the channel can synchronously call us again.
    attempt.handle?.closed();
    attempt.session.close();
    if (notify) { try { this.send(peerId, attempt, 'close'); } catch { /* Relay may be offline. */ } }
    this.retry(peerId, peer);
  }
  private retry(peerId: string, peer: Peer): void {
    if (Date.now() - peer.touched >= DIRECT_LINK_IDLE_MS && !this.deps.isBusy?.(peerId)) { this.forget(peerId); return; }
    if (this.peers.get(peerId) !== peer || peer.retry) return;
    if (!this.deps.streams(peerId) || !this.deps.identity()
      || this.deps.identity()! >= (this.deps.peerDeviceId ? this.deps.peerDeviceId(peerId) ?? '' : peerId)) {
      this.forget(peerId); return;
    }
    const backoff = Math.min(60_000, 5_000 * 2 ** Math.min(peer.failures++, 4));
    // Spread simultaneous peer failures even at the cap, without exceeding the retry ceiling.
    const delay = Math.floor(backoff * (0.8 + Math.random() * 0.2));
    peer.retry = setTimeout(() => {
      peer.retry = undefined;
      if (this.peers.get(peerId) === peer) {
        if (Date.now() - peer.touched >= DIRECT_LINK_IDLE_MS && !this.deps.isBusy?.(peerId)) this.forget(peerId);
        else this.start(peerId, peer);
      }
    }, delay);
  }
}
