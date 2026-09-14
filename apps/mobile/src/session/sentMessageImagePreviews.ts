import type { RemoteSerializedAttachment } from '@/session/types';

export interface SentMessageImagePreview {
  attachmentId: string;
  name: string;
  sourceRef: string;
  sha256?: string;
  uri: string;
}

export type SentMessageImagePreviews = Map<string, readonly (SentMessageImagePreview | null)[]>;
export type GetSentMessageImagePreview = (
  clientId: string, imageIndex: number, name: string, attachmentId?: string, sha256?: string, sourceRef?: string,
) => SentMessageImagePreview | undefined;

const messageKey = (sessionId: string, clientId: string) => JSON.stringify([sessionId, clientId]);

/** Presentation-only snapshot. Host materialization changes URLs, but preserves message/image order. */
export function rememberSentMessageImagePreviews(
  previews: SentMessageImagePreviews,
  sessionId: string,
  clientId: string,
  attachments: readonly RemoteSerializedAttachment[],
  previewOf: (attachment: RemoteSerializedAttachment) => string | null | undefined,
): void {
  const key = messageKey(sessionId, clientId);
  const previous = previews.get(key);
  const images = attachments.filter((attachment) => attachment.category === 'image').map((attachment) => {
    const uri = previewOf(attachment);
    return uri ? { attachmentId: attachment.id, name: attachment.originalName ?? attachment.name,
      sourceRef: attachment.url ?? attachment.path, sha256: attachment.sha256, uri }
      : previous?.find((entry) => entry?.attachmentId === attachment.id) ?? null;
  });
  // Replace the complete snapshot on edit, including removed images and missing previews.
  previews.delete(key);
  previews.set(key, images);
  while (previews.size > 64) previews.delete(previews.keys().next().value!);
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
  const preview = previews.get(messageKey(sessionId, clientId))?.[imageIndex];
  if (!preview || (attachmentId ? preview.attachmentId !== attachmentId : preview.name !== name)) return undefined;
  // Formal content omits file IDs. Prove the pixels still match before reusing a local image;
  // a same-name queue edit on another device must never resurrect the old preview.
  if (!attachmentId && !(sha256 && preview.sha256 === sha256) && preview.sourceRef !== sourceRef) return undefined;
  return preview;
}
