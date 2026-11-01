/**
 * Client-side mirror of the `hermes-mgr` NDJSON RPC protocol
 * (`packages/maker-hermes-manager/src/protocol.ts` and `codec.ts`, the daemon
 * source of truth). maker-core deliberately keeps its own copy instead of
 * importing the manager package: the daemon is an out-of-process sidecar and
 * maker-core must stay free of that build dependency (same precedent as Pi's
 * local protocol shapes in `agents/pi/rpc-client.ts`).
 *
 * Wire: one UTF-8 JSON object per line, '\n'-terminated. Requests carry a
 * numeric id and expect a matching response; notifications have no id.
 *
 * Keep this file in sync with the daemon's protocol. `HERMES_MGR_PROTOCOL_VERSION`
 * is the handshake gate: a mismatch is an upgrade error, never guessed around.
 */

import { StringDecoder } from 'node:string_decoder';

/** Mirrors the daemon's `PROTOCOL_VERSION`. Bump together on a breaking change. */
export const HERMES_MGR_PROTOCOL_VERSION = 1 as const;

export type HermesRpcId = number;

export type HermesRpcErrorCode =
  | 'INVALID_PROTOCOL_VERSION'
  | 'UNKNOWN_METHOD'
  | 'INVALID_PARAMS'
  | 'NOT_INITIALIZED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_EXISTS'
  | 'TURN_ALREADY_RUNNING'
  | 'SESSION_KILL_PENDING'
  | 'SESSION_KILL_TIMEOUT'
  | 'HERMES_ERROR'
  | 'INTERNAL';

export interface HermesRpcError {
  code: HermesRpcErrorCode;
  message: string;
  data?: unknown;
}

export interface HermesRpcRequest<P = unknown> {
  type: 'request';
  id: HermesRpcId;
  method: string;
  params: P;
}

export interface HermesRpcResponse<R = unknown> {
  type: 'response';
  id: HermesRpcId;
  result?: R;
  error?: HermesRpcError;
}

export interface HermesRpcNotification<P = unknown> {
  type: 'notification';
  method: string;
  params: P;
}

export type HermesRpcMessage = HermesRpcRequest | HermesRpcResponse | HermesRpcNotification;

/** client → daemon methods used by this agent. */
export const HERMES_METHODS = {
  PROTOCOL_HELLO: 'protocol/hello',
  QUERY_START: 'query/start',
  QUERY_SEND: 'query/send',
  QUERY_SET_MODEL: 'query/setModel',
  QUERY_SET_PERMISSION_MODE: 'query/setPermissionMode',
  QUERY_INTERRUPT: 'query/interrupt',
  QUERY_CLOSE: 'query/close',
} as const;

export type HermesMethodName = (typeof HERMES_METHODS)[keyof typeof HERMES_METHODS];

/** daemon → client notification names. */
export const HERMES_NOTIFICATIONS = {
  QUERY_EVENT: 'query/event',
  SESSION_CLOSED: 'session/closed',
  CLIENT_REPLACED: 'client/replaced',
} as const;

export type HermesNotificationName =
  (typeof HERMES_NOTIFICATIONS)[keyof typeof HERMES_NOTIFICATIONS];

/** Authorization modes the daemon accepts; mirrors `HermesPermissionMode`. */
export type HermesPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'bypassPermissions';

export interface HermesHelloParams {
  protocolVersion: number;
  clientId?: string;
}

export interface HermesHelloResult {
  protocolVersion: number;
  managerVersion?: string;
  hermesHome?: string;
}

export interface HermesQueryStartParams {
  sessionId: string;
  resumeHermesSessionId?: string;
  cwd: string;
  env?: Record<string, string>;
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  permissionMode?: HermesPermissionMode;
  systemPromptPreamble?: string;
  maxTurns?: number;
  runBudgetSeconds?: number;
}

export interface HermesQueryStartResult {
  sessionId: string;
  hermesSessionId?: string;
}

export interface HermesQuerySendParams {
  sessionId: string;
  text: string;
  images?: string[];
}

export interface HermesQuerySetPermissionModeParams {
  sessionId: string;
  mode: HermesPermissionMode;
}

export interface HermesQuerySetModelParams {
  sessionId: string;
  model: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface HermesSessionParams {
  sessionId: string;
}

export interface HermesQueryEventNotification {
  sessionId: string;
  seq: number;
  ts: string;
  /** Verbatim Hermes stream-json event or a daemon-synthesized lifecycle event. */
  event: unknown;
}

export type HermesSessionClosedReason = 'completed' | 'closed' | 'killed' | 'error';

export interface HermesSessionClosedNotification {
  sessionId: string;
  reason: HermesSessionClosedReason;
  detail?: string;
}

export interface HermesClientReplacedNotification {
  sessionId: string;
  reason: 'another-client-attached';
}

/** A daemon response carried an error (typed by protocol code, not by message text). */
export class HermesRpcRequestError extends Error {
  constructor(
    public readonly code: HermesRpcErrorCode,
    message: string,
    public readonly data?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'HermesRpcRequestError';
  }
}

/** The bundled daemon speaks a newer/older protocol than this client. */
export class HermesProtocolMismatchError extends Error {
  constructor(public readonly daemonVersion: number | undefined) {
    super(
      `Hermes manager protocol mismatch: expected v${HERMES_MGR_PROTOCOL_VERSION}, `
      + `got v${daemonVersion ?? 'unknown'}. Upgrade the bundled hermes-mgr and Cindy together.`,
    );
    this.name = 'HermesProtocolMismatchError';
  }
}

export class HermesRpcTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`hermes-mgr ${method} timed out after ${timeoutMs}ms`);
    this.name = 'HermesRpcTimeoutError';
  }
}

export function isHermesRpcMessage(value: unknown): value is HermesRpcMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'request') {
    return typeof v.id === 'number' && typeof v.method === 'string';
  }
  if (v.type === 'response') {
    return typeof v.id === 'number';
  }
  if (v.type === 'notification') {
    return typeof v.method === 'string';
  }
  return false;
}

export function isHermesRpcResponse(value: HermesRpcMessage): value is HermesRpcResponse {
  return value.type === 'response';
}

export function isHermesRpcNotification(
  value: HermesRpcMessage,
): value is HermesRpcNotification {
  return value.type === 'notification';
}

export function isHermesRpcRequest(value: HermesRpcMessage): value is HermesRpcRequest {
  return value.type === 'request';
}

/**
 * Mirror of the daemon's `NDJSONDecoder` (`packages/maker-hermes-manager/src/codec.ts`).
 *
 * Chunk boundaries do not align with line boundaries; the partial tail is
 * buffered across pushes. Corrupt/non-RPC lines are reported through
 * `onCorruptLine` and skipped, never thrown. Buffers stay UTF-8 safe by using
 * StringDecoder, so multi-byte characters split across chunks survive.
 */
export class HermesNdjsonDecoder {
  /** Same bound as the daemon; an endless line means the peer is junk. */
  private static readonly MAX_BUFFER_CHARS = 64 * 1024 * 1024;

  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly onCorruptLine?: (line: string, error: Error) => void;

  constructor(opts: { onCorruptLine?: (line: string, error: Error) => void } = {}) {
    this.onCorruptLine = opts.onCorruptLine;
  }

  push(chunk: string | Buffer): HermesRpcMessage[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.buffer += text;
    if (this.buffer.length > HermesNdjsonDecoder.MAX_BUFFER_CHARS) {
      const sample = this.buffer.slice(0, 256);
      this.buffer = '';
      this.onCorruptLine?.(
        sample,
        new Error(
          `NDJSON buffer exceeded ${HermesNdjsonDecoder.MAX_BUFFER_CHARS} chars `
          + 'without a complete line; discarded to prevent OOM',
        ),
      );
      return [];
    }
    if (!this.buffer.includes('\n')) return [];
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const messages: HermesRpcMessage[] = [];
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        this.onCorruptLine?.(line, error as Error);
        continue;
      }
      if (!isHermesRpcMessage(parsed)) {
        this.onCorruptLine?.(line, new Error('not a valid HermesRpcMessage shape'));
        continue;
      }
      messages.push(parsed);
    }
    return messages;
  }

  reset(): void {
    this.buffer = '';
    this.decoder.end();
  }
}

/** Mirror of the daemon's `encodeMessage`: one NDJSON line, '\n'-terminated. */
export function encodeHermesMessage(message: HermesRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}
