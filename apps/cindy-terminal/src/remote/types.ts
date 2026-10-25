import type {
  DeviceLinkClientOptions, DeviceLinkLogger, DirectRuntime, Envelope,
  HelloPayload, PushOwnerStamp, Topic,
} from '@cindy/device-link';

/** Identity is taken from the authenticated relay envelope, never invoke args. */
export type TerminalPeerIdentity =
  | { kind: 'owner'; deviceId: string; peerId: string }
  | { kind: 'shared-task'; deviceId: string; peerId: string; sharedTaskId: string; role: 'host' | 'guest'; memberId?: string }
  | { kind: 'provider-share'; deviceId: string; peerId: string; shareId: string; role: 'host' | 'guest'; memberId?: string };

export interface TerminalRemoteContext {
  readonly source: TerminalPeerIdentity;
  readonly controllerDeviceId: string;
  readonly controllerCapabilities?: readonly string[];
  readonly sourceDeviceId: string;
  readonly requestId: string;
  readonly ownerScope: string;
  readonly signal: AbortSignal;
  /** Call immediately before writes and after asynchronous reads. */
  assertCurrent(): void;
}

/** Supplied by the actual shared-task/provider-share service, not by a caller.
 * No resolver means no cross-account access. These bounds narrow the global
 * allowlist; invokeLocal still owns resource, member and business validation. */
export interface TerminalScopedAuthority {
  allowedChannels: ReadonlySet<string>;
  allowedTopics: ReadonlySet<Topic>;
  allowedPushChannels?: ReadonlySet<string>;
  /** Last-mile data scope check, including batch contents and private interactions. */
  acceptsPush?(channel: string, payload: unknown): boolean;
  assertCurrent(): void;
}

export interface TerminalRemotePush {
  deviceId: string;
  source: TerminalPeerIdentity;
  channel: string;
  payload: unknown;
  ownerStamp?: PushOwnerStamp;
}

export interface TerminalDeviceServiceOptions {
  getToken: DeviceLinkClientOptions['getToken'];
  getHello(): HelloPayload;
  getWsUrl(): string;
  /** Stable account + realm + data-owner generation. Null while signed out.
   * Change this before changing data stores, then call stop/start for new auth. */
  getOwnerScope(): string | null;
  createWebSocket: DeviceLinkClientOptions['createWebSocket'];
  /** Cross-region shared-provider transports use a dedicated, restricted token. */
  authorizationScheme?: DeviceLinkClientOptions['authorizationScheme'];
  invokeLocal(channel: string, args: unknown[], context: TerminalRemoteContext): unknown | Promise<unknown>;
  onPush?(push: TerminalRemotePush): void;
  onLocalPush?(channel: string, payload: unknown): void;
  readSharedTaskForProbe?(id: string): Promise<{ sharedTaskId: string; sessionId: string; status: string }>;
  notificationBody?(kind: 'done' | 'error' | 'needs-reply'): string;
  logger?: DeviceLinkLogger;
  directRuntime?: DirectRuntime;
  transferCodec?: DeviceLinkClientOptions['transferCodec'];
  timing?: DeviceLinkClientOptions['timing'];
  /** Must reflect persisted owner opt-outs immediately. */
  isPeerRevoked?(deviceId: string): boolean;
  /** Controller preference only; it never revokes the target's inbound access. */
  isControlTargetDisabled?(peerId: string): boolean;
  resolveScopedAuthority?(source: Exclude<TerminalPeerIdentity, { kind: 'owner' }>): TerminalScopedAuthority | null | Promise<TerminalScopedAuthority | null>;
  replaySessionActivity?(emit: (payload: import('@cindy/device-link').SessionActivityPayload) => void): void;
  onSubscriptionsChanged?(source: TerminalPeerIdentity, topics: readonly Topic[], context: TerminalRemoteContext): void | Promise<void>;
  /** Release watches/listeners only. No user-data mutation or account reads. */
  onSubscriptionsClosed?(source: TerminalPeerIdentity): void;
  onPeerClosed?(peer: string, transient: boolean): void;
  /** Extra channels are only for a Host-owned protocol (e.g. encrypted OAuth).
   * Business code must validate that protocol before consuming its payload. */
  extraPushChannels?: ReadonlySet<string>;
  hostCapabilities?: readonly string[];
  controllerCapabilities?: readonly string[];
  getDevicesUrl?(): string;
  fetch?: typeof fetch;
  /** Tests/diagnostics may observe accepted envelopes without replacing routing. */
  onEnvelope?(envelope: Readonly<Envelope>): void;
}

/** Safe public failure. Ordinary exceptions are redacted at the wire boundary. */
export class TerminalRemoteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TerminalRemoteError';
  }
}
