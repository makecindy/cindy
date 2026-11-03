import type { DeviceLinkDirectChannel, DeviceLinkDirectPathHandle } from './directPath.js';

/** Optional, end-to-end capability. Signaling always stays on the authenticated relay. */
export const DIRECT_LINK_CAPABILITY = 'direct-link-v1';
/** Provider-share peers require both this capability and the ordinary direct-link capability. */
export const PROVIDER_SHARE_DIRECT_CAPABILITY = 'provider-share-direct-v1';
export const DIRECT_LINK_SIGNAL = 'device-link:direct-signal';
export const DIRECT_LINK_MAX_PEERS = 16;
export const DIRECT_LINK_TIMEOUT_MS = 15_000;
export const DIRECT_LINK_MAX_SDP = 128 * 1024;

export interface DirectRuntimeEvents {
  open(): void;
  message(text: string): void;
  drained(): void;
  closed(): void;
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
  create(id: string, events: DirectRuntimeEvents): DirectRuntimeSession;
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
  opened: boolean;
}
interface Peer {
  attempt?: Attempt;
  retry?: ReturnType<typeof setTimeout>;
  failures: number;
}

/** One bounded negotiation per authorized peer; failures never delay ordinary relay traffic. */
export class DirectLinkNegotiator {
  private readonly peers = new Map<string, Peer>();
  constructor(private readonly deps: {
    runtime: DirectRuntime;
    identity(): string | null;
    /** Physical identity for scoped peer keys; the scoped key itself is never an ordering identity. */
    peerDeviceId?(peer: string): string | null;
    /** Signaling needs the relay even when an established data channel remains usable. */
    canSignal?(peer: string): boolean;
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
      if (this.peers.size >= DIRECT_LINK_MAX_PEERS) return;
      peer = { failures: 0 };
      this.peers.set(peerId, peer);
    }
    if (peer.attempt || peer.retry) return;
    const attempt = this.createAttempt(peerId, peer, this.deps.id());
    if (!attempt) return;
    void attempt.session.offer().then((sdp) => {
      if (this.current(peerId, peer, attempt)) this.send(peerId, attempt, 'offer', sdp);
    }).catch(() => this.fail(peerId, peer!, attempt));
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
        if (this.peers.size >= DIRECT_LINK_MAX_PEERS) return;
        peer = { failures: 0 };
        this.peers.set(peerId, peer);
      }
      if (peer.attempt?.id === signal.id) return;
      // A live session is not displaced by a duplicate/late offer. A retry first closes it.
      if (peer.attempt) return;
      const attempt = this.createAttempt(peerId, peer, signal.id);
      if (!attempt) return;
      void attempt.session.accept(signal.sdp!).then((sdp) => {
        if (this.current(peerId, peer!, attempt)) this.send(peerId, attempt, 'answer', sdp);
      }).catch(() => this.fail(peerId, peer!, attempt));
    } else if (peer?.attempt?.id === signal.id) {
      const attempt = peer.attempt;
      if (signal.action === 'close') this.fail(peerId, peer, attempt, false);
      else if (this.deps.identity()! < (this.deps.peerDeviceId ? this.deps.peerDeviceId(peerId) ?? '' : peerId)) {
        void attempt.session.answer(signal.sdp!).catch(() => this.fail(peerId, peer!, attempt));
      }
    }
  }

  forget(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    clearTimeout(peer.retry);
    const attempt = peer.attempt;
    peer.attempt = undefined;
    if (attempt) {
      clearTimeout(attempt.timer);
      attempt.handle?.closed();
      attempt.session.close();
    }
  }
  clear(): void { for (const id of this.peers.keys()) this.forget(id); }

  private current(peerId: string, peer: Peer, attempt: Attempt): boolean {
    const streams = this.deps.streams(peerId);
    return this.peers.get(peerId) === peer && peer.attempt === attempt
      && streams?.local === attempt.localStream && streams.remote === attempt.remoteStream;
  }
  private createAttempt(peerId: string, peer: Peer, id: string): Attempt | null {
    const streams = this.deps.streams(peerId);
    if (!streams) return null;
    let attempt: Attempt;
    try {
      const session = this.deps.runtime.create(id, {
        open: () => {
          if (!this.current(peerId, peer, attempt) || attempt.opened) return;
          clearTimeout(attempt.timer);
          attempt.opened = true;
          attempt.timer = setTimeout(() => {
            if (this.current(peerId, peer, attempt)) peer.failures = 0;
          }, 60_000);
          const channel: DeviceLinkDirectChannel = {
            send: (text) => session.send(text),
            get bufferedAmount() { return session.bufferedAmount; },
            close: () => this.fail(peerId, peer, attempt),
          };
          attempt.handle = this.deps.attach(peerId, channel);
        },
        message: (text) => { if (this.current(peerId, peer, attempt)) attempt.handle?.receive(text); },
        drained: () => { if (this.current(peerId, peer, attempt)) attempt.handle?.drained(); },
        closed: () => this.fail(peerId, peer, attempt),
      });
      attempt = { id, localStream: streams.local, remoteStream: streams.remote, session, opened: false };
      peer.attempt = attempt;
      attempt.timer = setTimeout(() => this.fail(peerId, peer, attempt), DIRECT_LINK_TIMEOUT_MS);
      return attempt;
    } catch {
      this.retry(peerId, peer);
      return null;
    }
  }
  private send(peerId: string, attempt: Attempt, action: DirectSignal['action'], sdp?: string): void {
    if (sdp && sdp.length > DIRECT_LINK_MAX_SDP) throw new Error('DIRECT_SDP_TOO_LARGE');
    this.deps.signal(peerId, { action, id: attempt.id, stream: attempt.localStream,
      targetStream: attempt.remoteStream, ...(sdp ? { sdp } : {}) });
  }
  private fail(peerId: string, peer: Peer, attempt: Attempt, notify = true): void {
    if (this.peers.get(peerId) !== peer || peer.attempt !== attempt) return;
    peer.attempt = undefined;
    clearTimeout(attempt.timer);
    // Clear the registration first: closing the channel can synchronously call us again.
    attempt.handle?.closed();
    attempt.session.close();
    if (notify) { try { this.send(peerId, attempt, 'close'); } catch { /* Relay may be offline. */ } }
    this.retry(peerId, peer);
  }
  private retry(peerId: string, peer: Peer): void {
    if (this.peers.get(peerId) !== peer || peer.retry || !this.deps.streams(peerId)
      || !this.deps.identity() || this.deps.identity()! >= (this.deps.peerDeviceId ? this.deps.peerDeviceId(peerId) ?? '' : peerId)) return;
    const backoff = Math.min(60_000, 5_000 * 2 ** Math.min(peer.failures++, 4));
    // Spread simultaneous peer failures even at the cap, without exceeding the retry ceiling.
    const delay = Math.floor(backoff * (0.8 + Math.random() * 0.2));
    peer.retry = setTimeout(() => {
      peer.retry = undefined;
      if (this.peers.get(peerId) === peer) this.ready(peerId);
    }, delay);
  }
}
