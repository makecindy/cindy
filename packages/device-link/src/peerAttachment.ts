import { isValidAttachmentIntegrity } from "./attachmentOssRef.js";

export interface PeerAttachment {
  ticket: string;
  size: number;
  sha256: string;
  mimeType?: string;
  originalName?: string;
}
const prefix = "cindy-peer-attach://";
export const isPeerAttachmentRef = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith(prefix);
export function parsePeerAttachmentRef(value: string): PeerAttachment | null {
  if (!isPeerAttachmentRef(value) || value.length > 16384) return null;
  try {
    const r = JSON.parse(
      decodeURIComponent(value.slice(prefix.length)),
    ) as PeerAttachment;
    if (
      !r ||
      !/^[a-f0-9-]{36}$/.test(r.ticket) ||
      !isValidAttachmentIntegrity(r) ||
      r.size > 2 * 1024 ** 3 ||
      (r.mimeType !== undefined &&
        (typeof r.mimeType !== "string" ||
          !/^[\w.+-]+\/[\w.+-]+$/.test(r.mimeType))) ||
      (r.originalName !== undefined &&
        (typeof r.originalName !== "string" || r.originalName.length > 1024))
    )
      return null;
    return {
      ticket: r.ticket,
      size: r.size,
      sha256: r.sha256,
      mimeType: r.mimeType,
      originalName: r.originalName,
    };
  } catch {
    return null;
  }
}
export function buildPeerAttachmentRef(value: PeerAttachment): string {
  const result = prefix + encodeURIComponent(JSON.stringify(value));
  if (!parsePeerAttachmentRef(result))
    throw new Error("INVALID_PEER_ATTACHMENT");
  return result;
}

/** A failed upload is abandoned before sending the message; callers then upload through OSS. */
export async function uploadPeerAttachment(
  metadata: Omit<PeerAttachment, "ticket">,
  read: (offset: number, length: number) => Promise<string>,
  invoke: (request: Record<string, unknown>) => Promise<unknown>,
  check: () => void,
): Promise<string> {
  check();
  const { ticket } = (await invoke({ op: "begin", ...metadata })) as {
    ticket: string;
  };
  if (typeof ticket !== "string" || !/^[a-f0-9-]{36}$/.test(ticket))
    throw new Error("INVALID_PEER_ATTACHMENT");
  try {
    for (let offset = 0; offset < metadata.size; offset += 1024 * 1024) {
      check();
      const data = await read(
        offset,
        Math.min(1024 * 1024, metadata.size - offset),
      );
      check();
      await invoke({ op: "write", ticket, offset, data });
    }
    check();
    await invoke({ op: "finish", ticket });
    check();
    return buildPeerAttachmentRef({ ...metadata, ticket });
  } catch (error) {
    void invoke({ op: "cancel", ticket }).catch(() => {});
    throw error;
  }
}
