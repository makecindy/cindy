export interface DbTransport {
  send<R = unknown>(op: string, args?: unknown, transferList?: unknown[]): Promise<R>;

  on(event: 'log', cb: (payload: LogEvent) => void): void;
  on(event: 'vec-status', cb: (payload: VecStatusEvent) => void): void;

  onTerminated(cb: (info: DbTransportTerminationInfo) => void): void;

  close(): Promise<void>;
}

export const DB_TRANSPORT_NOT_SENT = 'DB_TRANSPORT_NOT_SENT' as const;
export const DB_TRANSPORT_OUTCOME_UNKNOWN = 'DB_TRANSPORT_OUTCOME_UNKNOWN' as const;

export type DbTransportErrorCode =
  typeof DB_TRANSPORT_NOT_SENT | typeof DB_TRANSPORT_OUTCOME_UNKNOWN;

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

export interface RpcRequest {
  id: number;
  op: string;
  args?: unknown;
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string; stack?: string } };

export type WorkerEvent =
  { event: 'log'; payload: LogEvent } | { event: 'vec-status'; payload: VecStatusEvent };

export type WorkerMessage = RpcResponse | WorkerEvent;

export type LogEvent = {
  level: 'info' | 'warn' | 'error';
  scope: string;
  payload: unknown;
};

export type VecStatusEvent = {
  loaded: boolean;
  version?: string;
  error?: string;
  expectedPath?: string;
};
