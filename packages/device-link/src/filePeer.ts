/** File bytes travel on WebRTC; this channel carries only authorized signaling. */
export const FILE_PEER_CHANNEL = "device-link:file-peer";
export const FILE_PEER_VERSION = 1;
export const FILE_PEER_CHUNK_BYTES = 16 * 1024;
export const FILE_PEER_MAX_BYTES = 100 * 1024 * 1024;
export const FILE_PEER_MAX_CONNECTIONS = 4;
export const FILE_PEER_IDLE_MS = 30_000;

export type FilePeerRequest =
  | { action: "caps" }
  | { action: "offer"; sdp: string }
  | { action: "open"; connection: string; url: string }
  | { action: "close"; connection: string };

export interface FilePeerFile {
  ticket: string;
  size: number;
  mimeType: string;
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
    return { action: "offer", sdp: v.sdp };
  if (typeof v.connection !== "string" || !/^[a-f0-9-]{36}$/.test(v.connection))
    throw new Error("INVALID_FILE_PEER_REQUEST");
  if (v.action === "close")
    return { action: "close", connection: v.connection };
  if (
    v.action === "open" &&
    typeof v.url === "string" &&
    v.url.length > 0 &&
    v.url.length <= 16 * 1024
  )
    return { action: "open", connection: v.connection, url: v.url };
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
  return { ticket: v.ticket, size: v.size, mimeType: v.mimeType };
}
