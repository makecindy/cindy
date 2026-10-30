import type { NormalizedAttachment } from '@/session/messageNormalize';
import { isMobileMarkdownImageDirectUrl, mobileMarkdownImageUrlForWorkdir } from '@/session/messageMarkdown';

/** Persisted SVGs may live in files[], but their presentation is an image.
 * Keep the original attachment untouched and use the existing remote/SSH resolver. */
export function svgAttachmentForDisplay(
  attachment: NormalizedAttachment,
  workdir?: string,
  messageKey?: string,
  remoteHostId?: string,
  sessionId?: string,
): NormalizedAttachment {
  if (attachment.kind !== 'file') return attachment;
  const mime = attachment.mimeType?.split(';', 1)[0].trim().toLowerCase();
  if (mime !== 'image/svg+xml' && !/\.svg$/i.test(attachment.name)) return attachment;
  const source = attachment.path || attachment.uri;
  if (!source) return attachment;
  const uri = mobileMarkdownImageUrlForWorkdir(source, workdir, messageKey, remoteHostId, sessionId);
  if (!uri) return attachment;
  return { ...attachment, kind: 'image', mimeType: 'image/svg+xml', uri, previewable: isMobileMarkdownImageDirectUrl(uri) };
}

export interface PartitionedMessageAttachments {
  imageAttachments: NormalizedAttachment[];
  fileAttachments: NormalizedAttachment[];
}

/**
 * Keeps desktop message attachment order stable inside each mobile presentation group.
 */
export function partitionMessageAttachments(
  attachments: readonly NormalizedAttachment[],
): PartitionedMessageAttachments {
  const imageAttachments: NormalizedAttachment[] = [];
  const fileAttachments: NormalizedAttachment[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      imageAttachments.push(attachment);
    } else {
      fileAttachments.push(attachment);
    }
  }

  return { imageAttachments, fileAttachments };
}
