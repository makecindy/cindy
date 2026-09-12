import AsyncStorage from "@react-native-async-storage/async-storage";
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import { createDurableOutbox, type DurableOutboxRecord } from "./durableOutbox";
import { durableOutboxUploadUri, removeOutboxFiles } from "./durableOutboxFiles";
import { outboxItemAttachments, type MobileOutboxItem } from "./sessionOutbox";
import { discardMobileUploadedAttachment } from "./mobileAttachmentUpload";
import type { RemoteSerializedAttachment } from "./types";

export const mobileDurableOutbox = createDurableOutbox(AsyncStorage);
/** Local filesystem failures must not suppress disposal of confirmed-cancelled uploads. */
export async function cleanupOutboxResources(
  record: DurableOutboxRecord,
  owner: MobileAuthOwnerGeneration,
  getToken: () => Promise<string | null>,
  cancelled: boolean,
): Promise<void> {
  try {
    await removeOutboxFiles(record);
  } finally {
    if (cancelled) discardOutboxUploads(record, owner, getToken);
  }
}
/** Hide old-owner rows even before the bridge's React effect activates the next ledger. */
export function getCurrentMobileOutboxRecords(): readonly DurableOutboxRecord[] {
  const key = getMobileAuthOwner().accountKey;
  return mobileDurableOutbox.getSnapshot().filter((record) => record.accountId === key);
}
/** Call only for confirmed cancellation, superseded references, or an upload never handed to the ledger. */
export function discardOutboxUploads(
  record: DurableOutboxRecord,
  owner: MobileAuthOwnerGeneration,
  getToken: () => Promise<string | null>,
  attachments: readonly RemoteSerializedAttachment[] = outboxItemAttachments(record.item),
): void {
  if (record.accountId !== owner.accountKey) return;
  for (const attachment of attachments) {
    discardMobileUploadedAttachment(attachment, { getToken: async () => {
      if (!isMobileAuthOwnerCurrent(owner)) return null;
      const token = await getToken();
      return isMobileAuthOwnerCurrent(owner) ? token : null;
    } });
  }
}
export function durableOutboxDisplayItem(
  record: DurableOutboxRecord,
): MobileOutboxItem {
  return {
    ...record.item,
    phase:
      record.state === "failed"
        ? "failed"
        : record.state === "sending" ||
            record.state === "confirming" ||
            record.state === "host-owned"
          ? "dispatching"
          : "uploading",
    enqueueError: record.error ?? null,
    slotMeta: record.item.slotMeta.map((meta, slot) => {
      const upload = record.uploads.find((u) => u.slot === slot);
      return upload
        ? { ...meta, previewUri: durableOutboxUploadUri(record, upload) }
        : meta;
    }),
  };
}

// Synchronous reservation covers the disk-write -> live creation task registration window.
const creationHolds = new Map<string, number>();
export function holdDurableOutboxCreation(sessionId: string): () => void {
  creationHolds.set(sessionId, (creationHolds.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (creationHolds.get(sessionId) ?? 1) - 1;
    if (count) creationHolds.set(sessionId, count);
    else creationHolds.delete(sessionId);
  };
}
export function isDurableOutboxCreationHeld(sessionId: string): boolean {
  return creationHolds.has(sessionId);
}
