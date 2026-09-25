import { REMOTE_DESKTOP_CHANNEL } from "./remoteDesktop.js";
import { FILE_PEER_CHANNEL } from "./filePeer.js";

/** Only replayable reads and idempotent staging writes may fall back after transport loss. */
export function canUsePeerInvoke(channel: string, args: unknown[]): boolean {
  if (args.length !== 1 || !args[0] || typeof args[0] !== "object")
    return false;
  const r = args[0] as Record<string, unknown>;
  if (channel === "file-browser:remote-op")
    return r.op === "listDir" || r.op === "readFile";
  return (
    channel === REMOTE_DESKTOP_CHANNEL &&
    r.op === "clipboardContent" &&
    (r.action === "read" || r.action === "write")
  );
}

/** Attachment failures restart through OSS, never replay uncertain staging operations over WSS. */
export function canServePeerInvoke(channel: string, args: unknown[]): boolean {
  return canUsePeerInvoke(channel, args) || (channel === FILE_PEER_CHANNEL && args.length === 1 &&
    !!args[0] && typeof args[0] === 'object' && (args[0] as { action?: unknown }).action === 'attachment');
}
