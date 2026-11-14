import type { KeyObject } from 'node:crypto';
import type { AgentNetUplink } from '@cindy/agent-net-relay/client';
export interface RosterEntry { id: string; dial: unknown; }
export interface PeerChannel {
  readonly remoteId: string;
  /** Bytes waiting for admission to the bounded core send buffer. */
  readonly bufferedAmount?: number;
  send(bytes: Uint8Array): void;
  onData(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  close(options?: { drain?: boolean }): void;
  path?(): 'direct' | 'relay' | null;
  stats?(): Record<string, number> | null;
  addressKind?(): 'relay' | 'loopback' | 'private' | 'public' | null;
}
export const MAX_CHANNEL_PENDING_BYTES = 8 * 1024 * 1024;
export interface Transport {
  readonly id: string;
  readonly dial: unknown;
  connect(entry: RosterEntry): Promise<PeerChannel>;
  close(): Promise<void>;
}
export interface TransportOptions {
  admit(remoteId: string): boolean;
  onIncoming(channel: PeerChannel): void;
  relay?: { uplink: Pick<AgentNetUplink, 'kind' | 'send' | 'onDatagram' | 'close'>; deviceId: string };
  relayIdOf?(remoteId: string): string | undefined;
  /** Root-verified, currently authorized keys; native hosts mirror these before polling IO. */
  admittedPeers?(): { id: string; relayId: string }[];
  /** Invalidates remembered handshake refusals when a verified roster/grant changes. */
  admissionVersion?(): number;
  udp?: boolean;
  reprobeMs?: number;
  bindAddress?: string;
  stunServers?: string[];
  publicCandidatesOnly?: boolean;
  identity?: KeyObject;
  module?: WebAssembly.Module;
  tap?(datagram: Uint8Array, via: 'udp' | 'relay'): void;
}
/** Early stream events are bounded by the core's receive credit; do not lose them during admission. */
export class ChannelEvents {
  private dataHandler: ((bytes: Uint8Array) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private readonly early: Uint8Array[] = [];
  private closedEarly = false;
  closed = false;
  onData(handler: (bytes: Uint8Array) => void): void {
    this.dataHandler = handler;
    for (const bytes of this.early.splice(0)) handler(bytes);
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.closedEarly) handler();
  }
  data(bytes: Uint8Array): void {
    if (this.dataHandler) this.dataHandler(bytes);
    else this.early.push(bytes);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeHandler) this.closeHandler();
    else this.closedEarly = true;
  }
}
