import AsyncStorage from "@react-native-async-storage/async-storage";
import { createDurableOutbox, type DurableOutboxRecord } from "./durableOutbox";
import { durableOutboxUploadUri } from "./durableOutboxFiles";
import type { MobileOutboxItem } from "./sessionOutbox";

export const mobileDurableOutbox = createDurableOutbox(AsyncStorage);
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
