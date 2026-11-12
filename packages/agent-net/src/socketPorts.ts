import type { Delegation, DelegationRequest, DeviceCertificate, DeviceView } from '@cindy/agent-net-protocol';
import type { Transport, TransportOptions } from './types.js';
export interface SocketUplink {
  readonly kind: 'agent-net';
  readonly devices: DeviceView[];
  readonly notifications?: boolean;
  readonly delegations?: Delegation[];
  readonly delegationRequests?: DelegationRequest[];
  send(deviceId: string, data: Uint8Array): void;
  presence(enabled: boolean, capabilities: readonly string[], metadata?: import('@cindy/agent-net-protocol').DeviceMetadata): void;
  onDatagram(receive: (deviceId: string, data: Uint8Array) => void): void;
  on(event: 'directory', listener: () => void): unknown;
  once(event: 'close', listener: (code: number) => void): unknown;
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
export interface SocketDiscovery { start(): void; close(): void; }
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
  onDirectory?(directory: DeviceView[]): void;
  onDelegationRequests?(requests: DelegationRequest[]): void;
  onDelegations?(delegations: Delegation[]): void;
  onPathChanged?(deviceId: string, path: 'direct' | 'relay' | null): void;
  bindings: {
    notify?(recipient: DeviceView, payload: import('@cindy/device-link-protocol').NotifyPayload, signal: AbortSignal, client: SocketClient): Promise<void>;
    verifyCertificate(rootPublicKey: string, certificate: DeviceCertificate, now?: number): boolean;
    verifyDelegation?(rootPublicKey: string, delegation: unknown, now?: number): delegation is Delegation;
    createTransport(options: TransportOptions): Promise<Transport>;
    createDiscovery?(options: DiscoveryOptions): SocketDiscovery;
  };
}
