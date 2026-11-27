import type { Delegation, DelegationRequest, DeviceCertificate, DeviceView } from '@cindy/agent-net-protocol';
import type { Transport, TransportOptions } from './types.js';
export interface SocketUplink {
  readonly kind: 'agent-net';
  readonly devices: DeviceView[];
  readonly notifications?: boolean;
  probeRelay?(): void;
  readonly delegations?: Delegation[];
  readonly delegationRequests?: DelegationRequest[];
  /** This session's UDP relay credentials when the relay offered them (over TLS); null or absent keeps WebSocket. */
  readonly udp?: { session: Uint8Array; key: Uint8Array; probe?: boolean } | null;
  send(deviceId: string, data: Uint8Array): void;
  presence(enabled: boolean, capabilities: readonly string[], metadata?: import('@cindy/agent-net-protocol').DeviceMetadata): void;
  onDatagram(receive: (deviceId: string, data: Uint8Array) => void): void;
  on(event: 'directory', listener: () => void): unknown;
  /** `reason`: this side ended the connection itself, for a frame it refused (an error code); absent when the relay or the network did. */
  once(event: 'close', listener: (code: number, reason?: string) => void): unknown;
  close(): void;
}
export interface SocketClient {
  readonly base: string;
  readonly rootPublicKey: string;
  readonly certificate: DeviceCertificate;
  readonly identity: { deviceId: string; signingKey: string; transportKey: string };
  readonly delegation?: Delegation;
  connect(): Promise<SocketUplink>;
  directory?(): Promise<DeviceView[]>;
}
export interface SocketDiscovery { start(): void; updatePort?(port: number): void; close(): void; }
/**
 * The host's own rule for which members of this account's directory to accept (`AgentNetSocket.restrictPeers`): only
 * `allowed` ones (null: every member), never `refused` ones.
 */
export interface PeerRule {
  allowed: readonly string[] | null;
  refused: readonly string[];
}
export interface DiscoveryOptions {
  networkId: string;
  port: number;
  certificateFor(deviceId: string): DeviceCertificate | undefined;
  onCandidate(deviceId: string, candidate: { address: string; port: number }): void;
}
export interface PortableSocketOptions {
  client: SocketClient;
  assertCurrent?(): void;
  userId: string;
  lanDiscovery?: boolean;
  /** Opt-in until the App's business authority and scoped dispatch are installed. */
  scoped?: boolean;
  cachedDirectory?: DeviceView[];
  directoryExpiresAt?: number;
  /** Verified direct UDP addresses from the previous socket on the same local network, tried first on open. */
  initialCandidates?: ReadonlyMap<string, { address: string; port: number }>;
  /** Saved per-device path preferences (`auto` / `direct` / `relay`) applied as peers connect. */
  initialPeerPathPreferences?: Readonly<Record<string, import('./types.js').PathPreference>>;
  /** Resolve `openWithBindings` as soon as the local transport is ready while the initial relay handshake finishes in the background. */
  deferRelay?: boolean;
  /** Which directory members to accept from the start (see `AgentNetSocket.restrictPeers`). */
  peerRule?: PeerRule;
  onDirectory?(directory: DeviceView[]): void;
  onRelayReplaced?(): void;
  /** The relay connection ended; `reason` as in SocketUplink's 'close'. The socket reconnects it by itself. */
  onRelayClosed?(code: number, reason?: string): void;
  onDelegationRequests?(requests: DelegationRequest[]): void;
  onDelegations?(delegations: Delegation[]): void;
  onPathChanged?(deviceId: string, path: 'direct' | 'relay' | null): void;
  onDirectAddress?(deviceId: string, address: { address: string; port: number }): void;
  /** Fired after the transport rebinds its UDP socket to a fresh port. */
  onUdpRebound?(reason: import('./types.js').UdpRebindReason): void;
  /** Called before closing with 4410 when the Agent-Net relay refuses this identity; true closes with retryable 1006 for Device Link fallback. */
  onIdentityRefused?(reason: string): boolean;
  bindings: {
    notify?(recipient: DeviceView, payload: import('@cindy/device-link-protocol').NotifyPayload, signal: AbortSignal, client: SocketClient): Promise<void>;
    verifyCertificate(rootPublicKey: string, certificate: DeviceCertificate, now?: number): boolean;
    verifyDelegation?(rootPublicKey: string, delegation: unknown, now?: number): delegation is Delegation;
    createTransport(options: TransportOptions): Promise<Transport>;
    createDiscovery?(options: DiscoveryOptions): SocketDiscovery;
  };
}
