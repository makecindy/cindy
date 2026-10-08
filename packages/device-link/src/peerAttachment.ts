import { isValidAttachmentIntegrity } from "./attachmentOssRef.js";

export interface PeerAttachment {
  ticket: string;
  size: number;
  sha256: string;
  mimeType?: string;
  originalName?: string;
}
/**
 * OSS 中转的单对象上限(与服务端 presign-put 对齐)。直连附件不受此限,只受接收端磁盘空间约束;
 * 超过此值的附件没有 OSS 保底,只能直连发送。
 */
export const OSS_ATTACHMENT_MAX_BYTES = 2 * 1024 ** 3;
/**
 * 对端能否收这份直连附件(依据 file-peer caps):需支持附件 RPC;超过 OSS 上限还要求对端声明
 * largeAttachments(旧端仍按 2GB 拒收)。发送端在读整份文件之前与建链之后都用这一判据。
 */
export function canSendPeerAttachment(
  caps: { attachments?: boolean; largeAttachments?: boolean } | null | undefined,
  size: number,
): boolean {
  return (
    !!caps?.attachments &&
    (size <= OSS_ATTACHMENT_MAX_BYTES || !!caps.largeAttachments)
  );
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

/**
 * 接收端处理 finish 要整读文件重算摘要,耗时随体积增长;按保守的 20 MB/s 放宽这一次请求的等待。
 * 其余请求沿用 RPC 默认超时。
 */
export function peerAttachmentFinishTimeoutMs(size: number): number {
  return 15_000 + Math.ceil(Math.max(0, size) / (20 * 1024 ** 2)) * 1000;
}

/**
 * 对端声明 `caps.streamAttachments` 时,同时在途的写入块数。块按发送顺序在接收端逐个落盘;
 * 文件通道每端最多 4 个在途请求,留 1 个给同一连接上的远程读取。
 */
export const PEER_ATTACHMENT_STREAM_WINDOW = 3;

/**
 * A failed upload is abandoned before sending the message; callers then upload through OSS.
 * `stream` (peer advertised `caps.streamAttachments`) keeps several writes in flight and passes
 * each block as the RPC binary body instead of a base64 field.
 */
export async function uploadPeerAttachment(
  metadata: Omit<PeerAttachment, "ticket">,
  read: (offset: number, length: number) => Promise<string>,
  invoke: (
    request: Record<string, unknown>,
    timeoutMs?: number,
    body?: string,
  ) => Promise<unknown>,
  check: () => void,
  onProgress?: (bytes: number) => void,
  stream = false,
): Promise<string> {
  check();
  const { ticket } = (await invoke({ op: "begin", ...metadata })) as {
    ticket: string;
  };
  if (typeof ticket !== "string" || !/^[a-f0-9-]{36}$/.test(ticket))
    throw new Error("INVALID_PEER_ATTACHMENT");
  const window = stream ? PEER_ATTACHMENT_STREAM_WINDOW : 1;
  // A queued block waits behind the others on the wire, so its deadline covers the whole window.
  // The receiver only drops a body that stalls, so it never cuts a block off before this deadline.
  const writeTimeoutMs = stream ? 15_000 * window : undefined;
  const inFlight: Promise<number>[] = [];
  let failed = false;
  // Not `onProgress?.(await …)`: optional call skips its argument, which would never dequeue.
  const settleOldest = async () => {
    const end = await inFlight.shift()!;
    onProgress?.(end);
  };
  try {
    for (let offset = 0; offset < metadata.size; offset += 1024 * 1024) {
      check();
      const end = Math.min(offset + 1024 * 1024, metadata.size);
      const data = await read(offset, end - offset);
      check();
      // Awaiting in send order reports progress monotonically; once any block failed, stop
      // sending and drain until that failure surfaces.
      while (inFlight.length >= window || (failed && inFlight.length))
        await settleOldest();
      const write = (
        stream
          ? invoke({ op: "write", ticket, offset }, writeTimeoutMs, data)
          : invoke({ op: "write", ticket, offset, data })
      ).then(() => end);
      // A later block may fail before earlier ones settle; record it instead of leaving it unhandled.
      write.catch(() => {
        failed = true;
      });
      inFlight.push(write);
    }
    while (inFlight.length) await settleOldest();
    check();
    await invoke(
      { op: "finish", ticket },
      peerAttachmentFinishTimeoutMs(metadata.size),
    );
    check();
    return buildPeerAttachmentRef({ ...metadata, ticket });
  } catch (error) {
    void invoke({ op: "cancel", ticket }).catch(() => {});
    throw error;
  }
}
