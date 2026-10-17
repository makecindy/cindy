import type { RemoteSerializedAttachment } from '@/session/types';
import { outboxItemAttachments, type MobileOutboxItem } from '@/session/sessionOutbox';

export interface SentMessageImagePreview {
  attachmentId: string;
  name: string;
  /** Reference used to find the retained local thumbnail. */
  sourceRef: string;
  /** Latest reference observed under this attachment ID, including host materialization. */
  currentSourceRef?: string;
  sha256?: string;
  uri: string | null;
  galleryImageKey?: string;
}

export type SentMessageImagePreviews = Map<string, readonly (SentMessageImagePreview | null)[]>;
export type GetSentMessageImagePreview = (
  clientId: string, imageIndex: number, name: string, attachmentId?: string, sha256?: string, sourceRef?: string,
) => SentMessageImagePreview | undefined;

const messageKey = (sessionId: string, clientId: string) => JSON.stringify([sessionId, clientId]);

/** Known attachments keep their identity when a queue edit changes their position. */
export const sentImageGalleryKey = (clientId: string, attachmentId: string): string => `${clientId}-attachment:${attachmentId}`;

/** Live sends retain their identity; only departed messages count toward the history budget. */
export function pruneSentMessageImagePreviews(
  previews: SentMessageImagePreviews,
  sessionId: string,
  liveClientIds: ReadonlySet<string> = new Set(),
  previousLiveClientIds: ReadonlySet<string> = liveClientIds,
): void {
  // A freshly handed-off message is recent history, even if it waited in the queue
  // longer than 64 completed sends. Preserve its bridge while formal history mounts.
  for (const clientId of previousLiveClientIds) {
    if (liveClientIds.has(clientId)) continue;
    const key = messageKey(sessionId, clientId);
    const images = previews.get(key);
    if (!images) continue;
    previews.delete(key);
    previews.set(key, images);
  }
  const liveKeys = new Set([...liveClientIds].map((clientId) => messageKey(sessionId, clientId)));
  let historicalCount = 0;
  for (const key of previews.keys()) if (!liveKeys.has(key)) historicalCount += 1;
  for (const key of previews.keys()) {
    if (historicalCount <= 64) break;
    if (liveKeys.has(key)) continue;
    previews.delete(key);
    historicalCount -= 1;
  }
}

/** Presentation-only attachment identities, with optional local pixels for immediate previews. */
export function rememberSentMessageImagePreviews(
  previews: SentMessageImagePreviews,
  sessionId: string,
  clientId: string,
  attachments: readonly RemoteSerializedAttachment[],
  previewOf: (attachment: RemoteSerializedAttachment) => string | null | undefined,
  galleryKeyOf?: (attachment: RemoteSerializedAttachment) => string | undefined,
  liveClientIds?: ReadonlySet<string>,
): void {
  const key = messageKey(sessionId, clientId);
  const previous = previews.get(key);
  const images = attachments.filter((attachment) => attachment.category === 'image').map((attachment) => {
    const uri = previewOf(attachment);
    const prior = previous?.find((entry) => entry?.attachmentId === attachment.id);
    // Preserve the outbox identity through URL materialization; a replaced file ID cannot inherit it.
    const galleryImageKey = galleryKeyOf?.(attachment) ?? prior?.galleryImageKey;
    const currentSourceRef = attachment.url ?? attachment.path;
    return { attachmentId: attachment.id, name: attachment.originalName ?? attachment.name,
      sourceRef: uri || !prior?.uri ? currentSourceRef : prior.sourceRef,
      currentSourceRef,
      sha256: attachment.sha256, uri: uri || prior?.uri || null,
      ...(galleryImageKey ? { galleryImageKey } : {}) };
  });
  // Replace the complete snapshot on edit, including removed images and missing previews.
  previews.delete(key);
  if (images.length === 0) return;
  previews.set(key, images);
  pruneSentMessageImagePreviews(previews, sessionId, liveClientIds);
}

/** Restored rows need the same slot-to-attachment bridge as newly dispatched sends. */
export function rememberOutboxImagePreviews(
  previews: SentMessageImagePreviews,
  sessionId: string,
  item: MobileOutboxItem,
  liveClientIds?: ReadonlySet<string>,
): void {
  const slotOf = (attachment: RemoteSerializedAttachment) => (
    item.attachmentSlots.findIndex((entry) => entry?.id === attachment.id)
  );
  rememberSentMessageImagePreviews(previews, sessionId, item.clientId, outboxItemAttachments(item),
    (attachment) => item.slotMeta[slotOf(attachment)]?.previewUri,
    (attachment) => `${item.clientId}-slot-${slotOf(attachment)}`, liveClientIds);
}

export function getSentMessageImagePreview(
  previews: SentMessageImagePreviews,
  sessionId: string,
  clientId: string,
  imageIndex: number,
  name: string,
  attachmentId?: string,
  sha256?: string,
  sourceRef?: string,
): SentMessageImagePreview | undefined {
  const entries = previews.get(messageKey(sessionId, clientId));
  if (attachmentId) return entries?.find((entry) => entry?.attachmentId === attachmentId) ?? undefined;
  // Formal content omits file IDs. Prove the pixels still match before reusing a local image;
  // a same-name queue edit on another device must never resurrect the old preview.
  const matches = (entry: SentMessageImagePreview | null | undefined): entry is SentMessageImagePreview => (
    !!entry && entry.name === name && (
      !!sha256 && entry.sha256 === sha256 || (entry.currentSourceRef ?? entry.sourceRef) === sourceRef
    )
  );
  const indexed = entries?.[imageIndex];
  if (matches(indexed)) return indexed;
  // Remote queue edits can move an image without updating this local snapshot. Only a unique,
  // proven content match may reconnect it; ambiguous same-name images cannot share identity.
  const candidates = entries?.filter(matches);
  return candidates?.length === 1 ? candidates[0] : undefined;
}
