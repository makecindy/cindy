import { RPC_BODY_MAX_BYTES } from "./filePeerRuntime.js";

/**
 * File bytes travel on WebRTC; this channel carries only authorized signaling. Between peers that both advertise
 * `streamTransport` and share a newer-transport session, the bytes travel on this channel instead: `stream-open`
 * opens a connection without WebRTC, `stream-rpc` carries what the data channel's RPC carried (same handler, same
 * checks), `stream-read` pulls the next block of a ticket in order. Older peers never receive these actions.
 */
export const FILE_PEER_CHANNEL = "device-link:file-peer";
export const FILE_PEER_VERSION = 1;
/** Negotiated seek reads reuse the existing files-v2 data channel. */
export const FILE_PEER_RANGE_BYTES = 1024 * 1024;
export interface FilePeerRange { start: number; end: number; version: string; }
export function parseFilePeerRange(value: unknown): FilePeerRange {
  const r = value as FilePeerRange | null;
  if (!r || !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 ||
    r.end < r.start || r.end >= FILE_PEER_MAX_BYTES || r.end - r.start >= FILE_PEER_RANGE_BYTES ||
    typeof r.version !== 'string' || !/^[a-f0-9]{64}$/.test(r.version)) throw new Error('FILE_PEER_RANGE');
  return { start: r.start, end: r.end, version: r.version };
}
export const FILE_PEER_CHUNK_BYTES = 16 * 1024;
export const FILE_PEER_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const FILE_PEER_MAX_CONNECTIONS = 4;
export const FILE_PEER_IDLE_MS = 5 * 60_000;
/** Local bridge batch only; wire frames remain 16 KiB for older peers. */
export const FILE_PEER_WRITE_BATCH_BYTES = 256 * 1024;

export type FilePeerRequest =
  | { action: "caps" }
  | { action: "offer"; sdp: string; sessionBound?: boolean }
  | { action: "open"; connection: string; url: string; range?: FilePeerRange }
  | { action: "attachment"; connection: string; request: Record<string, unknown> }
  | { action: "close"; connection: string }
  | { action: "stream-open"; sessionBound?: boolean }
  /** `payload`/`body` exactly as the data channel RPC: JSON `{channel, args}` and an optional base64 binary body. */
  | { action: "stream-rpc"; connection: string; payload: string; body?: string; timeoutMs?: number }
  | { action: "stream-read"; connection: string; ticket: string; offset: number; maxBytes: number };

/**
 * A `stream-read` result is one block of file bytes (base64): never kept in the result cache or delta-encoded, which would
 * hash every block and push the cached lists out.
 */
export function isFilePeerStreamRead(payload: { channel?: unknown; args?: unknown }): boolean {
  const request = Array.isArray(payload.args) ? payload.args[0] as { action?: unknown } | undefined : undefined;
  return payload.channel === FILE_PEER_CHANNEL && request?.action === "stream-read";
}

/**
 * A file block on the Agent-Net session (`stream-read` or `stream-rpc`): bytes, not a business call. They only travel on the
 * session, which does not retransmit, so the host keeps them out of its duplicate-request memory (each would evict other
 * controllers' records of non-idempotent calls).
 */
export function isFilePeerStreamTransfer(payload: { channel?: unknown; args?: unknown }): boolean {
  const request = Array.isArray(payload.args) ? payload.args[0] as { action?: unknown } | undefined : undefined;
  return payload.channel === FILE_PEER_CHANNEL && (request?.action === "stream-read" || request?.action === "stream-rpc");
}

/** Upper bound a `stream-rpc` may ask its caller to wait (a large attachment's finish re-reads it to verify the digest). */
export const FILE_PEER_STREAM_RPC_MAX_TIMEOUT_MS = 60 * 60_000;
const STREAM_RPC_MAX_PAYLOAD = 4 * 1024 * 1024;
const STREAM_RPC_MAX_BODY_BASE64 = Math.ceil(RPC_BODY_MAX_BYTES / 3) * 4;

export interface FilePeerFile {
  ticket: string;
  size: number;
  mimeType: string;
  version?: string;
}

export function parseFilePeerRequest(value: unknown): FilePeerRequest {
  if (!value || typeof value !== "object")
    throw new Error("INVALID_FILE_PEER_REQUEST");
  const v = value as Record<string, unknown>;
  if (v.action === "caps") return { action: "caps" };
  if (
    v.action === "offer" &&
    typeof v.sdp === "string" &&
    v.sdp.length > 0 &&
    v.sdp.length <= 128 * 1024
  )
    return { action: "offer", sdp: v.sdp, ...(v.sessionBound === true ? { sessionBound: true } : {}) };
  if (v.action === "stream-open") return { action: "stream-open", ...(v.sessionBound === true ? { sessionBound: true } : {}) };
  if (typeof v.connection !== "string" || !/^[a-f0-9-]{36}$/.test(v.connection))
    throw new Error("INVALID_FILE_PEER_REQUEST");
  if (v.action === "stream-rpc" && typeof v.payload === "string" && v.payload.length > 0 && v.payload.length <= STREAM_RPC_MAX_PAYLOAD
    && (v.body === undefined || (typeof v.body === "string" && v.body.length > 0 && v.body.length <= STREAM_RPC_MAX_BODY_BASE64))
    && (v.timeoutMs === undefined || (Number.isSafeInteger(v.timeoutMs) && (v.timeoutMs as number) > 0)))
    return { action: "stream-rpc", connection: v.connection, payload: v.payload,
      ...(v.body !== undefined ? { body: v.body as string } : {}),
      ...(v.timeoutMs !== undefined ? { timeoutMs: Math.min(v.timeoutMs as number, FILE_PEER_STREAM_RPC_MAX_TIMEOUT_MS) } : {}) };
  if (v.action === "stream-read" && typeof v.ticket === "string" && /^[a-f0-9-]{36}$/.test(v.ticket)
    && Number.isSafeInteger(v.offset) && (v.offset as number) >= 0 && (v.offset as number) <= FILE_PEER_MAX_BYTES
    && Number.isSafeInteger(v.maxBytes) && (v.maxBytes as number) >= 1 && (v.maxBytes as number) <= FILE_PEER_WRITE_BATCH_BYTES)
    return { action: "stream-read", connection: v.connection, ticket: v.ticket, offset: v.offset as number, maxBytes: v.maxBytes as number };
  if (v.action === "close")
    return { action: "close", connection: v.connection };
  if (v.action === "attachment" && v.request && typeof v.request === "object" && !Array.isArray(v.request))
    return { action: "attachment", connection: v.connection, request: v.request as Record<string, unknown> };
  if (
    v.action === "open" &&
    typeof v.url === "string" &&
    v.url.length > 0 &&
    v.url.length <= 16 * 1024
  )
    return { action: "open", connection: v.connection, url: v.url,
      ...(v.range !== undefined ? { range: parseFilePeerRange(v.range) } : {}) };
  throw new Error("INVALID_FILE_PEER_REQUEST");
}

export function parseFilePeerFile(value: unknown): FilePeerFile {
  if (!value || typeof value !== "object")
    throw new Error("INVALID_FILE_PEER_FILE");
  const v = value as FilePeerFile;
  if (
    typeof v.ticket !== "string" ||
    !/^[a-f0-9-]{36}$/.test(v.ticket) ||
    !Number.isSafeInteger(v.size) ||
    v.size < 0 ||
    v.size > FILE_PEER_MAX_BYTES ||
    typeof v.mimeType !== "string" ||
    !/^[\w.+-]+\/[\w.+-]+$/.test(v.mimeType)
  )
    throw new Error("INVALID_FILE_PEER_FILE");
  return { ticket: v.ticket, size: v.size, mimeType: v.mimeType,
    ...(typeof v.version === 'string' && /^[a-f0-9]{64}$/.test(v.version) ? { version: v.version } : {}) };
}
