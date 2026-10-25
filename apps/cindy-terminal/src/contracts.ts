/** Local transport exposes the same application channels as device-link. */
export interface TerminalClient {
  invoke<T = unknown>(channel: string, args?: unknown[], deviceId?: string): Promise<T>;
  subscribe(listener: (channel: string, args: unknown[]) => void): () => void;
  close(): void;
}

export interface TerminalSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Shared credential managers require a durable synchronous commit before
 * returning success; these methods are available only after vault unlock. */
export interface TerminalDurableSecrets extends TerminalSecrets {
  getSync(key: string): string | null;
  setSync(key: string, value: string): void;
  deleteSync(key: string): void;
  setManySync(entries:Record<string,string|null>):void;
}

export interface InvocationContext {
  source: 'local' | 'remote';
  /** Authenticated Device Link handshake; never command arguments. */
  controllerCapabilities?: readonly string[];
  /** Original host authority capture; never supplied by a controller payload. */
  sharedTaskCapture?: import('@cindy/app-runtime/sharedTaskInput').SharedTaskPeerCapture;
  /** Verified from the relay's scoped source and an authoritative membership snapshot. */
  sharedTask?: { sharedTaskId: string; sessionId: string; memberId: string; accountId: string; name?: string };
  deviceId?: string;
  /** Host-stamped display metadata from the authenticated device directory. */
  sourceDevice?: import('@cindy/maker-shared/message-source').MessageSourceDevice;
  /** Assigned by the authenticated host, never accepted from command arguments. */
  ownerId?: string;
  signal?: AbortSignal;
  /** Reject stale requests before mutations or publishing asynchronous results. */
  assertCurrent?: () => void;
}

export type ChannelHandler = (args: unknown[], context: InvocationContext) => Promise<unknown>;
