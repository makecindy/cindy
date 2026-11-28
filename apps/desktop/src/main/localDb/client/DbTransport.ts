export interface DbTransport {
  send<R = unknown>(op: string, args?: unknown, transferList?: unknown[]): Promise<R>;

  on(event: 'log', cb: (payload: LogEvent) => void): void;
  on(event: 'vec-status', cb: (payload: VecStatusEvent) => void): void;

  onTerminated(cb: (info: DbTransportTerminationInfo) => void): void;

  close(): Promise<void>;
}

export const DB_TRANSPORT_NOT_SENT = 'DB_TRANSPORT_NOT_SENT' as const;
export const DB_TRANSPORT_OUTCOME_UNKNOWN = 'DB_TRANSPORT_OUTCOME_UNKNOWN' as const;

export const DB_RPC_CANCELLED = 'DB_RPC_CANCELLED' as const;

export type DbTransportErrorCode =
  typeof DB_TRANSPORT_NOT_SENT | typeof DB_TRANSPORT_OUTCOME_UNKNOWN | typeof DB_RPC_CANCELLED;

export function createDbTransportError(
  code: DbTransportErrorCode,
  message: string,
  cause?: unknown,
): Error & { code: DbTransportErrorCode; cause?: unknown } {
  return Object.assign(new Error(message), {
    code,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function isDbTransportOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === DB_TRANSPORT_OUTCOME_UNKNOWN
  );
}

export interface DbTransportTerminationInfo {
  code: number | null;
  signal: string | null;
  error?: Error;
}

// The worker and the caller on timeout both exchange the same shared word.
// Only the side that observes zero may start SQL or confirm its cancellation.
export function startDbRequest(state?: Int32Array): void {
  if (state && Atomics.exchange(state, 0, 1) !== 0) {
    throw new Error('db worker RPC cancelled before execution');
  }
}

export interface RpcRequest {
  startState?: Int32Array;
  id: number;
  op: string;
  args?: unknown;
}

/** Epoch-aligned monotonic timestamps; never includes SQL or parameters. */
export interface RpcTiming { startedAt: number; finishedAt: number }

export type RpcResponse = (
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string; stack?: string } }) & { timing?: RpcTiming };

export type WorkerEvent =
  { event: 'log'; payload: LogEvent } | { event: 'vec-status'; payload: VecStatusEvent };

export type WorkerMessage = RpcResponse | WorkerEvent;

export type LogEvent = {
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  payload: unknown;
};

export type VecStatusEvent = {
  loaded: boolean;
  version?: string;
  error?: string;
  expectedPath?: string;
};
