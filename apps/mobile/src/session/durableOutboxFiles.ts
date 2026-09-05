import * as FileSystem from "expo-file-system/legacy";
import type { DurableOutboxRecord, DurableUpload } from "./durableOutbox";
import type { MobileLocalAttachmentUploadCandidate } from "./mobileLocalAttachmentUpload";

function segment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}
export function durableOutboxDirectory(
  record: Pick<DurableOutboxRecord, "accountId" | "deviceId" | "item">,
): string {
  if (!FileSystem.documentDirectory)
    throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
  return `${FileSystem.documentDirectory}message-outbox/${[record.accountId, record.deviceId, record.item.sessionId, record.item.clientId].map(segment).join("/")}/`;
}
export function durableOutboxUploadUri(
  record: DurableOutboxRecord,
  upload: DurableUpload,
): string {
  if (!/^slot-\d+(?:-[a-z0-9]+)?\.[a-z0-9]{1,12}$/.test(upload.fileName))
    throw new Error("OUTBOX_FILE_INVALID");
  return durableOutboxDirectory(record) + upload.fileName;
}
export async function retainOutboxFile(
  record: DurableOutboxRecord,
  slot: number,
  source: MobileLocalAttachmentUploadCandidate,
): Promise<DurableUpload> {
  const extension =
    source.name.match(/\.([a-z0-9]{1,12})$/i)?.[1]?.toLowerCase() ?? "bin";
  const upload: DurableUpload = {
    slot,
    fileName: `slot-${slot}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${extension}`,
    name: source.name,
    mimeType: source.mimeType,
    kind: source.kind,
    size: source.size,
    ...(source.annotation ? { annotated: true } : {}),
  };
  await FileSystem.makeDirectoryAsync(durableOutboxDirectory(record), {
    intermediates: true,
  });
  const target = durableOutboxUploadUri(record, upload);
  await FileSystem.copyAsync({ from: source.uri, to: target });
  const stat = await FileSystem.getInfoAsync(target);
  if (
    !stat.exists ||
    stat.isDirectory ||
    stat.size <= 0 ||
    (source.size > 0 && stat.size !== source.size)
  ) {
    throw new Error("OUTBOX_FILE_COPY_FAILED");
  }
  return { ...upload, size: stat.size };
}
export async function removeOutboxFiles(
  record: DurableOutboxRecord,
): Promise<void> {
  await FileSystem.deleteAsync(durableOutboxDirectory(record), {
    idempotent: true,
  });
}
